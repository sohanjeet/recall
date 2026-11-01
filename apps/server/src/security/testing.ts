// Test-only helpers: a verifier for a fake Supabase project and a signer for its tokens. Never used by the app.
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createSupabaseVerifier } from "./auth.js";

export const TEST_SUPABASE_URL = "https://test-project.supabase.co";
const TEST_SECRET = "test-only-jwt-secret-with-at-least-32-characters";

export const TEST_USER = { id: randomUUID(), email: "reviewer@example.test" };
export const OTHER_USER = { id: randomUUID(), email: "teammate@example.test" };

export interface TokenOptions {
  sub?: string;
  email?: string;
  role?: string;
  aud?: string;
  iss?: string;
  /** Seconds from now; negative for an expired token. */
  expiresIn?: number;
  secret?: string;
  extra?: Record<string, unknown>;
}

export async function signTestToken(o: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: o.email ?? TEST_USER.email, role: o.role ?? "authenticated", ...o.extra })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(o.sub ?? TEST_USER.id)
    .setIssuer(o.iss ?? `${TEST_SUPABASE_URL}/auth/v1`)
    .setAudience(o.aud ?? "authenticated")
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (o.expiresIn ?? 3600))
    .sign(new TextEncoder().encode(o.secret ?? TEST_SECRET));
}

/** createApp deps for a signed-in test workspace whose allow-list holds TEST_USER and OTHER_USER. */
export function testAuthDeps() {
  return {
    verifyToken: createSupabaseVerifier({
      supabaseUrl: TEST_SUPABASE_URL,
      jwtSecret: TEST_SECRET,
      jwks: async () => {
        throw new Error("tests use HS256 tokens");
      },
    }),
    allowedEmails: [TEST_USER.email, OTHER_USER.email],
  };
}

/** JSON request headers carrying a valid token for TEST_USER (or the given options). */
export async function authHeaders(o?: TokenOptions): Promise<Record<string, string>> {
  return { "content-type": "application/json", authorization: `Bearer ${await signTestToken(o)}` };
}
