import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat, access } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../server/index.js";
import { config } from "../server/config.js";
import { pool } from "../server/db.js";
import { syntheticCareers } from "./fixtures/synthetic-careers.js";

// This suite never truncates or attaches to an existing application database.
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
const checks: { name: string; passed: boolean }[] = [];
const artifacts: { name: string; bytes: number; sha256: string }[] = [];
const browserErrors: string[] = [];
let mcpCalls = 0;
function passed(name: string) {
  checks.push({ name, passed: true });
  console.log("PASS", name);
}
async function artifact(name: string, value: string | Buffer) {
  const bytes = Buffer.from(value);
  await writeFile(path.join(output, name), bytes, { mode: 0o600 });
  artifacts.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
// Pace protocol traffic; this is functional testing, not a load test.
let nextRequestAt = 0;
const limitedFetch: typeof fetch = async (input, init) => {
  const delay = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Math.max(Date.now(), nextRequestAt) + 450;
  if (delay) await new Promise((r) => setTimeout(r, delay));
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30000),
  });
};
type Actor = {
  id: string;
  cookie: string;
  password: string;
  fixture: (typeof syntheticCareers)[number];
  context: BrowserContext;
  page: Page;
  mcp: Client;
  oauth: any;
  source?: any;
  facts?: any[];
  resumes: any[];
  job?: any;
  application?: any;
  task?: any;
  uploads: any[];
};
const actors: Actor[] = [];
const clients: Client[] = [];
async function response(
  actor: Actor | undefined,
  method: string,
  endpoint: string,
  body?: unknown,
  expected = 200,
  extra: Record<string, string> = {},
) {
  const r = await limitedFetch(config.PUBLIC_URL + "/api" + endpoint, {
    method,
    headers: {
      origin: config.origin,
      "idempotency-key": randomUUID(),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(actor ? { cookie: actor.cookie } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(
    r.status,
    expected,
    `${method} ${endpoint} returned ${r.status}, expected ${expected}`,
  );
  return r;
}
async function api(
  actor: Actor | undefined,
  method: string,
  endpoint: string,
  body?: unknown,
  expected = 200,
  extra: Record<string, string> = {},
) {
  return (
    await response(actor, method, endpoint, body, expected, extra)
  ).json() as Promise<any>;
}
async function tool(
  actor: Actor,
  name: string,
  args: Record<string, unknown> = {},
  error?: string,
) {
  mcpCalls++;
  const r: any = await actor.mcp.callTool({ name, arguments: args });
  if (error) {
    assert.equal(r.isError, true, `${name} must reject`);
    assert.ok(
      r.content.some((c: any) => c.text?.includes(error)),
      `${name}: expected ${error}`,
    );
    return r;
  }
  assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
}
async function oauth(actor: Actor, scope: string) {
  const registered = await limitedFetch(config.PUBLIC_URL + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Synthetic CareerOS MCP QA",
      redirect_uris: ["http://127.0.0.1:9922/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registered.status, 201);
  const client: any = await registered.json();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope,
    resource: config.PUBLIC_URL + "/mcp",
    state,
  });
  const authorized = await limitedFetch(
    config.PUBLIC_URL + "/oauth/authorize?" + query,
    { redirect: "manual" },
  );
  assert.equal(authorized.status, 302);
  const rid = new URL(authorized.headers.get("location")!).hash.slice(
    "#consent=".length,
  );
  const consent = await api(actor, "POST", "/oauth/consent/" + rid, {
    approve: true,
  });
  const redirect = new URL(consent.redirect);
  assert.equal(redirect.searchParams.get("state"), state);
  const form = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code: redirect.searchParams.get("code")!,
    code_verifier: verifier,
    resource: config.PUBLIC_URL + "/mcp",
  };
  const exchange = (data: Record<string, string>) =>
    limitedFetch(config.PUBLIC_URL + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data),
    });
  assert.equal(
    (await exchange({ ...form, code_verifier: "x".repeat(43) })).status,
    400,
  );
  const success = await exchange(form);
  assert.equal(success.status, 200);
  const tokens: any = await success.json();
  assert.equal((await exchange(form)).status, 400);
  const mcp = new Client({ name: "synthetic-e2e", version: "1.0" });
  clients.push(mcp);
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(config.PUBLIC_URL + "/mcp"), {
      fetch: limitedFetch,
      requestInit: {
        headers: { authorization: "Bearer " + tokens.access_token },
      },
    }),
  );
  return { mcp, tokens, client, exchange };
}
async function navigate(actor: Actor, route: string) {
  await actor.page.goto(config.PUBLIC_URL + "/#" + route);
  await actor.page
    .locator(".content .card, .content .notice, .resume-card")
    .first()
    .waitFor();
}
async function confirmProposal(actor: Actor) {
  await navigate(actor, "tasks");
  await actor.page.getByRole("button", { name: "核對後確認" }).click();
  await actor.page
    .getByRole("button", { name: "確認並更新", exact: true })
    .click();
  await actor.page.getByRole("dialog").waitFor({ state: "hidden" });
}
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: config.PORT });
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
let worker: ReturnType<typeof spawn> | undefined;
let workerStopped: Promise<number | null> | undefined;
let failure: string | undefined;
try {
  const unauth = await limitedFetch(config.PUBLIC_URL + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauth.status, 401);
  assert.ok(
    unauth.headers
      .get("www-authenticate")
      ?.includes("oauth-protected-resource"),
  );
  passed("MCP unauthenticated requests require OAuth");
  for (const fixture of syntheticCareers) {
    const invite = actors.length
      ? (await api(actors[0], "POST", "/auth/invites", {})).token
      : config.BOOTSTRAP_TOKEN;
    const password = randomBytes(24).toString("base64url");
    const registration = await response(undefined, "POST", "/auth/register", {
      name: fixture.name,
      email: fixture.email,
      password,
      invite,
    });
    const cookieHeader = registration.headers.get("set-cookie")!;
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Lax/i);
    const cookie = cookieHeader.split(";")[0];
    const user: any = await registration.json();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    });
    await context.addCookies([
      {
        name: "careeros_session",
        value: cookie.slice("careeros_session=".length),
        domain: "127.0.0.1",
        path: "/careeros",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === config.origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    page.on("pageerror", (e) => browserErrors.push(e.message));
    const actor = {
      id: user.user.id,
      cookie,
      password,
      fixture,
      context,
      page,
      resumes: [],
      uploads: [],
    } as unknown as Actor;
    actors.push(actor);
    actor.oauth = await oauth(actor, "careeros:read careeros:write");
    actor.mcp = actor.oauth.mcp;
    const names = (await actor.mcp.listTools()).tools.map((t) => t.name);
    assert.ok(
      !names.some((n) =>
        /confirm|approve|submit_application|accept_offer/.test(n),
      ),
    );
    passed(
      fixture.slug + ": OAuth PKCE, one-use code and no MCP confirmation tools",
    );
    await artifact(
      fixture.slug + "-source.md",
      "# FICTIONAL QA ONLY / 完全虛構\n\n" + fixture.story,
    );
    const sourceArgs = {
      title: fixture.name + " 測試原始經驗",
      text: fixture.story,
      idempotencyKey: randomUUID(),
    };
    actor.source = await tool(actor, "sources_create_text", sourceArgs);
    assert.equal(
      (await tool(actor, "sources_create_text", sourceArgs)).id,
      actor.source.id,
    );
    await tool(
      actor,
      "sources_create_text",
      { ...sourceArgs, text: fixture.story + "changed" },
      "IDEMPOTENCY_CONFLICT",
    );
    const extract = await tool(actor, "generation_create_task", {
      kind: "extract_experience",
      input: { sourceId: actor.source.id },
      idempotencyKey: randomUUID(),
    });
    actor.task = extract;
    assert.equal(extract.status, "waiting_client");
    const ctx = await tool(actor, "generation_get_context", {
      taskId: extract.id,
    });
    assert.equal(ctx.source.content, fixture.story);
    const result = {
      facts: fixture.facts.map(({ kind, title, content }) => ({
        kind,
        title,
        content,
      })),
    };
    await tool(
      actor,
      "generation_submit_result",
      {
        taskId: extract.id,
        inputHash: "stale",
        result,
        idempotencyKey: randomUUID(),
      },
      "STALE_INPUT",
    );
    const submit = {
      taskId: extract.id,
      inputHash: ctx.inputHash,
      result,
      idempotencyKey: randomUUID(),
    };
    const extracted = await tool(actor, "generation_submit_result", submit);
    assert.deepEqual(
      await tool(actor, "generation_submit_result", submit),
      extracted,
    );
    const draftProfile = await tool(actor, "profile_get");
    assert.equal(draftProfile.facts.length, 4);
    assert.ok(draftProfile.facts.every((f: any) => !f.confirmed));
    assert.equal((await tool(actor, "career_markdown_get")).revision, 0);
    await navigate(actor, "experience");
    assert.equal(
      await page.evaluate(() => (window as any).__careerosInjected),
      undefined,
    );
    assert.equal(await page.locator("img[onerror]").count(), 0);
    await page.getByRole("button", { name: "我已核對下方待確認內容" }).click();
    await page
      .getByRole("button", { name: "我已核對下方待確認內容" })
      .waitFor({ state: "hidden" });
    actor.facts = (await tool(actor, "profile_get")).facts;
    assert.ok(actor.facts!.every((f) => f.confirmed));
    const career = await tool(actor, "career_markdown_get");
    assert.equal(career.revision, 1);
    assert.ok(career.markdown.includes(fixture.facts[0].content));
    await artifact(fixture.slug + "-career.md", career.markdown);
    passed(
      fixture.slug +
        ": MCP source → extraction → website confirmation → canonical Markdown",
    );
    actor.job = await tool(actor, "jobs_save", {
      job: {
        title: fixture.role,
        company: fixture.company,
        market: fixture.market,
        location: fixture.market === "TW" ? "台灣（虛構）" : "US (fictional)",
        description: fixture.jobDescription,
        url: "https://jobs.example.test/" + fixture.slug,
      },
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      (await tool(actor, "jobs_search", { query: fixture.role })).items.length,
      1,
    );
    for (const [index, language] of ["zh-TW", "en"].entries()) {
      const task = await tool(actor, "generation_create_task", {
        kind: "generate_resume",
        input: index ? { jobId: actor.job.id, language } : { language },
        idempotencyKey: randomUUID(),
      });
      const frozen = await tool(actor, "generation_get_context", {
        taskId: task.id,
      });
      assert.equal(frozen.career.length, 4);
      if (index) assert.equal(frozen.job.description, fixture.jobDescription);
      const blocks = fixture.facts.map((f) => ({
        heading: f.title,
        text: language === "en" ? f.en : f.content,
        factIds: [actor.facts!.find((saved) => saved.title === f.title).id],
      }));
      const generated = await tool(actor, "generation_submit_result", {
        taskId: task.id,
        inputHash: frozen.inputHash,
        result: { title: fixture.titles[index], language, blocks },
        idempotencyKey: randomUUID(),
      });
      const resume = (await tool(actor, "resumes_list")).items.find(
        (r: any) => r.id === generated.resumeId,
      );
      assert.equal(resume.approved_at, null);
      actor.resumes.push(resume);
      await navigate(actor, "resumes");
      await page
        .locator(".resume-card")
        .filter({ hasText: fixture.titles[index] })
        .click();
      await page.getByRole("button", { name: "確認履歷內容" }).click();
      await page.getByRole("button", { name: "我已核對，確認內容" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      for (const format of ["pdf", "docx", "md"]) {
        const route =
          `/resumes/${resume.id}/` +
          (format === "md" ? "markdown" : "export/" + format);
        const first = Buffer.from(
          await (await response(actor, "GET", route)).arrayBuffer(),
        );
        const repeat = Buffer.from(
          await (await response(actor, "GET", route)).arrayBuffer(),
        );
        assert.deepEqual(first, repeat);
        if (format === "pdf")
          assert.equal(first.subarray(0, 5).toString(), "%PDF-");
        if (format === "md")
          assert.ok(first.toString().includes(fixture.email));
        await artifact(`${fixture.slug}-${language}.${format}`, first);
      }
    }
    await navigate(actor, "resumes");
    await page
      .locator(".resume-card")
      .filter({ hasText: fixture.titles[1] })
      .click();
    await page.screenshot({
      path: path.join(output, fixture.slug + "-resume.png"),
      fullPage: true,
    });
    passed(
      fixture.slug +
        ": two MCP-generated resume variants, approval and stable PDF/DOCX/Markdown",
    );
    actor.application = await tool(actor, "applications_prepare", {
      jobId: actor.job.id,
      resumeId: actor.resumes[1].id,
      idempotencyKey: randomUUID(),
    });
    assert.equal(actor.application.status, "preparing");
    await tool(actor, "preparations_create", {
      title: "虛構面試練習",
      notes: "練習 SQL／系統設計；沒有收到任何真實邀請。",
      idempotencyKey: randomUUID(),
    });
    assert.deepEqual((await api(actor, "GET", "/dashboard")).counts, {
      submitted: 0,
      interviews: 0,
      offers: 0,
      preparing: 1,
    });
    const proposal = await tool(actor, "applications_propose_manual_event", {
      event: {
        applicationId: actor.application.id,
        type: "submitted",
        occurredAt: new Date().toISOString(),
        expectedVersion: 0,
        notes: "SYNTHETIC QA EVENT — NO APPLICATION WAS SENT",
      },
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      (await tool(actor, "applications_list")).items[0].status,
      "preparing",
    );
    await api(
      undefined,
      "POST",
      "/proposals/" + proposal.id + "/confirm",
      {},
      401,
      { authorization: "Bearer " + actor.oauth.tokens.access_token },
    );
    await confirmProposal(actor);
    let application = (await tool(actor, "applications_list")).items[0];
    assert.equal(application.status, "submitted");
    await tool(actor, "applications_propose_manual_event", {
      event: {
        applicationId: application.id,
        type: "interview_invited",
        occurredAt: new Date().toISOString(),
        expectedVersion: application.version,
        notes: "SYNTHETIC INVITATION — NO REAL EMPLOYER",
      },
      idempotencyKey: randomUUID(),
    });
    assert.equal((await api(actor, "GET", "/dashboard")).counts.interviews, 0);
    await confirmProposal(actor);
    assert.equal((await api(actor, "GET", "/dashboard")).counts.interviews, 1);
    const noteForm = new FormData();
    noteForm.append(
      "file",
      new Blob(["虛構面經：練習了 SQL 與履歷說明，非真實雇主面試。"], {
        type: "text/markdown",
      }),
      "fictional-interview.md",
    );
    const uploaded: Response = await limitedFetch(
      config.PUBLIC_URL + "/api/assets",
      {
        method: "POST",
        headers: { origin: config.origin, cookie: actor.cookie },
        body: noteForm,
      },
    );
    assert.equal(uploaded.status, 200);
    const attachment: any = await uploaded.json();
    actor.uploads.push(attachment);
    await api(actor, "POST", "/notes", {
      title: "虛構面經",
      content: "此資料僅用於驗收。",
      applicationId: application.id,
      assetId: attachment.asset.id,
    });
    const offer = await api(actor, "POST", "/offers", {
      applicationId: application.id,
      currency: fixture.market === "US" ? "USD" : "TWD",
      amount: fixture.market === "US" ? 120000 : 1200000,
      period: "year",
      terms: "FICTIONAL QA OFFER — NOT A REAL JOB OFFER",
    });
    const decision = fixture.slug === "career-switch" ? "declined" : "accepted";
    await api(actor, "POST", "/offers/" + offer.id + "/decision", {
      decision,
      expectedRevision: offer.revision,
    });
    application = (await tool(actor, "applications_list")).items[0];
    assert.equal(
      application.status,
      decision === "accepted" ? "accepted" : "offer_declined",
    );
    await api(
      actor,
      "POST",
      "/applications/events",
      {
        applicationId: application.id,
        type: "rejected",
        occurredAt: new Date().toISOString(),
        expectedVersion: application.version,
      },
      409,
    );
    await navigate(actor, "dashboard");
    await page.screenshot({
      path: path.join(output, fixture.slug + "-dashboard.png"),
      fullPage: true,
    });
    passed(
      fixture.slug +
        ": preparation ≠ invitation; proposals require web confirmation; notes and final offer tracked",
    );
    const analysis = await tool(actor, "generation_create_task", {
      kind: "career_analysis",
      input: {},
      idempotencyKey: randomUUID(),
    });
    const evidence = await tool(actor, "generation_get_context", {
      taskId: analysis.id,
    });
    const advice = {
      title: "虛構職涯分析",
      directions: [
        {
          title: fixture.role,
          reason: "只依一份虛構職缺示範，不能推論整體市場或證照資格。",
          evidenceJobIds: [actor.job.id],
          gaps: [
            {
              skill: fixture.gap,
              state: "evidence_needed",
              reason: "素材尚未提供佐證，不表示不具備能力。",
            },
          ],
        },
      ],
      tasks: [
        {
          title: "建立可驗證的練習作品",
          output: "一份公開假資料的練習報告及測試結果。",
        },
      ],
    };
    await tool(
      actor,
      "generation_submit_result",
      {
        taskId: analysis.id,
        inputHash: evidence.inputHash,
        result: {
          ...advice,
          directions: [
            { ...advice.directions[0], evidenceJobIds: [randomUUID()] },
          ],
        },
        idempotencyKey: randomUUID(),
      },
      "INVALID_CAREER_EVIDENCE",
    );
    await tool(actor, "generation_submit_result", {
      taskId: analysis.id,
      inputHash: evidence.inputHash,
      result: advice,
      idempotencyKey: randomUUID(),
    });
    passed(
      fixture.slug +
        ": career advice rejects evidence outside frozen job sample",
    );
  }
  const [a, b, c] = actors;
  const htmlProbe = '<img src=x onerror="window.__careerosInjected=true">';
  await tool(c, "sources_create_text", {
    title: htmlProbe,
    text: "Literal HTML security fixture, not a career fact or instruction.",
    idempotencyKey: randomUUID(),
  });
  await navigate(c, "experience");
  await c.page.getByText(htmlProbe, { exact: true }).waitFor();
  assert.equal(await c.page.locator("img[onerror]").count(), 0);
  assert.equal(
    await c.page.evaluate(() => (window as any).__careerosInjected),
    undefined,
  );
  passed("Stored HTML payload is rendered as literal text, never executed");
  for (const [actor, victim] of [
    [b, a],
    [c, b],
    [a, c],
  ]) {
    await tool(
      actor,
      "generation_get_context",
      { taskId: victim.task.id },
      "NOT_FOUND",
    );
    await tool(
      actor,
      "generation_create_task",
      {
        kind: "extract_experience",
        input: { sourceId: victim.source.id },
        idempotencyKey: randomUUID(),
      },
      "NOT_FOUND",
    );
    await tool(
      actor,
      "applications_prepare",
      {
        jobId: victim.job.id,
        resumeId: victim.resumes[0].id,
        idempotencyKey: randomUUID(),
      },
      "NOT_FOUND",
    );
    await tool(
      actor,
      "resumes_create_version",
      {
        resume: {
          title: "Foreign fact probe",
          language: "en",
          careerRevision: 1,
          blocks: [
            {
              heading: "probe",
              text: "Must not persist",
              factIds: [victim.facts![0].id],
            },
          ],
        },
        idempotencyKey: randomUUID(),
      },
      "FACT_OUTSIDE_REVISION",
    );
    await response(
      actor,
      "GET",
      `/resumes/${victim.resumes[0].id}/export/pdf`,
      undefined,
      404,
    );
    await response(
      actor,
      "GET",
      `/assets/${victim.uploads[0].asset.id}`,
      undefined,
      404,
    );
    assert.equal((await tool(actor, "resumes_list")).items.length, 2);
  }
  passed(
    "Three-way tenant isolation: tasks, sources, facts, jobs, resumes and private attachments",
  );
  await response(
    a,
    "POST",
    "/facts/confirm",
    { ids: a.facts!.map((f) => f.id), expectedRevision: 1 },
    403,
    { origin: "https://attacker.invalid" },
  );
  const badOrigin = await limitedFetch(config.PUBLIC_URL + "/mcp", {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      authorization: "Bearer " + a.oauth.tokens.access_token,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(badOrigin.status, 403);
  const maliciousRedirect = await limitedFetch(
    config.PUBLIC_URL + "/oauth/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["javascript:alert(1)"],
        token_endpoint_auth_method: "none",
      }),
    },
  );
  assert.equal(maliciousRedirect.status, 400);
  passed("Website CSRF, MCP Origin and unsafe OAuth redirects blocked");
  const readOnly = await oauth(a, "careeros:read");
  const roNames = (await readOnly.mcp.listTools()).tools.map((t) => t.name);
  assert.ok(!roNames.includes("sources_create_text"));
  let denied = false;
  try {
    denied = Boolean(
      (
        await readOnly.mcp.callTool({
          name: "sources_create_text",
          arguments: {
            title: "denied",
            text: "denied",
            idempotencyKey: randomUUID(),
          },
        })
      ).isError,
    );
  } catch {
    denied = true;
  }
  assert.ok(denied);
  const grant = {
    grant_type: "refresh_token",
    client_id: readOnly.client.client_id,
    refresh_token: readOnly.tokens.refresh_token,
    resource: config.PUBLIC_URL + "/mcp",
  };
  assert.equal(
    (
      await readOnly.exchange({
        ...grant,
        scope: "careeros:read careeros:write",
      })
    ).status,
    400,
  );
  const refresh = await readOnly.exchange(grant);
  assert.equal(refresh.status, 200);
  const rotated: any = await refresh.json();
  assert.equal((await readOnly.exchange(grant)).status, 400);
  const replay = await limitedFetch(config.PUBLIC_URL + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + rotated.access_token,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(replay.status, 401);
  passed(
    "Read-only scope, privilege escalation and reused refresh-token family revocation",
  );
  const group = await api(a, "POST", "/groups", { name: "虛構 QA 小組" });
  await api(c, "GET", "/groups/" + group.id, undefined, 404);
  const invitation = await api(
    a,
    "POST",
    "/groups/" + group.id + "/invites",
    {},
  );
  await api(b, "POST", "/groups/join", { token: invitation.invite });
  await api(c, "POST", "/groups/join", { token: invitation.invite }, 422);
  await api(a, "POST", "/groups/" + group.id + "/jobs", { jobId: a.job.id });
  const shared = await api(b, "GET", "/groups/" + group.id);
  assert.equal(shared.jobs[0].my_status, null);
  assert.equal(shared.jobs[0].shared_statuses, null);
  await api(a, "POST", "/groups/" + group.id + "/remove-member", {
    userId: b.id,
  });
  await api(b, "GET", "/groups/" + group.id, undefined, 404);
  passed(
    "Private groups: one-use invite, opt-in progress and immediate member revocation",
  );
  for (const actor of actors) {
    for (const format of ["pdf", "docx"]) {
      const data = await readFile(
        path.join(output, `${actor.fixture.slug}-zh-TW.${format}`),
      );
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(data)], {
          type:
            format === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
        "fictional-resume." + format,
      );
      const r: Response = await limitedFetch(
        config.PUBLIC_URL + "/api/assets",
        {
          method: "POST",
          headers: { cookie: actor.cookie, origin: config.origin },
          body: form,
        },
      );
      assert.equal(r.status, 200);
      actor.uploads.push(await r.json());
    }
  }
  worker = spawn(process.execPath, ["--import", "tsx", "server/worker.ts"], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  workerStopped = new Promise((resolve, reject) => {
    worker!.once("error", reject);
    worker!.once("exit", resolve);
  });
  const deadline = Date.now() + 90000;
  while (true) {
    const tasks = (
      await pool.query(
        "SELECT status,error FROM tasks WHERE kind='parse_document'",
      )
    ).rows;
    if (tasks.length === 6 && tasks.every((t) => t.status === "succeeded"))
      break;
    assert.ok(
      !tasks.some((t) => t.status === "failed"),
      "Document parsing task failed",
    );
    assert.ok(Date.now() < deadline, "Document parsing timed out");
    await new Promise((r) => setTimeout(r, 1000));
  }
  worker.kill("SIGTERM");
  assert.equal(await workerStopped, 0);
  worker = undefined;
  for (const actor of actors) {
    for (const uploaded of actor.uploads.slice(1)) {
      const source = (await api(actor, "GET", "/career")).sources.find(
        (s: any) => s.id === uploaded.source.id,
      );
      assert.ok(source.content.includes(actor.fixture.email));
      assert.ok(source.content.includes(actor.fixture.name));
      assert.ok(!source.content.includes("\uFFFD"));
    }
  }
  passed(
    "Six real PDF/DOCX uploads round-trip through the worker with correct Chinese names and email",
  );
  const stored = (await pool.query("SELECT owner_id,storage_key FROM assets"))
    .rows;
  for (const asset of stored) {
    const file = path.join(config.dataDir, "assets", asset.storage_key);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const bytes = await readFile(file, "utf8");
    assert.ok(
      !bytes.includes("%PDF-") &&
        !bytes.includes("虛構面經") &&
        !bytes.includes("example.test"),
    );
  }
  passed("Stored attachments are encrypted and mode 0600");
  const beforeInvalid = (
    await pool.query("SELECT count(*)::int AS n FROM assets")
  ).rows[0].n;
  const invalidForm = new FormData();
  invalidForm.append(
    "file",
    new Blob(["not a PDF"], { type: "application/pdf" }),
    "invalid.pdf",
  );
  const invalid = await limitedFetch(config.PUBLIC_URL + "/api/assets", {
    method: "POST",
    headers: { origin: config.origin, cookie: a.cookie },
    body: invalidForm,
  });
  assert.equal(invalid.status, 422);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM assets")).rows[0].n,
    beforeInvalid,
  );
  passed("Invalid PDF signature rejected before persistence");
  await a.page.setViewportSize({ width: 390, height: 844 });
  await navigate(a, "experience");
  await a.page.waitForFunction(
    () =>
      document.querySelector(".sidebar")!.getBoundingClientRect().right <= 1,
  );
  assert.ok(
    await a.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await a.page.screenshot({
    path: path.join(output, "mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(browserErrors, []);
  passed(
    "Real browser confirmations and populated desktop/mobile screens have no page errors or overflow",
  );
  const exported = await (await response(c, "GET", "/account/export")).text();
  for (const secret of [
    "password_hash",
    "storage_key",
    c.password,
    c.oauth.tokens.access_token,
    c.oauth.tokens.refresh_token,
  ])
    assert.ok(!exported.includes(secret));
  await api(c, "POST", "/account/delete", {
    password: c.password,
    confirmation: "DELETE",
  });
  await api(c, "GET", "/career", undefined, 401);
  const revoked = await limitedFetch(config.PUBLIC_URL + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + c.oauth.tokens.access_token,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(revoked.status, 401);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM assets WHERE owner_id=$1",
        [c.id],
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(access(path.join(config.dataDir, "assets", c.id)));
  assert.ok(
    !(
      await readFile(path.join(config.dataDir, "deletions.log"), "utf8")
    ).includes(c.id),
  );
  passed(
    "Account export excludes secrets; deletion revokes web/MCP access and removes private attachments",
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM usage")).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM credentials")).rows[0].n,
    0,
  );
  passed(
    "No provider credentials, paid AI usage or real application submission",
  );
} catch (e) {
  failure = e instanceof Error ? e.message : "Unknown failure";
  console.error("E2E FAILED", failure);
  process.exitCode = 1;
} finally {
  if (worker) {
    worker.kill("SIGTERM");
    await workerStopped;
  }
  for (const client of clients) await client.close().catch(() => {});
  await browser.close();
  await app.close();
  await pool.end();
  const report = {
    started,
    finished: new Date().toISOString(),
    passed: !failure,
    failure,
    personas: syntheticCareers.map((p) => ({
      name: p.name,
      role: p.role,
      market: p.market,
    })),
    resumeVariants: 6,
    mcpCalls,
    checks,
    artifacts,
    limits: [
      "All people, employers, interviews and offers are fictional.",
      "Uses official MCP SDK over real HTTP plus real browser website confirmations.",
      "Generation JSON is a deterministic synthetic fixture; no Claude UI or paid model inference was tested.",
      "No external applications, Google integration, load test or penetration-test certification.",
      "Isolated internal Docker network; no production data, environment secrets or database are mounted.",
    ],
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(output, "REPORT.md"),
    `# CareerOS MCP E2E — synthetic data only\n\nStarted: ${started}\nFinished: ${report.finished}\nResult: ${failure ? "FAILED: " + failure : "PASS"}\nMCP calls: ${mcpCalls}\n\n## Scenarios\n\n${report.personas.map((p) => `- ${p.name}: ${p.role} / ${p.market}; zh-TW and English resumes`).join("\n")}\n\n## Checks\n\n${checks.map((c) => "- [x] " + c.name).join("\n")}\n\n## Scope and limits\n\n${report.limits.map((s) => "- " + s).join("\n")}\n`,
    { mode: 0o600 },
  );
}
