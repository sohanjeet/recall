import { defineConfig } from "@playwright/test";

// Mocked suite: serves the web app with the Vite dev server and intercepts every /api and Supabase request.
// Related configs: playwright.live.config.ts (real API, read-only) and playwright.screenshots.config.ts.
export default defineConfig({
  testDir: ".",
  testMatch: "qa.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../node_modules/.cache/playwright-results",
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "light",
    serviceWorkers: "block",
    // Optional: point at an already-installed Chromium instead of running `npx playwright install chromium`.
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  webServer: { command: "pnpm --filter @recall/web dev", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
});
