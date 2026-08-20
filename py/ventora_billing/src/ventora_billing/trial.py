from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from math import ceil
from typing import Protocol

logger = logging.getLogger(__name__)


@dataclass
class TrialRecord:
    user_id: str
    trial_ends_at: datetime
    status: str
    organization_id: str | None = None


class TrialDb(Protocol):
    def find_expired_trials(self, now: datetime) -> list[TrialRecord]: ...
    def mark_trial_expired(self, user_id: str) -> None: ...
    def find_trials_ending_soon(self, days_ahead: int, now: datetime) -> list[TrialRecord]: ...


class TrialEmailClient(Protocol):
    def send_trial_ending_warning(self, user_id: str, days_left: int) -> None: ...
    def send_trial_expired_notice(self, user_id: str) -> None: ...


@dataclass
class TrialLifecycleConfig:
    db: TrialDb
    email_client: TrialEmailClient | None = None
    warning_days_ahead: int = 3


class TrialLifecycle:
    def __init__(self, config: TrialLifecycleConfig) -> None:
        self._config = config

    def sweep_expired_trials(self, now: datetime | None = None) -> dict[str, int]:
        now = now or datetime.now(UTC)
        records = self._config.db.find_expired_trials(now)
        swept = 0
        for record in records:
            try:
                self._config.db.mark_trial_expired(record.user_id)
                swept += 1
            except Exception as e:
                logger.warning("Failed to expire trial for user %s: %s", record.user_id, e)
        return {"swept": swept}

    def dispatch_trial_reminders(self, now: datetime | None = None) -> dict[str, int]:
        if not self._config.email_client:
            return {"sent": 0}
        now = now or datetime.now(UTC)
        records = self._config.db.find_trials_ending_soon(self._config.warning_days_ahead, now)
        sent = 0
        for record in records:
            try:
                seconds_left = (record.trial_ends_at - now).total_seconds()
                days_left = max(0, ceil(seconds_left / 86_400))
                self._config.email_client.send_trial_ending_warning(record.user_id, days_left)
                sent += 1
            except Exception as e:
                logger.warning("Failed to send trial reminder for user %s: %s", record.user_id, e)
        return {"sent": sent}


def create_trial_lifecycle(config: TrialLifecycleConfig) -> TrialLifecycle:
    return TrialLifecycle(config)
