import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { sameOrigin, requireUser } from "./auth.js";
import { pool, tx, one, DomainError, audit } from "./db.js";
import { passwordHash, encrypt } from "./crypto.js";
import { verifyAccountProof } from "./google-login.js";
export async function accountRoutes(app: FastifyInstance) {
  app.get(config.basePath + "/api/account/export", async (req, reply) => {
    const u = await requireUser(req);
    const tables = [
      "google_identities",
      "sources",
      "facts",
      "career_revisions",
      "jobs",
      "collections",
      "collection_jobs",
      "resumes",
      "resume_exports",
      "applications",
      "application_events",
      "dossiers",
      "submission_runs",
      "account_setup_runs",
      "interviews",
      "preparations",
      "interview_notes",
      "offers",
      "answers",
      "career_plans",
      "growth_tasks",
      "assets",
    ];
    const data: Record<string, any> = {
      format: "careeros-personal-export-v1",
      exportedAt: new Date().toISOString(),
      profile: { name: u.name, email: u.email, settings: u.settings },
    };
    for (const table of tables) {
      data[table] = (
        await pool.query(`SELECT * FROM ${table} WHERE owner_id=$1`, [u.id])
      ).rows;
    }
    data.account_setup_runs = data.account_setup_runs.map(
      ({ claim_id, ...run }: any) => run,
    );
    data.assets = data.assets.map(({ storage_key, ...a }: any) => ({
      ...a,
      downloadUrl: config.PUBLIC_URL + "/api/assets/" + a.id,
    }));
    return reply
      .type("application/json")
      .header(
        "Content-Disposition",
        'attachment; filename="careeros-export.json"',
      )
      .send(data);
  });
  app.post(config.basePath + "/api/account/password", async (req) => {
    sameOrigin(req);
    const u = await requireUser(req);
    const b = z
      .object({
        currentPassword: z.string().max(128).optional(),
        newPassword: z.string().min(12).max(128),
      })
      .parse(req.body);
    const encoded = await passwordHash(b.newPassword);
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      const row = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
        u.id,
      ]);
      if (!row) throw new DomainError("LOGIN_REQUIRED", 401);
      await verifyAccountProof(db, req, row, b.currentPassword);
      await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
        encoded,
        u.id,
      ]);
      await db.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
      await db.query("DELETE FROM google_login_challenges WHERE owner_id=$1", [
        u.id,
      ]);
      await db.query(
        "UPDATE oauth_tokens SET revoked_at=now() WHERE user_id=$1",
        [u.id],
      );
      await db.query("DELETE FROM oauth_codes WHERE user_id=$1", [u.id]);
      await audit(db, u.id, "account.password_changed");
    });
    return { ok: true, loginRequired: true };
  });
  app.post(config.basePath + "/api/account/delete", async (req, reply) => {
    sameOrigin(req);
    const u = await requireUser(req);
    const b = z
      .object({
        password: z.string().max(128).optional(),
        confirmation: z.literal("DELETE"),
      })
      .parse(req.body);
    if (u.role === "owner")
      throw new DomainError("TRANSFER_PLATFORM_OWNER_FIRST", 409);
    await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(813590)");
      const row = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
        u.id,
      ]);
      if (!row) throw new DomainError("LOGIN_REQUIRED", 401);
      await verifyAccountProof(db, req, row, b.password);
      const owns = await one(
        db,
        "SELECT 1 FROM memberships WHERE user_id=$1 AND role='owner'",
        [u.id],
      );
      if (owns) throw new DomainError("TRANSFER_GROUP_OWNER_FIRST", 409);
      await mkdir(config.dataDir, { recursive: true });
      const ledger = await open(
        path.join(config.dataDir, "deletions.log"),
        "a",
        0o600,
      );
      try {
        await ledger.write(
          encrypt(
            JSON.stringify({
              ownerId: u.id,
              requestedAt: new Date().toISOString(),
            }),
            config.ENCRYPTION_KEY,
            "deletion-ledger",
          ) + "\n",
        );
        await ledger.sync();
      } finally {
        await ledger.close();
      }
      await db.query("DELETE FROM group_comments WHERE author_id=$1", [u.id]);
      await db.query("DELETE FROM users WHERE id=$1", [u.id]);
    });
    await rm(path.join(config.dataDir, "assets", u.id), {
      recursive: true,
      force: true,
    });
    reply.clearCookie("careeros_session", { path: config.basePath || "/" });
    return {
      ok: true,
      retention:
        "Local encrypted backups expire after 7 days. Restore must replay the current deletion ledger.",
    };
  });
}
