import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { productionConfigProblems, type ProductionConfig } from "./production.js";

const good: ProductionConfig = {
  APP_URL: "https://recall.vercel.app",
  CORS_ORIGINS: [],
  AUTH_ALLOWED_EMAILS: ["a@example.test"],
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  DATABASE_SSL: true,
  TRUST_PROXY: 1,
};

describe("production config check", () => {
  test("a complete https configuration passes", () => {
    assert.deepEqual(productionConfigProblems(good), { errors: [], warnings: [] });
  });

  test("localhost and plain-http browser origins are rejected", () => {
    assert.equal(productionConfigProblems({ ...good, APP_URL: "http://localhost:5173" }).errors.length, 1);
    assert.equal(productionConfigProblems({ ...good, APP_URL: "http://recall.vercel.app" }).errors.length, 1);
    assert.equal(productionConfigProblems({ ...good, CORS_ORIGINS: ["https://ok.example", "http://127.0.0.1:3000"] }).errors.length, 1);
  });

  test("missing sign-in settings or an empty allow-list fail closed", () => {
    assert.equal(productionConfigProblems({ ...good, SUPABASE_ANON_KEY: undefined }).errors.length, 1);
    assert.equal(productionConfigProblems({ ...good, AUTH_ALLOWED_EMAILS: [] }).errors.length, 1);
  });

  test("insecure database or missing proxy trust only warn", () => {
    const r = productionConfigProblems({ ...good, DATABASE_SSL: false, TRUST_PROXY: 0 });
    assert.equal(r.errors.length, 0);
    assert.equal(r.warnings.length, 2);
  });
});
