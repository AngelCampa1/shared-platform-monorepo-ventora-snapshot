import type {
  AuthContext,
  BetterAuthInstance,
  Member,
  OrgAuthContext,
  Organization,
  Session,
  User,
} from "./types.js";

export class AuthRequiredError extends Error {
  readonly status: number;
  constructor(message?: string) {
    super(message ?? "Authentication required");
    this.name = "AuthRequiredError";
    this.status = 401;
  }
}

export class ForbiddenRoleError extends Error {
  readonly status: number;
  constructor(requiredRole: string) {
    super(`Required role: ${requiredRole}`);
    this.name = "ForbiddenRoleError";
    this.status = 403;
  }
}

export async function requireSession(
  request: Request,
  auth: BetterAuthInstance,
): Promise<AuthContext> {
  const result = await auth.api.getSession({ headers: request.headers });
  if (result === null) {
    throw new AuthRequiredError();
  }
  return { session: result.session, user: result.user };
}

type OrgAwareSessionResult = {
  session: Session;
  user: User;
  member?: Member;
  organization?: Organization;
} | null;

export async function requireOrg(
  request: Request,
  auth: BetterAuthInstance,
  role?: string,
): Promise<OrgAuthContext> {
  const rawResult = await auth.api.getSession({ headers: request.headers });

  if (rawResult === null) {
    throw new AuthRequiredError();
  }

  // Cast to org-aware shape; Better Auth's org plugin populates these fields
  const result = rawResult as OrgAwareSessionResult & { session: Session; user: User };
  const { session, user } = result;
  const organization = (result as { organization?: Organization }).organization;
  const member = (result as { member?: Member }).member;

  if (organization === undefined || member === undefined) {
    throw new AuthRequiredError("No active organization on session");
  }

  if (role !== undefined && member.role !== role) {
    throw new ForbiddenRoleError(role);
  }

  return { session, user, organization, member };
}

export async function requireRole(
  request: Request,
  auth: BetterAuthInstance & {
    api: {
      getSession: (opts: {
        headers: Headers;
      }) => Promise<OrgAwareSessionResult>;
    };
  },
  role: string,
): Promise<OrgAuthContext> {
  const rawResult = await auth.api.getSession({ headers: request.headers });

  if (rawResult === null) {
    throw new AuthRequiredError();
  }

  // The intersection of the overloaded api.getSession signatures resolves to the base
  // return type; cast to the full org-aware shape to access the extended fields.
  const fullResult = rawResult as OrgAwareSessionResult & { session: Session; user: User };
  const session = fullResult.session;
  const user = fullResult.user;
  const organization = fullResult.organization;
  const member = fullResult.member;

  if (organization === undefined || member === undefined) {
    throw new AuthRequiredError("No active organization on session");
  }

  if (member.role !== role) {
    throw new ForbiddenRoleError(role);
  }

  return { session, user, organization, member };
}
