// Advanced tier — plugin interfaces and factory functions for regulated products

export type KmsOpts = {
  kmsKeyId: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export type SessionIdleTimeoutOpts = {
  idleTimeoutMs: number; // e.g. 900_000 (15 min for HIPAA)
  warningMs?: number; // e.g. 60_000 — emit event before expiry
};

export type InviteOpts = {
  handler: (data: {
    email: string;
    role: string;
    inviterName: string;
    acceptUrl: string;
  }) => Promise<void>;
  expiresInMs?: number; // default: 7 days
};

export type AuditableSessionOpts = {
  onSessionCreated?: (session: {
    userId: string;
    sessionId: string;
    ipAddress?: string;
  }) => Promise<void>;
  onSessionRevoked?: (sessionId: string) => Promise<void>;
};

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new Error(`${field} is required`);
  }
}

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be greater than 0`);
  }
}

// Plugin descriptor interfaces — products pass these when calling createAuth

export interface EncryptedTokenPlugin {
  readonly _type: "encrypted-token";
  kms: KmsOpts;
}

export interface SessionIdleTimeoutPlugin {
  readonly _type: "session-idle-timeout";
  opts: SessionIdleTimeoutOpts;
}

export interface InviteSignupPlugin {
  readonly _type: "invite-signup";
  opts: InviteOpts;
}

export interface AuditableSessionPlugin {
  readonly _type: "auditable-session";
  opts: AuditableSessionOpts;
}

export type VentoraPlugin =
  | EncryptedTokenPlugin
  | SessionIdleTimeoutPlugin
  | InviteSignupPlugin
  | AuditableSessionPlugin;

export function encryptedTokenPlugin(kms: KmsOpts): EncryptedTokenPlugin {
  requireNonEmpty(kms.kmsKeyId, "kmsKeyId");
  requireNonEmpty(kms.region, "region");
  return { _type: "encrypted-token", kms };
}

export function sessionIdleTimeoutPlugin(opts: SessionIdleTimeoutOpts): SessionIdleTimeoutPlugin {
  requirePositive(opts.idleTimeoutMs, "idleTimeoutMs");
  if (opts.warningMs !== undefined) {
    requirePositive(opts.warningMs, "warningMs");
    if (opts.warningMs >= opts.idleTimeoutMs) {
      throw new Error("warningMs must be less than idleTimeoutMs");
    }
  }
  return { _type: "session-idle-timeout", opts };
}

export function inviteSignupPlugin(opts: InviteOpts): InviteSignupPlugin {
  if (opts.expiresInMs !== undefined) {
    requirePositive(opts.expiresInMs, "expiresInMs");
  }
  return { _type: "invite-signup", opts };
}

export function auditableSessionPlugin(opts: AuditableSessionOpts): AuditableSessionPlugin {
  return { _type: "auditable-session", opts };
}

const VENTORA_PLUGIN_TYPES = new Set<string>([
  "encrypted-token",
  "session-idle-timeout",
  "invite-signup",
  "auditable-session",
]);

export function isVentoraPlugin(p: unknown): p is VentoraPlugin {
  if (typeof p !== "object" || p === null) return false;
  const obj = p as Record<string, unknown>;
  return typeof obj._type === "string" && VENTORA_PLUGIN_TYPES.has(obj._type);
}

// Resolve only descriptors that this package can wire safely. Security-sensitive
// descriptors fail closed unless the product supplies its own Better Auth hooks.
export function resolvePlugins(plugins: VentoraPlugin[]): unknown[] {
  return plugins.map((plugin) => {
    switch (plugin._type) {
      case "encrypted-token":
        throw new Error(
          "ventora encrypted-token requires a product-owned Better Auth integration; this package does not expose a no-op KMS token plugin",
        );
      case "session-idle-timeout":
        throw new Error(
          "ventora session-idle-timeout requires a product-owned Better Auth integration; this package does not expose a no-op idle-timeout plugin",
        );
      case "invite-signup":
        throw new Error(
          "ventora invite-signup requires a product-owned Better Auth integration; this package does not expose a no-op invite plugin",
        );
      case "auditable-session":
        throw new Error(
          "ventora auditable-session requires a product-owned Better Auth integration; this package does not expose a no-op audit plugin",
        );
    }
  });
}
