import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../server/index.js";
import { config } from "../server/config.js";
import { pool } from "../server/db.js";
import { accountTarget, observeAccountSetup } from "../server/account-setup.js";
assert.equal(config.NODE_ENV, "test");
assert.ok(new URL(config.DATABASE_URL).pathname.endsWith("_test"));
if (process.env.E2E_OUTPUT) {
  assert.equal(new URL(config.DATABASE_URL).hostname, "postgres-e2e");
  assert.equal(config.dataDir, "/tmp/careeros-mcp-e2e-data");
}
const output = process.env.E2E_OUTPUT ?? "/tmp/careeros-account-setup-report";
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
      name: "Fictional Account QA",
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
      client_name: "Account assistance isolated QA",
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
  const mcp = new Client({ name: "account-assistance-qa", version: "1.0" });
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
const createJob = (url: string) =>
  api("POST", "/jobs", {
    title: "Fictional engineer",
    company: "Synthetic QA Company",
    market: "US",
    description: "Isolated account workflow test, never a real application",
    url,
  });
const setupInput = {
  candidateName: "Fictional Candidate",
  candidateEmail: "candidate@example.test",
  allowRegistration: true,
  confirm: true,
};
let success = false;
try {
  await pool.query(
    "TRUNCATE users,oauth_clients,auth_throttles,google_login_challenges CASCADE",
  );
  await app.listen({ host: "127.0.0.1", port: config.PORT });
  const a = await register("account-qa@example.test", config.BOOTSTRAP_TOKEN!);
  cookie = a.cookie;
  owner = a.id;
  const invite = await api("POST", "/auth/invites", {});
  otherCookie = (await register("other-account-qa@example.test", invite.token))
    .cookie;
  const mcp = await connectMcp(),
    read = await connectMcp("careeros:read"),
    other = await connectMcp("careeros:read careeros:write", otherCookie);
  const readNames = (await read.listTools()).tools.map((t) => t.name);
  assert.ok(readNames.includes("account_setup_list"));
  assert.ok(!readNames.includes("account_setup_claim"));
  assert.ok(!readNames.includes("account_setup_report_observation"));
  assert.ok(
    !(await mcp.listTools()).tools.some((t) =>
      /account_setup_(request|resume|authorize)/.test(t.name),
    ),
  );
  passed(
    "Real MCP OAuth/PKCE preserves read/write scopes and cannot authorize its own registration task",
  );
  for (const bad of [
    "https://www.linkedin.com/feed/",
    "https://www.104.com.tw/company/5x2b0tk",
    "https://jobs.lever.co.evil.test/company/job",
    "http://127.0.0.1/job",
    "https://user:pass@jobs.lever.co/company/job",
  ])
    assert.throws(() => accountTarget(bad));
  assert.notEqual(
    accountTarget("https://qa.wd1.myworkdayjobs.com/en-US/External/job/QA/test")
      .realm,
    accountTarget("https://qa.wd1.myworkdayjobs.com/en-US/Other/job/QA/test")
      .realm,
  );
  assert.equal(
    accountTarget("https://jobs.lever.co/qa/job-1?token=secret").entryUrl,
    "https://jobs.lever.co/qa/job-1",
  );
  passed(
    "Provider allowlist rejects feed/company/SSRF-like URLs and isolates employer account realms",
  );
  const job = await createJob("https://www.linkedin.com/jobs/view/1234567890/");
  assert.equal(
    (await api("GET", "/jobs/" + job.id + "/account-preflight")).state,
    "not_checked",
  );
  await api("GET", "/account-setups", undefined, 401, "");
  await api(
    "GET",
    "/jobs/" + job.id + "/account-preflight",
    undefined,
    404,
    otherCookie,
  );
  await api(
    "POST",
    "/jobs/" + job.id + "/account-setup",
    setupInput,
    403,
    cookie,
    "https://attacker.invalid",
  );
  await api(
    "POST",
    "/jobs/" + job.id + "/account-setup",
    { ...setupInput, password: "must-not-store" },
    422,
  );
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  // No test browser may contact LinkedIn, 104, employers or any external service.
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === config.origin
      ? r.continue()
      : r.abort(),
  );
  await context.addCookies(
    cookie.split("; ").map((c) => {
      const i = c.indexOf("=");
      return {
        name: c.slice(0, i),
        value: c.slice(i + 1),
        url: config.PUBLIC_URL,
        httpOnly: true,
      };
    }),
  );
  const page = await context.newPage();
  await page.goto(config.PUBLIC_URL + "/#jobs");
  await page.getByRole("button", { name: "我的職缺", exact: true }).click();
  await page
    .getByRole("button", { name: "登入／註冊準備", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "登入／註冊準備" });
  await dialog
    .getByText("網站不會自行啟動雲端瀏覽器。", { exact: false })
    .waitFor();
  assert.ok(
    await dialog.getByRole("button", { name: "建立帳戶協助任務" }).isDisabled(),
  );
  await dialog
    .getByLabel("申請人姓名", { exact: true })
    .fill(setupInput.candidateName);
  await dialog
    .getByLabel("此網站使用的 Email", { exact: true })
    .fill(setupInput.candidateEmail);
  await dialog.getByLabel("沒有帳戶時，允許助理協助建立此網站帳戶").check();
  await dialog.getByLabel(/^我確認使用上述姓名/).check();
  await dialog.getByRole("button", { name: "建立帳戶協助任務" }).click();
  await dialog.getByLabel("給瀏覽器助理的指令").waitFor();
  let run = (await tool(mcp, "account_setup_list", {})).items[0];
  assert.equal(run.allow_registration, true);
  assert.equal(
    (await api("POST", "/jobs/" + job.id + "/account-setup", setupInput)).id,
    run.id,
  );
  assert.equal(
    (await api("GET", "/account-setups", undefined, 200, otherCookie)).items
      .length,
    0,
  );
  await tool(
    other,
    "account_setup_claim",
    { runId: run.id, expectedVersion: run.version },
    "NOT_FOUND",
  );
  const claims: any[] = await Promise.all(
    [0, 1].map(() =>
      mcp.callTool({
        name: "account_setup_claim",
        arguments: { runId: run.id, expectedVersion: run.version },
      }),
    ),
  );
  assert.equal(claims.filter((r) => !r.isError).length, 1);
  let claim = JSON.parse(claims.find((r) => !r.isError).content[0].text);
  let ctx = await tool(mcp, "account_setup_get_context", {
    runId: run.id,
    claimId: claim.claimId,
  });
  const activeExport = await api("GET", "/account/export");
  assert.ok(
    !JSON.stringify(activeExport.account_setup_runs).includes(claim.claimId),
  );
  assert.ok(
    activeExport.account_setup_runs.every((r: any) => !("claim_id" in r)),
  );
  assert.deepEqual(ctx.profile, {
    name: setupInput.candidateName,
    email: setupInput.candidateEmail,
  });
  await assert.rejects(
    observeAccountSetup(owner, {
      runId: run.id,
      claimId: claim.claimId,
      expectedVersion: claim.version,
      state: "account_ready",
      observedEmail: setupInput.candidateEmail,
      pageUrl: ctx.entryUrl,
      password: "must-not-store",
    }),
    (e: any) =>
      e.issues?.length === 1 &&
      e.issues[0].code === "unrecognized_keys" &&
      e.issues[0].keys.join() === "password",
  );
  const observe = (state: string, extra = {}) => ({
    runId: run.id,
    claimId: claim.claimId,
    expectedVersion: claim.version,
    state,
    pageUrl: ctx.entryUrl,
    ...extra,
  });
  let secretRejected = false;
  try {
    const response: any = await mcp.callTool({
      name: "account_setup_report_observation",
      arguments: observe("account_ready", {
        observedEmail: setupInput.candidateEmail,
        password: "must-not-store",
      }),
    });
    secretRejected = response.isError === true;
    assert.ok(!JSON.stringify(response).includes("must-not-store"));
  } catch (e: any) {
    secretRejected = String(e.message).includes("password");
    assert.ok(!String(e.message).includes("must-not-store"));
  }
  assert.ok(
    secretRejected,
    "MCP must reject secret-bearing input, not strip and execute it",
  );
  assert.equal(
    (
      await tool(mcp, "account_setup_get_context", {
        runId: run.id,
        claimId: claim.claimId,
      })
    ).state,
    "working",
  );
  await tool(
    mcp,
    "account_setup_report_observation",
    observe("account_ready", { observedEmail: "other@example.test" }),
    "ACCOUNT_IDENTITY_MISMATCH",
  );
  await tool(
    mcp,
    "account_setup_report_observation",
    observe("account_ready", {
      observedEmail: setupInput.candidateEmail,
      pageUrl: "https://attacker.invalid/page",
    }),
    "ACCOUNT_ORIGIN_MISMATCH",
  );
  run = await tool(
    mcp,
    "account_setup_report_observation",
    observe("password_required", {
      pageUrl: ctx.entryUrl + "?token=do-not-persist#otp",
    }),
  );
  assert.ok(!JSON.stringify(run).includes("do-not-persist"));
  await tool(
    mcp,
    "account_setup_get_context",
    { runId: run.id, claimId: claim.claimId },
    "ACCOUNT_SETUP_CLAIMED_OR_CHANGED",
  );
  await dialog
    .getByRole("button", { name: "重新檢查狀態", exact: true })
    .click();
  await dialog.getByText("請在原網站輸入密碼", { exact: true }).waitFor();
  assert.equal(await dialog.locator('input[type="password"]').count(), 0);
  await page.screenshot({
    path: output + "/account-handoff-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: output + "/account-handoff-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await dialog
    .getByRole("button", { name: "已完成，請助理再檢查", exact: true })
    .click();
  await dialog.getByLabel("給瀏覽器助理的指令").waitFor();
  run = (await tool(mcp, "account_setup_list", {})).items[0];
  claim = await tool(mcp, "account_setup_claim", {
    runId: run.id,
    expectedVersion: run.version,
  });
  ctx = await tool(mcp, "account_setup_get_context", {
    runId: run.id,
    claimId: claim.claimId,
  });
  run = await tool(
    mcp,
    "account_setup_report_observation",
    observe("account_ready", { observedEmail: setupInput.candidateEmail }),
  );
  await dialog
    .getByRole("button", { name: "重新檢查狀態", exact: true })
    .click();
  await dialog.getByText("助理回報已登入", { exact: true }).waitFor();
  assert.equal((await api("GET", "/applications")).items.length, 0);
  passed(
    "Browser authorization → real MCP claim → password handoff → website resume → agent report, without creating/submitting applications",
  );
  passed(
    "Wrong candidate/site, duplicate claim, cross-owner access, CSRF and secret-bearing inputs blocked; desktop/mobile handoff UI verified",
  );
  // Another tab revokes registration while this dialog is still mounted.
  run = await api("POST", "/account-setups/" + run.id + "/resume", {
    expectedVersion: run.version,
    allowRegistration: false,
    confirm: true,
  });
  claim = await tool(mcp, "account_setup_claim", {
    runId: run.id,
    expectedVersion: run.version,
  });
  run = await tool(
    mcp,
    "account_setup_report_observation",
    observe("account_ready", { observedEmail: setupInput.candidateEmail }),
  );
  await dialog
    .getByRole("button", { name: "重新檢查狀態", exact: true })
    .click();
  await dialog.getByText("僅協助既有帳戶登入", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByLabel("下一次檢查允許協助註冊此網站帳戶").isChecked(),
    false,
  );
  await dialog
    .getByRole("button", { name: "重新授權並安排檢查", exact: true })
    .click();
  await dialog.getByLabel("給瀏覽器助理的指令").waitFor();
  run = (await tool(mcp, "account_setup_list", {})).items[0];
  assert.equal(
    run.allow_registration,
    false,
    "Stale UI must not restore revoked registration scope",
  );
  passed(
    "Cross-tab registration revocation resets the visible checkbox and renewed authorization remains login-only",
  );
  // A cancelled or expired authorization cannot be used by a stale client.
  run = await api("POST", "/account-setups/" + run.id + "/resume", {
    expectedVersion: run.version,
    confirm: true,
  });
  claim = await tool(mcp, "account_setup_claim", {
    runId: run.id,
    expectedVersion: run.version,
  });
  await api(
    "POST",
    "/account-setups/" + run.id + "/cancel",
    { expectedVersion: run.version, confirm: true },
    409,
  );
  run = await api("POST", "/account-setups/" + run.id + "/cancel", {
    expectedVersion: claim.version,
    confirm: true,
  });
  await tool(
    mcp,
    "account_setup_report_observation",
    observe("account_ready", { observedEmail: setupInput.candidateEmail }),
    "ACCOUNT_SETUP_CANCELLED",
  );
  run = await api("POST", "/jobs/" + job.id + "/account-setup", setupInput);
  await pool.query(
    "UPDATE account_setup_runs SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [run.id],
  );
  await tool(
    mcp,
    "account_setup_claim",
    { runId: run.id, expectedVersion: run.version },
    "ACCOUNT_SETUP_EXPIRED",
  );
  run = await api("POST", "/account-setups/" + run.id + "/resume", {
    expectedVersion: run.version,
    allowRegistration: false,
    confirm: true,
  });
  claim = await tool(mcp, "account_setup_claim", {
    runId: run.id,
    expectedVersion: run.version,
  });
  ctx = await tool(mcp, "account_setup_get_context", {
    runId: run.id,
    claimId: claim.claimId,
  });
  assert.equal(ctx.allowRegistration, false);
  await pool.query(
    "UPDATE jobs SET url='https://www.linkedin.com/jobs/view/99999999/' WHERE id=$1",
    [job.id],
  );
  await tool(
    mcp,
    "account_setup_get_context",
    { runId: run.id, claimId: claim.claimId },
    "ACCOUNT_TARGET_CHANGED",
  );
  passed(
    "Version conflicts, cancellation, expiration, explicit renewed scope and changed targets invalidate stale actions",
  );
  const workday = await createJob(
    "https://qa.wd1.myworkdayjobs.com/en-US/External/job/QA/test",
  );
  run = await api("POST", "/jobs/" + workday.id + "/account-setup", setupInput);
  claim = await tool(mcp, "account_setup_claim", {
    runId: run.id,
    expectedVersion: run.version,
  });
  ctx = await tool(mcp, "account_setup_get_context", {
    runId: run.id,
    claimId: claim.claimId,
  });
  await tool(
    mcp,
    "account_setup_report_observation",
    observe("account_ready", {
      observedEmail: setupInput.candidateEmail,
      pageUrl: "https://qa.wd1.myworkdayjobs.com/en-US/Other/login",
    }),
    "ACCOUNT_ORIGIN_MISMATCH",
  );
  run = await tool(
    mcp,
    "account_setup_report_observation",
    observe("external_login_required"),
  );
  assert.equal(run.observed_path, "/External");
  const exported = await api("GET", "/account/export");
  assert.ok(exported.account_setup_runs.some((r: any) => r.id === run.id));
  assert.ok(
    !JSON.stringify(exported.account_setup_runs).includes("do-not-persist"),
  );
  passed(
    "Workday tenant boundaries and cross-origin handoff preserved; private export includes task history without verification URLs",
  );
  success = true;
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  await browser?.close();
  await app.close();
  await pool.end();
  await writeFile(
    output + "/report.json",
    JSON.stringify(
      {
        passed: success,
        scope:
          "Website + real MCP account coordination; external employer account creation is not exercised",
        checks,
      },
      null,
      2,
    ),
  );
  await writeFile(
    output + "/REPORT.md",
    "# Account assistance E2E\n\n" +
      (success ? "PASS" : "FAIL") +
      "\n\n" +
      checks.map((c) => "- " + c).join("\n") +
      "\n\nExternal employer account creation is not exercised. Browser network access is limited to the isolated CareerOS server. No real employer or production personal data is used.\n",
  );
}
