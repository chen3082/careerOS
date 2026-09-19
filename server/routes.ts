import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { requireUser, sameOrigin, publicUser } from "./auth.js";
import { pool, tx, one, owned, id, DomainError, audit } from "./db.js";
import { hash, token, encrypt } from "./crypto.js";
import {
  uuid,
  text,
  jobSchema,
  taskSchema,
  salarySchema,
  resumeMarkdown,
} from "./schemas.js";
import {
  idempotent,
  addFact,
  confirmFacts,
  revokeFact,
  createResume,
  validateResume,
  saveJob,
  createApplication,
  applyManualEvent,
  prepareDossier,
  newTask,
  lockUser,
} from "./domain.js";
const key = (r: FastifyRequest) =>
  z.string().min(8).max(160).parse(r.headers["idempotency-key"]);
const params = (r: FastifyRequest) => z.object({ id: uuid }).parse(r.params);
export async function apiRoutes(app: FastifyInstance) {
  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req) => {
        sameOrigin(req);
        await requireUser(req);
      });
      api.get("/me", async (req) => ({ user: publicUser(req.user!) }));
      api.get("/dashboard", async (req) => {
        const u = req.user!.id;
        const counts = await one(
          pool,
          "SELECT count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted,count(*) FILTER (WHERE submitted_at IS NOT NULL AND EXISTS(SELECT 1 FROM interviews i WHERE i.application_id=a.id AND i.status<>'cancelled'))::int AS interviews,count(*) FILTER (WHERE submitted_at IS NOT NULL AND EXISTS(SELECT 1 FROM offers o WHERE o.application_id=a.id))::int AS offers,count(*) FILTER (WHERE status='preparing')::int AS preparing FROM applications a WHERE owner_id=$1",
          [u],
        );
        const recent = (
          await pool.query(
            "SELECT a.*,j.company,j.title FROM applications a JOIN jobs j ON j.id=a.job_id AND j.owner_id=a.owner_id WHERE a.owner_id=$1 ORDER BY a.created_at DESC LIMIT 8",
            [u],
          )
        ).rows;
        const upcoming = (
          await pool.query(
            "SELECT i.*,j.company,j.title FROM interviews i JOIN applications a ON a.id=i.application_id JOIN jobs j ON j.id=a.job_id WHERE i.owner_id=$1 AND i.status IN ('invited','scheduled') ORDER BY starts_at NULLS LAST LIMIT 5",
            [u],
          )
        ).rows;
        const pending = await one(
          pool,
          "SELECT (SELECT count(*) FROM facts WHERE owner_id=$1 AND NOT confirmed AND revoked_at IS NULL)::int AS facts,(SELECT count(*) FROM proposals WHERE owner_id=$1 AND state='pending')::int AS proposals,(SELECT count(*) FROM tasks WHERE owner_id=$1 AND status IN ('queued','running','waiting_client','failed'))::int AS tasks",
          [u],
        );
        return {
          counts,
          recent,
          upcoming,
          pending,
          asOf: new Date().toISOString(),
        };
      });
      api.get("/career", async (req) => {
        const u = req.user!;
        return {
          revision: u.revision,
          facts: (
            await pool.query(
              "SELECT * FROM facts WHERE owner_id=$1 ORDER BY created_at DESC",
              [u.id],
            )
          ).rows,
          sources: (
            await pool.query(
              "SELECT * FROM sources WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
              [u.id],
            )
          ).rows,
        };
      });
      api.get("/career/markdown", async (req, reply) => {
        const row = await one(
          pool,
          "SELECT markdown FROM career_revisions WHERE owner_id=$1 ORDER BY revision DESC LIMIT 1",
          [req.user!.id],
        );
        reply
          .type("text/markdown; charset=utf-8")
          .header("Content-Disposition", 'attachment; filename="career.md"');
        return row?.markdown ?? "# 我的經驗\n";
      });
      api.post("/sources", async (req) => {
        const b = z
          .object({
            title: z.string().min(1).max(160),
            content: text,
            kind: z.enum(["text", "markdown", "transcript"]).default("text"),
          })
          .parse(req.body);
        return idempotent(req.user!.id, "sources", key(req), b, (db) =>
          one(
            db,
            "INSERT INTO sources(id,owner_id,title,content,kind) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [id(), req.user!.id, b.title, b.content, b.kind],
          ),
        );
      });
      api.post("/facts", async (req) => {
        const b = z
          .object({ fact: z.unknown(), expectedRevision: z.number().int() })
          .parse(req.body);
        return idempotent(req.user!.id, "facts", key(req), b, (db) =>
          addFact(db, req.user!.id, b.fact, b.expectedRevision, true),
        );
      });
      api.post("/facts/confirm", async (req) => {
        const b = z
          .object({
            ids: z.array(uuid).min(1).max(100),
            expectedRevision: z.number().int(),
          })
          .parse(req.body);
        return idempotent(req.user!.id, "confirm-facts", key(req), b, (db) =>
          confirmFacts(db, req.user!.id, b.ids, b.expectedRevision),
        );
      });
      api.post("/facts/:id/revoke", async (req) => {
        const { id: fid } = params(req);
        const b = z
          .object({ expectedRevision: z.number().int() })
          .parse(req.body);
        return idempotent(
          req.user!.id,
          "revoke-fact",
          key(req),
          { ...b, fid },
          (db) => revokeFact(db, req.user!.id, fid, b.expectedRevision),
        );
      });
      api.get("/resumes", async (req) => ({
        items: await Promise.all(
          (
            await pool.query(
              "SELECT * FROM resumes WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
              [req.user!.id],
            )
          ).rows.map(async (r) => ({
            ...r,
            validation: await validateResume(pool, req.user!.id, r),
          })),
        ),
      }));
      api.post("/resumes", async (req) =>
        idempotent(req.user!.id, "resume", key(req), req.body, (db) =>
          createResume(db, req.user!.id, req.body),
        ),
      );
      api.post("/resumes/:id/approve", async (req) => {
        const { id: rid } = params(req);
        return idempotent(
          req.user!.id,
          "approve-resume",
          key(req),
          { rid },
          async (db) => {
            await lockUser(db, req.user!.id);
            const r = await owned(db, "resumes", req.user!.id, rid);
            const v = await validateResume(db, req.user!.id, {
              ...r,
              approved_at: new Date(),
            });
            if (!v.eligible)
              throw new DomainError("SOURCE_WITHDRAWN_OR_EXPIRED", 422);
            await audit(db, req.user!.id, "resume.text_confirmed", rid);
            return one(
              db,
              "UPDATE resumes SET approved_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *",
              [rid, req.user!.id],
            );
          },
        );
      });
      api.get("/resumes/:id/markdown", async (req, reply) => {
        const r = await owned(pool, "resumes", req.user!.id, params(req).id);
        return reply
          .type("text/markdown; charset=utf-8")
          .header("Content-Disposition", 'attachment; filename="resume.md"')
          .send(resumeMarkdown(req.user!.name, r.blocks, req.user!.email));
      });
      api.get("/jobs", async (req) => {
        const q = z
          .object({
            q: z.string().max(100).default(""),
            market: z.string().max(10).default(""),
            limit: z.coerce.number().int().min(1).max(100).default(100),
          })
          .parse(req.query);
        return {
          items: (
            await pool.query(
              "SELECT j.*,a.id AS application_id,a.status AS application_status,a.submitted_at FROM jobs j LEFT JOIN applications a ON a.job_id=j.id AND a.owner_id=j.owner_id AND a.cycle=1 WHERE j.owner_id=$1 AND ($2='' OR j.title ILIKE $3 OR j.company ILIKE $3 OR j.description ILIKE $3) AND ($4='' OR j.market=$4) ORDER BY j.created_at DESC LIMIT $5",
              [req.user!.id, q.q, "%" + q.q + "%", q.market, q.limit],
            )
          ).rows,
        };
      });
      api.post("/jobs", async (req) => {
        const b = jobSchema.parse(req.body);
        return idempotent(req.user!.id, "job", key(req), b, (db) =>
          saveJob(db, req.user!.id, b),
        );
      });
      api.get("/collections", async (req) => ({
        items: (
          await pool.query(
            "SELECT c.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.id,'title',j.title,'company',j.company,'status',a.status,'submitted_at',a.submitted_at)) FROM collection_jobs cj JOIN jobs j ON j.id=cj.job_id AND j.owner_id=cj.owner_id LEFT JOIN applications a ON a.job_id=j.id AND a.owner_id=j.owner_id WHERE cj.collection_id=c.id),'[]') AS jobs FROM collections c WHERE owner_id=$1 ORDER BY created_at DESC",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/collections", async (req) => {
        const b = z
          .object({ name: z.string().trim().min(1).max(100) })
          .parse(req.body);
        return idempotent(req.user!.id, "collection", key(req), b, (db) =>
          one(
            db,
            "INSERT INTO collections(id,owner_id,name) VALUES($1,$2,$3) RETURNING *",
            [id(), req.user!.id, b.name],
          ),
        );
      });
      api.post("/collections/:id/jobs", async (req) => {
        const cid = params(req).id;
        const b = z.object({ jobId: uuid }).parse(req.body);
        await owned(pool, "collections", req.user!.id, cid);
        await owned(pool, "jobs", req.user!.id, b.jobId);
        await pool.query(
          "INSERT INTO collection_jobs(owner_id,collection_id,job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [req.user!.id, cid, b.jobId],
        );
        return { ok: true };
      });
      api.get("/applications", async (req) => ({
        items: (
          await pool.query(
            "SELECT a.*,j.title,j.company,j.url,r.title AS resume_title FROM applications a JOIN jobs j ON j.id=a.job_id AND j.owner_id=a.owner_id LEFT JOIN resumes r ON r.id=a.resume_id AND r.owner_id=a.owner_id WHERE a.owner_id=$1 ORDER BY a.created_at DESC LIMIT 200",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/applications", async (req) => {
        const b = z
          .object({ jobId: uuid, resumeId: uuid.optional() })
          .parse(req.body);
        return idempotent(req.user!.id, "application", key(req), b, (db) =>
          createApplication(db, req.user!.id, b.jobId, b.resumeId),
        );
      });
      api.get("/applications/:id", async (req) => {
        const aid = params(req).id;
        const application = await owned(
          pool,
          "applications",
          req.user!.id,
          aid,
        );
        const job = await owned(pool, "jobs", req.user!.id, application.job_id);
        const events = (
          await pool.query(
            "SELECT * FROM application_events WHERE owner_id=$1 AND application_id=$2 ORDER BY created_at DESC",
            [req.user!.id, aid],
          )
        ).rows;
        const dossiers = (
          await pool.query(
            "SELECT * FROM dossiers WHERE owner_id=$1 AND application_id=$2 ORDER BY created_at DESC",
            [req.user!.id, aid],
          )
        ).rows;
        return { application, job, events, dossiers };
      });
      api.post("/applications/:id/resume", async (req) => {
        const aid = params(req).id;
        const b = z
          .object({ resumeId: uuid, expectedVersion: z.number().int() })
          .parse(req.body);
        return tx(async (db) => {
          const a = await owned(db, "applications", req.user!.id, aid, true);
          if (a.submitted_at) throw new DomainError("ALREADY_SUBMITTED", 409);
          if (a.version !== b.expectedVersion)
            throw new DomainError("VERSION_CONFLICT", 409);
          await owned(db, "resumes", req.user!.id, b.resumeId);
          await db.query(
            "UPDATE authorizations SET revoked_at=now() WHERE owner_id=$1 AND dossier_id IN (SELECT id FROM dossiers WHERE application_id=$2)",
            [req.user!.id, aid],
          );
          return one(
            db,
            "UPDATE applications SET resume_id=$1,version=version+1 WHERE id=$2 AND owner_id=$3 RETURNING *",
            [b.resumeId, aid, req.user!.id],
          );
        });
      });
      api.post("/applications/events", async (req) =>
        idempotent(req.user!.id, "manual-event", key(req), req.body, (db) =>
          applyManualEvent(db, req.user!.id, req.body),
        ),
      );
      api.post("/applications/:id/prepare", async (req) =>
        idempotent(req.user!.id, "prepare", key(req), params(req), (db) =>
          prepareDossier(db, req.user!.id, params(req).id),
        ),
      );
      api.get("/interviews", async (req) => ({
        items: (
          await pool.query(
            "SELECT i.*,j.company,j.title FROM interviews i JOIN applications a ON a.id=i.application_id JOIN jobs j ON j.id=a.job_id WHERE i.owner_id=$1 ORDER BY i.created_at DESC",
            [req.user!.id],
          )
        ).rows,
        preparations: (
          await pool.query(
            "SELECT * FROM preparations WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
            [req.user!.id],
          )
        ).rows,
        notes: (
          await pool.query(
            "SELECT * FROM interview_notes WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/interviews", async (req) => {
        const b = z
          .object({
            applicationId: uuid,
            round: z.string().min(1).max(100),
            status: z.enum(["invited", "scheduled", "completed", "cancelled"]),
            startsAt: z.string().datetime().nullable(),
            timezone: z.string().max(64),
            notes: z.string().max(5000).default(""),
          })
          .parse(req.body);
        return idempotent(
          req.user!.id,
          "interview",
          key(req),
          b,
          async (db) => {
            await owned(
              db,
              "applications",
              req.user!.id,
              b.applicationId,
              true,
            );
            const i = await one(
              db,
              "INSERT INTO interviews(id,owner_id,application_id,round,status,starts_at,timezone,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
              [
                id(),
                req.user!.id,
                b.applicationId,
                b.round,
                b.status,
                b.startsAt,
                b.timezone,
                b.notes,
              ],
            );
            if (b.status !== "cancelled")
              await db.query(
                "UPDATE applications SET status=CASE WHEN status IN ('preparing','submitted') THEN 'interviewing' ELSE status END,version=version+1 WHERE id=$1 AND owner_id=$2",
                [b.applicationId, req.user!.id],
              );
            await db.query(
              "INSERT INTO application_events(id,owner_id,application_id,type,payload,source) VALUES($1,$2,$3,'interview.created',$4,'user_reported')",
              [id(), req.user!.id, b.applicationId, JSON.stringify(b)],
            );
            return i;
          },
        );
      });
      api.post("/interviews/:id/update", async (req) => {
        const iid = params(req).id;
        const b = z
          .object({
            status: z.enum(["invited", "scheduled", "completed", "cancelled"]),
            startsAt: z.string().datetime().nullable(),
            notes: z.string().max(5000),
          })
          .parse(req.body);
        return tx(async (db) => {
          const i = await owned(db, "interviews", req.user!.id, iid, true);
          await db.query(
            "INSERT INTO application_events(id,owner_id,application_id,type,payload,source) VALUES($1,$2,$3,'interview.updated',$4,'user_reported')",
            [
              id(),
              req.user!.id,
              i.application_id,
              JSON.stringify({ before: i, after: b }),
            ],
          );
          return one(
            db,
            "UPDATE interviews SET status=$1,starts_at=$2,notes=$3 WHERE id=$4 AND owner_id=$5 RETURNING *",
            [b.status, b.startsAt, b.notes, iid, req.user!.id],
          );
        });
      });
      api.post("/preparations", async (req) => {
        const b = z
          .object({
            title: z.string().min(1).max(200),
            notes: z.string().max(20000).default(""),
          })
          .parse(req.body);
        return idempotent(req.user!.id, "prep", key(req), b, (db) =>
          one(
            db,
            "INSERT INTO preparations(id,owner_id,title,notes) VALUES($1,$2,$3,$4) RETURNING *",
            [id(), req.user!.id, b.title, b.notes],
          ),
        );
      });
      api.post("/notes", async (req) => {
        const b = z
          .object({
            title: z.string().min(1).max(200),
            content: text,
            applicationId: uuid.nullable().optional(),
            interviewId: uuid.nullable().optional(),
            assetId: uuid.nullable().optional(),
          })
          .parse(req.body);
        return idempotent(req.user!.id, "note", key(req), b, async (db) => {
          if (b.applicationId)
            await owned(db, "applications", req.user!.id, b.applicationId);
          if (b.interviewId)
            await owned(db, "interviews", req.user!.id, b.interviewId);
          if (b.assetId) await owned(db, "assets", req.user!.id, b.assetId);
          return one(
            db,
            "INSERT INTO interview_notes(id,owner_id,application_id,interview_id,title,content,asset_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              id(),
              req.user!.id,
              b.applicationId ?? null,
              b.interviewId ?? null,
              b.title,
              b.content,
              b.assetId ?? null,
            ],
          );
        });
      });
      api.get("/offers", async (req) => ({
        items: (
          await pool.query(
            "SELECT o.*,j.company,j.title FROM offers o JOIN applications a ON a.id=o.application_id JOIN jobs j ON j.id=a.job_id WHERE o.owner_id=$1 ORDER BY o.created_at DESC",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/offers", async (req) => {
        const b = salarySchema.parse(req.body);
        return idempotent(req.user!.id, "offer", key(req), b, async (db) => {
          const application = await owned(
            db,
            "applications",
            req.user!.id,
            b.applicationId,
            true,
          );
          if (
            ["accepted", "offer_declined", "rejected", "withdrawn"].includes(
              application.status,
            )
          )
            throw new DomainError("APPLICATION_CLOSED", 409);
          const o = await one(
            db,
            "INSERT INTO offers(id,owner_id,application_id,currency,amount,period,terms,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            [
              id(),
              req.user!.id,
              b.applicationId,
              b.currency,
              b.amount,
              b.period,
              b.terms,
              b.deadline ?? null,
            ],
          );
          await db.query(
            "INSERT INTO offer_revisions(offer_id,revision,snapshot) VALUES($1,1,$2)",
            [o.id, JSON.stringify(o)],
          );
          await db.query(
            "UPDATE applications SET status='offer',version=version+1 WHERE id=$1 AND owner_id=$2",
            [b.applicationId, req.user!.id],
          );
          return o;
        });
      });
      api.post("/offers/:id/decision", async (req) => {
        const oid = params(req).id;
        const b = z
          .object({
            decision: z.enum(["accepted", "declined"]),
            expectedRevision: z.number().int(),
          })
          .parse(req.body);
        return idempotent(
          req.user!.id,
          "offer-decision",
          key(req),
          { ...b, oid },
          async (db) => {
            const reference = await owned(db, "offers", req.user!.id, oid);
            const application = await owned(
              db,
              "applications",
              req.user!.id,
              reference.application_id,
              true,
            );
            if (application.status !== "offer")
              throw new DomainError("APPLICATION_CLOSED", 409);
            const o = await owned(db, "offers", req.user!.id, oid, true);
            if (o.revision !== b.expectedRevision || o.status !== "received")
              throw new DomainError("VERSION_CONFLICT", 409);
            const row = await one(
              db,
              "UPDATE offers SET status=$1,revision=revision+1 WHERE id=$2 AND owner_id=$3 RETURNING *",
              [b.decision, oid, req.user!.id],
            );
            await db.query(
              "INSERT INTO offer_revisions(offer_id,revision,snapshot) VALUES($1,$2,$3)",
              [oid, row.revision, JSON.stringify(row)],
            );
            await db.query(
              "UPDATE applications SET status=$1,version=version+1 WHERE id=$2 AND owner_id=$3",
              [
                b.decision === "accepted" ? "accepted" : "offer_declined",
                o.application_id,
                req.user!.id,
              ],
            );
            return row;
          },
        );
      });
      api.get("/tasks", async (req) => ({
        items: (
          await pool.query(
            "SELECT * FROM tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
            [req.user!.id],
          )
        ).rows,
        proposals: (
          await pool.query(
            "SELECT * FROM proposals WHERE owner_id=$1 AND state='pending' ORDER BY created_at DESC LIMIT 50",
            [req.user!.id],
          )
        ).rows,
        signals: (
          await pool.query(
            "SELECT * FROM sync_evidence WHERE owner_id=$1 AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 50",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/signals/:id/dismiss", async (req) => {
        await pool.query(
          "UPDATE sync_evidence SET dismissed_at=now() WHERE id=$1 AND owner_id=$2",
          [params(req).id, req.user!.id],
        );
        return { ok: true };
      });
      api.post("/offers/:id/revise", async (req) => {
        const oid = params(req).id;
        const b = salarySchema
          .omit({ applicationId: true })
          .extend({ expectedRevision: z.number().int() })
          .parse(req.body);
        return idempotent(
          req.user!.id,
          "offer-revise",
          key(req),
          { ...b, oid },
          async (db) => {
            const old = await owned(db, "offers", req.user!.id, oid, true);
            if (
              old.revision !== b.expectedRevision ||
              old.status !== "received"
            )
              throw new DomainError("VERSION_CONFLICT", 409);
            const row = await one(
              db,
              "UPDATE offers SET currency=$1,amount=$2,period=$3,terms=$4,deadline=$5,revision=revision+1 WHERE id=$6 AND owner_id=$7 RETURNING *",
              [
                b.currency,
                b.amount,
                b.period,
                b.terms,
                b.deadline ?? null,
                oid,
                req.user!.id,
              ],
            );
            await db.query(
              "INSERT INTO offer_revisions(offer_id,revision,snapshot) VALUES($1,$2,$3)",
              [oid, row.revision, JSON.stringify(row)],
            );
            return row;
          },
        );
      });
      api.post("/tasks", async (req) => {
        const b = taskSchema.parse(req.body);
        return idempotent(req.user!.id, "task", key(req), b, (db) =>
          newTask(db, req.user!.id, b.kind, b.input),
        );
      });
      api.post("/tasks/:id/cancel", async (req) => {
        await owned(pool, "tasks", req.user!.id, params(req).id);
        await pool.query(
          "UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status IN ('queued','waiting_client','failed')",
          [params(req).id, req.user!.id],
        );
        return { ok: true };
      });
      api.get("/proposals", async (req) => ({
        items: (
          await pool.query(
            "SELECT * FROM proposals WHERE owner_id=$1 AND state='pending' ORDER BY created_at DESC",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/proposals/:id/confirm", async (req) => {
        const pid = params(req).id;
        return idempotent(
          req.user!.id,
          "confirm-proposal",
          key(req),
          { pid },
          async (db) => {
            const p = await owned(db, "proposals", req.user!.id, pid, true);
            if (p.state !== "pending")
              throw new DomainError("ALREADY_PROCESSED", 409);
            if (p.kind !== "manual_event")
              throw new DomainError("USE_DEDICATED_FORM", 422);
            const result = await applyManualEvent(db, req.user!.id, p.payload);
            await db.query(
              "UPDATE proposals SET state='confirmed' WHERE id=$1 AND owner_id=$2",
              [pid, req.user!.id],
            );
            return result;
          },
        );
      });
      api.post("/proposals/:id/dismiss", async (req) => {
        await owned(pool, "proposals", req.user!.id, params(req).id);
        await pool.query(
          "UPDATE proposals SET state='dismissed' WHERE id=$1 AND owner_id=$2",
          [params(req).id, req.user!.id],
        );
        return { ok: true };
      });
      api.get("/career-plans", async (req) => ({
        items: (
          await pool.query(
            "SELECT * FROM career_plans WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20",
            [req.user!.id],
          )
        ).rows,
        tasks: (
          await pool.query(
            "SELECT * FROM growth_tasks WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/growth-tasks/:id/complete", async (req) => {
        const b = z.object({ evidence: text }).parse(req.body);
        await owned(pool, "growth_tasks", req.user!.id, params(req).id);
        return one(
          pool,
          "UPDATE growth_tasks SET completed_at=now(),evidence=$1 WHERE id=$2 AND owner_id=$3 RETURNING *",
          [b.evidence, params(req).id, req.user!.id],
        );
      });
      api.get("/answers", async (req) => ({
        items: (
          await pool.query(
            "SELECT * FROM answers WHERE owner_id=$1 ORDER BY created_at DESC",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/answers", async (req) => {
        const b = z
          .object({
            question: text,
            semanticKey: z.string().min(1).max(100),
            country: z.enum(["TW", "US", "INTL"]),
            company: z.string().max(200).default(""),
            value: text,
            unit: z.string().max(40).default(""),
            reusable: z.boolean().default(false),
          })
          .parse(req.body);
        return idempotent(req.user!.id, "answer", key(req), b, (db) =>
          one(
            db,
            "INSERT INTO answers(id,owner_id,question,semantic_key,country,company,value,unit,reusable) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              id(),
              req.user!.id,
              b.question,
              b.semanticKey,
              b.country,
              b.company,
              b.value,
              b.unit,
              b.reusable,
            ],
          ),
        );
      });
      api.post("/answers/:id/revoke", async (req) =>
        tx(async (db) => {
          await lockUser(db, req.user!.id);
          await owned(db, "answers", req.user!.id, params(req).id);
          await db.query(
            "UPDATE answers SET revoked_at=now() WHERE id=$1 AND owner_id=$2",
            [params(req).id, req.user!.id],
          );
          await db.query(
            "UPDATE authorizations SET revoked_at=now() WHERE owner_id=$1 AND consumed_at IS NULL",
            [req.user!.id],
          );
          return { ok: true };
        }),
      );
      api.get("/settings", async (req) => ({
        settings: req.user!.settings,
        credentials: (
          await pool.query(
            "SELECT provider,last4,created_at FROM credentials WHERE owner_id=$1",
            [req.user!.id],
          )
        ).rows,
        usage: (
          await pool.query(
            "SELECT day,sum(coalesce(actual_tokens,reserved_tokens))::int AS tokens,count(*)::int AS requests FROM usage WHERE owner_id=$1 GROUP BY day ORDER BY day DESC LIMIT 30",
            [req.user!.id],
          )
        ).rows,
        connections: (
          await pool.query(
            "SELECT id,provider,state,last_synced_at FROM connections WHERE owner_id=$1",
            [req.user!.id],
          )
        ).rows,
        mcpUrl: config.PUBLIC_URL + "/mcp",
        capabilities: {
          google: Boolean(config.GOOGLE_CLIENT_ID),
          autopilot: config.SUBMISSIONS_ENABLED === "true",
          search: ["greenhouse", "lever", "arbeitnow"],
          transcription: "openai_byok",
        },
        grants: (
          await pool.query(
            "SELECT t.grant_id,t.client_id,max(t.expires_at) AS expires_at,c.metadata->>'client_name' AS name FROM oauth_tokens t JOIN oauth_clients c ON c.id=t.client_id WHERE t.user_id=$1 AND t.revoked_at IS NULL GROUP BY t.grant_id,t.client_id,c.metadata",
            [req.user!.id],
          )
        ).rows,
      }));
      api.post("/settings", async (req) => {
        const b = z
          .object({
            mode: z.enum(["mcp", "byok", "manual"]),
            timezone: z.string().max(64),
            dailyTokenLimit: z.number().int().min(1000).max(1000000),
          })
          .strict()
          .parse(req.body);
        try {
          new Intl.DateTimeFormat("en", { timeZone: b.timezone });
        } catch {
          throw new DomainError("INVALID_TIMEZONE");
        }
        await pool.query("UPDATE users SET settings=$1 WHERE id=$2", [
          JSON.stringify(b),
          req.user!.id,
        ]);
        return { ok: true };
      });
      api.post("/credentials", async (req) => {
        const b = z
          .object({
            provider: z.enum(["anthropic", "openai"]),
            key: z.string().min(20).max(1000),
          })
          .strict()
          .parse(req.body);
        await pool.query(
          "INSERT INTO credentials(owner_id,provider,encrypted,last4) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,provider) DO UPDATE SET encrypted=excluded.encrypted,last4=excluded.last4,created_at=now()",
          [
            req.user!.id,
            b.provider,
            encrypt(
              b.key,
              config.ENCRYPTION_KEY,
              req.user!.id + ":" + b.provider,
            ),
            b.key.slice(-4),
          ],
        );
        await audit(pool, req.user!.id, "credential.updated");
        return { ok: true };
      });
      api.delete("/credentials/:provider", async (req) => {
        const b = z
          .object({ provider: z.enum(["anthropic", "openai"]) })
          .parse(req.params);
        await pool.query(
          "DELETE FROM credentials WHERE owner_id=$1 AND provider=$2",
          [req.user!.id, b.provider],
        );
        return { ok: true };
      });
      api.post("/grants/:id/revoke", async (req) => {
        await pool.query(
          "UPDATE oauth_tokens SET revoked_at=now() WHERE user_id=$1 AND grant_id=$2",
          [req.user!.id, params(req).id],
        );
        return { ok: true };
      });
    },
    { prefix: config.basePath + "/api" },
  );
}
