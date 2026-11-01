// Applies supabase/migrations/*.sql in filename order, each in its own transaction.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";

const migrationsDir = fileURLToPath(new URL("../../../../supabase/migrations", import.meta.url));

async function migrate() {
  await pool.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    );
    alter table schema_migrations enable row level security;
  `);
  const { rows } = await pool.query<{ name: string }>("select name from schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  console.log(`migrations up to date (${files.length} total)`);
}

migrate()
  .catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
