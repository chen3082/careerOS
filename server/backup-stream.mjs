import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";
import { pipeline } from "node:stream/promises";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY ?? ""))
  throw new Error("ENCRYPTION_KEY must be 32 bytes");
const key = Buffer.from(
  hkdfSync(
    "sha256",
    Buffer.from(process.env.ENCRYPTION_KEY ?? "", "hex"),
    "careeros",
    "backup-v1",
    32,
  ),
);
const magic = Buffer.from("CAREEROS1");
if (process.argv[2] === "encrypt") {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(magic);
  process.stdout.write(Buffer.concat([magic, nonce]));
  await pipeline(process.stdin, cipher, process.stdout, { end: false });
  process.stdout.end(cipher.getAuthTag());
} else if (process.argv[2] === "decrypt") {
  // Decrypt into a private scratch file; expose no plaintext until GCM authentication succeeds.
  const scratch = await mkdtemp(
    path.join(process.env.BACKUP_TMP_DIR ?? tmpdir(), "careeros-restore-"),
  );
  const file = path.join(scratch, "verified.bin");
  const output = await open(file, "wx", 0o600);
  let prefix = Buffer.alloc(0),
    tail = Buffer.alloc(0),
    decipher;
  try {
    for await (const chunk of process.stdin) {
      let bytes = chunk;
      if (!decipher) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < magic.length + 12) continue;
        if (!prefix.subarray(0, magic.length).equals(magic))
          throw new Error("Invalid backup header");
        decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          prefix.subarray(magic.length, magic.length + 12),
        );
        decipher.setAAD(magic);
        bytes = prefix.subarray(magic.length + 12);
        prefix = Buffer.alloc(0);
      }
      const buffered = Buffer.concat([tail, bytes]);
      if (buffered.length <= 16) {
        tail = buffered;
        continue;
      }
      const plain = decipher.update(buffered.subarray(0, -16));
      tail = Buffer.from(buffered.subarray(-16));
      await output.writeFile(plain);
    }
    if (!decipher || tail.length !== 16) throw new Error("Truncated backup");
    decipher.setAuthTag(tail);
    await output.writeFile(decipher.final());
    await output.sync();
    await output.close();
    await pipeline(createReadStream(file), process.stdout);
  } finally {
    await output.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
} else throw new Error("Usage: backup-stream.mjs encrypt|decrypt");
