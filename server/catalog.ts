import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, tx, one, id, DomainError, type DB } from "./db.js";
import { config } from "./config.js";
import { requireUser, sameOrigin } from "./auth.js";
import { hash, canonical } from "./crypto.js";
import { lockUser, saveJob } from "./domain.js";
import {
  providerSchema,
  boardSchema,
  fetchPublicJobs,
  validatePublicFeed,
  type CatalogSource,
  type PublicFeed,
} from "./public-job-feed.js";

export const catalogQuery = z.object({
  q: z.string().trim().max(100).default(""),
  market: z.enum(["", "TW", "US", "INTL"]).default(""),
  sourceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const sourceColumns =
  "id,provider,board,label,enabled,interval_hours,version,status,next_fetch_at,last_attempt_at,last_success_at,last_error,job_count,new_count,changed_count,complete";
export async function catalogSources() {
  return {
    items: (
      await pool.query(
        `SELECT ${sourceColumns} FROM catalog_sources ORDER BY label`,
      )
    ).rows,
    pollingEnabled: config.CATALOG_POLLING === "true",
  };
}
export async function listCatalog(owner: string, input: unknown) {
  const q = catalogQuery.parse(input);
  // Search text and personal application state never enter the shared source tables.
  const match = `s.enabled AND c.availability='listed' AND ($2='' OR c.title ILIKE $3 OR c.company ILIKE $3 OR c.description ILIKE $3) AND ($4='' OR ($4='INTL' AND cardinality(c.markets)=0) OR $4=ANY(c.markets)) AND ($5::uuid IS NULL OR c.source_id=$5)`;
  const values = [
    owner,
    q.q,
    "%" + q.q.replace(/[\\%_]/g, "\\$&") + "%",
    q.market,
    q.sourceId ?? null,
  ];
  const items = (
    await pool.query(
      `SELECT c.*,s.provider,s.board,s.label AS source_label,s.last_success_at AS source_checked_at,s.status AS source_status,j.id AS saved_job_id,a.id AS application_id,a.status AS application_status,a.submitted_at FROM catalog_jobs c JOIN catalog_sources s ON s.id=c.source_id LEFT JOIN LATERAL (SELECT j.* FROM jobs j LEFT JOIN catalog_saves cs ON cs.owner_id=$1 AND cs.job_id=j.id AND cs.catalog_job_id=c.id WHERE j.owner_id=$1 AND (cs.job_id IS NOT NULL OR j.url=c.url) ORDER BY (cs.job_id IS NOT NULL) DESC,j.created_at,j.id LIMIT 1) j ON true LEFT JOIN applications a ON a.job_id=j.id AND a.owner_id=$1 AND a.cycle=1 WHERE ${match} ORDER BY c.first_seen_at DESC,c.id LIMIT $6 OFFSET $7`,
      [...values, q.limit, q.offset],
    )
  ).rows;
  const count = await one(
    pool,
    `SELECT count(*)::int AS total FROM catalog_jobs c JOIN catalog_sources s ON s.id=c.source_id WHERE ${match} AND $1::uuid IS NOT NULL`,
    values,
  );
  return { items, total: count.total, limit: q.limit, offset: q.offset };
}
export async function requestCatalogRefresh(sourceId: string) {
  return tx(async (db) => {
    const source = await one(
      db,
      "SELECT *,last_attempt_at>now()-interval '5 minutes' AS cooling FROM catalog_sources WHERE id=$1 FOR UPDATE",
      [z.string().uuid().parse(sourceId)],
    );
    if (!source || !source.enabled)
      throw new DomainError("CATALOG_SOURCE_UNAVAILABLE", 404);
    if (
      source.status === "running" &&
      new Date(source.lease_until).getTime() > Date.now()
    )
      return { status: "running", sourceId: source.id };
    if (source.cooling)
      return {
        status: "cooldown",
        sourceId: source.id,
        nextAllowedAt: new Date(
          new Date(source.last_attempt_at).getTime() + 300000,
        ).toISOString(),
      };
    await db.query(
      "UPDATE catalog_sources SET status='queued',refresh_requested=true,next_fetch_at=now() WHERE id=$1",
      [source.id],
    );
    return { status: "queued", sourceId: source.id };
  });
}
export async function claimCatalogSource(sourceId?: string, scheduled = true) {
  return tx(async (db) => {
    const source = await one(
      db,
      `SELECT * FROM catalog_sources WHERE enabled AND (refresh_requested OR $2::boolean OR status='running') AND next_fetch_at<=now() AND (lease_until IS NULL OR lease_until<=now()) AND ($1::uuid IS NULL OR id=$1) ORDER BY next_fetch_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [sourceId ?? null, scheduled],
    );
    if (!source) return null;
    const lease = id();
    await db.query(
      "UPDATE catalog_sources SET status='running',refresh_requested=false,lease_token=$2,lease_until=now()+interval '3 minutes',last_attempt_at=now(),last_error=NULL WHERE id=$1",
      [source.id, lease],
    );
    return { ...source, lease_token: lease } as CatalogSource & {
      lease_token: string;
    };
  });
}
export async function publishCatalogFeed(
  claim: CatalogSource & { lease_token: string },
  input: PublicFeed,
) {
  const feed = validatePublicFeed(input);
  return tx(async (db) => {
    const source = await one(
      db,
      "SELECT * FROM catalog_sources WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND enabled FOR UPDATE",
      [claim.id, claim.lease_token],
    );
    if (!source) return { published: false, newCount: 0, changedCount: 0 };
    const previous = new Map(
      (
        await db.query(
          "SELECT external_id,content_hash,availability FROM catalog_jobs WHERE source_id=$1",
          [claim.id],
        )
      ).rows.map((j) => [j.external_id, j]),
    );
    let newCount = 0,
      changedCount = 0;
    const rows = feed.jobs.map((j) => {
      const contentHash = hash(canonical(j));
      const old = previous.get(j.externalId);
      if (!old) newCount++;
      else if (
        old.content_hash !== contentHash ||
        old.availability !== "listed"
      )
        changedCount++;
      return {
        external_id: j.externalId,
        title: j.title,
        company: j.company,
        location: j.location,
        markets: j.markets,
        url: j.url,
        description: j.description,
        content_hash: contentHash,
      };
    });
    for (let n = 0; n < rows.length; n += 200) {
      await db.query(
        `INSERT INTO catalog_jobs(source_id,external_id,title,company,location,markets,url,description,content_hash)
        SELECT $1,r.external_id,r.title,r.company,r.location,r.markets,r.url,r.description,r.content_hash FROM jsonb_to_recordset($2::jsonb) AS r(external_id text,title text,company text,location text,markets text[],url text,description text,content_hash text)
        ON CONFLICT(source_id,external_id) DO UPDATE SET title=excluded.title,company=excluded.company,location=excluded.location,markets=excluded.markets,url=excluded.url,description=excluded.description,content_hash=excluded.content_hash,last_seen_at=now(),availability='listed',changed_at=CASE WHEN catalog_jobs.content_hash<>excluded.content_hash OR catalog_jobs.availability<>'listed' THEN now() ELSE catalog_jobs.changed_at END`,
        [claim.id, JSON.stringify(rows.slice(n, n + 200))],
      );
    }
    if (feed.complete)
      await db.query(
        "UPDATE catalog_jobs SET availability='not_listed' WHERE source_id=$1 AND external_id<>ALL($2::text[])",
        [claim.id, feed.jobs.map((j) => j.externalId)],
      );
    // Partial feeds retain older rows as stale; they do not prove closure.
    await db.query(
      "UPDATE catalog_sources SET status='idle',lease_token=NULL,lease_until=NULL,last_success_at=now(),next_fetch_at=now()+make_interval(hours=>interval_hours),failures=0,last_error=NULL,job_count=$2,new_count=$3,changed_count=$4,complete=$5 WHERE id=$1",
      [claim.id, feed.jobs.length, newCount, changedCount, feed.complete],
    );
    return { published: true, newCount, changedCount };
  });
}
export async function runCatalogSource(
  sourceId?: string,
  fetchFeed = fetchPublicJobs,
  scheduled = true,
) {
  const claim = await claimCatalogSource(sourceId, scheduled);
  if (!claim) return { claimed: false };
  try {
    const result = await publishCatalogFeed(claim, await fetchFeed(claim));
    return { claimed: true, ...result };
  } catch (e) {
    const code = e instanceof DomainError ? e.code : "CATALOG_FETCH_FAILED";
    await pool.query(
      "UPDATE catalog_sources SET status='failed',last_error=$3,failures=failures+1,next_fetch_at=now()+make_interval(mins=>LEAST(360,15*(1<<LEAST(failures,4)))),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
      [claim.id, claim.lease_token, code],
    );
    return { claimed: true, published: false, error: code };
  }
}
export async function saveCatalogJob(db: DB, owner: string, jobId: string) {
  await lockUser(db, owner);
  const c = await one(
    db,
    "SELECT c.*,s.provider,s.board FROM catalog_jobs c JOIN catalog_sources s ON s.id=c.source_id WHERE c.id=$1 AND c.availability='listed' AND s.enabled",
    [z.string().uuid().parse(jobId)],
  );
  if (!c) throw new DomainError("CATALOG_JOB_UNAVAILABLE", 404);
  // Exact public aliases reuse one private snapshot/application. Source identity
  // remains recorded even if a provider later changes its canonical URL.
  const existing = await one(
    db,
    `SELECT j.* FROM jobs j LEFT JOIN catalog_saves cs ON cs.job_id=j.id AND cs.owner_id=$1 AND cs.catalog_job_id=$2 WHERE j.owner_id=$1 AND (cs.job_id IS NOT NULL OR j.url=$3) ORDER BY (cs.job_id IS NOT NULL) DESC,j.created_at,j.id LIMIT 1 FOR UPDATE OF j`,
    [owner, c.id, c.url],
  );
  const saved =
    existing ??
    (await saveJob(
      db,
      owner,
      {
        title: c.title,
        company: c.company,
        location: c.location.slice(0, 200),
        market: c.markets.length === 1 ? c.markets[0] : "INTL",
        url: c.url,
        description: c.description,
      },
      c.provider,
      c.board + ":" + c.external_id,
      { board: c.board, externalId: c.external_id },
    ));
  await db.query(
    "INSERT INTO catalog_saves(owner_id,catalog_job_id,job_id) VALUES($1,$2,$3) ON CONFLICT(owner_id,catalog_job_id) DO NOTHING",
    [owner, c.id, saved.id],
  );
  return { ...saved, catalog_job_id: c.id };
}

export async function catalogRoutes(app: FastifyInstance) {
  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req) => {
        sameOrigin(req);
        await requireUser(req);
      });
      api.get("/catalog/jobs", (req) => listCatalog(req.user!.id, req.query));
      api.get("/catalog/sources", () => catalogSources());
      api.post("/catalog/sources/:id/refresh", (req) =>
        requestCatalogRefresh(
          z.object({ id: z.string().uuid() }).parse(req.params).id,
        ),
      );
      api.post("/catalog/jobs/:id/save", (req) =>
        tx((db) =>
          saveCatalogJob(
            db,
            req.user!.id,
            z.object({ id: z.string().uuid() }).parse(req.params).id,
          ),
        ),
      );
      api.post("/catalog/sources", async (req) => {
        if (req.user!.role !== "owner") throw new DomainError("FORBIDDEN", 403);
        const b = z
          .object({
            provider: providerSchema,
            board: boardSchema,
            label: z.string().trim().min(1).max(100),
          })
          .strict()
          .parse(req.body);
        if (b.provider === "arbeitnow")
          throw new DomainError("CATALOG_SOURCE_EXISTS", 409);
        return tx(async (db) => {
          await db.query("SELECT pg_advisory_xact_lock(901239)");
          if (
            (await one(db, "SELECT count(*)::int AS n FROM catalog_sources"))
              .n >= 50
          )
            throw new DomainError("CATALOG_SOURCE_LIMIT", 409);
          return one(
            db,
            `INSERT INTO catalog_sources(provider,board,label,refresh_requested) VALUES($1,$2,$3,true) ON CONFLICT(provider,board) DO UPDATE SET label=catalog_sources.label RETURNING ${sourceColumns}`,
            [b.provider, b.board, b.label],
          );
        });
      });
      api.patch("/catalog/sources/:id", async (req) => {
        if (req.user!.role !== "owner") throw new DomainError("FORBIDDEN", 403);
        const sourceId = z
          .object({ id: z.string().uuid() })
          .parse(req.params).id;
        const b = z
          .object({
            enabled: z.boolean(),
            intervalHours: z.number().int().min(1).max(24),
            expectedVersion: z.number().int().nonnegative(),
          })
          .strict()
          .parse(req.body);
        const result = await one(
          pool,
          `UPDATE catalog_sources SET enabled=$2,refresh_requested=$2,interval_hours=$3,version=version+1,lease_token=NULL,lease_until=NULL,status=CASE WHEN $2 THEN 'queued' ELSE 'idle' END,next_fetch_at=GREATEST(now(),coalesce(last_attempt_at+interval '5 minutes',now())) WHERE id=$1 AND version=$4 RETURNING ${sourceColumns}`,
          [sourceId, b.enabled, b.intervalHours, b.expectedVersion],
        );
        if (!result) throw new DomainError("VERSION_CONFLICT", 409);
        return result;
      });
    },
    { prefix: config.basePath + "/api" },
  );
}
