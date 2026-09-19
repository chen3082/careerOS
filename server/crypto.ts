import {
  createHash,
  randomBytes,
  scrypt as rawScrypt,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(rawScrypt);
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export async function passwordHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(value, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function passwordVerify(value: string, encoded: string) {
  const [, salt, key] = encoded.split(":");
  if (!salt || !key) return false;
  const derived = (await scrypt(value, salt, 64)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  );
}
export function encrypt(value: string, keyHex: string, aad: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    nonce,
  );
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), bytes]
    .map((v) => v.toString("base64"))
    .join(".");
}
export function decrypt(value: string, keyHex: string, aad: string) {
  const [nonce, tag, bytes] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64"));
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    nonce,
  );
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
