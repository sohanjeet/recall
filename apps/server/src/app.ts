import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import type { ApiError, AuthConfig } from "@recall/shared";
import { detectConflicts, extractMeeting } from "./ai/index.js";
import { createLinearClient, type LinearClient } from "./approvals/linear.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import type { ConflictClassifier } from "./meetings/conflicts.js";
import { HttpError } from "./meetings/errors.js";
import type { Extractor } from "./meetings/service.js";
import { healthRouter } from "./routes/health.js";
import { approvalsRouter } from "./routes/approvals.js";
import { meetingsRouter } from "./routes/meetings.js";
import { notificationsRouter } from "./routes/notifications.js";
import { createSupabaseVerifier, currentUser, requireAuth, type TokenVerifier } from "./security/auth.js";
import { contentSecurityPolicy, cors, rateLimit, requestLogger, securityHeaders, type RateLimit } from "./security/http.js";

const MINUTE = 60_000;

export interface RateLimits {
  /** Per client IP, across the whole API (before authentication). */
  api: RateLimit;
  /** Per user: endpoints that call the AI provider. */
  ai: RateLimit;
  /** Per user: endpoints that write to Linear or generate many rows. */
  sensitive: RateLimit;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  api: { windowMs: MINUTE, max: 300 },
  ai: { windowMs: 10 * MINUTE, max: 20 },
  sensitive: { windowMs: 10 * MINUTE, max: 60 },
};

export interface AppDeps {
  extract?: Extractor;
  classifyConflicts?: ConflictClassifier;
  linear?: LinearClient | null;
  /** null disables sign-in: every protected route answers 503. Defaults to the Supabase project from the environment. */
  verifyToken?: TokenVerifier | null;
  allowedEmails?: readonly string[];
  rateLimits?: Partial<RateLimits>;
}

export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);
  // Liveness for the platform health check: no database call, so a database blip never gets the process restarted.
  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });
  if (env.NODE_ENV === "production") app.use(requestLogger);
  app.use(securityHeaders({ production: env.NODE_ENV === "production" }));

  const limits = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  const verifyToken =
    deps.verifyToken !== undefined
      ? deps.verifyToken
      : env.SUPABASE_URL
        ? createSupabaseVerifier({ supabaseUrl: env.SUPABASE_URL, jwtSecret: env.SUPABASE_JWT_SECRET })
        : null;

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", cors([env.APP_URL, ...env.CORS_ORIGINS]));
  app.use("/api", rateLimit(limits.api, (req) => `ip:${req.ip}`, "Too many requests. Slow down and try again shortly."));

  // ---- public ----
  app.use("/api/health", healthRouter);
  app.get("/api/auth/config", (_req, res) => {
    const config: AuthConfig =
      verifyToken && env.SUPABASE_URL && env.SUPABASE_ANON_KEY
        ? { enabled: true, supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY }
        : { enabled: false };
    res.json(config);
  });

  // ---- everything below requires a verified, allow-listed session ----
  app.use("/api", requireAuth({ verify: verifyToken, allowedEmails: deps.allowedEmails ?? env.AUTH_ALLOWED_EMAILS }));
  // Bodies are parsed only for authenticated requests. The largest legitimate body is a 50k-character transcript.
  app.use("/api", express.json({ limit: "512kb" }));

  app.get("/api/me", (_req, res) => {
    res.json(currentUser(res));
  });

  const perUser = (limit: RateLimit, error: string) => rateLimit(limit, (_req, res) => `user:${currentUser(res).id}`, error);
  app.post(
    ["/api/meetings/:id/analyze", "/api/meetings/:id/conflicts/check"],
    perUser(limits.ai, "Too many AI analysis requests. Wait a few minutes and try again."),
  );
  app.post(
    ["/api/meetings", "/api/tasks/:id/approve", "/api/tasks/:id/sync", "/api/reminders/generate", "/api/digests/generate"],
    perUser(limits.sensitive, "Too many requests of this kind. Wait a few minutes and try again."),
  );

  app.use(
    "/api/meetings",
    meetingsRouter({
      pool,
      extract: deps.extract ?? extractMeeting,
      classifyConflicts: deps.classifyConflicts ?? detectConflicts,
    }),
  );

  // Linear credentials stay on the server; without them nothing is ever sent.
  const linear =
    deps.linear !== undefined
      ? deps.linear
      : env.LINEAR_API_KEY && env.LINEAR_TEAM_ID
        ? createLinearClient({ apiKey: env.LINEAR_API_KEY, teamId: env.LINEAR_TEAM_ID })
        : null;
  app.use("/api", approvalsRouter({ pool, linear }));

  app.use("/api", notificationsRouter({ pool }));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" } satisfies ApiError);
  });

  // In production the built web app is served from the same origin as the API.
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    const csp = contentSecurityPolicy(env.SUPABASE_URL);
    app.use((_req, res, next) => {
      res.set("Content-Security-Policy", csp);
      next();
    });
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile("index.html", { root: webDist }));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details } satisfies ApiError);
      return;
    }
    if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      res.status(err.status ?? 400).json({ error: "Invalid request body" } satisfies ApiError);
      return;
    }
    // Log the message and stack only: never request headers or bodies, which can carry tokens or transcripts.
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    res.status(500).json({ error: "Internal server error" } satisfies ApiError);
  };
  app.use(onError);

  return app;
}
