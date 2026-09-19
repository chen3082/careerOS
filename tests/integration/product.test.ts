import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { buildApp } from "../../server/index.js";
import { pool } from "../../server/db.js";
import { config } from "../../server/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { taskContext } from "../../server/domain.js";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { readFile } from "node:fs/promises";
import { decrypt } from "../../server/crypto.js";
if (!new URL(config.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Integration tests require a dedicated *_test database");
const app = await buildApp();
type Actor = { id: string; cookie: string };
let a: Actor, b: Actor;
const origin = config.origin;
async function call(
  actor: Actor | undefined,
  method: any,
  path: string,
  body?: any,
  expected = 200,
  key = randomUUID(),
) {
  const r = await app.inject({
    method,
    url: config.basePath + "/api" + path,
    headers: {
      origin,
      "idempotency-key": key,
      ...(actor ? { cookie: actor.cookie } : {}),
    },
    payload: body,
  });
  assert.equal(r.statusCode, expected, `${method} ${path}: ${r.body}`);
  return r;
}
async function register(email: string, invite: string) {
  const r = await call(undefined, "POST", "/auth/register", {
    name: email.split("@")[0],
    email,
    password: "test-password-very-long",
    invite,
  });
  return {
    id: r.json().user.id,
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
  };
}
before(async () => {
  await pool.query("TRUNCATE users,oauth_clients,auth_throttles CASCADE");
  await app.listen({ port: config.PORT, host: "127.0.0.1" });
  a = await register("alice@example.test", config.BOOTSTRAP_TOKEN!);
  const invite = (await call(a, "POST", "/auth/invites", {})).json().token;
  b = await register("bob@example.test", invite);
  await call(
    undefined,
    "POST",
    "/auth/register",
    {
      name: "Eve",
      email: "eve@example.test",
      password: "test-password-very-long",
      invite,
    },
    403,
  );
});
after(async () => {
  await app.close();
  await pool.end();
});
let fact: any, resume: any, job: any, application: any;
test("session authorization and CSRF are enforced", async () => {
  await call(undefined, "GET", "/career", undefined, 401);
  const r = await app.inject({
    method: "POST",
    url: config.basePath + "/api/sources",
    headers: { cookie: a.cookie, origin: "https://attacker.invalid" },
    payload: { title: "bad", content: "bad" },
  });
  assert.equal(r.statusCode, 403);
});
test("facts, revision conflict, immutable resume, ownership and idempotency", async () => {
  const body = {
    expectedRevision: 0,
    fact: {
      kind: "project",
      title: "API platform",
      content: "Built a TypeScript API and PostgreSQL service.",
    },
  };
  const key = randomUUID();
  fact = (await call(a, "POST", "/facts", body, 200, key)).json().fact;
  assert.equal(
    (await call(a, "POST", "/facts", body, 200, key)).json().fact.id,
    fact.id,
  );
  await call(
    a,
    "POST",
    "/facts",
    { ...body, fact: { ...body.fact, title: "changed" } },
    409,
    key,
  );
  await call(a, "POST", "/facts", body, 409);
  resume = (
    await call(a, "POST", "/resumes", {
      title: "Backend engineer",
      language: "en",
      careerRevision: 1,
      blocks: [{ heading: "Projects", text: fact.content, factIds: [fact.id] }],
    })
  ).json();
  await call(b, "POST", "/resumes/" + resume.id + "/approve", {}, 404);
  job = (
    await call(a, "POST", "/jobs", {
      title: "Backend engineer",
      company: "Test Company",
      market: "US",
      description: "TypeScript and PostgreSQL required",
      url: "https://example.com/careers/test",
    })
  ).json();
  await call(b, "POST", "/applications", { jobId: job.id }, 404);
  application = (
    await call(a, "POST", "/applications", {
      jobId: job.id,
      resumeId: resume.id,
    })
  ).json();
  await call(
    a,
    "POST",
    "/applications/" + application.id + "/prepare",
    {},
    422,
  );
  await call(a, "POST", "/resumes/" + resume.id + "/approve", {});
  for (const item of [
    { value: "One-time answer", country: "US", reusable: false },
    { value: "Wrong market", country: "TW", reusable: true },
    { value: "Approved reuse", country: "US", reusable: true },
  ])
    await call(a, "POST", "/answers", {
      question: "Availability",
      semanticKey: "availability",
      company: "",
      ...item,
    });
  const dossier = (
    await call(a, "POST", "/applications/" + application.id + "/prepare", {})
  ).json();
  assert.equal(dossier.snapshot.resume.id, resume.id);
  assert.deepEqual(
    dossier.snapshot.answers.map((a: any) => a.value),
    ["Approved reuse"],
  );
});
test("generation inputs freeze job evidence and reject foreign references", async () => {
  const task = (
    await call(a, "POST", "/tasks", { kind: "career_analysis", input: {} })
  ).json();
  const context = await taskContext(pool, a.id, task.id);
  await call(a, "POST", "/jobs", {
    title: "Updated title",
    company: job.company,
    market: "US",
    description: "Updated job requirement",
    url: job.url,
  });
  const after = await taskContext(pool, a.id, task.id);
  assert.deepEqual(after.jobs, context.jobs);
  assert.equal(after.inputHash, context.inputHash);
  await call(
    b,
    "POST",
    "/tasks",
    { kind: "generate_resume", input: { jobId: job.id } },
    404,
  );
});
test("interview preparation is not an invitation; manual submission is single and freezes history", async () => {
  await call(a, "POST", "/preparations", {
    title: "Practice with Claude",
    notes: "Practice does not imply an invitation.",
  });
  assert.equal(
    (await call(a, "GET", "/dashboard")).json().counts.interviews,
    0,
  );
  const body = {
    applicationId: application.id,
    type: "submitted",
    occurredAt: new Date().toISOString(),
    expectedVersion: 0,
    notes: "Submitted manually at company portal",
  };
  const key = randomUUID();
  const first = (
    await call(a, "POST", "/applications/events", body, 200, key)
  ).json();
  assert.equal(first.status, "submitted");
  await call(a, "POST", "/applications/events", body, 200, key);
  await call(
    a,
    "POST",
    "/applications/events",
    { ...body, expectedVersion: 1 },
    409,
  );
  const detail = (
    await call(a, "GET", "/applications/" + application.id)
  ).json();
  assert.equal(detail.events.length, 1);
  assert.equal(detail.dossiers[0].snapshot.source, "user_reported");
  await call(
    a,
    "POST",
    "/applications/" + application.id + "/resume",
    { resumeId: resume.id, expectedVersion: 1 },
    409,
  );
  await call(a, "POST", "/applications/events", {
    ...body,
    type: "interview_invited",
    expectedVersion: 1,
  });
  assert.equal(
    (await call(a, "GET", "/dashboard")).json().counts.interviews,
    1,
  );
});
test("offers preserve revisions and accepted state cannot be overwritten by stale events", async () => {
  const o = (
    await call(a, "POST", "/offers", {
      applicationId: application.id,
      currency: "USD",
      amount: 150000,
      period: "year",
      terms: "Test offer",
    })
  ).json();
  const accepted = (
    await call(a, "POST", "/offers/" + o.id + "/decision", {
      decision: "accepted",
      expectedRevision: o.revision,
    })
  ).json();
  assert.equal(accepted.status, "accepted");
  await call(
    a,
    "POST",
    "/offers",
    {
      applicationId: application.id,
      currency: "USD",
      amount: 160000,
      period: "year",
      terms: "Duplicate would overwrite accepted",
    },
    409,
  );
  await call(
    a,
    "POST",
    "/offers/" + o.id + "/decision",
    { decision: "declined", expectedRevision: o.revision },
    409,
  );
  const current = (
    await call(a, "GET", "/applications/" + application.id)
  ).json().application;
  await call(
    a,
    "POST",
    "/applications/events",
    {
      applicationId: application.id,
      type: "rejected",
      occurredAt: new Date().toISOString(),
      expectedVersion: current.version,
    },
    409,
  );
});
test("groups preserve independent application status and revoke membership access", async () => {
  const g = (
    await call(a, "POST", "/groups", { name: "Backend circle" })
  ).json();
  const invite = (
    await call(a, "POST", "/groups/" + g.id + "/invites", {})
  ).json().invite;
  await call(b, "POST", "/groups/join", { token: invite });
  await call(b, "POST", "/groups/join", { token: invite }, 422);
  const shared = (
    await call(a, "POST", "/groups/" + g.id + "/jobs", { jobId: job.id })
  ).json();
  let detail = (await call(b, "GET", "/groups/" + g.id)).json();
  assert.equal(detail.jobs[0].my_status, null);
  assert.equal(detail.jobs[0].shared_statuses, null);
  const mine = (
    await call(b, "POST", "/groups/" + g.id + "/save-job", { jobId: shared.id })
  ).json();
  await call(b, "POST", "/applications", { jobId: mine.id });
  detail = (await call(b, "GET", "/groups/" + g.id)).json();
  assert.equal(detail.jobs[0].my_status, "preparing");
  await call(a, "POST", "/groups/" + g.id + "/sharing", { shareStatus: true });
  detail = (await call(b, "GET", "/groups/" + g.id)).json();
  assert.equal(detail.jobs[0].shared_statuses[0].status, "accepted");
  await call(a, "POST", "/groups/" + g.id + "/remove-member", { userId: b.id });
  await call(b, "GET", "/groups/" + g.id, undefined, 404);
  await call(
    b,
    "POST",
    "/groups/" + g.id + "/save-job",
    { jobId: shared.id },
    404,
  );
});
test("withdrawn facts invalidate future use but preserve past resume history", async () => {
  await call(a, "POST", "/facts/" + fact.id + "/revoke", {
    expectedRevision: 1,
  });
  const versions = (await call(a, "GET", "/resumes")).json().items;
  assert.equal(versions[0].validation.eligible, false);
  assert.equal(versions[0].blocks[0].text, fact.content);
  assert.equal(
    (await call(a, "GET", "/applications/" + application.id)).json().dossiers[0]
      .snapshot.resume.blocks[0].text,
    fact.content,
  );
});
async function oauth(scopes: string) {
  const reg = await fetch(config.PUBLIC_URL + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Integration MCP",
      redirect_uris: ["http://localhost:9922/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(reg.status, 201, await reg.clone().text());
  const client: any = await reg.json();
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://localhost:9922/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: scopes,
    resource: config.PUBLIC_URL + "/mcp",
    state: "test-state",
  });
  const auth = await fetch(config.PUBLIC_URL + "/oauth/authorize?" + query, {
    redirect: "manual",
  });
  assert.equal(auth.status, 302, await auth.text());
  const request = new URL(auth.headers.get("location")!).hash.slice(
    "#consent=".length,
  );
  const consent = (
    await call(a, "POST", "/oauth/consent/" + request, { approve: true })
  ).json();
  const redirect = new URL(consent.redirect);
  assert.equal(redirect.searchParams.get("state"), "test-state");
  const form = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: "http://localhost:9922/callback",
    code: redirect.searchParams.get("code")!,
    code_verifier: verifier,
    resource: config.PUBLIC_URL + "/mcp",
  };
  const exchange = async (data: any) =>
    fetch(config.PUBLIC_URL + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data),
    });
  assert.equal(
    (await exchange({ ...form, code_verifier: "x".repeat(43) })).status,
    400,
  );
  const success = await exchange(form);
  assert.equal(success.status, 200, await success.clone().text());
  const tokens: any = await success.json();
  assert.equal((await exchange(form)).status, 400);
  return { client, tokens, exchange };
}
test("OAuth PKCE, read-only MCP permissions and refresh replay revocation", async () => {
  const { client, tokens, exchange } = await oauth("careeros:read");
  const mcp = new Client({ name: "tests", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(config.PUBLIC_URL + "/mcp"),
    {
      requestInit: {
        headers: { authorization: "Bearer " + tokens.access_token },
      },
    },
  );
  await mcp.connect(transport);
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("profile_get"));
  assert.ok(!names.includes("sources_create_text"));
  await mcp.callTool({ name: "profile_get", arguments: {} });
  await mcp.close();
  const grant = {
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource: config.PUBLIC_URL + "/mcp",
  };
  assert.equal(
    (await exchange({ ...grant, scope: "careeros:read careeros:write" }))
      .status,
    400,
  );
  const renewed = await exchange(grant);
  assert.equal(renewed.status, 200);
  const next: any = await renewed.json();
  assert.equal((await exchange(grant)).status, 400);
  assert.equal(
    (
      await fetch(config.PUBLIC_URL + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + next.access_token,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    401,
  );
});
test("MCP writes create proposals, never confirmed facts or submitted applications", async () => {
  const { tokens } = await oauth("careeros:read careeros:write");
  const mcp = new Client({ name: "write-tests", version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(config.PUBLIC_URL + "/mcp"), {
      requestInit: {
        headers: { authorization: "Bearer " + tokens.access_token },
      },
    }),
  );
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(
    !names.some((n) => /confirm|submit_application|accept_offer/.test(n)),
  );
  const result: any = await mcp.callTool({
    name: "sources_create_text",
    arguments: {
      title: "Original story",
      text: "I built an API.",
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(result.isError, undefined);
  const source = JSON.parse(result.content[0].text);
  const created: any = await mcp.callTool({
    name: "generation_create_task",
    arguments: {
      kind: "extract_experience",
      input: { sourceId: source.id },
      idempotencyKey: randomUUID(),
    },
  });
  const task = JSON.parse(created.content[0].text);
  assert.equal(task.status, "waiting_client");
  const ctx = await taskContext(pool, a.id, task.id);
  const accepted: any = await mcp.callTool({
    name: "generation_submit_result",
    arguments: {
      taskId: task.id,
      inputHash: ctx.inputHash,
      result: {
        facts: [{ kind: "project", title: "API", content: "Built an API" }],
      },
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(accepted.isError, undefined);
  const facts = (await call(a, "GET", "/career")).json().facts;
  assert.equal(facts.find((f: any) => f.title === "API").confirmed, false);
  await mcp.close();
});
test("resume exports are private and stable across downloads", async () => {
  for (const format of ["pdf", "docx"]) {
    const r = await call(a, "GET", `/resumes/${resume.id}/export/${format}`);
    const repeat = await call(
      a,
      "GET",
      `/resumes/${resume.id}/export/${format}`,
    );
    assert.deepEqual(r.rawPayload, repeat.rawPayload);
    assert.ok(r.rawPayload.length > 500);
    if (format === "pdf") {
      const parser = new PDFParse({ data: new Uint8Array(r.rawPayload) });
      try {
        assert.match((await parser.getText()).text, /alice@example\.test/);
      } finally {
        await parser.destroy();
      }
    } else
      assert.match(
        (await mammoth.extractRawText({ buffer: r.rawPayload })).value,
        /alice@example\.test/,
      );
    await call(
      b,
      "GET",
      `/resumes/${resume.id}/export/${format}`,
      undefined,
      404,
    );
  }
  assert.match(
    (await call(a, "GET", `/resumes/${resume.id}/markdown`)).body,
    /alice@example\.test/,
  );
});
test("account exports omit secrets and deletion immediately revokes access", async () => {
  const exported = (await call(a, "GET", "/account/export")).body;
  assert.ok(!exported.includes("password_hash"));
  assert.ok(!exported.includes("encrypted"));
  await call(
    b,
    "POST",
    "/account/delete",
    { password: "wrong", confirmation: "DELETE" },
    401,
  );
  await call(b, "POST", "/account/delete", {
    password: "test-password-very-long",
    confirmation: "DELETE",
  });
  await call(b, "GET", "/career", undefined, 401);
  const ledger = await readFile(config.dataDir + "/deletions.log", "utf8");
  assert.ok(
    ledger
      .trim()
      .split("\n")
      .map((line) =>
        JSON.parse(decrypt(line, config.ENCRYPTION_KEY, "deletion-ledger")),
      )
      .some((row) => row.ownerId === b.id),
  );
});
