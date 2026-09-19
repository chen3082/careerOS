import pg from "pg";
import { config } from "./config.js";
import { randomUUID } from "node:crypto";
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  statement_timeout: 15000,
  idle_in_transaction_session_timeout: 10000,
});
export type DB = Pick<pg.PoolClient, "query">;
export async function tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function one<T = any>(
  db: DB,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0];
}
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(code);
  }
}
export async function owned(
  db: DB,
  table: string,
  owner: string,
  id: string,
  lock = false,
) {
  if (
    ![
      "sources",
      "facts",
      "jobs",
      "resumes",
      "collections",
      "applications",
      "dossiers",
      "policies",
      "interviews",
      "interview_notes",
      "offers",
      "tasks",
      "proposals",
      "assets",
      "growth_tasks",
      "career_plans",
      "answers",
    ].includes(table)
  )
    throw new Error("Unsupported table");
  const row = await one(
    db,
    `SELECT * FROM ${table} WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`,
    [id, owner],
  );
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}
export const id = () => randomUUID();
export async function audit(
  db: DB,
  owner: string,
  action: string,
  resource?: string,
) {
  await db.query(
    "INSERT INTO audit_events(owner_id,action,resource_id) VALUES($1,$2,$3)",
    [owner, action, resource ?? null],
  );
}
