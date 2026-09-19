import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../server/index.js";
import { config } from "../server/config.js";
import { pool } from "../server/db.js";
import {
  claimCatalogSource,
  publishCatalogFeed,
  runCatalogSource,
} from "../server/catalog.js";
import { fetchPublicJobs, type PublicFeed } from "../server/public-job-feed.js";
import { DomainError } from "../server/db.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
assert.equal(config.NODE_ENV, "test");
assert.ok(new URL(config.DATABASE_URL).pathname.endsWith("_test"));
if (process.env.E2E_OUTPUT) {
  assert.equal(new URL(config.DATABASE_URL).hostname, "postgres-e2e");
  assert.equal(config.dataDir, "/tmp/careeros-mcp-e2e-data");
}
const output = process.env.E2E_OUTPUT ?? "/tmp/careeros-catalog-report";
await mkdir(output, { recursive: true, mode: 0o700 });
const app = await buildApp();
const clients: Client[] = [],
  checks: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cookie = "",
  otherCookie = "",
  owner = "";
const passed = (name: string) => {
  checks.push(name);
  console.log("PASS", name);
};
async function api(
  method: string,
  endpoint: string,
  body?: unknown,
  expected = 200,
  actorCookie = cookie,
  origin = config.origin,
): Promise<any> {
  const response = await fetch(config.PUBLIC_URL + "/api" + endpoint, {
    method,
    headers: {
      origin,
      cookie: actorCookie,
      "idempotency-key": randomUUID(),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${endpoint}: ${JSON.stringify(result)}`,
  );
  return result;
}
async function register(email: string, invite: string) {
  const r = await fetch(config.PUBLIC_URL + "/api/auth/register", {
    method: "POST",
    headers: { origin: config.origin, "content-type": "application/json" },
    body: JSON.stringify({
      email,
      name: "Fictional Catalog QA",
      password: "account-qa-synthetic-password",
      invite,
    }),
  });
  assert.equal(r.status, 200);
  const data: any = await r.json();
  return {
    id: data.user.id,
    cookie: r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
async function connectMcp(
  scope = "careeros:read careeros:write",
  actorCookie = cookie,
) {
  const registered = await fetch(config.PUBLIC_URL + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Shared catalog isolated QA",
      redirect_uris: ["http://127.0.0.1:9922/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registered.status, 201);
  const client: any = await registered.json(),
    verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope,
    resource: config.PUBLIC_URL + "/mcp",
    state: randomUUID(),
  });
  const authorize = await fetch(
    config.PUBLIC_URL + "/oauth/authorize?" + query,
    { redirect: "manual" },
  );
  assert.equal(authorize.status, 302);
  const rid = new URL(authorize.headers.get("location")!).hash.slice(
    "#consent=".length,
  );
  const consent = await api(
    "POST",
    "/oauth/consent/" + rid,
    { approve: true },
    200,
    actorCookie,
  );
  const exchanged = await fetch(config.PUBLIC_URL + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code: new URL(consent.redirect).searchParams.get("code")!,
      code_verifier: verifier,
      resource: config.PUBLIC_URL + "/mcp",
    }),
  });
  assert.equal(exchanged.status, 200);
  const token: any = await exchanged.json();
  const mcp = new Client({ name: "shared-catalog-qa", version: "1.0" });
  clients.push(mcp);
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(config.PUBLIC_URL + "/mcp"), {
      requestInit: {
        headers: { authorization: "Bearer " + token.access_token },
      },
    }),
  );
  return mcp;
}
async function tool(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
  error?: string,
) {
  const result: any = await mcp.callTool({ name, arguments: args });
  if (error) {
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, error);
    return;
  }
  assert.ok(!result.isError, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}
const feeds = (
  title = "Public Backend Engineer",
  complete = true,
): PublicFeed => ({
  complete,
  jobs: [
    {
      externalId: "qa-1",
      title,
      company: "Public QA Company",
      location: "Taipei, Taiwan",
      url: "https://job-boards.greenhouse.io/catalog-fixture/jobs/1",
      description: "PUBLIC QA ONLY TypeScript PostgreSQL",
      markets: ["TW"],
    },
    {
      externalId: "qa-2",
      title: "Public Data Engineer",
      company: "Public QA Company",
      location: "San Francisco, US",
      url: "https://job-boards.greenhouse.io/catalog-fixture/jobs/2",
      description: "PUBLIC QA ONLY Python SQL",
      markets: ["US"],
    },
  ],
});
let source: any, other: any, worker: ReturnType<typeof spawn> | undefined;
async function due(sourceId = source.id) {
  await pool.query(
    "UPDATE catalog_sources SET next_fetch_at=now()-interval '1 second',last_attempt_at=NULL,refresh_requested=false,lease_token=NULL,lease_until=NULL WHERE id=$1",
    [sourceId],
  );
}
async function ingest(feed = feeds(), sourceId = source.id) {
  await due(sourceId);
  return runCatalogSource(sourceId, async () => feed);
}
let failure: unknown;
try {
  await pool.query("TRUNCATE users,oauth_clients,auth_throttles CASCADE");
  await pool.query("UPDATE catalog_sources SET enabled=false");
  await app.listen({ port: config.PORT, host: "127.0.0.1" });
  const first = await register(
    "catalog-owner@example.test",
    config.BOOTSTRAP_TOKEN!,
  );
  cookie = first.cookie;
  owner = first.id;
  const invite = await api("POST", "/auth/invites", {});
  const second = await register("catalog-member@example.test", invite.token);
  otherCookie = second.cookie;
  await api("GET", "/catalog/jobs", undefined, 401, "");
  await api(
    "POST",
    "/catalog/sources",
    {
      provider: "greenhouse",
      board: "catalog-fixture",
      label: "Public QA Company",
    },
    403,
    otherCookie,
  );
  await api(
    "POST",
    "/catalog/sources",
    { provider: "greenhouse", board: "https://127.0.0.1", label: "Invalid" },
    422,
  );
  source = await api("POST", "/catalog/sources", {
    provider: "greenhouse",
    board: "catalog-fixture",
    label: "Public QA Company",
  });
  await api(
    "POST",
    `/catalog/sources/${source.id}/refresh`,
    {},
    403,
    cookie,
    "https://attacker.invalid",
  );
  await Promise.all(
    Array.from({ length: 8 }, () =>
      api(
        "POST",
        `/catalog/sources/${source.id}/refresh`,
        {},
        200,
        otherCookie,
      ),
    ),
  );
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => claimCatalogSource(source.id)),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  await publishCatalogFeed(claims.find(Boolean)!, feeds());
  assert.equal(
    (await api("POST", `/catalog/sources/${source.id}/refresh`, {})).status,
    "cooldown",
  );
  const aList = await api("GET", "/catalog/jobs"),
    bList = await api("GET", "/catalog/jobs", undefined, 200, otherCookie);
  assert.deepEqual(
    aList.items.map((j: any) => j.id),
    bList.items.map((j: any) => j.id),
  );
  assert.equal(aList.total, 2);
  assert.equal((await api("GET", "/catalog/jobs?market=TW")).total, 1);
  assert.equal((await api("GET", "/catalog/jobs?q=%25")).total, 0);
  assert.equal(
    (await api("GET", "/catalog/jobs?limit=1&offset=1")).items.length,
    1,
  );
  passed(
    "One shared crawl for concurrent requests; both users see the same public IDs; filters/pagination/auth/CSRF/owner-only source management",
  );

  const publicJob = aList.items.find((j: any) => j.markets.includes("TW"));
  const saved = await Promise.all(
    Array.from({ length: 6 }, () =>
      api("POST", `/catalog/jobs/${publicJob.id}/save`, {}),
    ),
  );
  assert.equal(new Set(saved.map((j) => j.id)).size, 1);
  const application = await api("POST", "/applications", {
    jobId: saved[0].id,
  });
  assert.equal(
    (await api("GET", "/catalog/jobs?market=TW")).items[0].application_id,
    application.id,
  );
  assert.equal(
    (await api("GET", "/catalog/jobs?market=TW", undefined, 200, otherCookie))
      .items[0].application_id,
    null,
  );
  assert.equal(
    (await api("GET", "/jobs", undefined, 200, otherCookie)).items.length,
    0,
  );
  await api("POST", "/applications", { jobId: saved[0].id }, 404, otherCookie);
  const privateJob = await api("POST", "/jobs", {
    title: "PRIVATE UNPUBLISHED JOB",
    company: "PRIVATE COMPANY",
    market: "TW",
    url: "https://private.example.test/job",
    description: "PRIVATE CANDIDATE NOTES",
  });
  await api(
    "POST",
    "/jobs",
    {
      title: "Member private snapshot",
      company: "Private naming",
      market: "TW",
      url: publicJob.url,
      description: "PRIVATE custom job notes",
    },
    200,
    otherCookie,
  );
  const existingOverlay = (
    await api("GET", "/catalog/jobs?market=TW", undefined, 200, otherCookie)
  ).items[0];
  assert.ok(
    existingOverlay.saved_job_id,
    "Existing private URL appears as saved before catalog import",
  );
  const reused = await api(
    "POST",
    `/catalog/jobs/${publicJob.id}/save`,
    {},
    200,
    otherCookie,
  );
  assert.equal(reused.description, "PRIVATE custom job notes");
  assert.ok(
    !JSON.stringify(await api("GET", "/catalog/jobs")).includes("PRIVATE"),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM catalog_jobs WHERE title=$1",
        [privateJob.title],
      )
    ).rows[0].n,
    0,
  );
  const rw = await connectMcp(),
    ro = await connectMcp("careeros:read", otherCookie);
  assert.equal(
    (await tool(rw, "catalog_search", { market: "TW" })).items[0]
      .application_id,
    application.id,
  );
  assert.equal(
    (await tool(ro, "catalog_search", { market: "TW" })).items[0]
      .application_id,
    null,
  );
  assert.ok(
    !(await ro.listTools()).tools.some((t) => t.name === "catalog_refresh"),
  );
  let denied = false;
  try {
    denied = Boolean(
      (
        await ro.callTool({
          name: "catalog_refresh",
          arguments: { sourceId: source.id },
        })
      ).isError,
    );
  } catch {
    denied = true;
  }
  assert.ok(denied, "Read-only MCP cannot trigger refresh");
  await tool(rw, "catalog_save", { jobId: publicJob.id });
  const mcpSources = await tool(ro, "catalog_sources", {});
  assert.ok(!JSON.stringify(mcpSources).includes("lease_token"));
  passed(
    "Private imports never publish; private snapshots/applications remain isolated; concurrent save is idempotent; real OAuth MCP read/write scopes enforced",
  );

  assert.deepEqual(await ingest(), {
    claimed: true,
    published: true,
    newCount: 0,
    changedCount: 0,
  });
  const before = await pool.query(
    "SELECT first_seen_at,changed_at FROM catalog_jobs WHERE id=$1",
    [publicJob.id],
  );
  const updated = await ingest(feeds("Updated public title"));
  assert.ok("changedCount" in updated && updated.changedCount === 1);
  assert.equal(
    (
      await pool.query("SELECT first_seen_at FROM catalog_jobs WHERE id=$1", [
        publicJob.id,
      ])
    ).rows[0].first_seen_at.getTime(),
    before.rows[0].first_seen_at.getTime(),
  );
  assert.equal(
    (await api("GET", "/jobs")).items.find((j: any) => j.id === saved[0].id)
      .title,
    "Public Backend Engineer",
  );
  await ingest({ complete: false, jobs: [] });
  assert.equal((await api("GET", "/catalog/jobs")).total, 2);
  await due();
  await runCatalogSource(source.id, async () => {
    throw new DomainError("PROVIDER_HTTP_429", 429);
  });
  assert.equal((await api("GET", "/catalog/jobs")).total, 2);
  assert.equal(
    (await api("GET", "/catalog/sources")).items.find(
      (s: any) => s.id === source.id,
    ).last_error,
    "PROVIDER_HTTP_429",
  );
  await ingest({ complete: true, jobs: [feeds().jobs[0]] });
  assert.equal((await api("GET", "/catalog/jobs")).total, 1);
  await ingest();
  await due();
  const stale = (await claimCatalogSource(source.id))!;
  await pool.query(
    "UPDATE catalog_sources SET lease_until=now()-interval '1 second' WHERE id=$1",
    [source.id],
  );
  const fresh = (await claimCatalogSource(source.id))!;
  assert.equal(
    (await publishCatalogFeed(stale, { complete: true, jobs: [] })).published,
    false,
  );
  await publishCatalogFeed(fresh, feeds());
  await due();
  const revoked = (await claimCatalogSource(source.id))!;
  const s = (await api("GET", "/catalog/sources")).items.find(
    (s: any) => s.id === source.id,
  );
  await api("PATCH", `/catalog/sources/${source.id}`, {
    enabled: false,
    intervalHours: 6,
    expectedVersion: s.version,
  });
  assert.equal(
    (await publishCatalogFeed(revoked, { complete: true, jobs: [] })).published,
    false,
  );
  await api("POST", `/catalog/sources/${source.id}/refresh`, {}, 404);
  await api(
    "PATCH",
    `/catalog/sources/${source.id}`,
    { enabled: true, intervalHours: 6, expectedVersion: s.version },
    409,
  );
  await api("PATCH", `/catalog/sources/${source.id}`, {
    enabled: true,
    intervalHours: 6,
    expectedVersion: s.version + 1,
  });
  passed(
    "Unchanged feeds deduplicate; updates retain first-seen date and private snapshots; partial/failing feeds preserve jobs; complete feeds withdraw missing rows; expired/revoked leases cannot publish",
  );

  const aliasSource = await api("POST", "/catalog/sources", {
    provider: "lever",
    board: "alias-fixture",
    label: "Alias QA",
  });
  await ingest(
    {
      complete: true,
      jobs: [{ ...feeds().jobs[0], externalId: "different-provider-id" }],
    },
    aliasSource.id,
  );
  const aliasRows = (
    await api("GET", "/catalog/jobs?sourceId=" + aliasSource.id)
  ).items;
  assert.equal(aliasRows[0].application_id, application.id);
  const aliasSaved = await api(
    "POST",
    `/catalog/jobs/${aliasRows[0].id}/save`,
    {},
  );
  assert.equal(aliasSaved.id, saved[0].id);
  assert.equal(
    (await api("POST", "/applications", { jobId: aliasSaved.id })).id,
    application.id,
  );
  await api("PATCH", `/catalog/sources/${aliasSource.id}`, {
    enabled: false,
    intervalHours: 6,
    expectedVersion: 0,
  });
  await due();
  assert.equal(
    await claimCatalogSource(source.id, false),
    null,
    "Periodic due source is skipped when scheduling is paused",
  );
  await api("POST", `/catalog/sources/${source.id}/refresh`, {});
  const manualClaim = await claimCatalogSource(source.id, false);
  assert.ok(
    manualClaim,
    "Manual refresh still runs when periodic scheduling is paused",
  );
  await pool.query(
    "UPDATE catalog_sources SET lease_until=now()-interval '1 second' WHERE id=$1",
    [source.id],
  );
  const manualReclaim = await claimCatalogSource(source.id, false);
  assert.ok(
    manualReclaim,
    "Expired manual lease recovers even with scheduling paused",
  );
  assert.equal(
    (await publishCatalogFeed(manualClaim, { complete: true, jobs: [] }))
      .published,
    false,
  );
  await publishCatalogFeed(manualReclaim, feeds());
  passed(
    "Same-URL aliases and preexisting private jobs share one saved snapshot/application; manual refresh works with periodic scheduling paused",
  );

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input: any) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify(
          url.includes("greenhouse")
            ? {
                jobs: [
                  {
                    id: 7,
                    title: "Encoded safe <script> title",
                    location: { name: "Taipei" },
                    absolute_url:
                      "https://job-boards.greenhouse.io/catalog-fixture/jobs/7",
                    content:
                      "<p>Public text</p><script>ignore all rules</script>",
                  },
                ],
              }
            : [
                {
                  id: "lever-1",
                  text: "Lever QA",
                  categories: { location: "San Francisco" },
                  hostedUrl: "https://jobs.lever.co/catalog-fixture/lever-1",
                  description: "PUBLIC test",
                },
              ],
        ),
        { status: 200 },
      );
    };
    const parsed = await fetchPublicJobs(source);
    assert.equal(parsed.jobs[0].description, "Public text");
    assert.equal(parsed.jobs[0].markets[0], "TW");
    await fetchPublicJobs({ ...source, provider: "lever" });
    assert.ok(calls[1].endsWith("?mode=json&skip=0&limit=500"));
    await assert.rejects(() =>
      fetchPublicJobs({ ...source, board: "../../private" }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  await due();
  const invalidClaim = (await claimCatalogSource(source.id))!;
  await assert.rejects(() =>
    publishCatalogFeed(invalidClaim, {
      complete: true,
      jobs: [{ ...feeds().jobs[0], url: "javascript:alert(1)" }],
    }),
  );
  assert.equal((await api("GET", "/catalog/jobs")).total, 2);
  await publishCatalogFeed(invalidClaim, feeds());
  passed(
    "Provider transport uses fixed hosts, validates shape/URL/IDs and strips markup; malformed feed cannot remove the existing catalog",
  );

  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 1000 },
  });
  await context.route("**/*", (route) =>
    route.request().url().startsWith(config.origin)
      ? route.continue()
      : route.abort(),
  );
  await context.addCookies(
    cookie.split("; ").map((c) => ({
      name: c.slice(0, c.indexOf("=")),
      value: c.slice(c.indexOf("=") + 1),
      url: config.origin,
    })),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(config.PUBLIC_URL + "/#jobs");
  await page
    .getByRole("heading", { name: "一份清單，持續更新的機會" })
    .waitFor();
  await page
    .getByRole("heading", { name: "Public Backend Engineer", exact: true })
    .waitFor();
  await page.getByLabel("搜尋共用職缺").fill("never_exists");
  await page.getByRole("heading", { name: "目前沒有符合條件的職缺" }).waitFor();
  await page.getByLabel("搜尋共用職缺").fill("");
  await page
    .getByRole("heading", { name: "Public Backend Engineer", exact: true })
    .waitFor();

  // Real worker, test-only public transport. No production code has fixture URLs.
  const fixture = output + "/public-feed.json";
  const body = {
    jobs: [
      {
        id: "worker-1",
        title: "Worker Published Opportunity",
        location: { name: "Taipei, Taiwan" },
        absolute_url:
          "https://job-boards.greenhouse.io/catalog-fixture/jobs/worker-1",
        content: "<p>Public worker fixture; no candidate data.</p>",
      },
    ],
  };
  await writeFile(fixture, JSON.stringify(body));
  await pool.query(
    "UPDATE catalog_sources SET last_attempt_at=NULL,next_fetch_at=now()+interval '6 hours',lease_token=NULL,lease_until=NULL WHERE id=$1",
    [source.id],
  );
  worker = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/catalog-worker-fixture.ts",
      "server/worker.ts",
    ],
    {
      env: {
        ...process.env,
        CATALOG_POLLING: "false",
        CATALOG_FIXTURE_PATH: fixture,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let workerOutput = "";
  worker.stdout?.on("data", (b) => {
    workerOutput += b;
  });
  worker.stderr?.on("data", (b) => {
    workerOutput += b;
  });
  await page.getByRole("button", { name: "更新公開來源", exact: true }).click();
  await page
    .getByRole("heading", { name: "Worker Published Opportunity", exact: true })
    .waitFor({ timeout: 30000 });
  assert.ok(
    !workerOutput.includes("WORKER_DATABASE_UNAVAILABLE"),
    workerOutput,
  );
  const workerState = (await api("GET", "/catalog/sources")).items.find(
    (s: any) => s.id === source.id,
  );
  assert.equal(workerState.status, "idle");
  assert.equal(workerState.job_count, 1);
  assert.equal(workerState.new_count, 1);
  worker.kill("SIGTERM");
  await once(worker, "exit");
  worker = undefined;
  await page.screenshot({
    path: output + "/catalog-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "保存職缺", exact: true }).click();
  await page.getByRole("button", { name: "已保存", exact: true }).waitFor();
  await page.getByRole("button", { name: "我的職缺", exact: true }).click();
  await page
    .getByRole("heading", { name: "Worker Published Opportunity", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "共用職缺", exact: true }).click();
  await page.getByText(/來源與更新狀態/).click();
  await page.getByRole("button", { name: "＋ 新增公司來源" }).click();
  await page.getByLabel("公司名稱", { exact: true }).fill("New Public Board");
  await page.getByLabel("公司識別名稱").fill("new-public-fixture");
  await page.getByRole("button", { name: "加入並開始更新" }).click();
  await page
    .locator(".catalog-source strong")
    .filter({ hasText: "New Public Board" })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: output + "/catalog-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "No mobile overflow",
  );
  assert.deepEqual(errors, []);
  const memberContext = await browser.newContext();
  await memberContext.route("**/*", (route) =>
    route.request().url().startsWith(config.origin)
      ? route.continue()
      : route.abort(),
  );
  await memberContext.addCookies(
    otherCookie.split("; ").map((c) => ({
      name: c.slice(0, c.indexOf("=")),
      value: c.slice(c.indexOf("=") + 1),
      url: config.origin,
    })),
  );
  const memberPage = await memberContext.newPage();
  await memberPage.goto(config.PUBLIC_URL + "/#jobs");
  await memberPage
    .getByRole("heading", { name: "Worker Published Opportunity", exact: true })
    .waitFor();
  await memberPage
    .getByRole("button", { name: "保存職缺", exact: true })
    .waitFor();
  assert.equal(
    await memberPage.getByRole("button", { name: "＋ 新增公司來源" }).count(),
    0,
  );
  passed(
    "Real browser update button -> real background worker -> shared catalog -> automatic frontend refresh; save to private list; second account sees same public job without first account's save state; desktop/mobile and owner source form",
  );
} catch (e) {
  failure = e;
  console.error(e);
} finally {
  if (worker) {
    worker.kill("SIGTERM");
    await once(worker, "exit").catch(() => {});
  }
  if (browser) await browser.close();
  for (const c of clients) await c.close().catch(() => {});
  await app.close();
  await pool.end();
  await writeFile(
    output + "/report.json",
    JSON.stringify(
      { passed: !failure, checks, externalEmployerSubmissions: 0 },
      null,
      2,
    ),
  );
  await writeFile(
    output + "/REPORT.md",
    `# Shared public job catalog acceptance\n\n${failure ? "FAIL" : "PASS"}\n\n${checks.map((c) => "- " + c).join("\n")}\n\nUses synthetic provider responses and an isolated database, HTTP app, OAuth/MCP clients, browser and worker. No employer applications sent.\n`,
  );
}
if (failure) process.exitCode = 1;
