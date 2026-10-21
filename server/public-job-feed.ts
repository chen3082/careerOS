import { isIP } from "node:net";
import { z } from "zod";
import { DomainError } from "./db.js";

export const providerSchema = z.enum(["greenhouse", "lever", "arbeitnow"]);
export const boardSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export type CatalogSource = {
  id: string;
  provider: z.infer<typeof providerSchema>;
  board: string;
  label: string;
};
export type PublicJob = {
  externalId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  markets: string[];
};
export type PublicFeed = { jobs: PublicJob[]; complete: boolean };

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
  if (Number(r.headers.get("content-length") ?? 0) > 8 * 1024 * 1024)
    throw new DomainError("PROVIDER_RESPONSE_TOO_LARGE", 502);
  if (!r.body) throw new DomainError("PROVIDER_EMPTY_RESPONSE", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
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
export function inferMarkets(location: string) {
  const markets = [];
  if (
    /taiwan|taipei|台灣|臺灣|台北|臺北|新竹|kaohsiung|taichung/i.test(location)
  )
    markets.push("TW");
  if (
    /united states|\busa?\b|new york|san francisco|california|seattle|boston|austin|chicago|san diego|los angeles|washington,? dc/i.test(
      location,
    )
  )
    markets.push("US");
  return markets;
}
const required = z.string().trim().min(1);
const job = z.object({
  externalId: required.max(200),
  title: required.max(200),
  company: required.max(200),
  location: z.string().max(400),
  url: z.string().url().max(2000),
  description: required.max(20000),
  markets: z.array(z.enum(["TW", "US"])),
});
export function validatePublicFeed(input: PublicFeed): PublicFeed {
  const parsed = z
    .object({ jobs: z.array(job).max(5000), complete: z.boolean() })
    .parse(input);
  const ids = new Set<string>();
  for (const j of parsed.jobs) {
    const url = new URL(j.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !url.hostname.includes(".") ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
      /\.(localhost|local|internal)$/.test(url.hostname) ||
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname)
    )
      throw new DomainError("PROVIDER_UNSAFE_JOB_URL", 502);
    if (ids.has(j.externalId))
      throw new DomainError("PROVIDER_DUPLICATE_JOB", 502);
    ids.add(j.externalId);
  }
  return parsed;
}
// The only outbound destinations are these fixed public provider API hosts.
// Never fetch URLs from job descriptions, user-supplied pages or provider pagination links.
export async function fetchPublicJobs(
  source: CatalogSource,
): Promise<PublicFeed> {
  const provider = providerSchema.parse(source.provider);
  const board = provider === "arbeitnow" ? "" : boardSchema.parse(source.board);
  let jobs: PublicJob[] = [];
  let complete = true;
  const toJob = (j: any): PublicJob => {
    const location = String(
      provider === "lever"
        ? (j.categories?.location ?? "")
        : provider === "greenhouse"
          ? (j.location?.name ?? "")
          : (j.location ?? ""),
    ).slice(0, 400);
    return {
      externalId: String(
        provider === "arbeitnow" ? (j.slug ?? "") : (j.id ?? ""),
      ),
      title: String(
        provider === "lever" ? (j.text ?? "") : (j.title ?? ""),
      ).slice(0, 200),
      company: String(j.company_name ?? source.label).slice(0, 200),
      location,
      url:
        provider === "lever"
          ? j.hostedUrl
          : provider === "greenhouse"
            ? j.absolute_url
            : j.url,
      description: strip(
        String(
          provider === "greenhouse"
            ? (j.content ?? "")
            : (j.descriptionPlain ?? j.description ?? ""),
        ) +
          " " +
          (provider === "lever"
            ? (j.lists ?? []).map((l: any) => String(l.content ?? "")).join(" ")
            : ""),
      ).slice(0, 20000),
      markets: inferMarkets(location),
    };
  };
  if (provider === "greenhouse") {
    const body = await jsonFetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
    );
    if (!Array.isArray(body.jobs))
      throw new DomainError("PROVIDER_SHAPE_INVALID", 502);
    complete =
      body.jobs.length <= 5000 &&
      (body.meta?.total === undefined || body.meta.total === body.jobs.length);
    jobs = body.jobs.slice(0, 5000).map(toJob);
  } else if (provider === "lever") {
    // Bounded pagination: 4 requests maximum, within the 3-minute source lease.
    for (let skip = 0; skip < 2000; skip += 500) {
      const body = await jsonFetch(
        `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json&skip=${skip}&limit=500`,
      );
      if (!Array.isArray(body))
        throw new DomainError("PROVIDER_SHAPE_INVALID", 502);
      jobs.push(...body.map(toJob));
      if (body.length < 500) break;
      if (skip === 1500) complete = false;
    }
  } else {
    const body = await jsonFetch("https://www.arbeitnow.com/api/job-board-api");
    if (!Array.isArray(body.data))
      throw new DomainError("PROVIDER_SHAPE_INVALID", 502);
    jobs = body.data.slice(0, 5000).map(toJob);
    complete = false; // The first page is a sample, never evidence that a job closed.
  }
  return validatePublicFeed({ jobs, complete });
}
