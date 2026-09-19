import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const env = { ...process.env, ENCRYPTION_KEY: "ab".repeat(32) };
const encrypt = spawn(
  process.execPath,
  ["--max-old-space-size=128", "server/backup-stream.mjs", "encrypt"],
  { env, stdio: ["pipe", "pipe", "inherit"] },
);
const decrypt = spawn(
  process.execPath,
  ["--max-old-space-size=128", "server/backup-stream.mjs", "decrypt"],
  { env, stdio: ["pipe", "pipe", "inherit"] },
);
const exited = (p) =>
  new Promise((resolve, reject) => {
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Child failed: " + code)),
    );
  });
const e = exited(encrypt),
  d = exited(decrypt),
  expected = createHash("sha256"),
  actual = createHash("sha256");
let bytes = 0;
decrypt.stdout.on("data", (chunk) => {
  bytes += chunk.length;
  actual.update(chunk);
});
const write = pipeline(
  Readable.from(
    (async function* () {
      for (let i = 0; i < 520; i++) {
        const block = Buffer.alloc(1024 * 1024, i % 256);
        expected.update(block);
        yield block;
      }
    })(),
  ),
  encrypt.stdin,
);
await Promise.all([write, pipeline(encrypt.stdout, decrypt.stdin), e, d]);
assert.equal(bytes, 520 * 1024 * 1024);
assert.equal(actual.digest("hex"), expected.digest("hex"));
console.log(
  JSON.stringify({
    encryptedRestoreMiB: 520,
    verified: true,
    heapLimitMiB: 128,
  }),
);
