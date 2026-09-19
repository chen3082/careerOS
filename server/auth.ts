import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { pool, one, tx, id, DomainError, audit, type DB } from "./db.js";
import { hash, token, passwordHash, passwordVerify } from "./crypto.js";
export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  revision: number;
  eligibility_epoch: number;
  settings: Record<string, any>;
  password_hash?: string | null;
};
declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}
export const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  revision: u.revision,
  settings: u.settings,
  hasPassword: Boolean(u.password_hash),
});
export async function currentUser(req: FastifyRequest) {
  const t = req.cookies.careeros_session;
  if (!t) return;
  return one<User>(
    pool,
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [hash(t)],
  );
}
export async function requireUser(req: FastifyRequest) {
  const u = await currentUser(req);
  if (!u) throw new DomainError("LOGIN_REQUIRED", 401);
  req.user = u;
  return u;
}
export function sameOrigin(req: FastifyRequest) {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !== config.origin
  )
    throw new DomainError("ORIGIN_NOT_ALLOWED", 403);
}
export async function throttle(key: string) {
  const row = await one(
    pool,
    "INSERT INTO auth_throttles(key,count,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_throttles.expires_at<now() THEN 1 ELSE auth_throttles.count+1 END,expires_at=CASE WHEN auth_throttles.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_throttles.expires_at END RETURNING count",
    [key],
  );
  if (row.count > 15) throw new DomainError("TOO_MANY_ATTEMPTS", 429);
}
// Keep a consumed challenge for five minutes so a concurrent logout can revoke
// the session issued by its in-flight Google request. Call under auth advisory lock.
export async function cancelGoogleChallenge(db: DB, req: FastifyRequest) {
  const challengeHash = hash(req.cookies.careeros_google ?? "");
  await db.query(
    "DELETE FROM sessions WHERE token_hash IN (SELECT completed_session_hash FROM google_login_challenges WHERE hash=$1)",
    [challengeHash],
  );
  await db.query("DELETE FROM google_login_challenges WHERE hash=$1", [
    challengeHash,
  ]);
}
export async function authRoutes(app: FastifyInstance) {
  const p = config.basePath + "/api";
  app.get(p + "/auth/status", async () => ({
    registrationOpen: config.REGISTRATION_OPEN === "true",
    bootstrapAvailable: !(await one(pool, "SELECT 1 FROM users LIMIT 1")),
    googleEnabled: Boolean(config.GOOGLE_LOGIN_CLIENT_ID),
    googleClientId: config.GOOGLE_LOGIN_CLIENT_ID || null,
  }));
  app.post(p + "/auth/register", async (req, reply) => {
    sameOrigin(req);
    await throttle("register:" + req.ip);
    const b = z
      .object({
        email: z
          .string()
          .email()
          .max(254)
          .transform((s) => s.toLowerCase().trim()),
        name: z.string().trim().min(1).max(80),
        password: z.string().min(12).max(128),
        invite: z.string().max(200).optional(),
      })
      .parse(req.body);
    const password = await passwordHash(b.password);
    const t = token();
    const user = await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      const first = !(await one(db, "SELECT 1 FROM users LIMIT 1"));
      if (first) {
        if (
          !config.BOOTSTRAP_TOKEN ||
          !b.invite ||
          hash(b.invite) !== hash(config.BOOTSTRAP_TOKEN)
        )
          throw new DomainError("INVITE_REQUIRED", 403);
      } else if (config.REGISTRATION_OPEN !== "true") {
        const invite = await one(
          db,
          "UPDATE signup_invites SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING token_hash",
          [hash(b.invite ?? "")],
        );
        if (!invite) throw new DomainError("INVITE_REQUIRED", 403);
      }
      if (await one(db, "SELECT 1 FROM users WHERE email=$1", [b.email]))
        throw new DomainError("REGISTRATION_UNAVAILABLE", 409);
      const created = await one<User>(
        db,
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [id(), b.email, b.name, password, first ? "owner" : "member"],
      );
      await cancelGoogleChallenge(db, req);
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
        [hash(t), created!.id],
      );
      return created;
    });
    reply.setCookie("careeros_session", t, {
      httpOnly: true,
      secure: config.production,
      sameSite: "lax",
      path: config.basePath || "/",
      maxAge: 604800,
    });
    return { user: publicUser(user!) };
  });
  app.post(p + "/auth/login", async (req, reply) => {
    sameOrigin(req);
    const b = z
      .object({
        email: z
          .string()
          .email()
          .transform((s) => s.toLowerCase().trim()),
        password: z.string().max(128),
      })
      .parse(req.body);
    await throttle("login-ip:" + req.ip);
    await throttle("login-email:" + hash(b.email));
    const t = token();
    const u = await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      const row = await one(
        db,
        "SELECT * FROM users WHERE email=$1 FOR UPDATE",
        [b.email],
      );
      const dummy =
        "scrypt:0123456789abcdef0123456789abcdef:" + "0".repeat(128);
      if (
        !(await passwordVerify(b.password, row?.password_hash ?? dummy)) ||
        !row
      )
        throw new DomainError("INVALID_CREDENTIALS", 401);
      await cancelGoogleChallenge(db, req);
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
        [hash(t), row.id],
      );
      return row;
    });
    reply.setCookie("careeros_session", t, {
      httpOnly: true,
      secure: config.production,
      sameSite: "lax",
      path: config.basePath || "/",
      maxAge: 604800,
    });
    return { user: publicUser(u) };
  });
  app.post(p + "/auth/logout", async (req, reply) => {
    sameOrigin(req);
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      await cancelGoogleChallenge(db, req);
      await db.query("DELETE FROM sessions WHERE token_hash=$1", [
        hash(req.cookies.careeros_session ?? ""),
      ]);
      await db.query(
        "DELETE FROM sessions WHERE token_hash IN (SELECT completed_session_hash FROM google_login_challenges WHERE session_hash=$1)",
        [hash(req.cookies.careeros_session ?? "")],
      );
      await db.query(
        "DELETE FROM google_login_challenges WHERE session_hash=$1",
        [hash(req.cookies.careeros_session ?? "")],
      );
    });
    reply.clearCookie("careeros_google", {
      path: config.basePath + "/api/auth",
    });
    reply.clearCookie("careeros_session", { path: config.basePath || "/" });
    return { ok: true };
  });
  app.post(p + "/auth/invites", async (req) => {
    sameOrigin(req);
    const u = await requireUser(req);
    if (u.role !== "owner") throw new DomainError("FORBIDDEN", 403);
    const t = token();
    await pool.query(
      "INSERT INTO signup_invites(token_hash,created_by,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [hash(t), u.id],
    );
    await audit(pool, u.id, "signup.invite");
    return { token: t };
  });
}
