import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Secrets live in the repo-root .env and are only ever read by the server.
// RECALL_ENV_FILE (used by the opt-in real E2E suite) replaces it entirely, so a test run can never fall back to the
// real workspace's database or Linear keys. A missing override file is an error, never a silent fallback.
const overrideEnvFile = process.env.RECALL_ENV_FILE?.trim();
const rootEnvFile = overrideEnvFile || fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);
else if (overrideEnvFile) {
  console.error(`RECALL_ENV_FILE points to a file that does not exist: ${overrideEnvFile}`);
  process.exit(1);
}

const optional = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const emailList = z
  .string()
  .default("")
  .transform((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
  .pipe(z.array(z.email()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_URL: z.url().default("http://localhost:5173"),

  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  GROQ_API_KEY: z.string().trim().min(1, "must be a Groq API key (gsk_...)"),
  GROQ_MODEL: z.string().trim().min(1).default("openai/gpt-oss-20b"),
  GROQ_BASE_URL: z.url().default("https://api.groq.com/openai/v1"),

  LINEAR_API_KEY: optional,
  LINEAR_TEAM_ID: optional,

  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,

  // Supabase Auth. The URL and anon (publishable) key are public by design and are handed to the browser through
  // /api/auth/config; access tokens are verified here against the project's JWKS (or the legacy JWT secret).
  SUPABASE_URL: optional.pipe(z.url({ protocol: /^https?$/ }).transform((v) => v.replace(/\/+$/, "")).optional()),
  SUPABASE_ANON_KEY: optional,
  SUPABASE_JWT_SECRET: optional,
  /** Only these signed-in emails may use the API. Empty means nobody: access is deny-by-default. */
  AUTH_ALLOWED_EMAILS: emailList,
  /** Extra browser origins allowed to call the API cross-origin. APP_URL is always allowed. */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.url())),
  /** Number of reverse proxies in front of the server, so rate limits see the real client IP. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid environment configuration:\n${issues}\nSee .env.example.`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

export const integrations = {
  linear: Boolean(env.LINEAR_API_KEY && env.LINEAR_TEAM_ID),
  email: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
  auth: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
};
