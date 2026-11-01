import { createApp } from "./app.js";
import { pool } from "./db.js";
import { env, integrations } from "./env.js";
import { productionConfigProblems } from "./security/production.js";

if (env.NODE_ENV === "production") {
  const { errors, warnings } = productionConfigProblems(env);
  for (const w of warnings) console.warn(`[config] ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[config] ${e}`);
    process.exit(1);
  }
} else {
  // Without Supabase Auth every protected route answers 503: a safe failure in development.
  if (!integrations.auth) console.warn("Sign-in is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY. Protected API routes will answer 503.");
  if (env.AUTH_ALLOWED_EMAILS.length === 0) {
    console.warn("AUTH_ALLOWED_EMAILS is empty, so no signed-in user can use the API. Add the emails that may use Recall.");
  }
}

// Render sends SIGTERM on deploys and restarts, then force-kills after 30s: finish in-flight requests, close the pool.
const SHUTDOWN_GRACE_MS = 25_000;
const server = createApp().listen(env.PORT, "0.0.0.0", () => {
  console.log(`Recall API listening on port ${env.PORT} (${env.NODE_ENV})`);
});
// Keep-alive above the load balancer's idle timeout avoids sporadic 502s on reused connections.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received: draining connections`);
  setTimeout(() => {
    console.error("Graceful shutdown timed out; exiting");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
  server.close(() => {
    pool.end().then(
      () => process.exit(exitCode),
      () => process.exit(1),
    );
  });
  server.closeIdleConnections();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.stack ?? err.message);
  shutdown("uncaughtException", 1);
});
