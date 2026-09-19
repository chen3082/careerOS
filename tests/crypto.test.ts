import test from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, canonical, hash } from "../server/crypto.js";
test("encrypted assets cannot be replayed across owners or modified", () => {
  const key = "ab".repeat(32);
  const encrypted = encrypt("private experience", key, "owner-a:asset");
  assert.equal(decrypt(encrypted, key, "owner-a:asset"), "private experience");
  assert.throws(() => decrypt(encrypted, key, "owner-b:asset"));
  assert.throws(() => decrypt(encrypted, "cd".repeat(32), "owner-a:asset"));
});
test("idempotency hashes are independent of object key order", () => {
  assert.equal(
    hash(canonical({ b: 2, a: { y: 3, x: 1 } })),
    hash(canonical({ a: { x: 1, y: 3 }, b: 2 })),
  );
  assert.notEqual(hash(canonical({ a: 1 })), hash(canonical({ a: 2 })));
});
