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
import { readFile, readdir } from "node:fs/promises";
import { decrypt } from "../../server/crypto.js";
import {
  saveAssetInTransaction,
  removeUncommittedAsset,
  readAsset,
} from "../../server/assets.js";
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
test("manual applications work without career facts, freeze evidence and prevent duplicates", async () => {
  const body = {
    company: "Fictional Manual Company",
    title: "Frontend Engineer",
    market: "TW",
    occurredAt: "2025-06-15T02:30:00.000Z",
    channel: "104",
    externalResumeName: "External CV v3",
    notes: "Synthetic manually reported submission",
  };
  const requestKey = randomUUID();
  const recorded = (
    await call(b, "POST", "/applications/manual", body, 200, requestKey)
  ).json();
  assert.equal(recorded.status, "submitted");
  assert.equal(new Date(recorded.submitted_at).toISOString(), body.occurredAt);
  assert.equal(recorded.origin, "user_reported");
  assert.equal(
    (
      await call(b, "POST", "/applications/manual", body, 200, requestKey)
    ).json().id,
    recorded.id,
  );
  await call(b, "POST", "/applications/manual", body, 409);
  const detail = (await call(b, "GET", "/applications/" + recorded.id)).json();
  assert.equal(detail.events.length, 1);
  assert.equal(detail.dossiers.length, 1);
  assert.equal(detail.dossiers[0].snapshot.resume, null);
  assert.equal(detail.dossiers[0].snapshot.externalResume, null);
  assert.equal(detail.dossiers[0].snapshot.resumeLabel, "External CV v3");
  assert.equal(detail.dossiers[0].snapshot.submissionChannel, "104");
  assert.equal((await call(b, "GET", "/career")).json().facts.length, 0);
  await call(a, "GET", "/applications/" + recorded.id, undefined, 404);
  await call(
    b,
    "POST",
    "/applications/manual",
    {
      ...body,
      title: "Future",
      occurredAt: new Date(Date.now() + 86400000).toISOString(),
    },
    422,
  );
  await call(
    b,
    "POST",
    "/applications/manual",
    { ...body, title: "Unsafe", url: "javascript:alert(1)" },
    422,
  );
  await call(
    b,
    "POST",
    "/applications/manual",
    { ...body, externalResumeName: "", resumeId: resume.id },
    404,
  );
  await call(
    a,
    "POST",
    "/applications/manual",
    { ...body, resumeId: resume.id },
    422,
  );
});
test("manual backfill reuses saved job/application, preserves description and snapshots the selected version", async () => {
  const saved = (
    await call(a, "POST", "/jobs", {
      title: "Manual Backend",
      company: "Fictional Existing Company",
      market: "US",
      description:
        "Original full job description must survive a brief manual entry.",
      url: "https://example.test/manual-backend",
    })
  ).json();
  const draft = (
    await call(a, "POST", "/applications", { jobId: saved.id })
  ).json();
  const recorded = (
    await call(a, "POST", "/applications/manual", {
      title: saved.title,
      company: saved.company,
      market: saved.market,
      url: saved.url,
      occurredAt: "2025-07-03T14:00:00.000Z",
      resumeId: resume.id,
      channel: "Company website",
    })
  ).json();
  assert.equal(recorded.id, draft.id);
  const detail = (await call(a, "GET", "/applications/" + recorded.id)).json();
  assert.equal(detail.job.description, saved.description);
  assert.equal(detail.dossiers[0].snapshot.resume.id, resume.id);
  assert.equal(detail.dossiers[0].snapshot.source, "user_reported");
});
test("external application attachments commit atomically, replay safely and stay private", async () => {
  const boundary = "CareerOSManualFixture";
  const metadata = {
    company: "Fictional Uploaded Resume",
    title: "Engineer",
    market: "TW",
    occurredAt: "2025-08-01T01:00:00.000Z",
  };
  const upload = async (
    body: any,
    key = randomUUID(),
    file = "%PDF-1.4\nFICTIONAL TEST FIXTURE\n",
  ) =>
    app.inject({
      method: "POST",
      url: config.basePath + "/api/applications/manual",
      headers: {
        cookie: b.cookie,
        origin,
        "idempotency-key": key,
        "content-type": "multipart/form-data; boundary=" + boundary,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(body)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.pdf"\r\nContent-Type: application/pdf\r\n\r\n${file}\r\n--${boundary}--\r\n`,
      ),
    });
  const before = (await call(b, "GET", "/career")).json().sources.length;
  const key = randomUUID();
  const response = await upload(metadata, key);
  assert.equal(response.statusCode, 200, response.body);
  const recorded = response.json();
  assert.equal(recorded.external_resume_name, "fixture.pdf");
  assert.equal((await call(b, "GET", "/career")).json().sources.length, before);
  const detail = (await call(b, "GET", "/applications/" + recorded.id)).json();
  assert.equal(
    detail.dossiers[0].snapshot.externalResume.sha256,
    createHash("sha256")
      .update("%PDF-1.4\nFICTIONAL TEST FIXTURE\n")
      .digest("hex"),
  );
  assert.ok(!("storage_key" in detail.dossiers[0].snapshot.externalResume));
  const assetId = recorded.external_resume_asset_id;
  await call(a, "GET", "/assets/" + assetId, undefined, 404);
  await call(
    a,
    "POST",
    "/applications/manual",
    { ...metadata, externalResumeAssetId: assetId },
    404,
  );
  const files = await readdir(config.dataDir + "/assets/" + b.id);
  const count = async () =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM assets WHERE owner_id=$1",
        [b.id],
      )
    ).rows[0].n;
  const beforeCount = await count();
  assert.equal((await upload(metadata, key)).json().id, recorded.id);
  assert.equal(
    (await upload(metadata, key, "%PDF-1.4 CHANGED")).statusCode,
    409,
  );
  assert.equal((await upload(metadata)).statusCode, 409);
  assert.equal(
    (
      await upload({
        ...metadata,
        company: "Rollback",
        occurredAt: "2999-01-01T00:00:00.000Z",
      })
    ).statusCode,
    422,
  );
  assert.equal(await count(), beforeCount);
  assert.deepEqual(await readdir(config.dataDir + "/assets/" + b.id), files);
});
test("attachment cleanup waits for an in-flight writer before deciding whether the file is committed", async () => {
  const writer = await pool.connect();
  let cleanup: Promise<void> | undefined;
  try {
    await writer.query("BEGIN");
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    const bytes = Buffer.from("%PDF-1.4 FICTIONAL CONCURRENT COMMIT");
    const asset = await saveAssetInTransaction(
      writer,
      b.id,
      "committed.pdf",
      "application/pdf",
      bytes,
      () => {},
    );
    cleanup = removeUncommittedAsset(b.id, asset.id);
    // Observe the lock wait itself instead of relying on timing/sleeps as evidence.
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      if (waiting.rows[0].n > 0) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      blocked,
      true,
      "cleanup must wait for the owner's transaction lock",
    );
    await writer.query("COMMIT");
    await cleanup;
    assert.deepEqual((await readAsset(b.id, asset.id)).data, bytes);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    await cleanup;
  }
});
test("same company and title without a URL remain separate across job markets", async () => {
  const body = {
    company: "Fictional Global",
    title: "Engineer",
    occurredAt: "2025-08-01T01:00:00.000Z",
  };
  const tw = (
    await call(b, "POST", "/applications/manual", { ...body, market: "TW" })
  ).json();
  const us = (
    await call(b, "POST", "/applications/manual", { ...body, market: "US" })
  ).json();
  assert.notEqual(tw.job_id, us.job_id);
  assert.equal(
    (await call(b, "GET", "/applications/" + tw.id)).json().job.market,
    "TW",
  );
  assert.equal(
    (await call(b, "GET", "/applications/" + us.id)).json().job.market,
    "US",
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
