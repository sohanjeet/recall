export interface ProductionConfig {
  APP_URL: string;
  CORS_ORIGINS: readonly string[];
  AUTH_ALLOWED_EMAILS: readonly string[];
  SUPABASE_URL?: string | undefined;
  SUPABASE_ANON_KEY?: string | undefined;
  DATABASE_SSL: boolean;
  TRUST_PROXY: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Misconfigurations that must stop a production boot (`errors`) or deserve a loud log line (`warnings`).
 * Fail closed: a production server may not allow plain-HTTP or localhost browser origins, or run without sign-in.
 */
export function productionConfigProblems(c: ProductionConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const origins: [string, string][] = [["APP_URL", c.APP_URL], ...c.CORS_ORIGINS.map((o): [string, string] => ["CORS_ORIGINS", o])];
  for (const [name, value] of origins) {
    const url = new URL(value);
    if (url.protocol !== "https:" || LOCAL_HOSTS.has(url.hostname)) {
      errors.push(`${name} must be the public https:// origin of the web app, got ${url.origin}.`);
    }
  }
  if (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY) errors.push("SUPABASE_URL and SUPABASE_ANON_KEY are required: sign-in is not configured.");
  else if (new URL(c.SUPABASE_URL).protocol !== "https:") errors.push("SUPABASE_URL must be https://.");
  if (c.AUTH_ALLOWED_EMAILS.length === 0) errors.push("AUTH_ALLOWED_EMAILS is empty, so nobody could use the API.");
  if (!c.DATABASE_SSL) warnings.push("DATABASE_SSL=false: database traffic is not encrypted.");
  if (c.TRUST_PROXY === 0) warnings.push("TRUST_PROXY=0 behind a proxy (Render): rate limits see the proxy's IP, not the client's. Set TRUST_PROXY=1.");
  return { errors, warnings };
}
