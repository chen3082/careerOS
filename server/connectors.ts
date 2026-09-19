import { z } from "zod";
import { DomainError, pool, owned } from "./db.js";
import { saveJob } from "./domain.js";
const board = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export async function jsonFetch(url: string, options: RequestInit = {}) {
  const r = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok)
    throw new DomainError(
      "PROVIDER_HTTP_" + r.status,
      r.status === 429 ? 429 : 502,
    );
  const length = Number(r.headers.get("content-length") ?? 0);
  if (length > 8 * 1024 * 1024)
    throw new DomainError("PROVIDER_RESPONSE_TOO_LARGE", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!r.body) throw new DomainError("PROVIDER_EMPTY_RESPONSE", 502);
  for await (const chunk of r.body as any) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024)
      throw new DomainError("PROVIDER_RESPONSE_TOO_LARGE", 502);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function strip(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
export async function searchJobs(owner: string, input: unknown) {
  const b = z
    .object({
      provider: z.enum(["greenhouse", "lever", "arbeitnow"]),
      board: z.string().default(""),
      query: z.string().max(120).default(""),
      market: z.enum(["TW", "US", "INTL"]).default("INTL"),
    })
    .parse(input);
  let jobs: any[] = [];
  if (b.provider === "greenhouse") {
    const company = board.parse(b.board);
    const body = await jsonFetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs?content=true`,
    );
    jobs = (body.jobs ?? []).map((j: any) => ({
      id: String(j.id),
      title: j.title,
      company: j.company_name ?? company,
      location: j.location?.name ?? "",
      description: strip(j.content ?? ""),
      url: j.absolute_url,
      metadata: { board: company, externalId: String(j.id) },
    }));
  }
  if (b.provider === "lever") {
    const company = board.parse(b.board);
    const body = await jsonFetch(
      `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`,
    );
    jobs = body.map((j: any) => ({
      id: j.id,
      title: j.text,
      company,
      location: j.categories?.location ?? "",
      description:
        strip(j.descriptionPlain ?? j.description ?? "") +
        " " +
        (j.lists ?? []).map((l: any) => strip(l.content ?? "")).join("\n"),
      url: j.hostedUrl,
      metadata: { board: company, externalId: j.id },
    }));
  }
  if (b.provider === "arbeitnow") {
    const body = await jsonFetch("https://www.arbeitnow.com/api/job-board-api");
    jobs = (body.data ?? []).map((j: any) => ({
      id: j.slug,
      title: j.title,
      company: j.company_name,
      location: j.location ?? "",
      description: strip(j.description ?? ""),
      url: j.url,
      metadata: { remote: j.remote },
    }));
  }
  const query = b.query.toLocaleLowerCase();
  const matching = jobs.filter(
    (j) =>
      (!query ||
        (j.title + " " + j.description + " " + j.company)
          .toLocaleLowerCase()
          .includes(query)) &&
      (b.market !== "TW" ||
        /taiwan|taipei|台灣|臺灣|台北|臺北|新竹|kaohsiung|taichung/i.test(
          j.location,
        )) &&
      (b.market !== "US" ||
        /united states|\busa?\b|new york|san francisco|california|seattle|boston|austin|chicago/i.test(
          j.location,
        )),
  );
  let saved = 0;
  for (const j of matching.slice(0, 100)) {
    if (!j.description) continue;
    await saveJob(
      pool,
      owner,
      {
        title: j.title.slice(0, 200),
        company: j.company.slice(0, 200),
        location: j.location.slice(0, 200),
        market: b.market,
        url: j.url ?? "",
        description: j.description.slice(0, 20000),
      },
      b.provider,
      j.id,
      j.metadata,
    );
    saved++;
  }
  return {
    saved,
    matched: matching.length,
    sourceCount: jobs.length,
    provider: b.provider,
    board: b.board,
    fetchedAt: new Date().toISOString(),
    note: "僅涵蓋此來源與本次樣本；未標明地域的遠端職缺不推定適用任何國家。",
  };
}
