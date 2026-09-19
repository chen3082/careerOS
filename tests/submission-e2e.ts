import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { chromium, type Page, type BrowserContext } from "playwright";
import { PDFParse } from "pdf-parse";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../server/index.js";
import { config } from "../server/config.js";
import { pool, one } from "../server/db.js";
import { hash } from "../server/crypto.js";
import { SubmissionJournal } from "../server/submission-journal.js";
import {
  prepareBrowserSubmission,
  clickApprovedSubmission,
  type FormReview,
  type SubmissionPlan,
} from "../server/submission-browser.js";
import {
  acquireSubmissionPermit,
  approveSubmission,
  finishSubmission,
  submissionDocument,
  type SubmissionAcceptanceEngine,
} from "../server/submissions.js";

assert.equal(config.NODE_ENV, "test");
assert.ok(new URL(config.DATABASE_URL).pathname.endsWith("_test"));
if (process.env.E2E_OUTPUT) {
  assert.equal(new URL(config.DATABASE_URL).pathname, "/careeros_mcp_e2e_test");
  assert.equal(new URL(config.DATABASE_URL).hostname, "postgres-e2e");
  assert.equal(config.dataDir, "/tmp/careeros-mcp-e2e-data");
  assert.equal(process.env.E2E_OUTPUT, "/tmp/careeros-mcp-e2e-report");
}
const output = process.env.E2E_OUTPUT ?? "/tmp/careeros-submission-test-report";
const receiverDirectory = path.join(
  output,
  "careeros-submission-test-receiver-" + randomUUID(),
);
const receiverOrigin = `http://127.0.0.1:${config.PORT + 1}`;
const journalDirectory = path.join(
  output,
  "careeros-submission-test-journal-" + randomUUID(),
);
const journal = new SubmissionJournal(journalDirectory);
await mkdir(output, { recursive: true, mode: 0o700 });
await pool.query(
  "TRUNCATE users,oauth_clients,auth_throttles,google_login_challenges CASCADE",
);
const receiver = spawn(
  process.execPath,
  ["--import", "tsx", "tests/submission-receiver.ts"],
  {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      RECEIVER_DIRECTORY: receiverDirectory,
      RECEIVER_PORT: String(config.PORT + 1),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
let receiverLog = "";
receiver.stderr!.on("data", (b) => (receiverLog += String(b)));
receiver.stdout!.on("data", (b) => (receiverLog += String(b)));
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Receiver timeout: " + receiverLog)),
    15000,
  );
  receiver.once("message", () => {
    clearTimeout(timer);
    resolve();
  });
  receiver.once("exit", () => {
    clearTimeout(timer);
    reject(new Error("Receiver exited: " + receiverLog));
  });
  receiver.once("error", reject);
});
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
let foreignRequests = 0;
const foreignReceiver = createServer((req, res) => {
  foreignRequests++;
  req.resume();
  res.end("Foreign destination must never receive resume bytes");
});
await new Promise<void>((resolve) =>
  foreignReceiver.listen(config.PORT + 2, "127.0.0.1", resolve),
);
const email = "submission-qa@example.test";
const sessions = new Map<
  string,
  {
    page: Page;
    context: BrowserContext;
    review: FormReview;
    plan: SubmissionPlan;
  }
>();
const scenarios = new Map<string, string>();
const checks: string[] = [],
  receipts: any[] = [];
const passed = (s: string) => {
  checks.push(s);
  console.log("PASS", s);
};
const identity = (owner: string, run: any) =>
  `${owner}:${run.external_job_key}:${run.cycle}`;
async function fixture(plan: SubmissionPlan, scenario = "normal") {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === receiverOrigin
      ? r.continue()
      : r.abort(),
  );
  await context.addCookies([
    {
      name: "fixture_account",
      value: email,
      url: receiverOrigin,
      httpOnly: true,
    },
  ]);
  const page = await context.newPage();
  const job = new URL(plan.jobUrl).pathname.split("/").filter(Boolean).at(-1)!;
  await page.goto(
    `${receiverOrigin}/forms/${plan.platform}/${job}?scenario=${scenario}`,
  );
  return { page, context };
}
const engine: SubmissionAcceptanceEngine = {
  async prepare(owner, run) {
    const { data, asset } = await submissionDocument(owner, run.id);
    const plan: SubmissionPlan = {
      platform: run.manifest.target.platform,
      jobUrl: run.manifest.target.url,
      accountEmail: run.manifest.accountEmail,
      resume: { name: asset.name, bytes: data, sha256: asset.sha256 },
      answers: run.manifest.answers,
      testFixtureOrigin: receiverOrigin,
    };
    const session = await fixture(plan, scenarios.get(run.external_job_key));
    try {
      const review = await prepareBrowserSubmission(session.page, plan);
      sessions.set(run.id, { ...session, review, plan });
      return review;
    } catch (e) {
      console.error("Controlled preparation failed", e);
      await session.context.close();
      throw e;
    }
  },
  async submit(owner, run) {
    const session = sessions.get(run.id)!;
    // Receipt is parsed from an actual HTTP response from the separate process.
    // The test independently reads receiver disk files to verify it was persisted.
    const response = session.page
      .waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().startsWith(receiverOrigin + "/receive/"),
        { timeout: 5000 },
      )
      .then(async (r) => {
        assert.equal(r.status(), 200);
        return r.json();
      })
      .catch(() => null);
    try {
      await clickApprovedSubmission(
        session.page,
        session.review,
        async (fingerprint) => {
          await acquireSubmissionPermit(owner, run.id, fingerprint, () =>
            journal.reserve(identity(owner, run), {
              attemptId: run.id,
              dossierHash: run.manifest_hash,
              formHash: fingerprint,
            }),
          );
        },
      );
      const receipt = await response;
      if (!receipt) throw new Error("RECEIPT_UNAVAILABLE");
      assert.equal(receipt.externalJobKey, run.external_job_key);
      assert.equal(receipt.resumeHash, run.manifest.document.sha256);
      await finishSubmission(owner, run.id, "confirmed", receipt);
      await journal.recordResult(
        identity(owner, run),
        run.id,
        "confirmed",
        hash(JSON.stringify(receipt)),
      );
    } finally {
      await session.context.close();
    }
  },
};
const app = await buildApp({ submissionAcceptanceEngine: engine });
await app.listen({ host: "127.0.0.1", port: config.PORT });
let cookie = "",
  owner = "",
  mcp: Client | undefined;
async function call(
  method: string,
  endpoint: string,
  body?: unknown,
  expected = 200,
  actorCookie = cookie,
) {
  const response = await fetch(config.PUBLIC_URL + "/api" + endpoint, {
    method,
    headers: {
      origin: config.origin,
      cookie: actorCookie,
      "idempotency-key": randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(
    response.status,
    expected,
    `${method} ${endpoint}: ${response.status === expected ? "" : await response.text()}`,
  );
  return response;
}
async function api(
  method: string,
  endpoint: string,
  body?: unknown,
  expected = 200,
  actorCookie = cookie,
): Promise<any> {
  return (await call(method, endpoint, body, expected, actorCookie)).json();
}
async function connectMcp() {
  const registered = await fetch(config.PUBLIC_URL + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Controlled submission QA",
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
    scope: "careeros:read careeros:write",
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
  const consent = await api("POST", "/oauth/consent/" + rid, { approve: true });
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
  mcp = new Client({ name: "submission-acceptance", version: "1.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(config.PUBLIC_URL + "/mcp"), {
      requestInit: {
        headers: { authorization: "Bearer " + token.access_token },
      },
    }),
  );
}
async function tool(name: string, args: Record<string, unknown>) {
  const result: any = await mcp!.callTool({ name, arguments: args });
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}
const answers = {
  Name: "Fictional QA Applicant",
  "Email address *": email,
  "Mobile phone number*": "+12025550123",
  姓名: "Fictional QA Applicant",
  電子郵件: email,
  聯絡電話: "+12025550123",
};
const resumes: any[] = [];
async function application(
  platform: "linkedin" | "104",
  jobId: string,
  resume = resumes[0],
  alias = false,
) {
  const job = await api("POST", "/jobs", {
    title: `FICTIONAL ${jobId}`,
    company: "Controlled receiver only",
    market: platform === "104" ? "TW" : "US",
    description: "Synthetic QA posting, never sent to an employer",
    url:
      platform === "104"
        ? `https://www.104.com.tw/job/${jobId}${alias ? "?jobsource=company_job" : ""}`
        : alias
          ? `https://www.linkedin.com/jobs/search/?currentJobId=${jobId}`
          : `https://www.linkedin.com/jobs/view/${jobId}/`,
  });
  return api("POST", "/applications", { jobId: job.id, resumeId: resume.id });
}
const prepare = (a: any) =>
  api("POST", `/applications/${a.id}/submissions`, {
    expectedVersion: a.version,
    accountEmail: email,
    answers,
  });
const approve = (r: any, status = 200, actorCookie = cookie) =>
  api(
    "POST",
    `/submissions/${r.id}/approve`,
    { fingerprint: r.review.fingerprint, confirm: true },
    status,
    actorCookie,
  );
let failure: string | undefined;
try {
  const register = await call("POST", "/auth/register", {
    name: "Fictional QA Applicant",
    email,
    password: "synthetic-submission-password",
    invite: config.BOOTSTRAP_TOKEN,
  });
  cookie = register.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  owner = ((await register.json()) as any).user.id;
  const invite = await api("POST", "/auth/invites", {});
  const other = await call("POST", "/auth/register", {
    name: "Other QA",
    email: "other-submission@example.test",
    password: "synthetic-other-password",
    invite: invite.token,
  });
  const otherCookie = other.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  await connectMcp();
  const facts = [];
  const stories = [
    "FICTIONAL QA ONLY: Lin Example built TypeScript and PostgreSQL APIs in a synthetic benchmark.",
    "FICTIONAL QA ONLY: Maya Example used SQL and Python to analyze synthetic retention data.",
    "FICTIONAL QA ONLY: Zhou Example built a personal React reading list with keyboard navigation.",
  ];
  for (let i = 0; i < 3; i++) {
    await tool("sources_create_text", {
      title: `Synthetic resume ${i + 1}`,
      text: stories[i],
      idempotencyKey: randomUUID(),
    });
    facts.push(
      (
        await api("POST", "/facts", {
          expectedRevision: i,
          fact: {
            kind: "project",
            title: `Synthetic project ${i + 1}`,
            content: stories[i],
          },
        })
      ).fact,
    );
  }
  for (let i = 0; i < 3; i++) {
    const resume = await tool("resumes_create_version", {
      resume: {
        title: `Fictional resume ${i + 1}`,
        language: "en",
        careerRevision: 3,
        blocks: [
          { heading: "Projects", text: stories[i], factIds: [facts[i].id] },
        ],
      },
      idempotencyKey: randomUUID(),
    });
    await api("POST", `/resumes/${resume.id}/approve`, {});
    const pdf = Buffer.from(
      await (
        await call("GET", `/resumes/${resume.id}/export/pdf`)
      ).arrayBuffer(),
    );
    assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
    resumes.push({ ...resume, pdf });
  }
  passed(
    "MCP imported 3 fictional histories and created 3 fact-linked resume versions; approved PDF exports are real",
  );
  const ui = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await ui.route("**/*", (r) =>
    new URL(r.request().url()).origin === config.origin
      ? r.continue()
      : r.abort(),
  );
  await ui.addCookies(
    cookie.split("; ").map((c) => {
      const i = c.indexOf("=");
      return { name: c.slice(0, i), value: c.slice(i + 1), url: config.origin };
    }),
  );
  const page = await ui.newPage();
  for (let i = 0; i < 3; i++) {
    const a = await application(
      i === 1 ? "104" : "linkedin",
      String(90000001 + i),
      resumes[i],
    );
    if (i === 0) await page.goto(config.PUBLIC_URL + "/#applications");
    else await page.reload();
    await page
      .getByRole("row")
      .filter({ hasText: `FICTIONAL ${90000001 + i}` })
      .getByRole("button", { name: "檢查投遞" })
      .click();
    await page.getByLabel(/^聯絡電話/).fill(answers["聯絡電話"]);
    const prepared = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/applications/${a.id}/submissions`) &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "填表並檢查內容" }).click();
    const preparation = await prepared;
    assert.equal(preparation.status(), 200, await preparation.text());
    const run = await preparation.json();
    const dialog = page.getByRole("dialog", { name: "投遞檢查" });
    await dialog.getByText(email, { exact: true }).first().waitFor();
    await dialog.getByRole("checkbox").check();
    const completed = page.waitForResponse((r) =>
      r.url().endsWith(`/submissions/${run.id}/approve`),
    );
    await dialog.getByRole("button", { name: "確認送出這一份" }).click();
    const sent = await completed;
    assert.equal(sent.status(), 200, await sent.text());
    const confirmed = await sent.json();
    assert.equal(confirmed.status, "confirmed");
    const receipt = confirmed.receipt;
    const actualPdf = await readFile(
      path.join(receiverDirectory, receipt.receiptId + ".pdf"),
    );
    assert.equal(hash(actualPdf), hash(resumes[i].pdf));
    const diskReceipt = JSON.parse(
      await readFile(
        path.join(receiverDirectory, receipt.receiptId + ".json"),
        "utf8",
      ),
    );
    assert.equal(diskReceipt.resumeHash, hash(actualPdf));
    const parser = new PDFParse({ data: actualPdf });
    try {
      assert.ok(
        (await parser.getText()).text.includes(
          ["Lin Example", "Maya Example", "Zhou Example"][i],
        ),
      );
    } finally {
      await parser.destroy();
    }
    assert.equal(
      (
        await one(
          pool,
          "SELECT count(*)::int n FROM application_events WHERE application_id=$1 AND type='submitted' AND source='runner'",
          [a.id],
        )
      ).n,
      1,
    );
    await approve(run, 409);
    await page.screenshot({
      path: path.join(output, `submission-${i + 1}.png`),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "關閉", exact: true }).click();
    receipts.push({ ...diskReceipt, resumeBytes: actualPdf.length });
    passed(
      `Browser approval ${i + 1}: separate HTTP receiver persisted exact PDF bytes, content and receipt; retry rejected`,
    );
  }
  await ui.close();

  const dropped = await application("linkedin", "90000004");
  scenarios.set("linkedin:90000004", "drop");
  const dropRun = await prepare(dropped);
  await approve(dropRun, 409);
  assert.equal(
    (await one(pool, "SELECT * FROM submission_runs WHERE id=$1", [dropRun.id]))
      .status,
    "outcome_unknown",
  );
  const dropApp = await one(pool, "SELECT * FROM applications WHERE id=$1", [
    dropped.id,
  ]);
  assert.equal(dropApp.submitted_at, null);
  assert.equal(dropApp.status, "submission_unknown");
  await approve(dropRun, 409);
  await api("POST", `/submissions/${dropRun.id}/cancel`, {}, 409);
  const received = await Promise.all(
    (await readdir(receiverDirectory))
      .filter((f) => f.endsWith(".json"))
      .map(async (f) =>
        JSON.parse(await readFile(path.join(receiverDirectory, f), "utf8")),
      ),
  );
  assert.equal(
    received.filter((r) => r.externalJobKey === "linkedin:90000004").length,
    1,
  );
  const recreatedJournal = new SubmissionJournal(journalDirectory);
  await assert.rejects(
    recreatedJournal.reserve(identity(owner, dropRun), {
      attemptId: randomUUID(),
      dossierHash: dropRun.manifest_hash,
      formHash: dropRun.review.fingerprint,
    }),
    /EEXIST/,
  );
  const restart = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { SubmissionJournal } from './server/submission-journal.ts';
    try { await new SubmissionJournal(process.env.QA_JOURNAL).reserve(process.env.QA_IDENTITY, {attemptId:'new-process',dossierHash:'test',formHash:'test'}); process.exitCode=1; }
    catch(e) { if(e.code !== 'EEXIST') process.exitCode=2; }`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        QA_JOURNAL: journalDirectory,
        QA_IDENTITY: identity(owner, dropRun),
      },
      stdio: "ignore",
    },
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      restart.once("exit", resolve);
      restart.once("error", reject);
    }),
    0,
  );
  // Simulate restoring only the DB to before dispatch. Persistent independent
  // journal must block the second send even though DB would grant it again.
  await pool.query(
    "UPDATE applications SET status='preparing',version=$1 WHERE id=$2",
    [dropRun.manifest.applicationVersion, dropped.id],
  );
  await pool.query(
    "UPDATE submission_runs SET status='approved',permit_at=NULL WHERE id=$1",
    [dropRun.id],
  );
  await assert.rejects(
    acquireSubmissionPermit(owner, dropRun.id, dropRun.review.fingerprint, () =>
      recreatedJournal.reserve(identity(owner, dropRun), {
        attemptId: dropRun.id,
        dossierHash: dropRun.manifest_hash,
        formHash: dropRun.review.fingerprint,
      }),
    ),
    /EEXIST/,
  );
  passed(
    "Receiver accepted then connection dropped: unknown is not counted, no repeat send; a new Node process and simulated DB rollback cannot bypass local journal",
  );

  const protectedApp = await application("104", "90000005");
  const protectedRun = await prepare(protectedApp);
  await approve(protectedRun, 404, otherCookie);
  await api(
    "GET",
    `/applications/${protectedApp.id}/submissions`,
    undefined,
    404,
    otherCookie,
  );
  await pool.query(
    "UPDATE submission_runs SET expires_at=now()-interval '1 second' WHERE id=$1",
    [protectedRun.id],
  );
  await approve(protectedRun, 409);
  await api("POST", `/submissions/${protectedRun.id}/cancel`, {});
  const replacement = await prepare(protectedApp);
  assert.notEqual(replacement.id, protectedRun.id);
  await api("POST", `/submissions/${replacement.id}/cancel`, {});
  passed(
    "Cross-user access denied; expired preparation cancels and allows a fresh review without clearing issued permits",
  );

  const raceApp = await application("linkedin", "90000007");
  const raceRun = await prepare(raceApp);
  await approveSubmission(owner, raceRun.id, raceRun.review.fingerprint);
  const attempts = await Promise.allSettled(
    [1, 2].map(() =>
      acquireSubmissionPermit(
        owner,
        raceRun.id,
        raceRun.review.fingerprint,
        () =>
          journal.reserve(identity(owner, raceRun), {
            attemptId: raceRun.id,
            dossierHash: raceRun.manifest_hash,
            formHash: raceRun.review.fingerprint,
          }),
      ),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((r) => r.status === "rejected").length, 1);
  assert.equal(
    (
      await one(pool, "SELECT status FROM submission_runs WHERE id=$1", [
        raceRun.id,
      ])
    ).status,
    "sending",
  );
  passed(
    "Two concurrent dispatch permit requests produce exactly one durable permit",
  );

  const aliasApp = await application("linkedin", "90000006");
  const aliasRun = await prepare(aliasApp);
  const alternate = await application("linkedin", "90000006", resumes[0], true);
  await api("POST", "/applications/events", {
    applicationId: alternate.id,
    expectedVersion: alternate.version,
    type: "submitted",
    occurredAt: new Date().toISOString(),
    notes: "Synthetic existing application",
  });
  await approve(aliasRun, 409);
  passed(
    "A manual submission through an alternate URL after preparation prevents dispatch of the same external posting",
  );

  const plan: SubmissionPlan = {
    platform: "linkedin",
    jobUrl: "https://www.linkedin.com/jobs/view/90000009/",
    accountEmail: email,
    answers,
    resume: {
      name: "resume.pdf",
      bytes: resumes[0].pdf,
      sha256: hash(resumes[0].pdf),
    },
    testFixtureOrigin: receiverOrigin,
  };
  for (const scenario of ["question", "captcha"]) {
    const s = await fixture(plan, scenario);
    try {
      await assert.rejects(
        prepareBrowserSubmission(s.page, plan),
        scenario === "question" ? /ANSWERS_REQUIRED/ : /CAPTCHA_REQUIRES_USER/,
      );
    } finally {
      await s.context.close();
    }
  }
  passed(
    "Missing application answers and CAPTCHA stop before final submission",
  );
  for (const redirect of ["redirect307", "redirect308"]) {
    const s = await fixture(plan, redirect);
    try {
      const review = await prepareBrowserSubmission(s.page, plan);
      await clickApprovedSubmission(s.page, review, async () => {}).catch((e) =>
        assert.match(String(e), /ERR_FAILED/),
      );
    } finally {
      await s.context.close();
    }
  }
  assert.equal(foreignRequests, 0);
  passed(
    "HTTP 307 and 308 redirects cannot forward the multipart resume to a second localhost receiver",
  );
  for (const mutation of [
    "destination",
    "hidden",
    "pdf",
    "account",
    "during_permit",
    "submit_handler",
  ]) {
    const s = await fixture(plan);
    try {
      const review = await prepareBrowserSubmission(s.page, plan);
      let permits = 0;
      const mutate = async () => {
        if (mutation === "pdf")
          await s.page.locator('input[type="file"]').setInputFiles({
            name: "resume.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.concat([plan.resume.bytes, Buffer.from("changed")]),
          });
        else
          await s.page.evaluate((kind) => {
            if (kind === "destination")
              document.querySelector("form")!.action =
                "https://employer.invalid/receive";
            else if (kind === "account")
              document.querySelector<HTMLElement>(
                "[data-careeros-account]",
              )!.innerText = "wrong@example.test";
            else
              document.querySelector<HTMLInputElement>(
                'input[name="jobKey"]',
              )!.value = "linkedin:WRONG";
          }, mutation);
      };
      if (mutation === "submit_handler")
        await s.page.evaluate(() =>
          document.querySelector("form")!.addEventListener("submit", () => {
            document.querySelector<HTMLInputElement>(
              'input[name="jobKey"]',
            )!.value = "linkedin:WRONG";
          }),
        );
      else if (mutation !== "during_permit") await mutate();
      let posted = false;
      s.page.on("response", (r) => {
        if (r.request().method() === "POST") posted = true;
      });
      try {
        await clickApprovedSubmission(s.page, review, async () => {
          permits++;
          if (mutation === "during_permit") await mutate();
        });
        assert.equal(mutation, "submit_handler"); // Network guard, not DOM snapshot, rejects it.
      } catch (e) {
        assert.ok(
          /FORM_CHANGED|BROWSER_JOB|ERR_FAILED/.test(String(e)),
          String(e),
        );
      }
      assert.equal(
        permits,
        ["during_permit", "submit_handler"].includes(mutation) ? 1 : 0,
      );
      assert.equal(posted, false);
    } finally {
      await s.context.close();
    }
  }
  const forbidden = await fixture(plan);
  await forbidden.page.evaluate(() => {
    document.querySelector("form")!.action = "https://employer.invalid/receive";
  });
  await assert.rejects(
    prepareBrowserSubmission(forbidden.page, plan),
    /SUBMISSION_DESTINATION_FORBIDDEN/,
  );
  await forbidden.context.close();
  assert.equal(
    (await readdir(receiverDirectory)).filter((f) => f.endsWith(".json"))
      .length,
    4,
  );
  passed(
    "Changed destination, hidden job, same-name PDF bytes, account, permit-wait mutation and submit-event mutation never reach receiver; initial foreign destination rejected",
  );
} catch (e) {
  failure = e instanceof Error ? e.stack : String(e);
  console.error(failure);
} finally {
  await mcp?.close();
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    foreignReceiver.close((e) => (e ? reject(e) : resolve())),
  );
  await app.close();
  await pool.end();
  receiver.kill("SIGTERM");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        passed: !failure,
        scope:
          "controlled HTTP receiver; real LinkedIn/104 submission is NOT tested or enabled",
        checks,
        receipts,
        receiverDirectory,
        failure,
        receiverLog,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(output, "REPORT.md"),
    `# Controlled submission acceptance\n\n${failure ? "FAIL" : "PASS"}\n\nReal employer submission is NOT enabled or tested. Three fictional resumes are sent to a separate local HTTP receiver. One additional accepted request deliberately loses its response.\n\n${checks.map((c) => "- " + c).join("\n")}\n`,
  );
}
if (failure) process.exitCode = 1;
