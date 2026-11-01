import { defineConfig } from "@playwright/test";
import { loadRealE2E } from "./real/config";

// REAL suite (opt-in): drives a dedicated test account through the real web app, real API, real Supabase Auth, real
// Postgres and real Groq, against an isolated test project only. Kept apart from the mocked suite (playwright.config.ts)
// and the read-only live checks (playwright.live.config.ts). Without RECALL_REAL_E2E=1 every test skips with a reason.
// It starts its OWN API and web servers on separate ports from an env file that replaces the repo-root .env.
const real = loadRealE2E();

export default defineConfig({
  testDir: "./real",
  testMatch: "*.real.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Real model calls are slow and variable.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "../node_modules/.cache/playwright-real-results",
  use: {
    baseURL: real.mode === "ready" ? real.webUrl : "http://localhost:5174",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "light",
    serviceWorkers: "block",
    // No traces, videos or screenshots: they could capture the session or credentials.
    trace: "off",
    video: "off",
    screenshot: "off",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  webServer:
    real.mode === "ready"
      ? [
          {
            command: "pnpm --filter @recall/server exec tsx src/index.ts",
            url: `http://localhost:${real.apiPort}/api/health`,
            reuseExistingServer: false,
            timeout: 60_000,
            env: real.serverEnv,
          },
          {
            command: `pnpm --filter @recall/web exec vite --port ${real.webPort} --strictPort`,
            url: real.webUrl,
            reuseExistingServer: false,
            timeout: 60_000,
            env: { RECALL_API_PROXY_TARGET: `http://localhost:${real.apiPort}`, VITE_API_BASE_URL: "" },
          },
        ]
      : undefined,
});
