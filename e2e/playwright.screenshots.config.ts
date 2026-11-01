import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Regenerates docs/screenshots/{portfolio,qa}. login.png needs the real API on :8787 (`pnpm dev`).
export default defineConfig({ ...base, testMatch: "screenshots.spec.ts" });
