export type AuthEnv = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_COOKIE_DOMAIN?: string;
};

export type User = {
  id: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  createdAt: Date;
};

export type Session = {
  id: string;
  userId: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
};

export type Organization = {
  id: string;
  name: string;
  slug?: string;
};

export type Member = {
  userId: string;
  organizationId: string;
  role: string;
};

export type AuthContext = {
  session: Session;
  user: User;
};

export type OrgAuthContext = AuthContext & {
  organization: Organization;
  member: Member;
};

export type VerifyEmailData = {
  user: User;
  url: string;
  token: string;
};

export type ResetPasswordData = {
  user: User;
  url: string;
  token: string;
};

// Minimal BetterAuthInstance interface — what products need from the auth object
export interface BetterAuthInstance {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{ session: Session; user: User } | null>;
  };
}

// Minimal database interface — what Better Auth needs from the DB adapter
export type Database = unknown; // Products pass their Drizzle db instance; typed as unknown here since the shape varies
