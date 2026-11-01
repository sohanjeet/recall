import { Router } from "express";
import type { HealthResponse } from "@recall/shared";
import { pingDatabase } from "../db.js";
import { env, integrations } from "../env.js";

const startedAt = Date.now();

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const dbOk = await pingDatabase();
  const body: HealthResponse = {
    status: dbOk ? "ok" : "degraded",
    version: process.env.npm_package_version ?? "0.1.0",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    services: {
      database: dbOk ? "ok" : "down",
      // Key presence only; no outbound call on every health check.
      groq: env.GROQ_API_KEY ? "ok" : "unconfigured",
      taskTracker: integrations.linear ? "ok" : "unconfigured",
      email: integrations.email ? "ok" : "unconfigured",
    },
  };
  res.status(dbOk ? 200 : 503).json(body);
});
