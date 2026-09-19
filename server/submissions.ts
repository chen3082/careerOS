import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { requireUser, sameOrigin } from "./auth.js";
import { pool, tx, one, owned, id, DomainError, type DB } from "./db.js";
import { canonical, hash } from "./crypto.js";
import { validateResume, lockUser } from "./domain.js";
import { readAsset } from "./assets.js";
import {
  canonicalSubmissionJob,
  type FormReview,
} from "./submission-browser.js";

const inputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    accountEmail: z.string().email().max(254),
    answers: z
      .record(z.string().min(1).max(400), z.string().max(4000))
      .refine((v) => Object.keys(v).length <= 80),
  })
  .strict();
export async function prepareSubmission(
  owner: string,
  applicationId: string,
  input: unknown,
) {
  const b = inputSchema.parse(input);
  return tx(async (db) => {
    await lockUser(db, owner);
    const app = await owned(db, "applications", owner, applicationId, true);
    if (app.submitted_at) throw new DomainError("ALREADY_SUBMITTED", 409);
    if (app.status !== "preparing")
      throw new DomainError("APPLICATION_NOT_READY", 409);
    if (app.version !== b.expectedVersion)
      throw new DomainError("VERSION_CONFLICT", 409);
    const job = await owned(db, "jobs", owner, app.job_id);
    const target = canonicalSubmissionJob(job.url);
    const externalKey = target.platform + ":" + target.jobId;
    // Block URL aliases and provider/manual imports of the same external posting.
    const previous = (
      await db.query(
        "SELECT j.url,a.status,a.submitted_at FROM applications a JOIN jobs j ON j.id=a.job_id AND j.owner_id=a.owner_id WHERE a.owner_id=$1 AND a.cycle=$2 AND a.id<>$3",
        [owner, app.cycle, app.id],
      )
    ).rows;
    for (const p of previous) {
      let key: string;
      try {
        const other = canonicalSubmissionJob(p.url);
        key = other.platform + ":" + other.jobId;
      } catch {
        continue;
      }
      if (key === externalKey && (p.submitted_at || p.status !== "preparing"))
        throw new DomainError("ALREADY_SUBMITTED", 409);
    }
    if (!app.resume_id) throw new DomainError("RESUME_REQUIRED", 422);
    const resume = await owned(db, "resumes", owner, app.resume_id);
    if (!(await validateResume(db, owner, resume)).eligible)
      throw new DomainError("RESUME_NEEDS_REVIEW", 422);
    const document = await one(
      db,
      "SELECT a.id,a.name,a.sha256,a.size,a.mime FROM resume_exports e JOIN assets a ON a.id=e.asset_id AND a.owner_id=e.owner_id WHERE e.owner_id=$1 AND e.resume_id=$2 AND e.format='pdf'",
      [owner, resume.id],
    );
    if (!document) throw new DomainError("RESUME_PDF_REQUIRED", 422);
    const manifest = {
      target,
      externalKey,
      applicationVersion: app.version,
      company: job.company,
      title: job.title,
      resumeId: resume.id,
      resumeTitle: resume.title,
      document,
      accountEmail: b.accountEmail.toLowerCase(),
      answers: b.answers,
      resumeHash: hash(canonical(resume)),
    };
    const manifestHash = hash(canonical(manifest));
    const dossier = await one(
      db,
      "INSERT INTO dossiers(id,owner_id,application_id,hash,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [id(), owner, app.id, manifestHash, JSON.stringify(manifest)],
    );
    return one(
      db,
      "INSERT INTO submission_runs(id,owner_id,application_id,dossier_id,external_job_key,cycle,status,manifest,manifest_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,'prepared',$7,$8,now()+interval '15 minutes') RETURNING *",
      [
        id(),
        owner,
        app.id,
        dossier.id,
        externalKey,
        app.cycle,
        JSON.stringify(manifest),
        manifestHash,
      ],
    );
  });
}
async function runOwned(db: DB, owner: string, runId: string, lock = false) {
  const run = await one(
    db,
    "SELECT * FROM submission_runs WHERE id=$1 AND owner_id=$2" +
      (lock ? " FOR UPDATE" : ""),
    [runId, owner],
  );
  if (!run) throw new DomainError("NOT_FOUND", 404);
  return run;
}
async function fresh(db: DB, owner: string, run: any) {
  const app = await owned(db, "applications", owner, run.application_id, true);
  if (app.submitted_at) throw new DomainError("ALREADY_SUBMITTED", 409);
  if (
    app.status !== "preparing" ||
    app.version !== run.manifest.applicationVersion ||
    app.resume_id !== run.manifest.resumeId
  )
    throw new DomainError("SUBMISSION_CHANGED_REVIEW_AGAIN", 409);
  if (new Date(run.expires_at).getTime() <= Date.now())
    throw new DomainError("SUBMISSION_AUTH_EXPIRED", 409);
  const resume = await owned(db, "resumes", owner, app.resume_id);
  if (
    hash(canonical(resume)) !== run.manifest.resumeHash ||
    !(await validateResume(db, owner, resume)).eligible
  )
    throw new DomainError("RESUME_NEEDS_REVIEW", 422);
  const job = await owned(db, "jobs", owner, app.job_id);
  const target = canonicalSubmissionJob(job.url);
  if (target.platform + ":" + target.jobId !== run.external_job_key)
    throw new DomainError("SUBMISSION_CHANGED_REVIEW_AGAIN", 409);
  const aliases = (
    await db.query(
      "SELECT j.url,a.status,a.submitted_at FROM applications a JOIN jobs j ON j.id=a.job_id AND j.owner_id=a.owner_id WHERE a.owner_id=$1 AND a.cycle=$2 AND a.id<>$3",
      [owner, app.cycle, app.id],
    )
  ).rows;
  for (const previous of aliases) {
    let key: string;
    try {
      const t = canonicalSubmissionJob(previous.url);
      key = t.platform + ":" + t.jobId;
    } catch {
      continue;
    }
    if (
      key === run.external_job_key &&
      (previous.submitted_at || previous.status !== "preparing")
    )
      throw new DomainError("ALREADY_SUBMITTED", 409);
  }
}
export async function submissionDocument(owner: string, runId: string) {
  const run = await runOwned(pool, owner, runId);
  const { asset, data } = await readAsset(owner, run.manifest.document.id);
  if (
    asset.sha256 !== run.manifest.document.sha256 ||
    hash(data) !== asset.sha256
  )
    throw new DomainError("RESUME_BYTES_MISMATCH", 409);
  return { run, asset, data };
}
export async function saveSubmissionReview(
  owner: string,
  runId: string,
  review: FormReview,
) {
  return tx(async (db) => {
    await lockUser(db, owner);
    const run = await runOwned(db, owner, runId, true);
    if (run.status !== "prepared")
      throw new DomainError("SUBMISSION_ALREADY_STARTED", 409);
    await fresh(db, owner, run);
    if (review.resumeHash !== run.manifest.document.sha256)
      throw new DomainError("RESUME_BYTES_MISMATCH", 409);
    if (
      review.binding.externalJobKey !== run.external_job_key ||
      review.binding.accountEmail !== run.manifest.accountEmail
    )
      throw new DomainError("BROWSER_JOB_OR_ACCOUNT_MISMATCH", 409);
    return one(
      db,
      "UPDATE submission_runs SET review=$1,updated_at=now() WHERE id=$2 RETURNING *",
      [JSON.stringify(review), run.id],
    );
  });
}
export async function approveSubmission(
  owner: string,
  runId: string,
  fingerprint: string,
) {
  return tx(async (db) => {
    await lockUser(db, owner);
    const run = await runOwned(db, owner, runId, true);
    if (
      run.status !== "prepared" ||
      !run.review ||
      run.review.fingerprint !== fingerprint
    )
      throw new DomainError("SUBMISSION_REVIEW_REQUIRED", 409);
    await fresh(db, owner, run);
    return one(
      db,
      "UPDATE submission_runs SET status='approved',approved_hash=$1,updated_at=now() WHERE id=$2 RETURNING *",
      [
        hash(canonical({ manifest: run.manifest_hash, form: fingerprint })),
        run.id,
      ],
    );
  });
}
export async function acquireSubmissionPermit(
  owner: string,
  runId: string,
  fingerprint: string,
  journalAck: () => Promise<void>,
) {
  await tx(async (db) => {
    await lockUser(db, owner);
    const run = await runOwned(db, owner, runId, true);
    if (
      run.status !== "approved" ||
      run.permit_at ||
      run.review?.fingerprint !== fingerprint
    )
      throw new DomainError("SUBMISSION_PERMIT_UNAVAILABLE", 409);
    await fresh(db, owner, run);
  });
  // The external journal must ack before the DB permit. If DB commit fails, its
  // already-durable marker prevents replay after restart/restore. Never delete it.
  await journalAck();
  return tx(async (db) => {
    await lockUser(db, owner);
    const run = await runOwned(db, owner, runId, true);
    if (
      run.status !== "approved" ||
      run.permit_at ||
      run.approved_hash !==
        hash(canonical({ manifest: run.manifest_hash, form: fingerprint }))
    )
      throw new DomainError("SUBMISSION_PERMIT_UNAVAILABLE", 409);
    await fresh(db, owner, run);
    return one(
      db,
      "UPDATE submission_runs SET status='sending',permit_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
      [run.id],
    );
  });
}
export async function finishSubmission(
  owner: string,
  runId: string,
  outcome: "confirmed" | "outcome_unknown",
  receipt?: Record<string, unknown>,
) {
  return tx(async (db) => {
    await lockUser(db, owner);
    const run = await runOwned(db, owner, runId, true);
    if (run.status === "confirmed") return run;
    if (!["sending", "outcome_unknown"].includes(run.status))
      throw new DomainError("SUBMISSION_NOT_SENT", 409);
    const app = await owned(
      db,
      "applications",
      owner,
      run.application_id,
      true,
    );
    if (outcome === "confirmed") {
      if (
        !receipt ||
        receipt.resumeHash !== run.manifest.document.sha256 ||
        receipt.externalJobKey !== run.external_job_key ||
        typeof receipt.receiptId !== "string" ||
        !receipt.receiptId
      )
        throw new DomainError("SUBMISSION_RECEIPT_REQUIRED", 409);
      if (!app.submitted_at) {
        await db.query(
          "INSERT INTO application_events(id,owner_id,application_id,type,payload,source) VALUES($1,$2,$3,'submitted',$4,'runner')",
          [
            id(),
            owner,
            app.id,
            JSON.stringify({ runId, dossierId: run.dossier_id, receipt }),
          ],
        );
        await db.query(
          "UPDATE applications SET status=CASE WHEN status IN ('preparing','submission_unknown') THEN 'submitted' ELSE status END,submitted_at=now(),version=version+1 WHERE id=$1 AND owner_id=$2",
          [app.id, owner],
        );
      }
    } else if (!app.submitted_at) {
      await db.query(
        "UPDATE applications SET status='submission_unknown',version=version+1 WHERE id=$1 AND owner_id=$2 AND status='preparing'",
        [app.id, owner],
      );
    }
    return one(
      db,
      "UPDATE submission_runs SET status=$1,receipt=coalesce($2,receipt),updated_at=now() WHERE id=$3 RETURNING *",
      [outcome, receipt ? JSON.stringify(receipt) : null, run.id],
    );
  });
}
export async function cancelSubmission(owner: string, runId: string) {
  return tx(async (db) => {
    await lockUser(db, owner);
    const run = await runOwned(db, owner, runId, true);
    if (run.permit_at || !["prepared", "approved"].includes(run.status))
      throw new DomainError("SUBMISSION_CANNOT_CANCEL_AFTER_SEND", 409);
    return one(
      db,
      "UPDATE submission_runs SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *",
      [run.id],
    );
  });
}

// A controlled acceptance engine is injectable only in NODE_ENV=test. The live
// platform/account adapters have a separate acceptance gate, not a fake success.
export type SubmissionAcceptanceEngine = {
  prepare(owner: string, run: any): Promise<FormReview>;
  submit(owner: string, run: any): Promise<void>;
};
export async function submissionRoutes(
  app: FastifyInstance,
  engine?: SubmissionAcceptanceEngine,
) {
  if (engine && config.NODE_ENV !== "test")
    throw new Error("Controlled submission engine is forbidden outside tests");
  const prefix = config.basePath + "/api";
  app.get(prefix + "/applications/:id/submissions", async (req) => {
    const user = await requireUser(req);
    const applicationId = z
      .object({ id: z.string().uuid() })
      .parse(req.params).id;
    await owned(pool, "applications", user.id, applicationId);
    return {
      enabled: !!engine,
      mode: engine ? "controlled_acceptance" : "not_connected",
      runs: (
        await pool.query(
          "SELECT * FROM submission_runs WHERE owner_id=$1 AND application_id=$2 ORDER BY created_at DESC",
          [user.id, applicationId],
        )
      ).rows,
    };
  });
  app.post(prefix + "/applications/:id/submissions", async (req) => {
    sameOrigin(req);
    const user = await requireUser(req);
    if (!engine) throw new DomainError("LIVE_SUBMISSION_NOT_CONNECTED", 503);
    const applicationId = z
      .object({ id: z.string().uuid() })
      .parse(req.params).id;
    const run = await prepareSubmission(user.id, applicationId, req.body);
    try {
      return await saveSubmissionReview(
        user.id,
        run.id,
        await engine.prepare(user.id, run),
      );
    } catch (e) {
      await pool.query(
        "UPDATE submission_runs SET status='needs_input',error=$1,updated_at=now() WHERE id=$2 AND status='prepared'",
        [
          e instanceof Error ? e.message.slice(0, 120) : "PREPARATION_FAILED",
          run.id,
        ],
      );
      throw e;
    }
  });
  app.post(prefix + "/submissions/:id/approve", async (req) => {
    sameOrigin(req);
    const user = await requireUser(req);
    if (!engine) throw new DomainError("LIVE_SUBMISSION_NOT_CONNECTED", 503);
    const runId = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const body = z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        confirm: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const run = await approveSubmission(user.id, runId, body.fingerprint);
    // External IO is deliberately outside any idempotent DB transaction.
    try {
      await engine.submit(user.id, run);
    } catch (e) {
      const current = await runOwned(pool, user.id, runId);
      if (current.permit_at)
        await finishSubmission(user.id, runId, "outcome_unknown");
      else
        await pool.query(
          "UPDATE submission_runs SET status='failed_safe',error=$1,updated_at=now() WHERE id=$2 AND status='approved'",
          [
            e instanceof Error ? e.message.slice(0, 120) : "SEND_NOT_STARTED",
            runId,
          ],
        );
      throw new DomainError(
        current.permit_at
          ? "SUBMISSION_OUTCOME_UNKNOWN"
          : "SUBMISSION_NOT_SENT",
        409,
      );
    }
    return runOwned(pool, user.id, runId);
  });
  app.post(prefix + "/submissions/:id/cancel", async (req) => {
    sameOrigin(req);
    const user = await requireUser(req);
    const runId = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return cancelSubmission(user.id, runId);
  });
}
