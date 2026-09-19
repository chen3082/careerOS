import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { config } from "./config.js";
import {
  currentUser,
  requireUser,
  sameOrigin,
  publicUser,
  throttle,
} from "./auth.js";
import { pool, one, tx, id, audit, DomainError, type DB } from "./db.js";
import { hash, token, passwordVerify } from "./crypto.js";

export type GoogleIdentity = { subject: string; email: string; name: string };
export type GoogleVerifier = (
  credential: string,
  nonceHash: string,
) => Promise<GoogleIdentity>;
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 5000 },
);
export function googleVerifier(
  clientId: string,
  keys: JWTVerifyGetKey = googleKeys,
): GoogleVerifier {
  return async (credential, nonceHash) => {
    try {
      const { payload } = await jwtVerify(credential, keys, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "iat", "exp", "nonce"],
        maxTokenAge: "10 minutes",
        clockTolerance: 5,
      });
      if (
        payload.aud !== clientId ||
        (payload.azp !== undefined && payload.azp !== clientId) ||
        payload.email_verified !== true ||
        typeof payload.nonce !== "string" ||
        hash(payload.nonce) !== nonceHash
      )
        throw new Error("Invalid identity claims");
      const identity = z
        .object({
          sub: z.string().min(1).max(255),
          email: z.string().email().max(254),
          name: z.string().optional(),
        })
        .parse(payload);
      return {
        subject: identity.sub,
        email: identity.email.trim().toLowerCase(),
        name: (identity.name?.trim() || identity.email.split("@")[0]).slice(
          0,
          80,
        ),
      };
    } catch {
      throw new DomainError("GOOGLE_IDENTITY_INVALID", 401);
    }
  };
}

// Call while holding the owner row lock. A passwordless account must prove a fresh Google sign-in.
export async function verifyAccountProof(
  db: DB,
  req: FastifyRequest,
  user: any,
  password?: string,
) {
  if (user.password_hash) {
    if (!password || !(await passwordVerify(password, user.password_hash)))
      throw new DomainError("INVALID_CREDENTIALS", 401);
  } else {
    const verified = await one(
      db,
      "SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() AND google_verified_at>now()-interval '5 minutes'",
      [hash(req.cookies.careeros_session ?? ""), user.id],
    );
    if (!verified) throw new DomainError("GOOGLE_REAUTH_REQUIRED", 403);
  }
}

export async function googleLoginRoutes(
  app: FastifyInstance,
  testVerifier?: GoogleVerifier,
) {
  if (testVerifier && config.NODE_ENV !== "test")
    throw new Error("Test verifier is forbidden outside tests");
  const p = config.basePath + "/api/auth/google";
  const cookie = {
    httpOnly: true,
    secure: config.production,
    sameSite: "strict" as const,
    path: config.basePath + "/api/auth",
    maxAge: 300,
  };
  const configured = () => {
    if (!config.GOOGLE_LOGIN_CLIENT_ID)
      throw new DomainError("GOOGLE_LOGIN_NOT_CONFIGURED", 503);
  };
  app.post(p + "/challenge", async (req, reply) => {
    sameOrigin(req);
    configured();
    await throttle("google-challenge:" + req.ip);
    const { intent } = z
      .object({ intent: z.enum(["login", "link", "reauth"]) })
      .strict()
      .parse(req.body);
    const user = await currentUser(req);
    if (intent === "login" && user)
      throw new DomainError("ALREADY_SIGNED_IN", 409);
    if (intent !== "login" && !user)
      throw new DomainError("LOGIN_REQUIRED", 401);
    const challenge = token(),
      nonce = token();
    await pool.query(
      "DELETE FROM google_login_challenges WHERE expires_at<now()",
    );
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      if (user) {
        await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
          user.id,
        ]);
        if (
          !(await one(
            db,
            "SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()",
            [hash(req.cookies.careeros_session ?? ""), user.id],
          ))
        )
          throw new DomainError("LOGIN_REQUIRED", 401);
      }
      await db.query("DELETE FROM google_login_challenges WHERE hash=$1", [
        hash(req.cookies.careeros_google ?? ""),
      ]);
      await db.query(
        "INSERT INTO google_login_challenges(hash,nonce_hash,intent,owner_id,session_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",
        [
          hash(challenge),
          hash(nonce),
          intent,
          user?.id ?? null,
          user ? hash(req.cookies.careeros_session!) : null,
        ],
      );
    });
    reply.setCookie("careeros_google", challenge, cookie);
    return { nonce };
  });
  app.get(p + "/status", async (req) => {
    const user = await requireUser(req);
    const identity = await one(
      pool,
      "SELECT email FROM google_identities WHERE owner_id=$1",
      [user.id],
    );
    const session = await one(
      pool,
      "SELECT google_verified_at>now()-interval '5 minutes' AS recent FROM sessions WHERE token_hash=$1",
      [hash(req.cookies.careeros_session!)],
    );
    return {
      enabled: Boolean(config.GOOGLE_LOGIN_CLIENT_ID),
      clientId: config.GOOGLE_LOGIN_CLIENT_ID || null,
      linked: Boolean(identity),
      email: identity?.email ?? null,
      hasPassword: Boolean(user.password_hash),
      recentlyVerified: session?.recent === true,
    };
  });
  app.post(p + "/complete", async (req, reply) => {
    sameOrigin(req);
    configured();
    await throttle("google-complete:" + req.ip);
    const b = z
      .object({
        credential: z.string().min(1).max(16000),
        invite: z.string().max(200).optional(),
        currentPassword: z.string().max(128).optional(),
      })
      .strict()
      .parse(req.body);
    const challengeHash = hash(req.cookies.careeros_google ?? "");
    const challenge = await one(
      pool,
      "SELECT * FROM google_login_challenges WHERE hash=$1 AND expires_at>now() AND completed_session_hash IS NULL",
      [challengeHash],
    );
    reply.clearCookie("careeros_google", {
      path: config.basePath + "/api/auth",
    });
    if (!challenge) throw new DomainError("GOOGLE_CHALLENGE_EXPIRED", 401);
    const current = await currentUser(req);
    if (
      (challenge.intent === "login" && current) ||
      (challenge.intent !== "login" &&
        (!current ||
          current.id !== challenge.owner_id ||
          hash(req.cookies.careeros_session ?? "") !== challenge.session_hash))
    )
      throw new DomainError("GOOGLE_ACCOUNT_MISMATCH", 403);
    let identity: GoogleIdentity;
    try {
      identity = await (
        testVerifier ?? googleVerifier(config.GOOGLE_LOGIN_CLIENT_ID!)
      )(b.credential, challenge.nonce_hash);
    } catch (error) {
      await pool.query(
        "DELETE FROM google_login_challenges WHERE hash=$1 AND completed_session_hash IS NULL",
        [challengeHash],
      );
      throw error;
    }
    const sessionToken = token();
    const user = await tx(async (db) => {
      // Shared with password registration, so invites/bootstrap and email identities cannot race.
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      let user: any;
      const linked = await one(
        db,
        "SELECT owner_id FROM google_identities WHERE subject=$1",
        [identity.subject],
      );
      if (challenge.intent === "login") {
        if (linked) {
          user = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
            linked.owner_id,
          ]);
          if (
            !user ||
            !(await one(
              db,
              "SELECT 1 FROM google_identities WHERE owner_id=$1 AND subject=$2",
              [user.id, identity.subject],
            ))
          )
            throw new DomainError("GOOGLE_ACCOUNT_LINK_REQUIRED", 409);
        } else {
          if (
            await one(db, "SELECT 1 FROM users WHERE email=$1", [
              identity.email,
            ])
          )
            throw new DomainError("GOOGLE_ACCOUNT_LINK_REQUIRED", 409);
          const first = !(await one(db, "SELECT 1 FROM users LIMIT 1"));
          if (first) {
            if (
              !config.BOOTSTRAP_TOKEN ||
              !b.invite ||
              hash(b.invite) !== hash(config.BOOTSTRAP_TOKEN)
            )
              throw new DomainError("INVITE_REQUIRED", 403);
          } else if (config.REGISTRATION_OPEN !== "true") {
            if (
              !(await one(
                db,
                "UPDATE signup_invites SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING token_hash",
                [hash(b.invite ?? "")],
              ))
            )
              throw new DomainError("INVITE_REQUIRED", 403);
          }
          user = await one(
            db,
            "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,NULL,$4) RETURNING *",
            [id(), identity.email, identity.name, first ? "owner" : "member"],
          );
          await db.query(
            "INSERT INTO google_identities(owner_id,subject,email) VALUES($1,$2,$3)",
            [user.id, identity.subject, identity.email],
          );
          await audit(db, user.id, "account.google_registered");
        }
      } else {
        user = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
          challenge.owner_id,
        ]);
        if (
          !user ||
          !(await one(
            db,
            "SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()",
            [challenge.session_hash, user.id],
          ))
        )
          throw new DomainError("LOGIN_REQUIRED", 401);
        if (challenge.intent === "link") {
          if (
            !user.password_hash ||
            !b.currentPassword ||
            !(await passwordVerify(b.currentPassword, user.password_hash))
          )
            throw new DomainError("INVALID_CREDENTIALS", 401);
          const own = await one(
            db,
            "SELECT subject FROM google_identities WHERE owner_id=$1",
            [user.id],
          );
          if (
            (linked && linked.owner_id !== user.id) ||
            (own && own.subject !== identity.subject)
          )
            throw new DomainError("GOOGLE_ALREADY_LINKED", 409);
          if (!own)
            await db.query(
              "INSERT INTO google_identities(owner_id,subject,email) VALUES($1,$2,$3)",
              [user.id, identity.subject, identity.email],
            );
          await audit(db, user.id, "account.google_linked");
        } else if (linked?.owner_id !== user.id)
          throw new DomainError("GOOGLE_ACCOUNT_MISMATCH", 403);
      }
      if (
        !(await one(
          db,
          "UPDATE google_login_challenges SET completed_session_hash=$2,expires_at=now()+interval '5 minutes' WHERE hash=$1 AND expires_at>now() AND completed_session_hash IS NULL RETURNING hash",
          [challengeHash, hash(sessionToken)],
        ))
      )
        throw new DomainError("GOOGLE_CHALLENGE_EXPIRED", 401);
      await db.query(
        "UPDATE google_identities SET email=$1 WHERE owner_id=$2 AND subject=$3",
        [identity.email, user.id, identity.subject],
      );
      if (req.cookies.careeros_session)
        await db.query(
          "DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2",
          [hash(req.cookies.careeros_session), user.id],
        );
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at,google_verified_at) VALUES($1,$2,now()+interval '7 days',now())",
        [hash(sessionToken), user.id],
      );
      await audit(db, user.id, "account.google_authenticated");
      return user;
    }).catch(async (error) => {
      await pool.query(
        "DELETE FROM google_login_challenges WHERE hash=$1 AND completed_session_hash IS NULL",
        [challengeHash],
      );
      throw error;
    });
    reply.setCookie("careeros_session", sessionToken, {
      httpOnly: true,
      secure: config.production,
      sameSite: "lax",
      path: config.basePath || "/",
      maxAge: 604800,
    });
    return { user: publicUser(user) };
  });
  app.post(p + "/unlink", async (req, reply) => {
    sameOrigin(req);
    const user = await requireUser(req);
    await throttle("google-unlink:" + user.id);
    const b = z
      .object({ currentPassword: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      const row = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
        user.id,
      ]);
      if (!row?.password_hash)
        throw new DomainError("PASSWORD_REQUIRED_BEFORE_UNLINK", 409);
      await verifyAccountProof(db, req, row, b.currentPassword);
      await db.query("DELETE FROM google_identities WHERE owner_id=$1", [
        user.id,
      ]);
      await db.query("DELETE FROM google_login_challenges WHERE owner_id=$1", [
        user.id,
      ]);
      await db.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
      await db.query(
        "UPDATE oauth_tokens SET revoked_at=now() WHERE user_id=$1",
        [user.id],
      );
      await db.query("DELETE FROM oauth_codes WHERE user_id=$1", [user.id]);
      await audit(db, user.id, "account.google_unlinked");
    });
    reply.clearCookie("careeros_session", { path: config.basePath || "/" });
    return { ok: true, loginRequired: true };
  });
}
