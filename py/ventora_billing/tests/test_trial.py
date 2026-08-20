from __future__ import annotations
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, call

import pytest

from ventora_billing.trial import (
    TrialRecord,
    TrialLifecycleConfig,
    TrialLifecycle,
    create_trial_lifecycle,
)


def make_record(user_id: str, days_ahead: int = 2) -> TrialRecord:
    return TrialRecord(
        user_id=user_id,
        trial_ends_at=datetime.now(UTC) + timedelta(days=days_ahead),
        status="trialing",
    )


def make_expired_record(user_id: str) -> TrialRecord:
    return TrialRecord(
        user_id=user_id,
        trial_ends_at=datetime.now(UTC) - timedelta(days=1),
        status="trialing",
    )


# --- sweep_expired_trials ---

def test_sweep_expired_trials_calls_mark_for_each_record():
    db = MagicMock()
    records = [make_expired_record("u1"), make_expired_record("u2")]
    db.find_expired_trials.return_value = records

    config = TrialLifecycleConfig(db=db)
    lifecycle = TrialLifecycle(config)

    now = datetime.now(UTC)
    result = lifecycle.sweep_expired_trials(now)

    db.mark_trial_expired.assert_any_call("u1")
    db.mark_trial_expired.assert_any_call("u2")
    assert result == {"swept": 2}


def test_sweep_expired_trials_returns_zero_when_no_records():
    db = MagicMock()
    db.find_expired_trials.return_value = []

    lifecycle = TrialLifecycle(TrialLifecycleConfig(db=db))
    result = lifecycle.sweep_expired_trials()
    assert result == {"swept": 0}


def test_sweep_expired_trials_continues_on_individual_db_error():
    db = MagicMock()
    records = [make_expired_record("u1"), make_expired_record("u2"), make_expired_record("u3")]
    db.find_expired_trials.return_value = records
    # u2 raises, u1 and u3 succeed
    db.mark_trial_expired.side_effect = lambda uid: (_ for _ in ()).throw(Exception("DB error")) if uid == "u2" else None

    lifecycle = TrialLifecycle(TrialLifecycleConfig(db=db))
    result = lifecycle.sweep_expired_trials()
    # u1 and u3 succeed, u2 fails
    assert result == {"swept": 2}


def test_sweep_expired_trials_uses_utc_aware_now_when_no_now_arg():
    """When called without an explicit now, sweep_expired_trials passes a UTC-aware datetime to the db."""
    db = MagicMock()
    db.find_expired_trials.return_value = []

    lifecycle = TrialLifecycle(TrialLifecycleConfig(db=db))
    lifecycle.sweep_expired_trials()  # no `now` argument

    db.find_expired_trials.assert_called_once()
    passed_now: datetime = db.find_expired_trials.call_args[0][0]
    assert passed_now is not None
    assert passed_now.tzinfo is not None, "now passed to db must be timezone-aware"
    assert passed_now.tzinfo == UTC


# --- dispatch_trial_reminders ---

def test_dispatch_trial_reminders_sends_warnings_and_returns_count():
    db = MagicMock()
    email_client = MagicMock()
    records = [make_record("u1", days_ahead=2), make_record("u2", days_ahead=1)]
    db.find_trials_ending_soon.return_value = records

    config = TrialLifecycleConfig(db=db, email_client=email_client, warning_days_ahead=3)
    lifecycle = TrialLifecycle(config)

    now = datetime.now(UTC)
    result = lifecycle.dispatch_trial_reminders(now)

    assert email_client.send_trial_ending_warning.call_count == 2
    assert result == {"sent": 2}


def test_dispatch_trial_reminders_returns_zero_when_no_email_client():
    db = MagicMock()
    db.find_trials_ending_soon.return_value = [make_record("u1")]

    config = TrialLifecycleConfig(db=db, email_client=None)
    lifecycle = TrialLifecycle(config)

    result = lifecycle.dispatch_trial_reminders()
    assert result == {"sent": 0}
    db.find_trials_ending_soon.assert_not_called()


def test_dispatch_trial_reminders_continues_on_individual_email_error():
    db = MagicMock()
    email_client = MagicMock()
    records = [make_record("u1"), make_record("u2"), make_record("u3")]
    db.find_trials_ending_soon.return_value = records
    # u2 raises
    email_client.send_trial_ending_warning.side_effect = lambda uid, days: (_ for _ in ()).throw(Exception("SMTP error")) if uid == "u2" else None

    config = TrialLifecycleConfig(db=db, email_client=email_client)
    lifecycle = TrialLifecycle(config)
    result = lifecycle.dispatch_trial_reminders()
    assert result == {"sent": 2}


def test_dispatch_trial_reminders_uses_warning_days_ahead():
    db = MagicMock()
    email_client = MagicMock()
    db.find_trials_ending_soon.return_value = []

    config = TrialLifecycleConfig(db=db, email_client=email_client, warning_days_ahead=7)
    lifecycle = TrialLifecycle(config)

    now = datetime.now(UTC)
    lifecycle.dispatch_trial_reminders(now)
    db.find_trials_ending_soon.assert_called_once_with(7, now)


def test_dispatch_trial_reminders_days_left_is_non_negative():
    db = MagicMock()
    email_client = MagicMock()
    # A record that already ended (past date) to trigger days_left = 0
    past_record = TrialRecord(
        user_id="u_past",
        trial_ends_at=datetime.now(UTC) - timedelta(days=2),
        status="trialing",
    )
    db.find_trials_ending_soon.return_value = [past_record]

    config = TrialLifecycleConfig(db=db, email_client=email_client)
    lifecycle = TrialLifecycle(config)
    lifecycle.dispatch_trial_reminders()

    call_args = email_client.send_trial_ending_warning.call_args
    assert call_args[0][1] == 0  # days_left clamped to 0


def test_dispatch_trial_reminders_rounds_partial_days_up():
    db = MagicMock()
    email_client = MagicMock()
    now = datetime(2026, 5, 19, 12, 0, tzinfo=UTC)
    record = TrialRecord(
        user_id="u_partial",
        trial_ends_at=now + timedelta(days=1, hours=23),
        status="trialing",
    )
    db.find_trials_ending_soon.return_value = [record]

    lifecycle = TrialLifecycle(TrialLifecycleConfig(db=db, email_client=email_client))
    lifecycle.dispatch_trial_reminders(now)

    email_client.send_trial_ending_warning.assert_called_once_with("u_partial", 2)


def test_dispatch_trial_reminders_uses_utc_aware_now_when_no_now_arg():
    """When called without an explicit now, dispatch_trial_reminders passes a UTC-aware datetime to the db."""
    db = MagicMock()
    email_client = MagicMock()
    db.find_trials_ending_soon.return_value = []

    config = TrialLifecycleConfig(db=db, email_client=email_client)
    lifecycle = TrialLifecycle(config)
    lifecycle.dispatch_trial_reminders()  # no `now` argument

    db.find_trials_ending_soon.assert_called_once()
    passed_now: datetime = db.find_trials_ending_soon.call_args[0][1]
    assert passed_now is not None
    assert passed_now.tzinfo is not None, "now passed to db must be timezone-aware"
    assert passed_now.tzinfo == UTC


# --- create_trial_lifecycle factory ---

def test_create_trial_lifecycle_factory():
    db = MagicMock()
    config = TrialLifecycleConfig(db=db)
    lifecycle = create_trial_lifecycle(config)
    assert isinstance(lifecycle, TrialLifecycle)
