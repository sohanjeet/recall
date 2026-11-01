import type { Request, RequestHandler, Response } from "express";
import type { ApiError } from "@recall/shared";

export interface RateLimit {
  windowMs: number;
  max: number;
}

/**
 * Fixed-window, in-memory rate limiter. Per process: limits reset on restart and are not shared between instances,
 * which is enough for a single-server demo but not for a horizontally scaled deployment.
 */
export function rateLimit({ windowMs, max }: RateLimit, key: (req: Request, res: Response) => string, error: string): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const k = key(req, res);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error, code: "rate_limited" } satisfies ApiError);
      return;
    }
    next();
  };
}

/**
 * CORS for the API. Only listed origins get CORS headers, and preflights from any other origin are refused, so other
 * sites cannot send the Authorization or JSON Content-Type headers at all. Auth is a bearer token, never a cookie.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));
  return (req, res, next) => {
    const origin = req.get("origin");
    const ok = origin !== undefined && allowed.has(origin);
    res.vary("Origin");
    if (ok) res.set("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS") {
      if (!ok) {
        res.status(403).end();
        return;
      }
      res.set({
        "Access-Control-Allow-Methods": "GET, POST, PATCH",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.status(204).end();
      return;
    }
    next();
  };
}

export function securityHeaders({ production }: { production: boolean }): RequestHandler {
  return (_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    if (production) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  };
}

/** CSP for the built web app: same-origin scripts, Google Fonts, and the Supabase Auth endpoint. */
export function contentSecurityPolicy(supabaseUrl: string | undefined): string {
  const connect = ["'self'", supabaseUrl ? new URL(supabaseUrl).origin : ""].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** One line per request: method, path without the query string, status, duration. Never headers, bodies or tokens. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const path = req.originalUrl.split("?")[0];
    if (path === "/healthz" || path === "/api/health") return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
};
