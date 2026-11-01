// Tests for the real-E2E safety gate (config.ts). Pure: uses temp directories, never reads the repo's .env files.
// Run with `pnpm test` (node --test).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LINEAR_CONFIRMATION, databaseFingerprint, resolveRealE2E } from "./config.ts";

const TEST_DB = "postgresql://postgres.testref:secret@aws-0-eu.pooler.supabase.com:5432/postgres";
const REAL_DB = "postgresql://postgres.realref:secret@aws-0-eu.pooler.supabase.com:5432/postgres";
const FP = databaseFingerprint(TEST_DB)!;

const envText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
const goodFile = {
  DATABASE_URL: TEST_DB,
  SUPABASE_URL: "https://testref.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  GROQ_API_KEY: "gsk_x",
  AUTH_ALLOWED_EMAILS: "e2e@example.com",
  RECALL_E2E_EMAIL: "e2e@example.com",
  RECALL_E2E_PASSWORD: "pw",
};

function setup(file: Record<string, string> | null, root: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recall-e2e-gate-"));
  if (file) writeFileSync(join(dir, ".env.e2e"), envText(file));
  writeFileSync(join(dir, ".env"), envText(root));
  return dir;
}
const on = { RECALL_REAL_E2E: "1", RECALL_E2E_CONFIRM_DB: FP };

describe("real E2E safety gate", () => {
  test("is disabled, with a reason, unless explicitly enabled", () => {
    const r = resolveRealE2E({}, setup(goodFile));
    assert.equal(r.mode, "disabled");
    assert.match((r as { reason: string }).reason, /RECALL_REAL_E2E=1/);
  });

  test("an explicit request with a missing env file or credentials fails loudly instead of skipping", () => {
    assert.throws(() => resolveRealE2E(on, setup(null)), /Env file not found/);
    const { RECALL_E2E_PASSWORD: _p, ...noPassword } = goodFile;
    assert.throws(() => resolveRealE2E(on, setup(noPassword)), /RECALL_E2E_PASSWORD/);
  });

  test("never targets the database or Supabase project of the real workspace", () => {
    assert.throws(() => resolveRealE2E(on, setup(goodFile, { DATABASE_URL: TEST_DB })), /same database/);
    assert.throws(() => resolveRealE2E(on, setup(goodFile, { SUPABASE_URL: "https://testref.supabase.co" })), /same Supabase project/);
  });

  test("writes require the database to be confirmed by name", () => {
    assert.throws(() => resolveRealE2E({ RECALL_REAL_E2E: "1" }, setup(goodFile)), /RECALL_E2E_CONFIRM_DB=/);
    assert.throws(() => resolveRealE2E({ RECALL_REAL_E2E: "1", RECALL_E2E_CONFIRM_DB: "yes" }, setup(goodFile)), /RECALL_E2E_CONFIRM_DB=/);
  });

  test("the test account must be allow-listed", () => {
    assert.throws(() => resolveRealE2E(on, setup({ ...goodFile, AUTH_ALLOWED_EMAILS: "someone@else.com" })), /AUTH_ALLOWED_EMAILS/);
  });

  test("a valid isolated setup is ready and Linear is blanked for the server", () => {
    const r = resolveRealE2E(on, setup({ ...goodFile, LINEAR_API_KEY: "lin_key", LINEAR_TEAM_ID: "team" }, { DATABASE_URL: REAL_DB }));
    assert.equal(r.mode, "ready");
    if (r.mode !== "ready") return;
    assert.equal(r.linear.enabled, false);
    assert.equal(r.serverEnv.LINEAR_API_KEY, "");
    assert.equal(r.serverEnv.LINEAR_TEAM_ID, "");
    assert.notEqual(r.apiPort, 8787);
    assert.notEqual(r.webPort, 5173);
  });

  test("Linear needs its own confirmation and a test team that differs from the real one", () => {
    const withLinear = { ...goodFile, LINEAR_API_KEY: "lin_key", LINEAR_TEAM_ID: "test-team" };
    assert.throws(() => resolveRealE2E({ ...on, RECALL_E2E_LINEAR: "1" }, setup(withLinear)), new RegExp(LINEAR_CONFIRMATION));
    const confirmed = { ...on, RECALL_E2E_LINEAR: "1", RECALL_E2E_LINEAR_CONFIRM: LINEAR_CONFIRMATION };
    assert.throws(() => resolveRealE2E(confirmed, setup({ ...goodFile })), /LINEAR_API_KEY and LINEAR_TEAM_ID/);
    assert.throws(() => resolveRealE2E(confirmed, setup(withLinear, { LINEAR_TEAM_ID: "test-team" })), /same team/);
    const ok = resolveRealE2E(confirmed, setup(withLinear, { LINEAR_TEAM_ID: "real-team" }));
    assert.equal(ok.mode === "ready" && ok.linear.enabled, true);
    assert.equal(ok.mode === "ready" && ok.serverEnv.LINEAR_TEAM_ID, "test-team");
  });

  test("error messages never contain secrets", () => {
    try {
      resolveRealE2E(on, setup(goodFile, { DATABASE_URL: TEST_DB }));
      assert.fail("expected a throw");
    } catch (e) {
      const msg = String((e as Error).message);
      assert.ok(!msg.includes("secret") && !msg.includes("pw") && !msg.includes("gsk_x"));
    }
  });
});
