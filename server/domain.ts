import { z } from "zod";
import { pool, tx, one, owned, id, audit, DomainError, type DB } from "./db.js";
import { hash, canonical } from "./crypto.js";
import {
  factSchema,
  resumeSchema,
  manualEventSchema,
  factsMarkdown,
  jobSchema,
} from "./schemas.js";
export async function idempotent<T>(
  owner: string,
  operation: string,
  key: string,
  body: unknown,
  fn: (db: DB) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 160)
    throw new DomainError("IDEMPOTENCY_KEY_REQUIRED");
  return tx(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      owner + ":" + operation + ":" + key,
    ]);
    const old = await one(
      db,
      "SELECT * FROM idempotency WHERE owner_id=$1 AND operation=$2 AND key=$3",
      [owner, operation, key],
    );
    const h = hash(canonical(body));
    if (old) {
      if (old.request_hash !== h)
        throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return old.result;
    }
    const result = await fn(db);
    await db.query(
      "INSERT INTO idempotency(owner_id,operation,key,request_hash,result) VALUES($1,$2,$3,$4,$5)",
      [owner, operation, key, h, JSON.stringify(result)],
    );
    return result;
  });
}
export async function lockUser(db: DB, owner: string, expected?: number) {
  const u = await one(db, "SELECT * FROM users WHERE id=$1 FOR UPDATE", [
    owner,
  ]);
  if (!u) throw new DomainError("NOT_FOUND", 404);
  if (expected !== undefined && u.revision !== expected)
    throw new DomainError("REVISION_CONFLICT", 409, {
      currentRevision: u.revision,
    });
  return u;
}
export async function snapshotCareer(db: DB, owner: string) {
  const u = await one(
    db,
    "UPDATE users SET revision=revision+1,eligibility_epoch=eligibility_epoch+1 WHERE id=$1 RETURNING *",
    [owner],
  );
  const facts = (
    await db.query(
      "SELECT * FROM facts WHERE owner_id=$1 AND confirmed AND revoked_at IS NULL ORDER BY created_at",
      [owner],
    )
  ).rows;
  const md = factsMarkdown(u.name, u.revision, facts);
  await db.query(
    "INSERT INTO career_revisions(owner_id,revision,facts,markdown) VALUES($1,$2,$3,$4)",
    [owner, u.revision, JSON.stringify(facts), md],
  );
  return { revision: u.revision, facts, markdown: md };
}
export async function addFact(
  db: DB,
  owner: string,
  input: unknown,
  expected: number,
  confirmed: boolean,
) {
  await lockUser(db, owner, expected);
  const b = factSchema.parse(input);
  if (b.sourceId) await owned(db, "sources", owner, b.sourceId);
  const f = await one(
    db,
    "INSERT INTO facts(id,owner_id,kind,title,content,source_id,valid_until,confirmed,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    [
      id(),
      owner,
      b.kind,
      b.title,
      b.content,
      b.sourceId ?? null,
      b.validUntil ?? null,
      confirmed,
      expected + 1,
    ],
  );
  const snap = confirmed
    ? await snapshotCareer(db, owner)
    : { revision: expected };
  await audit(db, owner, "fact.created", f.id);
  return { fact: f, ...snap };
}
export async function confirmFacts(
  db: DB,
  owner: string,
  ids: string[],
  expected: number,
) {
  await lockUser(db, owner, expected);
  for (const fid of ids) {
    const f = await owned(db, "facts", owner, fid, true);
    if (f.revoked_at) throw new DomainError("FACT_REVOKED", 409);
    await db.query(
      "UPDATE facts SET confirmed=true WHERE id=$1 AND owner_id=$2",
      [fid, owner],
    );
  }
  return snapshotCareer(db, owner);
}
export async function revokeFact(
  db: DB,
  owner: string,
  fid: string,
  expected: number,
) {
  await lockUser(db, owner, expected);
  await owned(db, "facts", owner, fid, true);
  await db.query(
    "UPDATE facts SET revoked_at=now() WHERE id=$1 AND owner_id=$2",
    [fid, owner],
  );
  await db.query(
    "UPDATE authorizations SET revoked_at=now() WHERE owner_id=$1 AND consumed_at IS NULL",
    [owner],
  );
  return snapshotCareer(db, owner);
}
export async function validateResume(
  db: DB,
  owner: string,
  resume: { fact_ids: string[]; approved_at?: unknown; blocks: any[] },
) {
  const facts = (
    await db.query(
      "SELECT * FROM facts WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [owner, resume.fact_ids],
    )
  ).rows;
  const missing = resume.fact_ids.filter((x) => !facts.some((f) => f.id === x));
  if (missing.length) throw new DomainError("UNSUPPORTED_FACT_REFERENCE", 422);
  const invalid = facts.filter(
    (f) =>
      !f.confirmed ||
      f.revoked_at ||
      (f.valid_until && new Date(f.valid_until) < new Date()),
  );
  return {
    eligible: Boolean(resume.approved_at) && !invalid.length,
    issues: [
      ...(!resume.approved_at ? ["TEXT_NOT_CONFIRMED"] : []),
      ...(invalid.length ? ["SOURCE_WITHDRAWN_OR_EXPIRED"] : []),
    ],
    facts,
  };
}
export async function createResume(db: DB, owner: string, input: unknown) {
  const b = resumeSchema.parse(input);
  const revision = await one(
    db,
    "SELECT * FROM career_revisions WHERE owner_id=$1 AND revision=$2",
    [owner, b.careerRevision],
  );
  if (!revision) throw new DomainError("CAREER_REVISION_REQUIRED", 422);
  if (b.jobId) await owned(db, "jobs", owner, b.jobId);
  if (b.parentId) await owned(db, "resumes", owner, b.parentId);
  const factIds = [...new Set(b.blocks.flatMap((x) => x.factIds))];
  const permitted = new Set(revision.facts.map((f: any) => f.id));
  if (factIds.some((fid) => !permitted.has(fid)))
    throw new DomainError("FACT_OUTSIDE_REVISION", 422);
  await validateResume(db, owner, { fact_ids: factIds, blocks: b.blocks });
  return one(
    db,
    "INSERT INTO resumes(id,owner_id,title,language,career_revision,job_id,parent_id,blocks,fact_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    [
      id(),
      owner,
      b.title,
      b.language,
      b.careerRevision,
      b.jobId ?? null,
      b.parentId ?? null,
      JSON.stringify(b.blocks),
      factIds,
    ],
  );
}
export async function saveJob(
  db: DB,
  owner: string,
  input: unknown,
  provider = "manual",
  externalId?: string,
  metadata: unknown = {},
) {
  const b = jobSchema.parse(input);
  if (b.url && !/^https?:\/\//.test(b.url)) throw new DomainError("UNSAFE_URL");
  const external =
    externalId ?? hash(b.url || canonical([b.company, b.title, b.description]));
  return one(
    db,
    "INSERT INTO jobs(id,owner_id,provider,external_id,title,company,location,market,url,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(owner_id,provider,external_id) DO UPDATE SET title=excluded.title,description=excluded.description,location=excluded.location,metadata=excluded.metadata,updated_at=now() RETURNING *",
    [
      id(),
      owner,
      provider,
      external,
      b.title,
      b.company,
      b.location,
      b.market,
      b.url,
      b.description,
      JSON.stringify(metadata),
    ],
  );
}
export async function createApplication(
  db: DB,
  owner: string,
  jobId: string,
  resumeId?: string,
) {
  await owned(db, "jobs", owner, jobId);
  if (resumeId) await owned(db, "resumes", owner, resumeId);
  return one(
    db,
    "INSERT INTO applications(id,owner_id,job_id,resume_id) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,job_id,cycle) DO NOTHING RETURNING *",
    [id(), owner, jobId, resumeId ?? null],
  ).then(
    async (row) =>
      row ??
      (await one(
        db,
        "SELECT * FROM applications WHERE owner_id=$1 AND job_id=$2 AND cycle=1",
        [owner, jobId],
      )),
  );
}
export async function applyManualEvent(db: DB, owner: string, input: unknown) {
  const b = manualEventSchema.parse(input);
  await lockUser(db, owner);
  const app = await owned(db, "applications", owner, b.applicationId, true);
  if (app.version !== b.expectedVersion)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (b.type === "submitted" && app.submitted_at)
    throw new DomainError("ALREADY_SUBMITTED", 409);
  if (new Date(b.occurredAt).getTime() > Date.now() + 60000)
    throw new DomainError("EVENT_CANNOT_BE_IN_FUTURE", 422);
  if (
    b.type !== "submitted" &&
    ["accepted", "offer_declined", "withdrawn", "rejected"].includes(app.status)
  )
    throw new DomainError("APPLICATION_CLOSED", 409);
  let dossierId: string | null = null;
  if (b.type === "submitted") {
    const job = await owned(db, "jobs", owner, app.job_id);
    const resume = app.resume_id
      ? await owned(db, "resumes", owner, app.resume_id)
      : null;
    const snapshot = {
      job,
      resume,
      recordedAt: new Date().toISOString(),
      source: "user_reported",
      note: "User reports this resume version was used. External delivery is not independently verified.",
    };
    const dossier = await one(
      db,
      "INSERT INTO dossiers(id,owner_id,application_id,hash,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [
        id(),
        owner,
        app.id,
        hash(canonical(snapshot)),
        JSON.stringify(snapshot),
      ],
    );
    dossierId = dossier.id;
  }
  if (b.type === "interview_invited") {
    await db.query(
      "INSERT INTO interviews(id,owner_id,application_id,round,status) VALUES($1,$2,$3,'邀請','invited')",
      [id(), owner, app.id],
    );
  }
  await db.query(
    "INSERT INTO application_events(id,owner_id,application_id,type,payload,source,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      id(),
      owner,
      app.id,
      b.type,
      JSON.stringify({ notes: b.notes, dossierId }),
      "user_reported",
      b.occurredAt,
    ],
  );
  let status = {
    submitted: "submitted",
    interview_invited: "interviewing",
    rejected: "rejected",
    withdrawn: "withdrawn",
  }[b.type];
  if (b.type === "submitted" && app.status !== "preparing") status = app.status;
  return one(
    db,
    "UPDATE applications SET status=$1,version=version+1,submitted_at=CASE WHEN $2 THEN $3::timestamptz ELSE submitted_at END WHERE id=$4 AND owner_id=$5 RETURNING *",
    [status, b.type === "submitted", b.occurredAt, app.id, owner],
  );
}
export async function prepareDossier(db: DB, owner: string, appId: string) {
  await lockUser(db, owner);
  const app = await owned(db, "applications", owner, appId, true);
  if (app.submitted_at) throw new DomainError("ALREADY_SUBMITTED", 409);
  if (!app.resume_id) throw new DomainError("RESUME_REQUIRED", 422);
  const r = await owned(db, "resumes", owner, app.resume_id);
  const valid = await validateResume(db, owner, r);
  if (!valid.eligible)
    throw new DomainError("RESUME_NEEDS_REVIEW", 422, valid.issues);
  const j = await owned(db, "jobs", owner, app.job_id);
  const answers = (
    await db.query(
      "SELECT * FROM answers WHERE owner_id=$1 AND reusable=true AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until>now())",
      [owner],
    )
  ).rows;
  const snapshot = {
    job: j,
    resume: r,
    answers: answers.filter(
      (a) =>
        a.country === j.market && (a.company === "" || a.company === j.company),
    ),
    preparedAt: new Date().toISOString(),
  };
  const h = hash(canonical(snapshot));
  return one(
    db,
    "INSERT INTO dossiers(id,owner_id,application_id,hash,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [id(), owner, appId, h, JSON.stringify(snapshot)],
  );
}
export async function newTask(
  db: DB,
  owner: string,
  kind: string,
  input: Record<string, unknown>,
) {
  const u = await lockUser(db, owner);
  const pending = await one(
    db,
    "SELECT count(*)::int AS n FROM tasks WHERE owner_id=$1 AND status IN ('queued','running','waiting_client')",
    [owner],
  );
  if (pending.n >= 20) throw new DomainError("TOO_MANY_PENDING_TASKS", 429);
  const ai = [
    "extract_experience",
    "generate_resume",
    "career_analysis",
  ].includes(kind);
  if (ai && u.settings.mode === "manual")
    throw new DomainError("AI_MODE_DISABLED", 422);
  const status = ai && u.settings.mode !== "byok" ? "waiting_client" : "queued";
  const source = input.sourceId
    ? await owned(db, "sources", owner, z.string().uuid().parse(input.sourceId))
    : null;
  const job = input.jobId
    ? await owned(db, "jobs", owner, z.string().uuid().parse(input.jobId))
    : null;
  if (["extract_experience", "transcribe"].includes(kind) && !source)
    throw new DomainError("SOURCE_REQUIRED", 422);
  if (kind === "extract_experience" && !source.content)
    throw new DomainError("SOURCE_TEXT_REQUIRED", 422);
  const jobs =
    kind === "career_analysis"
      ? (
          await db.query(
            "SELECT id,title,company,market,description,updated_at FROM jobs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20",
            [owner],
          )
        ).rows
      : [];
  if (kind === "career_analysis" && !jobs.length)
    throw new DomainError("CAREER_JOB_SAMPLE_REQUIRED", 422);
  const snapshot = {
    ...input,
    careerRevision: u.revision,
    sourceSnapshot: source,
    jobSnapshot: job,
    jobSample: jobs,
  };
  return one(
    db,
    "INSERT INTO tasks(id,owner_id,kind,status,input) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [id(), owner, kind, status, JSON.stringify(snapshot)],
  );
}
export async function taskContext(db: DB, owner: string, taskId: string) {
  const task = await owned(db, "tasks", owner, taskId);
  const revision = await one(
    db,
    "SELECT * FROM career_revisions WHERE owner_id=$1 AND revision=$2",
    [owner, task.input.careerRevision],
  );
  const source =
    task.input.sourceSnapshot ??
    (task.input.sourceId
      ? await owned(db, "sources", owner, task.input.sourceId)
      : null);
  const job =
    task.input.jobSnapshot ??
    (task.input.jobId
      ? await owned(db, "jobs", owner, task.input.jobId)
      : null);
  const jobs: any[] = task.input.jobSample ?? [];
  return {
    task,
    career: revision?.facts ?? [],
    source,
    job,
    jobs,
    inputHash: hash(canonical(task.input)),
  };
}
export async function acceptGeneration(
  db: DB,
  owner: string,
  taskId: string,
  inputHash: string,
  result: unknown,
) {
  const t = await owned(db, "tasks", owner, taskId, true);
  if (!["waiting_client", "running"].includes(t.status))
    throw new DomainError("TASK_NOT_ACCEPTING_RESULT", 409);
  if (hash(canonical(t.input)) !== inputHash)
    throw new DomainError("STALE_INPUT", 409);
  let output: any;
  if (t.kind === "extract_experience") {
    const candidate = z
      .object({
        facts: z
          .array(factSchema.omit({ sourceId: true }))
          .min(1)
          .max(40),
      })
      .strict()
      .parse(result);
    const ids = [];
    for (const f of candidate.facts) {
      const row = await one(
        db,
        "INSERT INTO facts(id,owner_id,kind,title,content,source_id,confirmed,revision,valid_until) VALUES($1,$2,$3,$4,$5,$6,false,$7,$8) RETURNING id",
        [
          id(),
          owner,
          f.kind,
          f.title,
          f.content,
          t.input.sourceId ?? null,
          t.input.careerRevision,
          f.validUntil ?? null,
        ],
      );
      ids.push(row.id);
    }
    output = { factIds: ids, needsConfirmation: true };
  } else if (t.kind === "generate_resume") {
    const b = resumeSchema
      .omit({ careerRevision: true, jobId: true, parentId: true })
      .parse(result);
    const resume = await createResume(db, owner, {
      ...b,
      careerRevision: t.input.careerRevision,
      jobId: t.input.jobId ?? null,
    });
    output = { resumeId: resume.id, needsConfirmation: true };
  } else if (t.kind === "career_analysis") {
    const b = z
      .object({
        title: z.string().max(160),
        directions: z
          .array(
            z.object({
              title: z.string().max(160),
              reason: z.string().max(3000),
              evidenceJobIds: z.array(z.string().uuid()),
              gaps: z.array(
                z.object({
                  skill: z.string(),
                  state: z.enum(["unknown", "evidence_needed"]),
                  reason: z.string(),
                }),
              ),
            }),
          )
          .max(3),
        tasks: z
          .array(
            z.object({
              title: z.string().max(200),
              output: z.string().max(3000),
            }),
          )
          .max(12),
      })
      .strict()
      .parse(result);
    const context = await taskContext(db, owner, taskId);
    const sampleIds = new Set(context.jobs.map((j) => j.id));
    if (
      b.directions.some((d) => d.evidenceJobIds.some((j) => !sampleIds.has(j)))
    )
      throw new DomainError("INVALID_CAREER_EVIDENCE", 422);
    const p = await one(
      db,
      "INSERT INTO career_plans(id,owner_id,title,career_revision,sample,content) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        id(),
        owner,
        b.title,
        t.input.careerRevision,
        JSON.stringify(
          context.jobs.map((j) => ({
            id: j.id,
            market: j.market,
            updatedAt: j.updated_at,
          })),
        ),
        JSON.stringify(b),
      ],
    );
    for (const task of b.tasks)
      await db.query(
        "INSERT INTO growth_tasks(id,owner_id,plan_id,title,output) VALUES($1,$2,$3,$4,$5)",
        [id(), owner, p.id, task.title, task.output],
      );
    output = { planId: p.id };
  } else throw new DomainError("UNSUPPORTED_GENERATION", 422);
  await db.query(
    "UPDATE tasks SET status='succeeded',result=$1,updated_at=now() WHERE id=$2 AND owner_id=$3",
    [JSON.stringify(output), taskId, owner],
  );
  return output;
}
