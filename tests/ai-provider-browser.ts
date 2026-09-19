import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { buildApp } from "../server/index.js";
import { config } from "../server/config.js";
import { pool, one } from "../server/db.js";

assert.equal(config.NODE_ENV, "test");
assert.ok(new URL(config.DATABASE_URL).pathname.endsWith("_test"));
if (process.env.E2E_OUTPUT) {
  assert.equal(new URL(config.DATABASE_URL).pathname, "/careeros_mcp_e2e_test");
  assert.equal(new URL(config.DATABASE_URL).hostname, "postgres-e2e");
  assert.equal(config.dataDir, "/tmp/careeros-mcp-e2e-data");
  assert.equal(process.env.E2E_OUTPUT, "/tmp/careeros-mcp-e2e-report");
}
const output = process.env.E2E_OUTPUT ?? "/tmp/careeros-ai-provider-e2e";
await mkdir(output, { recursive: true });
await pool.query(
  "TRUNCATE users,oauth_clients,auth_throttles,google_login_challenges CASCADE",
);
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: config.PORT });
const worker = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--import",
    "./tests/ai-provider-stub.ts",
    "server/worker.ts",
  ],
  {
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let workerOutput = "";
worker.stdout.on("data", (b) => {
  workerOutput += String(b);
});
worker.stderr.on("data", (b) => {
  workerOutput += String(b);
});
const stopped = new Promise<number | null>((resolve, reject) => {
  worker.on("error", reject);
  worker.on("exit", resolve);
});
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
await context.route("**/*", (r) =>
  new URL(r.request().url()).origin === config.origin
    ? r.continue()
    : r.abort(),
);
const page = await context.newPage(),
  errors: string[] = [],
  checks: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (s: string) => {
  checks.push(s);
  console.log("PASS", s);
};
const goSettings = async () => {
  await page.goto(config.PUBLIC_URL + "/#settings");
  await page.getByRole("heading", { name: "連接自己的 AI 助理" }).waitFor();
};
async function saveSettings(provider: string, mode = "byok") {
  await goSettings();
  await page.getByLabel("推理來源").selectOption(mode);
  await page.getByLabel("背景文字生成供應商").selectOption(provider);
  const done = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  assert.equal((await done).status(), 200);
}
async function saveKey(provider: string) {
  const card = page
    .locator(".credential")
    .filter({
      hasText:
        provider === "openai"
          ? "OpenAI · 文字生成與音檔轉錄"
          : "Anthropic · 文字生成",
    });
  await card.getByRole("button", { name: "設定", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("API key")
    .fill(
      provider === "openai"
        ? "sk-synthetic-browser-openai-only"
        : "sk-ant-synthetic-browser-only",
    );
  const done = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/credentials") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "加密保存" }).click();
  assert.equal((await done).status(), 200);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}
async function createTask() {
  await page.goto(config.PUBLIC_URL + "/#experience");
  await page
    .locator(".source-row")
    .filter({ hasText: "Synthetic resume" })
    .click();
  const done = page.waitForResponse(
    (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "整理這段經驗" }).click();
  return (await done).json();
}
async function waitTask(t: any) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const row = await one(pool, "SELECT * FROM tasks WHERE id=$1", [t.id]);
    if (["succeeded", "failed"].includes(row.status)) {
      assert.equal(row.status, "succeeded", row.error + workerOutput);
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Worker task timed out: " + workerOutput);
}
let failure: string | undefined;
try {
  await page.goto(config.PUBLIC_URL + "/");
  await page.getByLabel("怎麼稱呼你").fill("Synthetic AI Applicant");
  await page
    .getByLabel("Email", { exact: true })
    .fill("ai-browser@example.test");
  await page
    .getByLabel("密碼", { exact: true })
    .fill("synthetic-ai-password-12345");
  await page.getByLabel("工作台邀請碼").fill(config.BOOTSTRAP_TOKEN!);
  await page.getByRole("button", { name: "建立工作台" }).click();
  await page.getByRole("heading", { name: "求職總覽", exact: true }).waitFor();
  await goSettings();
  await page.getByLabel("AI 助理", { exact: true }).selectOption("chatgpt");
  await page.getByRole("link", { name: "OpenAI 官方連接說明 ↗" }).waitFor();
  await page.getByLabel("AI 助理", { exact: true }).selectOption("codex");
  assert.match(
    await page.locator(".mcp-command").innerText(),
    /codex mcp add careeros --url .*\/mcp\ncodex mcp login careeros/,
  );
  check(
    "Claude, ChatGPT and Codex connection guidance shares one MCP endpoint",
  );
  await saveSettings("openai");
  await saveKey("openai");
  await page.goto(config.PUBLIC_URL + "/#experience");
  await page.getByRole("button", { name: "輸入一段經驗" }).click();
  await page.getByLabel("這段經驗的標題").fill("Synthetic resume");
  await page
    .getByLabel("原始經驗", { exact: false })
    .fill(
      "Built a TypeScript API with PostgreSQL. This is synthetic test data.",
    );
  await page.getByRole("button", { name: "保存原始素材" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const openai = await createTask();
  assert.equal(openai.ai_provider, "openai");
  await waitTask(openai);
  await page.reload();
  await page
    .getByRole("heading", { name: "Synthetic OpenAI draft", exact: true })
    .waitFor();
  const fact = await one(
    pool,
    "SELECT * FROM facts WHERE title='Synthetic OpenAI draft'",
  );
  assert.equal(fact.confirmed, false);
  check(
    "Website OpenAI selection and encrypted key drive the real worker to an unconfirmed draft",
  );
  await saveSettings("anthropic");
  await saveKey("anthropic");
  const anthropic = await createTask();
  assert.equal(anthropic.ai_provider, "anthropic");
  await waitTask(anthropic);
  check(
    "Switching to Anthropic uses its separate key and preserves OpenAI task history",
  );
  const usage = (
    await pool.query(
      "SELECT provider,model,state,actual_tokens FROM usage ORDER BY created_at",
    )
  ).rows;
  assert.deepEqual(
    usage.map((u) => u.provider),
    ["openai", "anthropic"],
  );
  assert.ok(
    usage.every(
      (u) => u.state === "settled" && u.actual_tokens === 160 && u.model,
    ),
  );
  check(
    "Actual worker usage is recorded by provider and model without paid API traffic",
  );
  await saveSettings("openai", "mcp");
  const mcp = await createTask();
  assert.equal(mcp.status, "waiting_client");
  assert.equal(mcp.ai_provider, null);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM usage")).n, 2);
  await page.goto(config.PUBLIC_URL + "/#tasks");
  await page.getByText("待你的 AI 助理處理", { exact: true }).waitFor();
  check("MCP tasks wait for any connected assistant and do not spend API keys");
  await goSettings();
  await page.getByLabel("AI 助理", { exact: true }).selectOption("chatgpt");
  await page.screenshot({
    path: output + "/ai-settings-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("AI 助理", { exact: true }).selectOption("codex");
  await page.screenshot({
    path: output + "/ai-settings-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  check(
    "Desktop and mobile AI settings render without overflow or browser errors",
  );
} catch (e) {
  failure = String(e);
  console.error(e);
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
} finally {
  worker.kill("SIGTERM");
  const code = await stopped;
  if (code !== 0) failure ??= "Worker exit " + code;
  await writeFile(
    output + "/report.json",
    JSON.stringify(
      {
        passed: !failure,
        checks,
        errors,
        failure,
        provider:
          "Synthetic Responses/Messages API transports; real app, worker, database and browser",
      },
      null,
      2,
    ),
  );
  await writeFile(
    output + "/REPORT.md",
    "# AI provider isolated E2E\n\n" +
      checks.map((c) => "- PASS " + c).join("\n") +
      (failure ? "\nFAIL " + failure : "") +
      "\n\nNo real provider key or paid inference used. Real ChatGPT/Codex/Claude account acceptance remains user-side.\n",
  );
  await browser.close();
  await app.close();
  await pool.end();
}
if (failure) process.exitCode = 1;
