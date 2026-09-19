import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const env = { ...process.env, ENCRYPTION_KEY: "ef".repeat(32) };
test("encrypted backup authenticates before output; tampering yields no plaintext", () => {
  const original = Buffer.from("private database dump\n".repeat(4000));
  const encrypted = spawnSync(
    process.execPath,
    ["server/backup-stream.mjs", "encrypt"],
    { env, input: original, maxBuffer: 200000 },
  );
  assert.equal(encrypted.status, 0, encrypted.stderr.toString());
  const restored = spawnSync(
    process.execPath,
    ["server/backup-stream.mjs", "decrypt"],
    { env, input: encrypted.stdout, maxBuffer: 200000 },
  );
  assert.equal(restored.status, 0, restored.stderr.toString());
  assert.deepEqual(restored.stdout, original);
  const changed = Buffer.from(encrypted.stdout);
  changed[40] ^= 1;
  const rejected = spawnSync(
    process.execPath,
    ["server/backup-stream.mjs", "decrypt"],
    { env, input: changed, maxBuffer: 200000 },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout.length, 0);
});
test("backup encryption refuses an absent key", () => {
  const missing = spawnSync(
    process.execPath,
    ["server/backup-stream.mjs", "encrypt"],
    { env: { ...process.env, ENCRYPTION_KEY: "" }, input: "secret" },
  );
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout.length, 0);
});
