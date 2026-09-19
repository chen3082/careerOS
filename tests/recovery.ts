import { pool, one } from "../server/db.js";
import { config } from "../server/config.js";
import { readAsset } from "../server/assets.js";
import { encrypt, hash } from "../server/crypto.js";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
if (!new URL(config.DATABASE_URL).pathname.endsWith("_restore_test"))
  throw new Error("Requires isolated *_restore_test database");
const users = (await pool.query("SELECT id FROM users")).rows;
assert.ok(users.length > 0, "Restored fixture must contain a user");
const assets = (await pool.query("SELECT id,owner_id,sha256,size FROM assets"))
  .rows;
assert.ok(
  assets.length >= 1,
  "Restored fixture must contain a real exported document",
);
for (const a of assets) {
  const { data } = await readAsset(a.owner_id, a.id);
  assert.equal(hash(data), a.sha256);
  assert.equal(data.length, Number(a.size));
}
const owner = users[0].id;
await writeFile(
  config.dataDir + "/latest-test-deletions.log",
  encrypt(
    JSON.stringify({ ownerId: owner, requestedAt: new Date().toISOString() }),
    config.ENCRYPTION_KEY,
    "deletion-ledger",
  ) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    restoredUsers: users.length,
    verifiedAssetHashes: assets.length,
    deletionReplayFixtureReady: true,
  }),
);
await pool.end();
