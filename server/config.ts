import path from "node:path";
import { z } from "zod";
try {
  process.loadEnvFile(".env");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const env = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().default(3100),
    PUBLIC_URL: z.string().url().default("http://localhost:3100/careeros"),
    DATABASE_URL: z.string().min(1),
    DATA_DIR: z.string().default("./data"),
    ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
    BOOTSTRAP_TOKEN: z.string().min(24).optional(),
    REGISTRATION_OPEN: z.string().default("false"),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
    RECOVERY_EPOCH: z.coerce.number().int().positive().default(1),
    SUBMISSIONS_ENABLED: z.string().default("false"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
  })
  .parse(process.env);
export const config = {
  ...env,
  basePath: new URL(env.PUBLIC_URL).pathname.replace(/\/$/, ""),
  origin: new URL(env.PUBLIC_URL).origin,
  dataDir: path.resolve(env.DATA_DIR),
  production: env.NODE_ENV === "production",
};
if (config.production && new URL(config.PUBLIC_URL).protocol !== "https:")
  throw new Error("Production PUBLIC_URL must use HTTPS");
if (config.SUBMISSIONS_ENABLED !== "false")
  throw new Error(
    "Automatic submission is unavailable until external journal and recovery gates are implemented and verified",
  );
