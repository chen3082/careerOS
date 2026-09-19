import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";
import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import { z } from "zod";
const filename = process.argv[2];
if (!filename)
  throw new Error(
    "Provide the latest deletion ledger from outside the backup being restored",
  );
const lines = (await readFile(filename, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean);
let count = 0;
for (const line of lines) {
  const record = z
    .object({ ownerId: z.string().uuid(), requestedAt: z.string().datetime() })
    .parse(JSON.parse(decrypt(line, config.ENCRYPTION_KEY, "deletion-ledger")));
  await pool.query("DELETE FROM group_comments WHERE author_id=$1", [
    record.ownerId,
  ]);
  await pool.query("DELETE FROM users WHERE id=$1", [record.ownerId]);
  await rm(path.join(config.dataDir, "assets", record.ownerId), {
    recursive: true,
    force: true,
  });
  count++;
}
console.log(JSON.stringify({ replayed: count }));
await pool.end();
