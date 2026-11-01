import type { RequestHandler, Response } from "express";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ApiError, SessionUser } from "@recall/shared";
import { HttpError } from "../meetings/errors.js";
import { IdParam } from "../meetings/validation.js";

export type AuthUser = SessionUser;

export type AuthErrorCode = "session_expired" | "invalid_token" | "auth_unavailable";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Resolves a bearer token to the signed-in user, or throws an AuthError. */
export type TokenVerifier = (token: string) => Promise<AuthUser>;

export interface SupabaseVerifierOptions {
  supabaseUrl: string;
  /** Legacy HS256 project secret. Without it only asymmetric (JWKS) signing keys are accepted. */
  jwtSecret?: string;
  /** Overrides the project's remote JWKS (tests). */
  jwks?: JWTVerifyGetKey;
}

/**
 * Verifies Supabase Auth access tokens locally: signature (project JWKS, or the legacy secret), issuer, audience,
 * expiry and role. Anonymous Supabase sessions are refused. Revocation is not checked: a token stays valid until it
 * expires (Supabase default: one hour) even after the user signs out elsewhere.
 */
export function createSupabaseVerifier({ supabaseUrl, jwtSecret, jwks }: SupabaseVerifierOptions): TokenVerifier {
  const issuer = `${supabaseUrl}/auth/v1`;
  const remote = jwks ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { timeoutDuration: 5_000 });
  const secret = jwtSecret ? new TextEncoder().encode(jwtSecret) : undefined;
  // The algorithm allow-list is checked before any key is resolved, so "none" and HS256-without-a-secret never verify.
  const algorithms = secret ? ["ES256", "RS256", "HS256"] : ["ES256", "RS256"];
  const getKey: JWTVerifyGetKey = (header, token) => (header.alg === "HS256" && secret ? secret : remote(header, token));

  return async (token) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, getKey, { issuer, audience: "authenticated", algorithms, requiredClaims: ["sub", "exp"], clockTolerance: 5 }));
    } catch (err) {
      if (err instanceof errors.JWTExpired) throw new AuthError("session_expired", "Your session has expired. Sign in again.");
      // Network failures fetching the JWKS are our problem, not a bad token.
      if (err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError)) {
        throw new AuthError("auth_unavailable", "Could not verify your session right now. Try again in a moment.");
      }
      throw new AuthError("invalid_token", "Your session is not valid. Sign in again.");
    }
    const sub = IdParam.safeParse(payload.sub);
    if (payload.role !== "authenticated" || payload.is_anonymous === true || !sub.success || typeof payload.email !== "string" || !payload.email) {
      throw new AuthError("invalid_token", "Your session is not valid. Sign in again.");
    }
    return { id: sub.data, email: payload.email.toLowerCase() };
  };
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$/;

function deny(res: Response, status: number, code: string, error: string) {
  if (status === 401) res.set("WWW-Authenticate", `Bearer error="${code === "missing_token" ? "invalid_request" : "invalid_token"}"`);
  res.status(status).json({ error, code } satisfies ApiError);
}

/**
 * Every route mounted after this requires a verified Supabase session whose email is on the allow-list.
 * The identity comes only from the token; request bodies and headers never name the actor.
 */
export function requireAuth({ verify, allowedEmails }: { verify: TokenVerifier | null; allowedEmails: readonly string[] }): RequestHandler {
  const allowed = new Set(allowedEmails.map((e) => e.toLowerCase()));
  return async (req, res, next) => {
    if (!verify) return deny(res, 503, "auth_unconfigured", "Sign-in is not configured on this server.");
    const match = BEARER.exec(req.get("authorization") ?? "");
    if (!match) return deny(res, 401, "missing_token", "Sign in to continue.");
    let user: AuthUser;
    try {
      user = await verify(match[1]!);
    } catch (err) {
      if (!(err instanceof AuthError)) return next(err);
      return err.code === "auth_unavailable" ? deny(res, 503, err.code, err.message) : deny(res, 401, err.code, err.message);
    }
    if (!allowed.has(user.email)) return deny(res, 403, "forbidden", "This account does not have access to this Recall workspace.");
    res.locals.user = user;
    next();
  };
}

/** The verified user for this request. Fails closed if a route is somehow reached without requireAuth. */
export function currentUser(res: Response): AuthUser {
  const user = res.locals.user as AuthUser | undefined;
  if (!user) throw new HttpError(401, "Sign in to continue.");
  return user;
}

/** The audit-history label for the signed-in user. */
export const actorOf = (res: Response) => currentUser(res).email;
