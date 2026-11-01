import pg from "pg";
import { env } from "./env.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}
