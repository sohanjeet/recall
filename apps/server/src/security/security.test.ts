import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { createApp, type AppDeps } from "../app.js";
import { listAudit } from "../approvals/common.js";
import type { LinearClient } from "../approvals/linear.js";
import { pingDatabase, pool } from "../db.js";
import { env } from "../env.js";
import { AuthError, createSupabaseVerifier } from "./auth.js";
import { authHeaders, OTHER_USER, signTestToken, TEST_SUPABASE_URL, TEST_USER, testAuthDeps } from "./testing.js";

const ID = randomUUID();

function serve(deps: AppDeps = {}) {
  const server = createApp({ extract: async () => assert.fail("extractor must not run"), linear: null, ...testAuthDeps(), ...deps }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

// ---------- token verification ----------

describe("Supabase token verifier", () => {
  const verify = testAuthDeps().verifyToken;
  const code = (c: AuthError["code"]) => (e: unknown) => e instanceof AuthError && e.code === c;

  test("accepts a valid token and takes identity only from its claims", async () => {
    const user = await verify(await signTestToken({ email: "Reviewer@Example.TEST" }));
    assert.deepEqual(user, { id: TEST_USER.id, email: "reviewer@example.test" });
  });

  test("expired tokens are reported as an expired session", async () => {
    await assert.rejects(verify(await signTestToken({ expiresIn: -60 })), code("session_expired"));
  });

  test("rejects bad signatures, wrong issuer/audience/role, anonymous users and missing claims", async () => {
    const bad = [
      await signTestToken({ secret: "another-secret-that-is-also-32-characters-long" }),
      await signTestToken({ iss: "https://evil.supabase.co/auth/v1" }),
      await signTestToken({ aud: "anon" }),
      await signTestToken({ role: "anon" }),
      await signTestToken({ role: "service_role" }),
      await signTestToken({ extra: { is_anonymous: true } }),
      await signTestToken({ email: "" }),
      await signTestToken({ sub: "not-a-uuid" }),
      "not.a.jwt",
      "",
    ];
    for (const token of bad) await assert.rejects(verify(token), code("invalid_token"), token);
  });

  test('refuses alg "none" and HS256 tokens when no shared secret is configured', async () => {
    const unsigned = new UnsecuredJWT({ email: TEST_USER.email, role: "authenticated" })
      .setSubject(TEST_USER.id)
      .setIssuer(`${TEST_SUPABASE_URL}/auth/v1`)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .encode();
    await assert.rejects(verify(unsigned), code("invalid_token"));

    const jwksOnly = createSupabaseVerifier({ supabaseUrl: TEST_SUPABASE_URL, jwks: async () => assert.fail("key must not be resolved") });
    await assert.rejects(jwksOnly(await signTestToken()), code("invalid_token"));
  });

  test("verifies asymmetric (ES256) tokens against the project JWKS and rejects other keys", async () => {
    const project = await generateKeyPair("ES256");
    const attacker = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(project.publicKey)), kid: "k1", alg: "ES256" };
    const verifyEs = createSupabaseVerifier({ supabaseUrl: TEST_SUPABASE_URL, jwks: createLocalJWKSet({ keys: [jwk] }) });
    const sign = (key: Parameters<SignJWT["sign"]>[0]) =>
      new SignJWT({ email: TEST_USER.email, role: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setSubject(TEST_USER.id)
        .setIssuer(`${TEST_SUPABASE_URL}/auth/v1`)
        .setAudience("authenticated")
        .setExpirationTime("1h")
        .sign(key);
    assert.equal((await verifyEs(await sign(project.privateKey))).id, TEST_USER.id);
    await assert.rejects(verifyEs(await sign(attacker.privateKey)), code("invalid_token"));
  });

  test("a JWKS outage is reported as unavailable, not as a bad token", async () => {
    const down = createSupabaseVerifier({
      supabaseUrl: TEST_SUPABASE_URL,
      jwks: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const token = await new SignJWT({ email: TEST_USER.email, role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject(TEST_USER.id)
      .setIssuer(`${TEST_SUPABASE_URL}/auth/v1`)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign((await generateKeyPair("ES256")).privateKey);
    await assert.rejects(down(token), code("auth_unavailable"));
  });
});

// ---------- HTTP boundary (no database needed: every request below is refused before any query) ----------

const PROTECTED: [string, string][] = [
  ["GET", "/api/me"],
  ["GET", "/api/meetings"],
  ["POST", "/api/meetings"],
  ["GET", `/api/meetings/${ID}`],
  ["POST", `/api/meetings/${ID}/analyze`],
  ["GET", `/api/meetings/${ID}/conflicts`],
  ["POST", `/api/meetings/${ID}/conflicts/check`],
  ["GET", "/api/approvals"],
  ["GET", `/api/audit?entityType=task&entityId=${ID}`],
  ["GET", `/api/decisions/${ID}`],
  ["PATCH", `/api/decisions/${ID}`],
  ["POST", `/api/decisions/${ID}/approve`],
  ["POST", `/api/decisions/${ID}/reject`],
  ["POST", `/api/conflicts/${ID}/resolve`],
  ["PATCH", `/api/tasks/${ID}`],
  ["POST", `/api/tasks/${ID}/approve`],
  ["POST", `/api/tasks/${ID}/reject`],
  ["POST", `/api/tasks/${ID}/sync`],
  ["POST", `/api/tasks/${ID}/complete`],
  ["GET", "/api/reminders"],
  ["GET", "/api/reminders/preview"],
  ["POST", "/api/reminders/generate"],
  ["POST", `/api/reminders/${ID}/read`],
  ["GET", "/api/digests"],
  ["GET", "/api/digests/preview"],
  ["POST", "/api/digests/generate"],
  ["GET", "/api/does-not-exist"],
];

describe("HTTP authentication boundary", () => {
  let app: ReturnType<typeof serve>;
  before(() => {
    app = serve();
  });
  after(() => app.server.close());

  const call = (method: string, path: string, headers: Record<string, string> = {}, body = "{}") =>
    fetch(app.base + path, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : body });

  test("every protected route answers 401 without a token, with a WWW-Authenticate challenge", async () => {
    for (const [method, path] of PROTECTED) {
      const res = await call(method, path);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
      assert.equal(((await res.json()) as { code: string }).code, "missing_token");
    }
  });

  test("malformed, invalid, expired and non-allow-listed tokens are refused on every protected route", async () => {
    const cases: [Record<string, string>, number, string][] = [
      [{ authorization: "Basic dXNlcjpwYXNz" }, 401, "missing_token"],
      [{ authorization: "Bearer " }, 401, "missing_token"],
      [{ authorization: `Bearer ${await signTestToken({ secret: "forged-secret-forged-secret-forged-secret" })}` }, 401, "invalid_token"],
      [{ authorization: `Bearer ${await signTestToken({ expiresIn: -60 })}` }, 401, "session_expired"],
      [{ authorization: `Bearer ${await signTestToken({ email: "outsider@example.test" })}` }, 403, "forbidden"],
    ];
    for (const [headers, status, code] of cases) {
      for (const [method, path] of PROTECTED) {
        const res = await call(method, path, headers);
        assert.equal(res.status, status, `${code}: ${method} ${path}`);
        assert.equal(((await res.json()) as { code: string }).code, code);
      }
    }
  });

  test("client-supplied identity headers grant nothing", async () => {
    const res = await call("GET", "/api/me", { "x-user-id": TEST_USER.id, "x-user-email": TEST_USER.email, "x-actor": "admin" });
    assert.equal(res.status, 401);
  });

  test("request bodies are not parsed before authentication", async () => {
    assert.equal((await call("POST", "/api/meetings", {}, "{not json")).status, 401);
    const authed = await call("POST", "/api/meetings", await authHeaders(), "{not json");
    assert.equal(authed.status, 400);
    const huge = await call("POST", "/api/meetings", await authHeaders(), JSON.stringify({ transcript: "x".repeat(600_000) }));
    assert.equal(huge.status, 413);
  });

  test("a valid session reaches the API and /api/me returns the verified identity", async () => {
    const res = await call("GET", "/api/me", await authHeaders());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), TEST_USER);
    // Validation still runs after auth.
    assert.equal((await call("POST", "/api/meetings/not-a-uuid/analyze", await authHeaders())).status, 400);
  });

  test("health and auth config are public and expose no secrets", async () => {
    const health = await fetch(`${app.base}/api/health`);
    assert.ok([200, 503].includes(health.status));
    const config = await fetch(`${app.base}/api/auth/config`);
    assert.equal(config.status, 200);
    const text = (await health.text()) + (await config.text());
    for (const secret of [env.DATABASE_URL, env.GROQ_API_KEY, env.LINEAR_API_KEY, env.SUPABASE_JWT_SECRET, env.RESEND_API_KEY]) {
      if (secret) assert.ok(!text.includes(secret));
    }
  });

  test("API responses carry security headers and are not cached", async () => {
    const res = await call("GET", "/api/me", await authHeaders());
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-powered-by"), null);
  });
});

describe("liveness probe", () => {
  test("/healthz is public and needs no database", async () => {
    const { server, base } = serve();
    try {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
    } finally {
      server.close();
    }
  });
});

describe("HTTP auth configuration", () => {
  test("with sign-in unconfigured, protected routes fail closed with 503", async () => {
    const { server, base } = serve({ verifyToken: null });
    try {
      const res = await fetch(`${base}/api/meetings`, { headers: await authHeaders() });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "auth_unconfigured");
      assert.deepEqual(await (await fetch(`${base}/api/auth/config`)).json(), { enabled: false });
    } finally {
      server.close();
    }
  });

  test("an empty allow-list admits nobody", async () => {
    const { server, base } = serve({ allowedEmails: [] });
    try {
      assert.equal((await fetch(`${base}/api/me`, { headers: await authHeaders() })).status, 403);
    } finally {
      server.close();
    }
  });
});

describe("CORS", () => {
  let app: ReturnType<typeof serve>;
  before(() => {
    app = serve();
  });
  after(() => app.server.close());
  const preflight = (origin: string) =>
    fetch(`${app.base}/api/meetings`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
    });

  test("the configured frontend origin may preflight authenticated requests", async () => {
    const origin = new URL(env.APP_URL).origin;
    const res = await preflight(origin);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  test("other origins are refused and never get CORS headers", async () => {
    const res = await preflight("https://evil.example");
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const simple = await fetch(`${app.base}/api/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(simple.headers.get("access-control-allow-origin"), null);
  });
});

describe("rate limiting", () => {
  test("AI endpoints are limited per user, independently of other users", async () => {
    const { server, base } = serve({ rateLimits: { ai: { windowMs: 60_000, max: 2 } } });
    try {
      const analyze = async (headers: Record<string, string>) => (await fetch(`${base}/api/meetings/not-a-uuid/analyze`, { method: "POST", headers })).status;
      const mine = await authHeaders();
      assert.equal(await analyze(mine), 400);
      assert.equal(await analyze(mine), 400);
      const limited = await fetch(`${base}/api/meetings/not-a-uuid/conflicts/check`, { method: "POST", headers: mine });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(await analyze(await authHeaders({ sub: OTHER_USER.id, email: OTHER_USER.email })), 400);
    } finally {
      server.close();
    }
  });

  test("Linear sync and generation endpoints share a per-user limit", async () => {
    const { server, base } = serve({ rateLimits: { sensitive: { windowMs: 60_000, max: 1 } } });
    try {
      const headers = await authHeaders();
      assert.equal((await fetch(`${base}/api/tasks/not-a-uuid/sync`, { method: "POST", headers, body: "{}" })).status, 400);
      assert.equal((await fetch(`${base}/api/reminders/generate`, { method: "POST", headers, body: "{}" })).status, 429);
    } finally {
      server.close();
    }
  });

  test("the whole API is limited per client IP, before authentication", async () => {
    const { server, base } = serve({ rateLimits: { api: { windowMs: 60_000, max: 2 } } });
    try {
      assert.equal((await fetch(`${base}/api/meetings`)).status, 401);
      assert.equal((await fetch(`${base}/api/meetings`)).status, 401);
      assert.equal((await fetch(`${base}/api/meetings`)).status, 429);
    } finally {
      server.close();
    }
  });
});

// ---------- authorization and audit attribution against the database ----------

const dbUp = await pingDatabase();

describe("authorized workflows and audit attribution (PostgreSQL)", { skip: !dbUp && "database unreachable" }, () => {
  const meetingIds: string[] = [];
  const linearCreates: string[] = [];
  const linear: LinearClient = {
    async findIssueByMarker() {
      return null;
    },
    async createIssue(input) {
      linearCreates.push(input.title);
      return { id: randomUUID(), identifier: `ENG-${linearCreates.length}`, url: `https://linear.app/t/issue/ENG-${linearCreates.length}` };
    },
  };
  let app: ReturnType<typeof serve>;
  before(() => {
    app = serve({ linear });
  });
  after(async () => {
    app.server.close();
    if (meetingIds.length) await pool.query(`delete from meetings where id = any($1::uuid[])`, [meetingIds]);
    await pool.end();
  });

  async function meeting() {
    const { rows } = await pool.query<{ id: string }>(
      `insert into meetings (title, occurred_at, source, raw_transcript, status) values ('security test', now(), 'paste', 'x', 'extracted') returning id`,
    );
    meetingIds.push(rows[0]!.id);
    return rows[0]!.id;
  }
  async function decision(meetingId: string, status: "proposed" | "active", summary: string) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into decisions (meeting_id, summary, status, approved_at) values ($1, $2, $3, case when $3 = 'active' then now() end) returning id`,
      [meetingId, summary, status],
    );
    return rows[0]!.id;
  }
  async function task(meetingId: string) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into tasks (meeting_id, title, description, status) values ($1, $2, 'desc', 'proposed') returning id`,
      [meetingId, `security task ${randomUUID()}`],
    );
    return rows[0]!.id;
  }
  const call = async (method: string, path: string, headers: Record<string, string>, body: unknown = {}) => {
    const res = await fetch(`${app.base}/api${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const taskRow = async (id: string) => (await pool.query(`select * from tasks where id = $1`, [id])).rows[0];

  test("unauthorized mutations change nothing, write no audit events and never reach Linear", async () => {
    const t = await task(await meeting());
    const before = linearCreates.length;
    const refused: Record<string, string>[] = [
      { "content-type": "application/json" },
      await authHeaders({ expiresIn: -30 }),
      await authHeaders({ secret: "forged-secret-forged-secret-forged-secret" }),
      await authHeaders({ email: "outsider@example.test" }),
    ];
    for (const headers of refused) {
      for (const path of [`/tasks/${t}/approve`, `/tasks/${t}/sync`, `/tasks/${t}/reject`, `/tasks/${t}/complete`]) {
        assert.ok([401, 403].includes((await call("POST", path, headers, { actor: TEST_USER.email })).status));
      }
      assert.ok([401, 403].includes((await call("PATCH", `/tasks/${t}`, headers, { version: 1, title: "pwned" })).status));
    }
    const row = await taskRow(t);
    assert.equal(row.status, "proposed");
    assert.equal(row.title.startsWith("security task"), true);
    assert.equal(row.approved_at, null);
    assert.deepEqual(await listAudit(pool, "task", t), []);
    assert.equal(linearCreates.length, before);
  });

  test("the audit actor is the verified user, never the actor named in the request body", async () => {
    const m = await meeting();
    const t = await task(m);
    const approved = await call("POST", `/tasks/${t}/approve`, await authHeaders(), { actor: "mallory", version: 1 });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "synced");
    assert.equal((await taskRow(t)).approved_by, TEST_USER.email);
    const events = await listAudit(pool, "task", t);
    assert.ok(events.length >= 2, "approved + synced");
    assert.ok(events.every((e) => e.actor === TEST_USER.email));

    // A second user's edit is attributed to them.
    const d = await decision(m, "proposed", `Adopt ${randomUUID()}`);
    const teammate = await authHeaders({ sub: OTHER_USER.id, email: OTHER_USER.email });
    const edited = await call("PATCH", `/decisions/${d}`, teammate, { actor: TEST_USER.email, version: 1, summary: "Adopt Postgres" });
    assert.equal(edited.status, 200);
    const audit = await call("GET", `/audit?entityType=decision&entityId=${d}`, teammate);
    assert.deepEqual(audit.body.map((e: { actor: string }) => e.actor), [OTHER_USER.email]);
  });

  test("permitted workflow: approve, conflict resolution and completion work end to end; repeats stay idempotent", async () => {
    const headers = await authHeaders();
    const m = await meeting();
    const earlier = await decision(await meeting(), "active", `Ship on Friday ${randomUUID()}`);
    const fresh = await decision(m, "proposed", `Ship on Monday ${randomUUID()}`);
    const { rows } = await pool.query<{ id: string }>(
      `insert into decision_conflicts (meeting_id, decision_id, conflicting_decision_id, explanation, certainty) values ($1, $2, $3, 'test', 'clear') returning id`,
      [m, fresh, earlier],
    );
    const c = rows[0]!.id;

    assert.equal((await call("POST", `/decisions/${fresh}/approve`, headers)).status, 409, "the approval gate still blocks on an open conflict");
    const resolved = await call("POST", `/conflicts/${c}/resolve`, headers, { action: "accept_new" });
    assert.equal(resolved.status, 200);
    assert.equal((await pool.query(`select resolved_by from decision_conflicts where id = $1`, [c])).rows[0].resolved_by, TEST_USER.email);

    const t = await task(m);
    const creates = linearCreates.length;
    assert.equal((await call("POST", `/tasks/${t}/approve`, headers)).status, 200);
    assert.equal((await call("POST", `/tasks/${t}/approve`, headers)).body.status, "synced");
    assert.equal((await call("POST", `/tasks/${t}/sync`, headers)).status, 200);
    assert.equal(linearCreates.length, creates + 1, "approval and sync stay idempotent: one Linear issue");

    const done = await call("POST", `/tasks/${t}/complete`, headers, { actor: "someone-else" });
    assert.equal(done.body.status, "done");
    const completed = (await listAudit(pool, "task", t)).find((e) => e.action === "completed");
    assert.equal(completed?.actor, TEST_USER.email);
  });
});
