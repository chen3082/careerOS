import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server/index.js";
import { config } from "../../server/config.js";
import { pool, one } from "../../server/db.js";
import { encrypt } from "../../server/crypto.js";
import { executeGenerationTask } from "../../server/ai-generation.js";

assert.equal(config.NODE_ENV, "test");
assert.ok(new URL(config.DATABASE_URL).pathname.endsWith("_test"));
const app = await buildApp();
const keys = {
  openai: "sk-synthetic-openai-owner-only",
  anthropic: "sk-ant-synthetic-owner-only",
};
let cookie = "",
  owner = "",
  source: any;
async function api(path: string, body?: any, expected = 200) {
  const r = await app.inject({
    method: body === undefined ? "GET" : "POST",
    url: config.basePath + "/api" + path,
    payload: body,
    headers: { origin: config.origin, cookie, "idempotency-key": randomUUID() },
  });
  assert.equal(r.statusCode, expected, `${path}: ${r.body}`);
  return r;
}
async function settings(
  provider: "anthropic" | "openai",
  mode = "byok",
  limit = 1000000,
) {
  await api("/settings", {
    mode,
    aiProvider: provider,
    timezone: "Asia/Taipei",
    dailyTokenLimit: limit,
  });
}
async function task(
  kind = "extract_experience",
  input: any = { sourceId: source.id },
) {
  return (await api("/tasks", { kind, input })).json();
}
async function lease(t: any) {
  return (
    await pool.query(
      "UPDATE tasks SET status='running',lease_token=$1,lease_until=now()+interval '2 minutes' WHERE id=$2 RETURNING *",
      [randomUUID(), t.id],
    )
  ).rows[0];
}
async function usage(t: any) {
  return one(pool, "SELECT * FROM usage WHERE task_id=$1", [t.id]);
}
const output = {
  facts: [
    {
      kind: "project",
      title: "Synthetic API",
      content: "Built a TypeScript API with PostgreSQL.",
      validUntil: null,
    },
  ],
};
function response(provider: string, result: unknown = output, extra: any = {}) {
  return Response.json(
    provider === "openai"
      ? {
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: JSON.stringify(result) }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 25 },
          ...extra,
        }
      : {
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(result) }],
          usage: { input_tokens: 100, output_tokens: 25 },
          ...extra,
        },
    {
      headers: {
        [provider === "openai" ? "x-request-id" : "request-id"]:
          "synthetic-request",
      },
    },
  );
}
function transport(
  provider: "openai" | "anthropic",
  result?: unknown,
  inspect?: (body: any) => void,
): typeof fetch {
  return async (url, init) => {
    assert.equal(
      url,
      provider === "openai"
        ? "https://api.openai.com/v1/responses"
        : "https://api.anthropic.com/v1/messages",
    );
    assert.equal(init?.redirect, "error");
    const h = new Headers(init?.headers);
    assert.equal(
      h.get(provider === "openai" ? "authorization" : "x-api-key"),
      provider === "openai" ? "Bearer " + keys.openai : keys.anthropic,
    );
    const body = JSON.parse(String(init?.body));
    assert.ok(!JSON.stringify(body).includes(keys.openai));
    assert.ok(!JSON.stringify(body).includes(keys.anthropic));
    inspect?.(body);
    return response(provider, result);
  };
}
beforeEach(async () => {
  await pool.query(
    "TRUNCATE users,oauth_clients,auth_throttles,google_login_challenges CASCADE",
  );
  cookie = "";
  const r = await api("/auth/register", {
    name: "Synthetic Provider User",
    email: "provider@example.test",
    password: "synthetic-password-12345",
    invite: config.BOOTSTRAP_TOKEN,
  });
  owner = r.json().user.id;
  cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  for (const provider of ["openai", "anthropic"] as const)
    await api("/credentials", { provider, key: keys[provider] });
  source = (
    await api("/sources", {
      title: "Synthetic resume",
      content: "Built a TypeScript API with PostgreSQL.",
    })
  ).json();
  // The source endpoint returns the row directly.
  assert.ok(source.id);
  await settings("openai");
});
after(async () => {
  await app.close();
  await pool.end();
});

test("provider selection is validated, preserves legacy settings updates and freezes on each task", async () => {
  const t = await task("extract_experience", {
    sourceId: source.id,
    ai: { provider: "anthropic", model: "injected" },
  });
  assert.equal(t.ai_provider, "openai");
  assert.equal(t.ai_model, config.OPENAI_MODEL);
  await api(
    "/settings",
    {
      mode: "byok",
      aiProvider: "unknown",
      timezone: "UTC",
      dailyTokenLimit: 50000,
    },
    422,
  );
  await api("/settings", {
    mode: "byok",
    timezone: "UTC",
    dailyTokenLimit: 50000,
  });
  assert.equal((await api("/settings")).json().settings.aiProvider, "openai");
  await settings("anthropic");
  await executeGenerationTask(
    await lease(t),
    transport("openai", output, (body) => {
      assert.equal(body.model, config.OPENAI_MODEL);
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 4500);
      assert.deepEqual(body.text, { format: { type: "json_object" } });
    }),
  );
  assert.equal((await usage(t)).provider, "openai");
});

test("OpenAI output creates only unconfirmed facts and settles actual usage", async () => {
  const t = await lease(await task());
  const result = await executeGenerationTask(t, transport("openai"));
  assert.equal(result.needsConfirmation, true);
  const fact = await one(pool, "SELECT * FROM facts WHERE id=$1", [
    result.factIds[0],
  ]);
  assert.equal(fact.confirmed, false);
  assert.equal(fact.owner_id, owner);
  const u = await usage(t);
  assert.equal(u.state, "settled");
  assert.equal(u.actual_tokens, 125);
  assert.equal(u.provider_request_id, "synthetic-request");
});

test("Anthropic remains available with its own owner key and endpoint", async () => {
  await settings("anthropic");
  const t = await lease(await task());
  await executeGenerationTask(
    t,
    transport("anthropic", output, (body) => {
      assert.equal(body.model, config.ANTHROPIC_MODEL);
      assert.equal(body.max_tokens, 4500);
    }),
  );
  assert.equal((await usage(t)).provider, "anthropic");
});

test("legacy queued tasks ignore untrusted input provider fields and retain Anthropic behavior", async () => {
  const t = await lease(
    await task("extract_experience", {
      sourceId: source.id,
      ai: { provider: "openai", model: "injected" },
    }),
  );
  await pool.query(
    "UPDATE tasks SET ai_provider=NULL,ai_model=NULL WHERE id=$1",
    [t.id],
  );
  await executeGenerationTask(t, transport("anthropic"));
  assert.equal((await usage(t)).provider, "anthropic");
});

test("missing selected key never falls back to the other provider or another owner", async () => {
  await pool.query(
    "DELETE FROM credentials WHERE owner_id=$1 AND provider='openai'",
    [owner],
  );
  const other = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,name,password_hash) VALUES($1,'other-provider@example.test','Other synthetic user',NULL)",
    [other],
  );
  await pool.query(
    "INSERT INTO credentials(owner_id,provider,encrypted,last4) VALUES($1,'openai',$2,'only')",
    [
      other,
      encrypt(
        "sk-synthetic-other-owner-only",
        config.ENCRYPTION_KEY,
        other + ":openai",
      ),
    ],
  );
  const t = await lease(await task());
  let calls = 0;
  await assert.rejects(
    executeGenerationTask(t, async () => {
      calls++;
      return response("anthropic");
    }),
    /API_KEY_REQUIRED/,
  );
  assert.equal(calls, 0);
  assert.equal(await usage(t), undefined);
});

test("daily budget rejects the request before any provider call", async () => {
  await settings("openai", "byok", 1000);
  const t = await lease(await task());
  let calls = 0;
  await assert.rejects(
    executeGenerationTask(t, async () => {
      calls++;
      return response("openai");
    }),
    /DAILY_BUDGET_REACHED/,
  );
  assert.equal(calls, 0);
  assert.equal(await usage(t), undefined);
});

test("known provider rejection releases the reservation without retries", async () => {
  const t = await lease(await task());
  let calls = 0;
  await assert.rejects(
    executeGenerationTask(t, async () => {
      calls++;
      return new Response("", { status: 401 });
    }),
    /AI_PROVIDER_401/,
  );
  assert.equal(calls, 1);
  assert.equal((await usage(t)).state, "released");
  assert.equal((await usage(t)).actual_tokens, 0);
});

test("timeout or ambiguous provider failure preserves budget and does not retry", async () => {
  for (const fail of [
    async () => {
      throw new Error("synthetic timeout");
    },
    async () => new Response("", { status: 503 }),
  ]) {
    const t = await lease(await task());
    let calls = 0;
    await assert.rejects(
      executeGenerationTask(t, async () => {
        calls++;
        return fail();
      }),
    );
    const u = await usage(t);
    assert.equal(calls, 1);
    assert.equal(u.state, "unresolved");
    assert.equal(u.actual_tokens, null);
    assert.ok(u.reserved_tokens > 4500);
  }
});

test("missing usage remains unresolved even when valid output can be saved", async () => {
  const t = await lease(await task());
  await executeGenerationTask(t, async () =>
    response("openai", output, { usage: null }),
  );
  assert.equal((await usage(t)).state, "unresolved");
  assert.equal((await usage(t)).actual_tokens, null);
});

test("refusals, truncation and invalid output are charged accurately but never become facts", async () => {
  for (const [extra, error] of [
    [{ status: "incomplete" }, /AI_OUTPUT_INCOMPLETE/],
    [
      {
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "synthetic" }],
          },
        ],
      },
      /AI_OUTPUT_REFUSED/,
    ],
    [
      {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "invalid json" }],
          },
        ],
      },
      /AI_OUTPUT_INVALID/,
    ],
    [
      {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"facts":[]}' }],
          },
        ],
      },
      /AI_OUTPUT_INVALID/,
    ],
  ] as const) {
    const t = await lease(await task());
    await assert.rejects(
      executeGenerationTask(t, async () => response("openai", output, extra)),
      error,
    );
    assert.equal((await usage(t)).actual_tokens, 125);
  }
  assert.equal(
    (
      await one(
        pool,
        "SELECT count(*)::int AS n FROM facts WHERE owner_id=$1",
        [owner],
      )
    ).n,
    0,
  );
});

test("OpenAI resume and career analysis use the same evidence validation and draft lifecycle", async () => {
  const fact = (
    await api("/facts", {
      expectedRevision: 0,
      fact: {
        kind: "project",
        title: "Synthetic API",
        content: "Built a TypeScript API with PostgreSQL.",
      },
    })
  ).json().fact;
  const resumeTask = await lease(
    await task("generate_resume", { language: "en" }),
  );
  const resume = await executeGenerationTask(
    resumeTask,
    transport("openai", {
      title: "Synthetic Resume",
      language: "en",
      blocks: [
        {
          heading: "Project",
          text: "Built a TypeScript API with PostgreSQL.",
          factIds: [fact.id],
        },
      ],
    }),
  );
  assert.equal(resume.needsConfirmation, true);
  const invalid = await lease(
    await task("generate_resume", { language: "en" }),
  );
  await assert.rejects(
    executeGenerationTask(
      invalid,
      transport("openai", {
        title: "Invalid",
        language: "en",
        blocks: [
          { heading: "Project", text: "Unsupported", factIds: [randomUUID()] },
        ],
      }),
    ),
  );
  const job = (
    await api("/jobs", {
      title: "Backend Engineer",
      company: "Synthetic Company",
      market: "TW",
      description: "TypeScript and PostgreSQL.",
    })
  ).json();
  const careerTask = await lease(await task("career_analysis", {}));
  const plan = await executeGenerationTask(
    careerTask,
    transport("openai", {
      title: "Synthetic plan",
      directions: [
        {
          title: "Backend",
          reason: "One saved job sample only.",
          evidenceJobIds: [job.id],
          gaps: [
            {
              skill: "PostgreSQL",
              state: "evidence_needed",
              reason: "Confirm project details.",
            },
          ],
        },
      ],
      tasks: [{ title: "Document project", output: "Write a README." }],
    }),
  );
  assert.ok(plan);
  const wrong = await lease(await task("career_analysis", {}));
  await assert.rejects(
    executeGenerationTask(
      wrong,
      transport("openai", {
        title: "Invalid",
        directions: [
          {
            title: "Backend",
            reason: "Unsupported",
            evidenceJobIds: [randomUUID()],
            gaps: [],
          },
        ],
        tasks: [],
      }),
    ),
    /INVALID_CAREER_EVIDENCE/,
  );
});

test("MCP waiting tasks and stale leases cannot spend stored keys", async () => {
  await settings("openai", "mcp");
  const t = await task();
  assert.equal(t.status, "waiting_client");
  assert.equal(t.ai_provider, null);
  let calls = 0;
  await assert.rejects(
    executeGenerationTask(t, async () => {
      calls++;
      return response("openai");
    }),
    /STALE_WORKER/,
  );
  assert.equal(calls, 0);
  assert.equal(await usage(t), undefined);
});
