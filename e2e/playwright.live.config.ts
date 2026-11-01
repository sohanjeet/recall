import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Read-only checks against the real API (:8787) and the real web app (:5173), both of which must already be running
// (`pnpm dev`). No credentials are used and nothing is written.
export default defineConfig({ ...base, testMatch: "live.spec.ts", webServer: undefined });
