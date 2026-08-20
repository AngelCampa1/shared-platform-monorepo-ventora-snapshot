// Trial lifecycle management — requires a database interface
// The DB interface is intentionally minimal (duck-typed) to avoid tying to Drizzle

export type TrialRecord = {
  userId: string;
  organizationId?: string;
  trialEndsAt: Date;
  status: "trialing" | "converted" | "expired";
};

export type TrialDb = {
  // Returns records where trialEndsAt < now and status === "trialing"
  findExpiredTrials(now: Date): Promise<TrialRecord[]>;
  // Update trial status to "expired"
  markTrialExpired(userId: string): Promise<void>;
  // Returns records where trialEndsAt is within warningDays days
  findTrialsEndingSoon(daysAhead: number, now: Date): Promise<TrialRecord[]>;
};

export type TrialEmailClient = {
  sendTrialEndingWarning(userId: string, daysLeft: number): Promise<void>;
  sendTrialExpiredNotice(userId: string): Promise<void>;
};

export type TrialLifecycleOpts = {
  db: TrialDb;
  emailClient?: TrialEmailClient;
  warningDaysAhead?: number; // default: 3
};

export interface TrialLifecycle {
  sweepExpiredTrials(now?: Date): Promise<{ swept: number }>;
  dispatchTrialReminders(now?: Date): Promise<{ sent: number }>;
}

export function createTrialLifecycle(opts: TrialLifecycleOpts): TrialLifecycle {
  const { db, emailClient, warningDaysAhead = 3 } = opts;

  return {
    async sweepExpiredTrials(now: Date = new Date()): Promise<{ swept: number }> {
      const expired = await db.findExpiredTrials(now);
      let swept = 0;
      for (const record of expired) {
        try {
          await db.markTrialExpired(record.userId);
          swept++;
        } catch (err) {
          console.warn(`Failed to mark trial expired for user ${record.userId}:`, err);
        }
      }
      return { swept };
    },

    async dispatchTrialReminders(now: Date = new Date()): Promise<{ sent: number }> {
      if (emailClient === undefined) return { sent: 0 };

      const ending = await db.findTrialsEndingSoon(warningDaysAhead, now);
      let sent = 0;
      for (const record of ending) {
        try {
          const msLeft = record.trialEndsAt.getTime() - now.getTime();
          const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
          await emailClient.sendTrialEndingWarning(record.userId, daysLeft);
          sent++;
        } catch (err) {
          console.warn(`Failed to send trial reminder to user ${record.userId}:`, err);
        }
      }
      return { sent };
    },
  };
}
