import { betterAuth as _betterAuth } from "better-auth";
import type {
  AuthEnv,
  BetterAuthInstance,
  Database,
  ResetPasswordData,
  User,
  VerifyEmailData,
} from "./types.js";

export type CrossSubdomainCookieConfig = {
  enabled: boolean;
  domain: string; // e.g. ".lextract.app" (leading dot = all subdomains)
};

export type AuthFactoryOpts = {
  db: Database;
  env: AuthEnv;
  appUrl: string;
  trustedOrigins?: string[];
  crossSubdomainCookie?: CrossSubdomainCookieConfig;
  emailVerification?: {
    sendOnSignUp: boolean;
    handler: (data: VerifyEmailData) => Promise<void>;
  };
  passwordReset?: (data: ResetPasswordData) => Promise<void>;
  signupHook?: (user: User, request: Request) => Promise<void>;
  cookieCacheMaxAge?: number; // seconds, default: 60
  enableGoogleOAuth?: boolean;
  plugins?: unknown[];
};

function validateEnv(env: AuthEnv): void {
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required");
  }
  if (env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
}

export function createAuth(opts: AuthFactoryOpts): BetterAuthInstance {
  validateEnv(opts.env);

  const betterAuth = _betterAuth as unknown as (
    config: Record<string, unknown>,
  ) => BetterAuthInstance;

  const cookieCacheMaxAge = opts.cookieCacheMaxAge ?? 60;

  const advancedConfig: Record<string, unknown> = {
    cookieCache: {
      enabled: true,
      maxAge: cookieCacheMaxAge,
    },
  };

  if (opts.crossSubdomainCookie?.enabled === true) {
    advancedConfig.crossSubDomainCookies = {
      enabled: true,
      domain: opts.crossSubdomainCookie.domain,
    };
  }

  const emailAndPassword: Record<string, unknown> = {
    enabled: true,
  };

  if (opts.passwordReset !== undefined) {
    emailAndPassword.sendResetPassword = async (data: {
      user: User;
      url: string;
      token: string;
    }) => {
      await opts.passwordReset?.({ user: data.user, url: data.url, token: data.token });
    };
  }

  const socialProviders: Record<string, unknown> = {};

  if (
    opts.enableGoogleOAuth === true &&
    opts.env.GOOGLE_CLIENT_ID !== undefined &&
    opts.env.GOOGLE_CLIENT_SECRET !== undefined
  ) {
    socialProviders.google = {
      clientId: opts.env.GOOGLE_CLIENT_ID,
      clientSecret: opts.env.GOOGLE_CLIENT_SECRET,
    };
  }

  const emailVerificationConfig: Record<string, unknown> = {};

  if (opts.emailVerification !== undefined) {
    emailVerificationConfig.sendOnSignUp = opts.emailVerification.sendOnSignUp;
    emailVerificationConfig.sendVerificationEmail = async (data: {
      user: User;
      url: string;
      token: string;
    }) => {
      await opts.emailVerification?.handler({
        user: data.user,
        url: data.url,
        token: data.token,
      });
    };
  }

  const hooks: Record<string, unknown> = {};

  if (opts.signupHook !== undefined) {
    hooks.after = async (context: Record<string, unknown>) => {
      if (context.path !== "/sign-up/email") {
        return;
      }
      const contextValue = context.context;
      const contextRecord =
        typeof contextValue === "object" && contextValue !== null
          ? (contextValue as Record<string, unknown>)
          : {};
      const newUserValue = contextRecord.newUser;
      const newUser =
        typeof newUserValue === "object" && newUserValue !== null
          ? (newUserValue as { user?: User })
          : undefined;
      if (newUser?.user !== undefined) {
        const req = context.request instanceof Request ? context.request : new Request(opts.appUrl);
        await opts.signupHook?.(newUser.user, req);
      }
    };
  }

  const config: Record<string, unknown> = {
    database: opts.db,
    secret: opts.env.BETTER_AUTH_SECRET,
    baseURL: opts.env.BETTER_AUTH_URL ?? opts.appUrl,
    trustedOrigins: opts.trustedOrigins ?? [opts.appUrl],
    advanced: advancedConfig,
    emailAndPassword,
    socialProviders,
    emailVerification: emailVerificationConfig,
    hooks,
    plugins: opts.plugins ?? [],
  };

  return betterAuth(config) as unknown as BetterAuthInstance;
}
