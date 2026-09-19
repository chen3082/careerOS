import { readdir, readFile } from "node:fs/promises";
import { pool, tx } from "./db.js";
await pool.query(
  "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
);
for (const name of (await readdir("migrations"))
  .filter((n) => /^\d{3}_[a-z0-9_]+\.sql$/.test(n))
  .sort()) {
  await tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(531912)");
    if (
      (
        await db.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
          name,
        ])
      ).rowCount
    )
      return;
    await db.query(await readFile("migrations/" + name, "utf8"));
    await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [name]);
    console.log("Applied", name);
  });
}
await pool.end();
