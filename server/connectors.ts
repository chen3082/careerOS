import { z } from "zod";
import { DomainError, pool, one, tx } from "./db.js";
import {
  listCatalog,
  requestCatalogRefresh,
  runCatalogSource,
  saveCatalogJob,
} from "./catalog.js";
export { jsonFetch } from "./public-job-feed.js";

// Legacy search tasks still save matches privately, while every fetch first
// publishes the provider's unfiltered public feed into the common catalog.
export async function searchJobs(owner: string, input: unknown) {
  const b = z
    .object({
      provider: z.enum(["greenhouse", "lever", "arbeitnow"]),
      board: z.string().default(""),
      query: z.string().max(100).default(""),
      market: z.enum(["TW", "US", "INTL"]).default("INTL"),
    })
    .parse(input);
  const source = await one(
    pool,
    "SELECT id FROM catalog_sources WHERE provider=$1 AND board=$2 AND enabled",
    [b.provider, b.board],
  );
  if (!source) throw new DomainError("CATALOG_SOURCE_UNAVAILABLE", 404);
  const request = await requestCatalogRefresh(source.id);
  const refresh =
    request.status === "queued"
      ? await runCatalogSource(source.id)
      : { claimed: false };
  if ("error" in refresh) throw new DomainError(refresh.error!, 502);
  const result = await listCatalog(owner, {
    q: b.query,
    market: b.market === "INTL" ? "" : b.market,
    sourceId: source.id,
    limit: 100,
  });
  await tx(async (db) => {
    for (const job of result.items) await saveCatalogJob(db, owner, job.id);
  });
  const state = await one(
    pool,
    "SELECT job_count,last_success_at,status FROM catalog_sources WHERE id=$1",
    [source.id],
  );
  return {
    saved: result.items.length,
    matched: result.total,
    sourceCount: state.job_count,
    provider: b.provider,
    board: b.board,
    fetchedAt: state.last_success_at,
    refreshStatus: state.status,
    catalogUpdated: "published" in refresh && refresh.published,
    pending: ["queued", "running"].includes(state.status),
    note:
      "published" in refresh && refresh.published
        ? "來源已更新，共用清單和符合條件的私人職缺已保存。"
        : ["queued", "running"].includes(state.status)
          ? "來源仍在更新；目前保存的是既有共用清單的結果，完成後可再查詢。"
          : "使用最近一次共用清單的快取結果，沒有重新抓取來源。",
  };
}
