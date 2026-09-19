import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { requireUser, sameOrigin } from "./auth.js";
import { pool, one, owned, id, DomainError, tx } from "./db.js";
import { hash, token } from "./crypto.js";
import { uuid } from "./schemas.js";
import { saveJob } from "./domain.js";
export async function member(owner: string, group: string, db = pool as any) {
  const m = await one(
    db,
    "SELECT * FROM memberships WHERE group_id=$1 AND user_id=$2",
    [group, owner],
  );
  if (!m) throw new DomainError("NOT_FOUND", 404);
  return m;
}
export async function groupRoutes(app: FastifyInstance) {
  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req) => {
        sameOrigin(req);
        await requireUser(req);
      });
      api.get("/groups", async (req) => ({
        items: (
          await pool.query(
            "SELECT g.*,m.role,m.share_status,(SELECT count(*)::int FROM memberships WHERE group_id=g.id) AS member_count FROM groups g JOIN memberships m ON m.group_id=g.id WHERE m.user_id=$1 ORDER BY g.created_at DESC",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/groups", async (req) => {
        const b = z
          .object({ name: z.string().trim().min(1).max(100) })
          .parse(req.body);
        return tx(async (db) => {
          const g = await one(
            db,
            "INSERT INTO groups(id,name,created_by) VALUES($1,$2,$3) RETURNING *",
            [id(), b.name, req.user!.id],
          );
          await db.query(
            "INSERT INTO memberships(group_id,user_id,role) VALUES($1,$2,'owner')",
            [g.id, req.user!.id],
          );
          return g;
        });
      });
      api.get("/groups/:id", async (req) => {
        return tx(async (db) => {
          const gid = z.object({ id: uuid }).parse(req.params).id;
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          const membership = await member(req.user!.id, gid, db);
          const group = await one(db, "SELECT * FROM groups WHERE id=$1", [
            gid,
          ]);
          const members = (
            await db.query(
              "SELECT m.user_id,u.name,m.role,m.share_status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1",
              [gid],
            )
          ).rows;
          const jobs = (
            await db.query(
              `SELECT gj.*,
 (SELECT a.status FROM jobs j JOIN applications a ON a.job_id=j.id AND a.owner_id=j.owner_id WHERE j.owner_id=$2 AND j.provider||':'||j.external_id=gj.job_key LIMIT 1) AS my_status,
 (SELECT jsonb_agg(jsonb_build_object('name',u.name,'status',a.status)) FROM memberships m JOIN users u ON u.id=m.user_id JOIN jobs j ON j.owner_id=m.user_id AND j.provider||':'||j.external_id=gj.job_key JOIN applications a ON a.job_id=j.id AND a.owner_id=m.user_id WHERE m.group_id=gj.group_id AND m.share_status) AS shared_statuses
 FROM group_jobs gj WHERE gj.group_id=$1 ORDER BY gj.created_at DESC`,
              [gid, req.user!.id],
            )
          ).rows;
          const notes = (
            await db.query(
              "SELECT s.id,s.owner_id,s.snapshot,u.name AS author FROM note_shares s JOIN memberships m ON m.group_id=s.group_id AND m.user_id=s.owner_id JOIN users u ON u.id=s.owner_id WHERE s.group_id=$1 ORDER BY s.created_at DESC",
              [gid],
            )
          ).rows;
          const comments = (
            await db.query(
              "SELECT c.id,c.body,c.created_at,u.name AS author FROM group_comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.group_id=$1 ORDER BY c.created_at DESC LIMIT 100",
              [gid],
            )
          ).rows;
          return { group, membership, members, jobs, notes, comments };
        });
      });
      api.post("/groups/:id/invites", async (req) => {
        return tx(async (db) => {
          const gid = z.object({ id: uuid }).parse(req.params).id;
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          const m = await member(req.user!.id, gid, db);
          if (!["owner", "admin"].includes(m.role))
            throw new DomainError("FORBIDDEN", 403);
          const t = token();
          await db.query(
            "INSERT INTO group_invites(token_hash,group_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
            [hash(t), gid],
          );
          return { invite: t, url: config.PUBLIC_URL + "/#join=" + t };
        });
      });
      api.post("/groups/join", async (req) => {
        const b = z
          .object({ token: z.string().min(20).max(200) })
          .parse(req.body);
        return tx(async (db) => {
          const invite = await one(
            db,
            "SELECT * FROM group_invites WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
            [hash(b.token)],
          );
          if (!invite) throw new DomainError("INVITE_INVALID", 422);
          await db.query(
            "INSERT INTO memberships(group_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
            [invite.group_id, req.user!.id],
          );
          await db.query(
            "UPDATE group_invites SET used_at=now() WHERE token_hash=$1",
            [hash(b.token)],
          );
          return { groupId: invite.group_id };
        });
      });
      api.post("/groups/:id/sharing", async (req) => {
        return tx(async (db) => {
          const gid = z.object({ id: uuid }).parse(req.params).id;
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          const b = z.object({ shareStatus: z.boolean() }).parse(req.body);
          await member(req.user!.id, gid, db);
          await db.query(
            "UPDATE memberships SET share_status=$1 WHERE group_id=$2 AND user_id=$3",
            [b.shareStatus, gid, req.user!.id],
          );
          return { ok: true };
        });
      });
      api.post("/groups/:id/jobs", async (req) => {
        return tx(async (db) => {
          const gid = z.object({ id: uuid }).parse(req.params).id;
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          const b = z.object({ jobId: uuid }).parse(req.body);
          await member(req.user!.id, gid, db);
          const j = await owned(db, "jobs", req.user!.id, b.jobId);
          const snapshot = {
            title: j.title,
            company: j.company,
            location: j.location,
            market: j.market,
            url: j.url,
            description: j.description,
            provider: j.provider,
            externalId: j.external_id,
          };
          return one(
            db,
            "INSERT INTO group_jobs(id,group_id,author_id,job_key,snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT(group_id,job_key) DO UPDATE SET snapshot=excluded.snapshot RETURNING *",
            [
              id(),
              gid,
              req.user!.id,
              j.provider + ":" + j.external_id,
              JSON.stringify(snapshot),
            ],
          );
        });
      });
      api.post("/groups/:id/comments", async (req) => {
        return tx(async (db) => {
          const gid = z.object({ id: uuid }).parse(req.params).id;
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          const b = z
            .object({ body: z.string().trim().min(1).max(5000) })
            .parse(req.body);
          await member(req.user!.id, gid, db);
          return one(
            db,
            "INSERT INTO group_comments(id,group_id,author_id,body) VALUES($1,$2,$3,$4) RETURNING *",
            [id(), gid, req.user!.id, b.body],
          );
        });
      });
      api.post("/groups/:id/save-job", async (req) => {
        const gid = z.object({ id: uuid }).parse(req.params).id;
        const { jobId } = z.object({ jobId: uuid }).parse(req.body);
        return tx(async (db) => {
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          await member(req.user!.id, gid, db);
          const row = await one(
            db,
            "SELECT snapshot FROM group_jobs WHERE id=$1 AND group_id=$2",
            [jobId, gid],
          );
          if (!row) throw new DomainError("NOT_FOUND", 404);
          const { provider, externalId, ...job } = row.snapshot;
          return saveJob(db, req.user!.id, job, provider, externalId);
        });
      });
      api.post("/groups/:id/revoke-invites", async (req) => {
        return tx(async (db) => {
          const gid = z.object({ id: uuid }).parse(req.params).id;
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          const m = await member(req.user!.id, gid, db);
          if (!["owner", "admin"].includes(m.role))
            throw new DomainError("FORBIDDEN", 403);
          await db.query(
            "UPDATE group_invites SET revoked_at=now() WHERE group_id=$1 AND used_at IS NULL",
            [gid],
          );
          return { ok: true };
        });
      });
      api.post("/groups/:id/notes", async (req) => {
        return tx(async (db) => {
          const gid = z.object({ id: uuid }).parse(req.params).id;
          await db.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [gid]);
          const b = z.object({ noteId: uuid }).parse(req.body);
          await member(req.user!.id, gid, db);
          const n = await owned(db, "interview_notes", req.user!.id, b.noteId);
          return one(
            db,
            "INSERT INTO note_shares(id,group_id,owner_id,note_id,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [
              id(),
              gid,
              req.user!.id,
              n.id,
              JSON.stringify({ title: n.title, content: n.content }),
            ],
          );
        });
      });
      api.delete("/note-shares/:id", async (req) => {
        const sid = z.object({ id: uuid }).parse(req.params).id;
        await pool.query(
          "DELETE FROM note_shares WHERE id=$1 AND owner_id=$2",
          [sid, req.user!.id],
        );
        return { ok: true };
      });
      api.post("/groups/:id/remove-member", async (req) => {
        const gid = z.object({ id: uuid }).parse(req.params).id;
        const b = z.object({ userId: uuid }).parse(req.body);
        return tx(async (db) => {
          await db.query("SELECT id FROM groups WHERE id=$1 FOR UPDATE", [gid]);
          const actor = await member(req.user!.id, gid, db);
          const target = await member(b.userId, gid, db);
          if (target.role === "owner")
            throw new DomainError("TRANSFER_OWNER_FIRST", 409);
          if (b.userId !== req.user!.id && actor.role !== "owner")
            throw new DomainError("FORBIDDEN", 403);
          await db.query(
            "DELETE FROM note_shares WHERE group_id=$1 AND owner_id=$2",
            [gid, b.userId],
          );
          await db.query(
            "DELETE FROM memberships WHERE group_id=$1 AND user_id=$2",
            [gid, b.userId],
          );
          return { ok: true };
        });
      });
      api.post("/groups/:id/transfer", async (req) => {
        const gid = z.object({ id: uuid }).parse(req.params).id;
        const { userId } = z.object({ userId: uuid }).parse(req.body);
        return tx(async (db) => {
          await db.query("SELECT id FROM groups WHERE id=$1 FOR UPDATE", [gid]);
          const actor = await member(req.user!.id, gid, db);
          if (actor.role !== "owner") throw new DomainError("FORBIDDEN", 403);
          await member(userId, gid, db);
          await db.query(
            "UPDATE memberships SET role=CASE WHEN user_id=$1 THEN 'owner' ELSE 'member' END WHERE group_id=$2 AND user_id IN ($1,$3)",
            [userId, gid, req.user!.id],
          );
          return { ok: true };
        });
      });
      api.delete("/groups/:id", async (req) => {
        const gid = z.object({ id: uuid }).parse(req.params).id;
        return tx(async (db) => {
          await db.query("SELECT id FROM groups WHERE id=$1 FOR UPDATE", [gid]);
          const m = await member(req.user!.id, gid, db);
          if (m.role !== "owner") throw new DomainError("FORBIDDEN", 403);
          await db.query("DELETE FROM groups WHERE id=$1", [gid]);
          return { ok: true };
        });
      });
    },
    { prefix: config.basePath + "/api" },
  );
}
