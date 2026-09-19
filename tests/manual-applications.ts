import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { buildApp } from "../server/index.js";
import { config } from "../server/config.js";
import { pool } from "../server/db.js";

assert.equal(config.NODE_ENV, "test");
assert.equal(new URL(config.DATABASE_URL).pathname, "/careeros_mcp_e2e_test");
assert.equal(new URL(config.DATABASE_URL).hostname, "postgres-e2e");
assert.equal(config.dataDir, "/tmp/careeros-mcp-e2e-data");
assert.equal(config.PUBLIC_URL, "http://127.0.0.1:3110/careeros");
assert.equal(
  (await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
  0,
);
const output = process.env.E2E_OUTPUT!;
assert.equal(output, "/tmp/careeros-mcp-e2e-report");
await mkdir(output, { recursive: true });
const started = new Date().toISOString();
const checks: string[] = [];
const errors: string[] = [];
let failure: string | undefined;
const check = (s: string) => {
  checks.push(s);
  console.log("PASS", s);
};
type Actor = { cookie: string; id: string };
async function request(
  actor: Actor | undefined,
  endpoint: string,
  method = "GET",
  data?: unknown,
  expected = 200,
  extra: Record<string, string> = {},
) {
  const r = await fetch(config.PUBLIC_URL + "/api" + endpoint, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      origin: config.origin,
      ...(actor ? { cookie: actor.cookie } : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
      "idempotency-key": randomUUID(),
      ...extra,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  assert.equal(
    r.status,
    expected,
    `${method} ${endpoint}: ${r.status} instead of ${expected}`,
  );
  return r;
}
async function api(
  actor: Actor | undefined,
  endpoint: string,
  method = "GET",
  data?: unknown,
  expected = 200,
  extra: Record<string, string> = {},
) {
  return (
    await request(actor, endpoint, method, data, expected, extra)
  ).json() as Promise<any>;
}
async function register(name: string, email: string, invite: string) {
  const password = randomBytes(24).toString("hex");
  const r = await request(undefined, "/auth/register", "POST", {
    name,
    email,
    password,
    invite,
  });
  const body: any = await r.json();
  return {
    password,
    id: body.user.id,
    cookie: r.headers.get("set-cookie")!.split(";")[0],
  };
}
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: config.PORT });
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  timezoneId: "Asia/Taipei",
  viewport: { width: 1440, height: 1050 },
});
await context.route("**/*", (r) =>
  new URL(r.request().url()).origin === config.origin
    ? r.continue()
    : r.abort(),
);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
try {
  const actor = await register(
    "手動投遞｜虛構測試",
    "manual@example.test",
    config.BOOTSTRAP_TOKEN!,
  );
  const invited = await api(actor, "/auth/invites", "POST", {});
  const other = await register(
    "另一位虛構人物",
    "other@example.test",
    invited.token,
  );
  await context.addCookies([
    {
      name: "careeros_session",
      value: actor.cookie.slice("careeros_session=".length),
      domain: "127.0.0.1",
      path: "/careeros",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(config.PUBLIC_URL + "/#applications");
  await page.getByRole("button", { name: "＋ 手動新增已投遞" }).click();
  const localInput = await page.getByLabel(/^投遞時間/).inputValue();
  const localEpoch = await page.evaluate(
    (s) => new Date(s).getTime(),
    localInput,
  );
  assert.ok(Math.abs(Date.now() - localEpoch) < 90000);
  check(
    "Manual entry defaults to the browser's local time (Asia/Taipei), not UTC displayed as local",
  );
  await page.getByLabel(/^公司/).fill("虛構公司：外部投遞");
  await page.getByLabel("職位名稱").fill("Frontend Engineer");
  await page.getByLabel(/^投遞時間/).fill("2025-06-15T10:30");
  await page.getByLabel("投遞管道").fill("104");
  await page.getByLabel("外部履歷名稱").fill("前端履歷 v3（外部文件）");
  await page.getByLabel("投遞備註").fill("完全虛構的驗收紀錄，沒有真實投遞。");
  await page.getByRole("button", { name: "確認已投遞，儲存紀錄" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("虛構公司：外部投遞", { exact: true }).waitFor();
  const first = (await api(actor, "/applications")).items[0];
  assert.equal(first.status, "submitted");
  assert.equal(
    new Date(first.submitted_at).toISOString(),
    "2025-06-15T02:30:00.000Z",
  );
  assert.equal(first.external_resume_name, "前端履歷 v3（外部文件）");
  assert.equal((await api(actor, "/career")).facts.length, 0);
  assert.equal((await api(actor, "/dashboard")).counts.submitted, 1);
  await page
    .getByRole("button")
    .filter({ hasText: "虛構公司：外部投遞" })
    .click();
  await page
    .getByRole("dialog")
    .getByText("前端履歷 v3（外部文件）", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("dialog").getByRole("link", { name: /履歷/ }).count(),
    0,
  );
  await page.getByRole("button", { name: "關閉", exact: true }).click();
  check(
    "Fresh user can record a past submission with a resume name only, without jobs, facts or platform resumes",
  );
  const pdfPage = await browser.newPage();
  await pdfPage.route("**/*", (r) => r.abort());
  await pdfPage.setContent(
    '<meta charset="utf-8"><h1>FICTIONAL QA RESUME</h1><p>manual@example.test</p><p>Private external resume fixture.</p>',
  );
  const pdf = await pdfPage.pdf({ format: "A4" });
  await pdfPage.close();
  await page.getByRole("button", { name: "＋ 手動新增已投遞" }).click();
  await page.getByLabel(/^公司/).fill("Fictional PDF Company");
  await page.getByLabel("職位名稱").fill("Backend Engineer");
  await page.getByRole("dialog").getByLabel(/^市場/).selectOption("US");
  await page.getByLabel(/^投遞時間/).fill("2025-07-20T09:15");
  await page.getByLabel("投遞管道").fill("Email");
  await page.getByLabel("上傳當時的履歷").setInputFiles({
    name: "external-cv.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByRole("button", { name: "確認已投遞，儲存紀錄" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const uploaded = (await api(actor, "/applications")).items.find(
    (r: any) => r.company === "Fictional PDF Company",
  );
  assert.equal(uploaded.external_resume_name, "external-cv.pdf");
  await page
    .getByRole("button")
    .filter({ hasText: "Fictional PDF Company" })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "下載當時履歷" })
    .click();
  await (await download).saveAs(path.join(output, "external-cv.pdf"));
  const privateDownload = await request(
    actor,
    "/assets/" + uploaded.external_resume_asset_id,
  );
  assert.deepEqual(Buffer.from(await privateDownload.arrayBuffer()), pdf);
  await request(
    other,
    "/assets/" + uploaded.external_resume_asset_id,
    "GET",
    undefined,
    404,
  );
  const uploadedDetail = await api(actor, "/applications/" + uploaded.id);
  assert.equal(
    uploadedDetail.dossiers[0].snapshot.externalResume.sha256,
    createHash("sha256").update(pdf).digest("hex"),
  );
  assert.equal((await api(actor, "/career")).sources.length, 0);
  assert.equal((await api(actor, "/tasks")).items.length, 0);
  await page.screenshot({
    path: path.join(output, "manual-external-resume.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "關閉", exact: true }).click();
  check(
    "External PDF upload, immutable snapshot and authenticated byte-identical download; no career import or parsing task",
  );
  const fact = (
    await api(actor, "/facts", "POST", {
      expectedRevision: 0,
      fact: {
        kind: "project",
        title: "Fictional API project",
        content: "Built a fictional TypeScript API for QA.",
      },
    })
  ).fact;
  const resume = await api(actor, "/resumes", "POST", {
    title: "站內履歷｜虛構測試",
    language: "en",
    careerRevision: 1,
    blocks: [{ heading: "Project", text: fact.content, factIds: [fact.id] }],
  });
  await page.getByRole("button", { name: "＋ 手動新增已投遞" }).click();
  await page.getByLabel(/^公司/).fill("Fictional Internal Resume Co");
  await page.getByLabel("職位名稱").fill("Platform Engineer");
  await page.getByLabel(/^投遞時間/).fill("2025-08-10T18:00");
  await page.getByLabel("使用的站內履歷").selectOption(resume.id);
  assert.equal(await page.getByLabel("上傳當時的履歷").count(), 0);
  assert.equal(await page.getByLabel("外部履歷名稱").count(), 0);
  await page.getByRole("button", { name: "確認已投遞，儲存紀錄" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const internal = (await api(actor, "/applications")).items.find(
    (r: any) => r.company === "Fictional Internal Resume Co",
  );
  assert.equal(internal.resume_id, resume.id);
  assert.equal(internal.external_resume_asset_id, null);
  await page
    .getByRole("button")
    .filter({ hasText: "Fictional Internal Resume Co" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "當時履歷 PDF" })
    .waitFor();
  await page.getByRole("button", { name: "關閉", exact: true }).click();
  check(
    "Existing platform resume can be recorded as historical use without changing its approval state",
  );
  const base = {
    company: "Fictional API-only Company",
    title: "Engineer",
    market: "TW",
    occurredAt: "2025-08-01T02:30:00.000Z",
  };
  const key = randomUUID();
  const unlinked = await api(actor, "/applications/manual", "POST", base, 200, {
    "idempotency-key": key,
  });
  assert.equal(
    (
      await api(actor, "/applications/manual", "POST", base, 200, {
        "idempotency-key": key,
      })
    ).id,
    unlinked.id,
  );
  await api(actor, "/applications/manual", "POST", base, 409);
  const detail = await api(actor, "/applications/" + unlinked.id);
  assert.equal(detail.events.length, 1);
  assert.equal(detail.dossiers.length, 1);
  assert.equal(detail.dossiers[0].snapshot.resume, null);
  await page.reload();
  await page.getByRole("button").filter({ hasText: base.company }).click();
  await page
    .getByRole("dialog")
    .getByText("未記錄履歷", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "關閉", exact: true }).click();
  check(
    "Optional resume stays explicitly unknown; idempotent retries and duplicate submissions do not double-count",
  );
  const jobsBefore = (await api(other, "/jobs")).items.length;
  await api(
    other,
    "/applications/manual",
    "POST",
    { ...base, externalResumeAssetId: uploaded.external_resume_asset_id },
    404,
  );
  await api(
    other,
    "/applications/manual",
    "POST",
    { ...base, resumeId: resume.id },
    404,
  );
  await api(
    other,
    "/applications/manual",
    "POST",
    { ...base, occurredAt: new Date(Date.now() + 86400000).toISOString() },
    422,
  );
  await api(
    other,
    "/applications/manual",
    "POST",
    { ...base, url: "javascript:alert(1)" },
    422,
  );
  await api(
    actor,
    "/applications/manual",
    "POST",
    {
      ...base,
      resumeId: resume.id,
      externalResumeAssetId: uploaded.external_resume_asset_id,
    },
    422,
  );
  await api(actor, "/applications/manual", "POST", base, 403, {
    origin: "https://attacker.invalid",
  });
  await api(undefined, "/applications/manual", "POST", base, 401, {
    authorization: "Bearer not-a-browser-session",
  });
  assert.equal((await api(other, "/jobs")).items.length, jobsBefore);
  assert.equal((await api(other, "/applications")).items.length, 0);
  check(
    "Cross-account references, conflicting resume sources, future dates, unsafe URLs, CSRF and bearer-only writes fail without partial records",
  );
  const savedJob = await api(actor, "/jobs", "POST", {
    title: "Saved Engineer",
    company: "Fictional Existing Job",
    market: "US",
    url: "https://example.test/saved",
    description: "Keep this original detailed job description.",
  });
  const prepared = await api(actor, "/applications", "POST", {
    jobId: savedJob.id,
  });
  await api(actor, "/applications/events", "POST", {
    applicationId: prepared.id,
    type: "interview_invited",
    occurredAt: "2025-08-15T02:30:00.000Z",
    expectedVersion: prepared.version,
  });
  const backfill = await api(actor, "/applications/manual", "POST", {
    company: savedJob.company,
    title: savedJob.title,
    market: savedJob.market,
    url: savedJob.url,
    occurredAt: "2025-08-12T02:30:00.000Z",
    resumeId: resume.id,
  });
  assert.equal(backfill.id, prepared.id);
  assert.equal(backfill.status, "interviewing");
  const preserved = await api(actor, "/applications/" + backfill.id);
  assert.equal(preserved.job.description, savedJob.description);
  assert.equal(preserved.dossiers[0].snapshot.resume.id, resume.id);
  check(
    "Backfill reuses the existing job/application, preserves the job description and does not downgrade interview progress",
  );
  const concurrent = { ...base, company: "Fictional Concurrent Company" };
  const attempts = await Promise.all(
    [1, 2].map(() =>
      fetch(config.PUBLIC_URL + "/api/applications/manual", {
        method: "POST",
        headers: {
          origin: config.origin,
          cookie: actor.cookie,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify(concurrent),
      }),
    ),
  );
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await api(actor, "/applications")).items.filter(
      (r: any) => r.company === concurrent.company,
    ).length,
    1,
  );
  check(
    "Concurrent manual submissions produce one application and one duplicate rejection",
  );
  const crossMarket = { ...base, company: "Fictional Global Markets" };
  const tw = await api(actor, "/applications/manual", "POST", {
    ...crossMarket,
    market: "TW",
  });
  const us = await api(actor, "/applications/manual", "POST", {
    ...crossMarket,
    market: "US",
  });
  assert.notEqual(tw.job_id, us.job_id);
  assert.equal((await api(actor, "/applications/" + tw.id)).job.market, "TW");
  assert.equal((await api(actor, "/applications/" + us.id)).job.market, "US");
  check(
    "Same company/title without a URL stays independent across Taiwan and US markets",
  );
  const assetDirectory = path.join(config.dataDir, "assets", actor.id);
  const existingFiles = (await readdir(assetDirectory)).sort();
  const assetCount = async () =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM assets WHERE owner_id=$1",
        [actor.id],
      )
    ).rows[0].n;
  const originalCount = await assetCount();
  const failedAttachment = new FormData();
  failedAttachment.append("metadata", JSON.stringify(base));
  failedAttachment.append(
    "file",
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    "duplicate.pdf",
  );
  const rejectedUpload = await fetch(
    config.PUBLIC_URL + "/api/applications/manual",
    {
      method: "POST",
      headers: {
        origin: config.origin,
        cookie: actor.cookie,
        "idempotency-key": randomUUID(),
      },
      body: failedAttachment,
    },
  );
  assert.equal(rejectedUpload.status, 409);
  assert.equal(await assetCount(), originalCount);
  assert.deepEqual((await readdir(assetDirectory)).sort(), existingFiles);
  check(
    "Failed manual record rolls back its private attachment and removes the encrypted file without consuming quota",
  );
  await page.reload();
  await page
    .getByText("Fictional Concurrent Company", { exact: true })
    .waitFor();
  const marketRows = page
    .getByRole("button")
    .filter({ hasText: crossMarket.company });
  assert.equal(await marketRows.filter({ hasText: "台灣" }).count(), 1);
  assert.equal(await marketRows.filter({ hasText: "美國" }).count(), 1);
  await page.screenshot({
    path: path.join(output, "manual-applications-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "＋ 手動新增已投遞" }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({
    path: path.join(output, "manual-applications-mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1050 });
  let releaseResponse!: () => void;
  let requestFetched!: () => void;
  let responseDelivered!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const fetched = new Promise<void>((resolve) => {
    requestFetched = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    responseDelivered = resolve;
  });
  await page.route(
    "**/api/resumes",
    async (route) => {
      const response = await route.fetch();
      requestFetched();
      await heldResponse;
      await route.fulfill({ response });
      responseDelivered();
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "＋ 手動新增已投遞" }).click();
  await fetched;
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await page.getByRole("heading", { name: "歡迎回到 CareerOS" }).waitFor();
  releaseResponse();
  await delivered;
  await page.getByLabel("Email", { exact: true }).fill("other@example.test");
  await page.getByLabel("密碼", { exact: true }).fill(other.password);
  await page.getByRole("button", { name: /進入工作台/ }).click();
  await page
    .locator(".workspace-user strong")
    .filter({ hasText: "另一位虛構人物" })
    .waitFor();
  await page.getByRole("heading", { name: "投遞中心", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.getByText(resume.title, { exact: true }).count(), 0);
  check(
    "A delayed resume response after logout cannot open the previous account's modal or expose its resume names to the next account",
  );
  assert.deepEqual(errors, []);
  check(
    "Desktop list/detail and mobile form render without page errors or horizontal overflow",
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM usage")).rows[0].n,
    0,
  );
} catch (e) {
  failure = e instanceof Error ? e.message : "Unknown failure";
  console.error("FAILED", failure);
  await page
    .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  await pool.end();
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        started,
        finished: new Date().toISOString(),
        passed: !failure,
        failure,
        checks,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(output, "REPORT.md"),
    `# Manual application entry — synthetic end-to-end verification\n\nScenario: ${failure ? "FAIL: " + failure : "PASS"}\n\n${checks.map((s) => "- [x] " + s).join("\n")}\n\nAll people, employers and applications were fictional. No external delivery or paid inference.\n`,
    { mode: 0o600 },
  );
}
