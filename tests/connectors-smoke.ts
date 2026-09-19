import { searchJobs } from "../server/connectors.js";
import { pool, one } from "../server/db.js";
import { config } from "../server/config.js";
import assert from "node:assert/strict";
if (!new URL(config.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Requires isolated test database");
const user = await one(pool, "SELECT id FROM users LIMIT 1");
for (const query of [
  { provider: "lever", board: "Gogolook", market: "TW", query: "" },
  { provider: "greenhouse", board: "figma", market: "US", query: "engineer" },
]) {
  const result = await searchJobs(user.id, query);
  assert.ok(result.saved > 0);
  console.log(JSON.stringify({ ...result, market: query.market }));
}
await pool.end();
