// Safety gate for the opt-in real E2E suite. Pure and deterministic: the Playwright config and every spec call it.
//
// The suite writes real data (meetings, decisions, tasks) and calls the real Groq API, so it refuses to run unless it
// is pointed at a disposable Supabase project through a dedicated env file, and unless that project is provably not
// the workspace in the repo-root .env. Nothing here ever prints a secret.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
export const LINEAR_CONFIRMATION = "create-real-linear-issues";

export type RealE2E =
  | { mode: "disabled"; reason: string }
  | {
      mode: "ready";
      envFile: string;
      apiPort: number;
      webPort: number;
      webUrl: string;
      account: { email: string; password: string };
      /** Variables handed to the spawned API server. Linear keys are blanked unless the Linear gate is fully open. */
      serverEnv: Record<string, string>;
      linear: { enabled: false; reason: string } | { enabled: true; apiKey: string; teamId: string };
      /** Non-secret description of the database under test, for log output. */
      databaseFingerprint: string;
    };

const readEnvFile = (path: string): Record<string, string> => (existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string>) : {});

/** user@host:port/db, without the password. Supabase's pooler user is postgres.<project-ref>, so this identifies the project. */
export function databaseFingerprint(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.username)}@${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return null;
  }
}

const supabaseHost = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

let cached: RealE2E | undefined;

/**
 * - RECALL_REAL_E2E unset: the suite is disabled and every spec skips with the reason below.
 * - RECALL_REAL_E2E=1 with any unmet requirement: throws, listing every problem. Never silently skips an explicit request.
 */
export function loadRealE2E(): RealE2E {
  cached ??= resolveRealE2E();
  return cached;
}

/** Exported for the gate's own tests; `env` and `root` are injectable. */
export function resolveRealE2E(env: NodeJS.ProcessEnv = process.env, root_: string = ROOT): RealE2E {
  if (env.RECALL_REAL_E2E !== "1") {
    return { mode: "disabled", reason: "Real E2E is opt-in. Set RECALL_REAL_E2E=1 (see docs/REAL_E2E.md for the required test project and account)." };
  }

  const problems: string[] = [];
  const envFile = resolve(root_, env.RECALL_E2E_ENV_FILE || ".env.e2e");
  const rootFile = resolve(root_, ".env");
  if (envFile === rootFile) problems.push("RECALL_E2E_ENV_FILE must not be the repo-root .env (that is the real workspace).");
  if (!existsSync(envFile)) problems.push(`Env file not found: ${envFile}. Copy .env.e2e.example to .env.e2e and fill in the isolated test project.`);

  const file = readEnvFile(envFile);
  const rootVars = readEnvFile(rootFile);

  for (const key of ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY", "GROQ_API_KEY", "AUTH_ALLOWED_EMAILS"]) {
    if (!file[key]?.trim()) problems.push(`${key} is missing from the env file.`);
  }

  const email = (env.RECALL_E2E_EMAIL || file.RECALL_E2E_EMAIL || "").trim();
  const password = env.RECALL_E2E_PASSWORD || file.RECALL_E2E_PASSWORD || "";
  if (!email) problems.push("RECALL_E2E_EMAIL (the dedicated test account) is not set.");
  if (!password) problems.push("RECALL_E2E_PASSWORD (the dedicated test account) is not set.");
  const allowed = (file.AUTH_ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (email && !allowed.includes(email.toLowerCase())) problems.push("The test account email must be listed in AUTH_ALLOWED_EMAILS in the env file.");

  // Isolation: the test project must differ from the real workspace and be confirmed explicitly by name.
  const fingerprint = databaseFingerprint(file.DATABASE_URL);
  if (file.DATABASE_URL && !fingerprint) problems.push("DATABASE_URL in the env file is not a valid connection string.");
  const realFingerprint = databaseFingerprint(rootVars.DATABASE_URL);
  if (fingerprint && realFingerprint && fingerprint === realFingerprint) {
    problems.push("DATABASE_URL in the env file is the same database as the repo-root .env. Refusing to write test data there.");
  }
  const realHost = supabaseHost(rootVars.SUPABASE_URL);
  if (realHost && supabaseHost(file.SUPABASE_URL) === realHost) {
    problems.push("SUPABASE_URL in the env file is the same Supabase project as the repo-root .env. Use a separate test project.");
  }
  if (fingerprint && env.RECALL_E2E_CONFIRM_DB !== fingerprint) {
    problems.push(`Writes need explicit confirmation of the isolated test database. Set RECALL_E2E_CONFIRM_DB=${fingerprint}`);
  }

  // Linear: a second, independent gate. Without it the server gets no Linear credentials at all.
  let linear: Extract<RealE2E, { mode: "ready" }>["linear"] = {
    enabled: false,
    reason: "Linear sync is opt-in: set RECALL_E2E_LINEAR=1 and RECALL_E2E_LINEAR_CONFIRM, plus a test team in the env file.",
  };
  if (env.RECALL_E2E_LINEAR === "1") {
    const lp: string[] = [];
    if (env.RECALL_E2E_LINEAR_CONFIRM !== LINEAR_CONFIRMATION) lp.push(`RECALL_E2E_LINEAR_CONFIRM=${LINEAR_CONFIRMATION} is required: this creates real Linear issues.`);
    if (!file.LINEAR_API_KEY?.trim() || !file.LINEAR_TEAM_ID?.trim()) lp.push("LINEAR_API_KEY and LINEAR_TEAM_ID must be set in the env file.");
    if (rootVars.LINEAR_TEAM_ID && file.LINEAR_TEAM_ID?.trim() === rootVars.LINEAR_TEAM_ID.trim()) lp.push("LINEAR_TEAM_ID is the same team as the repo-root .env. Use a dedicated test team.");
    if (lp.length) problems.push(...lp);
    else linear = { enabled: true, apiKey: file.LINEAR_API_KEY!.trim(), teamId: file.LINEAR_TEAM_ID!.trim() };
  }

  if (problems.length) {
    throw new Error(`Real E2E is enabled but not safe to run:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  const apiPort = Number(env.RECALL_E2E_API_PORT || 8788);
  const webPort = Number(env.RECALL_E2E_WEB_PORT || 5174);
  const webUrl = `http://localhost:${webPort}`;
  return {
    mode: "ready",
    envFile,
    apiPort,
    webPort,
    webUrl,
    account: { email, password },
    databaseFingerprint: fingerprint!,
    linear,
    serverEnv: {
      RECALL_ENV_FILE: envFile,
      NODE_ENV: "development",
      PORT: String(apiPort),
      APP_URL: webUrl,
      CORS_ORIGINS: "",
      // Set (even when empty) so the env file cannot supply them; an empty value reads as "not configured".
      LINEAR_API_KEY: linear.enabled ? linear.apiKey : "",
      LINEAR_TEAM_ID: linear.enabled ? linear.teamId : "",
    },
  };
}
