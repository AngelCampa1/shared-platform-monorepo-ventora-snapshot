import { describe, expect, it, vi } from "vitest";
import {
  AuthRequiredError,
  ForbiddenRoleError,
  requireOrg,
  requireRole,
  requireSession,
} from "../helpers.js";
import type { BetterAuthInstance, Member, Organization, Session, User } from "../types.js";

const mockSession: Session = {
  id: "session-1",
  userId: "user-1",
  expiresAt: new Date(Date.now() + 3600_000),
};

const mockUser: User = {
  id: "user-1",
  email: "test@example.com",
  emailVerified: true,
  createdAt: new Date(),
};

const mockOrg: Organization = {
  id: "org-1",
  name: "Test Org",
  slug: "test-org",
};

const mockMember: Member = {
  userId: "user-1",
  organizationId: "org-1",
  role: "admin",
};

function makeAuth(
  result: {
    session: Session;
    user: User;
    member?: Member;
    organization?: Organization;
  } | null,
): BetterAuthInstance {
  return {
    handler: async (_req: Request) => new Response("ok"),
    api: {
      getSession: vi.fn().mockResolvedValue(result),
    },
  };
}

describe("AuthRequiredError", () => {
  it("has status 401", () => {
    const err = new AuthRequiredError();
    expect(err.status).toBe(401);
  });

  it("uses default message", () => {
    const err = new AuthRequiredError();
    expect(err.message).toBe("Authentication required");
  });

  it("accepts custom message", () => {
    const err = new AuthRequiredError("custom message");
    expect(err.message).toBe("custom message");
  });

  it("is an instance of Error", () => {
    expect(new AuthRequiredError()).toBeInstanceOf(Error);
  });
});

describe("ForbiddenRoleError", () => {
  it("has status 403", () => {
    const err = new ForbiddenRoleError("admin");
    expect(err.status).toBe(403);
  });

  it("includes required role in message", () => {
    const err = new ForbiddenRoleError("admin");
    expect(err.message).toBe("Required role: admin");
  });

  it("is an instance of Error", () => {
    expect(new ForbiddenRoleError("owner")).toBeInstanceOf(Error);
  });
});

describe("requireSession", () => {
  it("throws AuthRequiredError when getSession returns null", async () => {
    const auth = makeAuth(null);
    const req = new Request("https://example.com");
    await expect(requireSession(req, auth)).rejects.toThrow(AuthRequiredError);
  });

  it("throws AuthRequiredError with status 401 when getSession returns null", async () => {
    const auth = makeAuth(null);
    const req = new Request("https://example.com");
    try {
      await requireSession(req, auth);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthRequiredError);
      expect((err as AuthRequiredError).status).toBe(401);
    }
  });

  it("returns AuthContext when getSession returns session and user", async () => {
    const auth = makeAuth({ session: mockSession, user: mockUser });
    const req = new Request("https://example.com");
    const ctx = await requireSession(req, auth);
    expect(ctx.session).toBe(mockSession);
    expect(ctx.user).toBe(mockUser);
  });

  it("passes request headers to getSession", async () => {
    const auth = makeAuth({ session: mockSession, user: mockUser });
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer token" },
    });
    await requireSession(req, auth);
    expect(auth.api.getSession).toHaveBeenCalledWith({ headers: req.headers });
  });
});

describe("requireOrg", () => {
  it("throws AuthRequiredError when session is null", async () => {
    const auth = makeAuth(null);
    const req = new Request("https://example.com");
    await expect(requireOrg(req, auth)).rejects.toThrow(AuthRequiredError);
  });

  it("throws AuthRequiredError when no org on session", async () => {
    const auth = makeAuth({ session: mockSession, user: mockUser });
    const req = new Request("https://example.com");
    await expect(requireOrg(req, auth)).rejects.toThrow(AuthRequiredError);
  });

  it("returns OrgAuthContext when org and member are present", async () => {
    const auth = makeAuth({
      session: mockSession,
      user: mockUser,
      organization: mockOrg,
      member: mockMember,
    });
    const req = new Request("https://example.com");
    const ctx = await requireOrg(req, auth);
    expect(ctx.session).toBe(mockSession);
    expect(ctx.user).toBe(mockUser);
    expect(ctx.organization).toBe(mockOrg);
    expect(ctx.member).toBe(mockMember);
  });

  it("throws ForbiddenRoleError when role does not match", async () => {
    const auth = makeAuth({
      session: mockSession,
      user: mockUser,
      organization: mockOrg,
      member: { ...mockMember, role: "member" },
    });
    const req = new Request("https://example.com");
    await expect(requireOrg(req, auth, "admin")).rejects.toThrow(ForbiddenRoleError);
  });

  it("returns OrgAuthContext when role matches", async () => {
    const auth = makeAuth({
      session: mockSession,
      user: mockUser,
      organization: mockOrg,
      member: mockMember,
    });
    const req = new Request("https://example.com");
    const ctx = await requireOrg(req, auth, "admin");
    expect(ctx.member.role).toBe("admin");
  });
});

describe("requireRole", () => {
  it("throws AuthRequiredError when session is null", async () => {
    const auth = makeAuth(null);
    const req = new Request("https://example.com");
    await expect(requireRole(req, auth, "admin")).rejects.toThrow(AuthRequiredError);
  });

  it("throws AuthRequiredError when no org on session", async () => {
    const auth = makeAuth({ session: mockSession, user: mockUser });
    const req = new Request("https://example.com");
    try {
      await requireRole(req, auth, "admin");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthRequiredError);
      expect(err).not.toBeInstanceOf(ForbiddenRoleError);
      expect((err as AuthRequiredError).message).toBe("No active organization on session");
      expect((err as AuthRequiredError).status).toBe(401);
    }
  });

  it("throws ForbiddenRoleError when role doesn't match", async () => {
    const auth = makeAuth({
      session: mockSession,
      user: mockUser,
      organization: mockOrg,
      member: { ...mockMember, role: "member" },
    });
    const req = new Request("https://example.com");
    await expect(requireRole(req, auth, "admin")).rejects.toThrow(ForbiddenRoleError);
  });

  it("ForbiddenRoleError includes required role", async () => {
    const auth = makeAuth({
      session: mockSession,
      user: mockUser,
      organization: mockOrg,
      member: { ...mockMember, role: "member" },
    });
    const req = new Request("https://example.com");
    try {
      await requireRole(req, auth, "admin");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenRoleError);
      expect((err as ForbiddenRoleError).message).toBe("Required role: admin");
    }
  });

  it("returns OrgAuthContext when role matches", async () => {
    const auth = makeAuth({
      session: mockSession,
      user: mockUser,
      organization: mockOrg,
      member: mockMember,
    });
    const req = new Request("https://example.com");
    const ctx = await requireRole(req, auth, "admin");
    expect(ctx.session).toBe(mockSession);
    expect(ctx.user).toBe(mockUser);
    expect(ctx.organization).toBe(mockOrg);
    expect(ctx.member).toBe(mockMember);
  });

  it("ForbiddenRoleError has status 403", async () => {
    const auth = makeAuth({
      session: mockSession,
      user: mockUser,
      organization: mockOrg,
      member: { ...mockMember, role: "member" },
    });
    const req = new Request("https://example.com");
    try {
      await requireRole(req, auth, "admin");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ForbiddenRoleError).status).toBe(403);
    }
  });
});
