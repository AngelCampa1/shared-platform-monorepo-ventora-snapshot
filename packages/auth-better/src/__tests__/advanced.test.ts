import { describe, expect, it, vi } from "vitest";
import {
  auditableSessionPlugin,
  encryptedTokenPlugin,
  inviteSignupPlugin,
  isVentoraPlugin,
  resolvePlugins,
  sessionIdleTimeoutPlugin,
} from "../advanced.js";
import type {
  AuditableSessionOpts,
  InviteOpts,
  KmsOpts,
  SessionIdleTimeoutOpts,
} from "../advanced.js";

const kmsOpts: KmsOpts = {
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/abc",
  region: "us-east-1",
};

const idleOpts: SessionIdleTimeoutOpts = {
  idleTimeoutMs: 900_000,
  warningMs: 60_000,
};

const inviteOpts: InviteOpts = {
  handler: vi.fn(),
  expiresInMs: 7 * 24 * 60 * 60 * 1000,
};

const auditOpts: AuditableSessionOpts = {
  onSessionCreated: vi.fn(),
  onSessionRevoked: vi.fn(),
};

describe("encryptedTokenPlugin", () => {
  it("rejects missing KMS key id", () => {
    expect(() => encryptedTokenPlugin({ kmsKeyId: "", region: "us-east-1" })).toThrow(
      "kmsKeyId is required",
    );
  });

  it("rejects missing KMS region", () => {
    expect(() =>
      encryptedTokenPlugin({ kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/abc", region: "" }),
    ).toThrow("region is required");
  });

  it("returns correct _type discriminant", () => {
    const plugin = encryptedTokenPlugin(kmsOpts);
    expect(plugin._type).toBe("encrypted-token");
  });

  it("retains kms options", () => {
    const plugin = encryptedTokenPlugin(kmsOpts);
    expect(plugin.kms).toEqual(kmsOpts);
  });
});

describe("sessionIdleTimeoutPlugin", () => {
  it("rejects nonpositive idle timeout", () => {
    expect(() => sessionIdleTimeoutPlugin({ idleTimeoutMs: 0 })).toThrow(
      "idleTimeoutMs must be greater than 0",
    );
  });

  it("rejects warning windows greater than or equal to the idle timeout", () => {
    expect(() => sessionIdleTimeoutPlugin({ idleTimeoutMs: 900_000, warningMs: 900_000 })).toThrow(
      "warningMs must be less than idleTimeoutMs",
    );
  });

  it("returns correct _type discriminant", () => {
    const plugin = sessionIdleTimeoutPlugin(idleOpts);
    expect(plugin._type).toBe("session-idle-timeout");
  });

  it("retains opts", () => {
    const plugin = sessionIdleTimeoutPlugin(idleOpts);
    expect(plugin.opts).toEqual(idleOpts);
  });
});

describe("inviteSignupPlugin", () => {
  it("rejects nonpositive expiry", () => {
    expect(() => inviteSignupPlugin({ handler: vi.fn(), expiresInMs: 0 })).toThrow(
      "expiresInMs must be greater than 0",
    );
  });

  it("returns correct _type discriminant", () => {
    const plugin = inviteSignupPlugin(inviteOpts);
    expect(plugin._type).toBe("invite-signup");
  });

  it("retains opts", () => {
    const plugin = inviteSignupPlugin(inviteOpts);
    expect(plugin.opts).toBe(inviteOpts);
  });
});

describe("auditableSessionPlugin", () => {
  it("returns correct _type discriminant", () => {
    const plugin = auditableSessionPlugin(auditOpts);
    expect(plugin._type).toBe("auditable-session");
  });

  it("retains opts", () => {
    const plugin = auditableSessionPlugin(auditOpts);
    expect(plugin.opts).toBe(auditOpts);
  });
});

describe("isVentoraPlugin", () => {
  it("returns true for EncryptedTokenPlugin", () => {
    expect(isVentoraPlugin(encryptedTokenPlugin(kmsOpts))).toBe(true);
  });

  it("returns true for SessionIdleTimeoutPlugin", () => {
    expect(isVentoraPlugin(sessionIdleTimeoutPlugin(idleOpts))).toBe(true);
  });

  it("returns true for InviteSignupPlugin", () => {
    expect(isVentoraPlugin(inviteSignupPlugin(inviteOpts))).toBe(true);
  });

  it("returns true for AuditableSessionPlugin", () => {
    expect(isVentoraPlugin(auditableSessionPlugin(auditOpts))).toBe(true);
  });

  it("returns false for null", () => {
    expect(isVentoraPlugin(null)).toBe(false);
  });

  it("returns false for a plain object without _type", () => {
    expect(isVentoraPlugin({ kms: kmsOpts })).toBe(false);
  });

  it("returns false for an object with unknown _type", () => {
    expect(isVentoraPlugin({ _type: "unknown-plugin" })).toBe(false);
  });

  it("returns false for a primitive string", () => {
    expect(isVentoraPlugin("encrypted-token")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isVentoraPlugin(undefined)).toBe(false);
  });
});

describe("resolvePlugins", () => {
  it("returns empty array for empty input", () => {
    expect(resolvePlugins([])).toEqual([]);
  });

  it("fails closed for encrypted-token instead of returning a no-op plugin", () => {
    expect(() => resolvePlugins([encryptedTokenPlugin(kmsOpts)])).toThrow(
      "ventora encrypted-token requires a product-owned Better Auth integration",
    );
  });

  it("fails closed for session-idle-timeout instead of returning a no-op plugin", () => {
    expect(() => resolvePlugins([sessionIdleTimeoutPlugin(idleOpts)])).toThrow(
      "ventora session-idle-timeout requires a product-owned Better Auth integration",
    );
  });

  it("fails closed for invite-signup instead of returning a descriptor-only plugin", () => {
    expect(() => resolvePlugins([inviteSignupPlugin(inviteOpts)])).toThrow(
      "ventora invite-signup requires a product-owned Better Auth integration",
    );
  });

  it("fails closed for auditable-session instead of returning a descriptor-only plugin", () => {
    expect(() => resolvePlugins([auditableSessionPlugin(auditOpts)])).toThrow(
      "ventora auditable-session requires a product-owned Better Auth integration",
    );
  });

  it("stops on the first unsupported descriptor in mixed input", () => {
    expect(() =>
      resolvePlugins([inviteSignupPlugin(inviteOpts), auditableSessionPlugin(auditOpts)]),
    ).toThrow("ventora invite-signup requires a product-owned Better Auth integration");
  });
});
