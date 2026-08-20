import { describe, expect, it, vi } from "vitest";
import { createTrialLifecycle } from "../trial.js";
import type { TrialDb, TrialEmailClient, TrialRecord } from "../trial.js";

const NOW = new Date("2025-06-01T00:00:00Z");

function makeRecord(userId: string, daysFromNow: number): TrialRecord {
  const trialEndsAt = new Date(NOW.getTime() + daysFromNow * 86_400_000);
  return { userId, trialEndsAt, status: "trialing" };
}

function makeDb(overrides: Partial<TrialDb> = {}): TrialDb {
  return {
    findExpiredTrials: vi.fn(async () => []),
    markTrialExpired: vi.fn(async () => undefined),
    findTrialsEndingSoon: vi.fn(async () => []),
    ...overrides,
  };
}

function makeEmail(overrides: Partial<TrialEmailClient> = {}): TrialEmailClient {
  return {
    sendTrialEndingWarning: vi.fn(async () => undefined),
    sendTrialExpiredNotice: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("sweepExpiredTrials", () => {
  it("finds expired trials, marks each expired, returns swept count", async () => {
    const records = [makeRecord("user_1", -2), makeRecord("user_2", -5)];
    const db = makeDb({ findExpiredTrials: vi.fn(async () => records) });
    const lifecycle = createTrialLifecycle({ db });

    const result = await lifecycle.sweepExpiredTrials(NOW);

    expect(result.swept).toBe(2);
    expect(db.findExpiredTrials).toHaveBeenCalledWith(NOW);
    expect(db.markTrialExpired).toHaveBeenCalledWith("user_1");
    expect(db.markTrialExpired).toHaveBeenCalledWith("user_2");
  });

  it("returns 0 when no expired trials", async () => {
    const db = makeDb();
    const lifecycle = createTrialLifecycle({ db });
    const result = await lifecycle.sweepExpiredTrials(NOW);
    expect(result.swept).toBe(0);
  });

  it("uses current time as default for now", async () => {
    const db = makeDb();
    const lifecycle = createTrialLifecycle({ db });
    await lifecycle.sweepExpiredTrials();
    expect(db.findExpiredTrials).toHaveBeenCalledOnce();
    const calledWith = (db.findExpiredTrials as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Date;
    expect(calledWith).toBeInstanceOf(Date);
  });

  it("continues past individual errors, counts only successful sweeps", async () => {
    const records = [makeRecord("user_fail", -1), makeRecord("user_ok", -2)];
    const db = makeDb({
      findExpiredTrials: vi.fn(async () => records),
      markTrialExpired: vi.fn(async (userId: string) => {
        if (userId === "user_fail") throw new Error("DB error");
      }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const lifecycle = createTrialLifecycle({ db });
    const result = await lifecycle.sweepExpiredTrials(NOW);

    expect(result.swept).toBe(1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe("dispatchTrialReminders", () => {
  it("sends warning emails for trials ending soon, returns sent count", async () => {
    // Record ending in 2 days
    const records = [makeRecord("user_soon", 2)];
    const db = makeDb({ findTrialsEndingSoon: vi.fn(async () => records) });
    const email = makeEmail();
    const lifecycle = createTrialLifecycle({ db, emailClient: email, warningDaysAhead: 3 });

    const result = await lifecycle.dispatchTrialReminders(NOW);

    expect(result.sent).toBe(1);
    expect(db.findTrialsEndingSoon).toHaveBeenCalledWith(3, NOW);
    expect(email.sendTrialEndingWarning).toHaveBeenCalledWith("user_soon", expect.any(Number));
  });

  it("no-ops gracefully when emailClient not provided", async () => {
    const db = makeDb({ findTrialsEndingSoon: vi.fn(async () => [makeRecord("user_a", 1)]) });
    const lifecycle = createTrialLifecycle({ db });

    const result = await lifecycle.dispatchTrialReminders(NOW);

    expect(result.sent).toBe(0);
    expect(db.findTrialsEndingSoon).not.toHaveBeenCalled();
  });

  it("uses default warningDaysAhead of 3", async () => {
    const db = makeDb();
    const email = makeEmail();
    const lifecycle = createTrialLifecycle({ db, emailClient: email });

    await lifecycle.dispatchTrialReminders(NOW);

    expect(db.findTrialsEndingSoon).toHaveBeenCalledWith(3, NOW);
  });

  it("continues past individual email errors", async () => {
    const records = [makeRecord("user_fail", 1), makeRecord("user_ok", 2)];
    const db = makeDb({ findTrialsEndingSoon: vi.fn(async () => records) });
    const email = makeEmail({
      sendTrialEndingWarning: vi.fn(async (userId: string) => {
        if (userId === "user_fail") throw new Error("Email error");
      }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const lifecycle = createTrialLifecycle({ db, emailClient: email });
    const result = await lifecycle.dispatchTrialReminders(NOW);

    expect(result.sent).toBe(1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("returns 0 when no trials ending soon", async () => {
    const db = makeDb();
    const email = makeEmail();
    const lifecycle = createTrialLifecycle({ db, emailClient: email });

    const result = await lifecycle.dispatchTrialReminders(NOW);
    expect(result.sent).toBe(0);
  });

  it("uses current time as default for now", async () => {
    const db = makeDb();
    const email = makeEmail();
    const lifecycle = createTrialLifecycle({ db, emailClient: email });

    await lifecycle.dispatchTrialReminders();
    const calledWith = (db.findTrialsEndingSoon as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as Date;
    expect(calledWith).toBeInstanceOf(Date);
  });

  it("computes daysLeft correctly as days until trialEndsAt", async () => {
    const trialEndsAt = new Date(NOW.getTime() + 2 * 86_400_000); // exactly 2 days away
    const record: TrialRecord = { userId: "user_exact", trialEndsAt, status: "trialing" };
    const db = makeDb({ findTrialsEndingSoon: vi.fn(async () => [record]) });
    const email = makeEmail();
    const lifecycle = createTrialLifecycle({ db, emailClient: email });

    await lifecycle.dispatchTrialReminders(NOW);

    expect(email.sendTrialEndingWarning).toHaveBeenCalledWith("user_exact", 2);
  });
});

describe("createTrialLifecycle – warningDaysAhead default", () => {
  it("uses 3 when warningDaysAhead is not specified", async () => {
    const db = makeDb();
    const email = makeEmail();
    const lifecycle = createTrialLifecycle({ db, emailClient: email });

    await lifecycle.dispatchTrialReminders(NOW);

    const [daysArg] = (db.findTrialsEndingSoon as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
    ];
    expect(daysArg).toBe(3);
  });
});
