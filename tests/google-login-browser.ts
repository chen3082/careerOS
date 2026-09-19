import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { googleFixture, testClient } from "./google-fixture.js";
import { config } from "../server/config.js";
import { pool } from "../server/db.js";
import { buildApp } from "../server/index.js";

assert.equal(config.NODE_ENV, "test");
assert.ok(new URL(config.DATABASE_URL).pathname.endsWith("_test"));
if (process.env.E2E_OUTPUT) {
  assert.equal(new URL(config.DATABASE_URL).pathname, "/careeros_mcp_e2e_test");
  assert.equal(new URL(config.DATABASE_URL).hostname, "postgres-e2e");
  assert.equal(config.dataDir, "/tmp/careeros-mcp-e2e-data");
  assert.equal(process.env.E2E_OUTPUT, "/tmp/careeros-mcp-e2e-report");
}
const output = process.env.E2E_OUTPUT ?? "/tmp/careeros-google-e2e";
await mkdir(output, { recursive: true });
await pool.query(
  "TRUNCATE users,oauth_clients,auth_throttles,google_login_challenges CASCADE",
);
config.GOOGLE_LOGIN_CLIENT_ID = testClient;
const fixture = await googleFixture();
const app = await buildApp({ googleVerifier: fixture.verify });
await app.listen({ host: "127.0.0.1", port: config.PORT });
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
const checks: string[] = [],
  errors: string[] = [];
const check = (s: string) => {
  checks.push(s);
  console.log("PASS", s);
};
let subject = "browser-google",
  email = "browser-google@example.test",
  invalidNonce = false;
await context.exposeFunction("syntheticGoogleCredential", (nonce: string) =>
  fixture.sign(invalidNonce ? "invalid" : nonce, { sub: subject, email }),
);
await context.route("**/*", async (route) => {
  if (route.request().url() === "https://accounts.google.com/gsi/client") {
    await route.fulfill({
      contentType: "application/javascript",
      body: `let options; window.google={accounts:{id:{initialize(o){options=o},renderButton(el){const b=document.createElement('button');b.type='button';b.textContent='Synthetic Google sign-in';b.onclick=async()=>{const o=options;o.callback({credential:await window.syntheticGoogleCredential(o.nonce)})};el.replaceChildren(b)}}}};`,
    });
  } else if (new URL(route.request().url()).origin === config.origin)
    await route.continue();
  else await route.abort();
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const google = () =>
  page.getByRole("button", { name: "Synthetic Google sign-in" });
const dashboard = async () => {
  await page.getByRole("button", { name: "登出", exact: true }).waitFor();
  await page.goto(config.PUBLIC_URL + "/#dashboard");
  await page.getByRole("heading", { name: "求職總覽", exact: true }).waitFor();
};
const settings = async () => {
  await page.goto(config.PUBLIC_URL + "/#settings");
  await page
    .getByRole("heading", { name: "Google 登入", exact: true })
    .waitFor();
};
let failure: string | undefined;
try {
  await page.goto(config.PUBLIC_URL + "/privacy");
  await page.getByRole("heading", { name: "隱私與帳戶資料" }).waitFor();
  check("Public privacy page available without a session");
  await page.goto(config.PUBLIC_URL + "/");
  await page.getByLabel("工作台邀請碼").fill(config.BOOTSTRAP_TOKEN!);
  await google().click();
  await dashboard();
  check(
    "Invited Google-only registration via real browser cookies and verified synthetic JWT",
  );
  await settings();
  await page
    .getByText("browser-google@example.test", { exact: true })
    .last()
    .waitFor();
  await page
    .getByRole("button", { name: "重新驗證 Google", exact: true })
    .click();
  await google().click();
  await page
    .getByRole("button", { name: "重新驗證 Google", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "設定登入密碼", exact: true }).click();
  await page
    .getByLabel("新密碼（至少 12 字元）")
    .fill("synthetic-browser-password-123");
  await page.getByRole("button", { name: "更換並重新登入" }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  check(
    "Google reauthentication and initial password setup revoke the old browser session",
  );
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByLabel("密碼", { exact: true })
    .fill("synthetic-browser-password-123");
  await page.locator(".auth-card form button").click();
  await dashboard();
  await settings();
  await page
    .getByRole("button", { name: "解除 Google 登入", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel(/^目前密碼/)
    .fill("synthetic-browser-password-123");
  await page.getByRole("button", { name: "解除並登出", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  check("Password fallback login and explicit Google unlink work end to end");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByLabel("密碼", { exact: true })
    .fill("synthetic-browser-password-123");
  await page.locator(".auth-card form button").click();
  await dashboard();
  await settings();
  await page.getByLabel("目前 CareerOS 密碼").fill("wrong-password");
  await page.getByRole("button", { name: "下一步：綁定 Google 帳號" }).click();
  await google().click();
  await page.getByRole("button", { name: "重新載入 Google 登入" }).waitFor();
  await page
    .getByLabel("目前 CareerOS 密碼")
    .fill("synthetic-browser-password-123");
  await page.getByRole("button", { name: "重新載入 Google 登入" }).click();
  await google().click();
  await page
    .getByRole("button", { name: "重新驗證 Google", exact: true })
    .waitFor();
  check(
    "Wrong linking password can be edited and retried without reloading the page",
  );
  await page
    .getByRole("button", { name: "重新驗證 Google", exact: true })
    .click();
  await google().waitFor();
  const sentChallenge = page.waitForRequest((r) =>
    r.url().endsWith("/api/auth/logout"),
  );
  await page.getByRole("button", { name: "登出", exact: true }).click();
  assert.ok(
    ((await (await sentChallenge).allHeaders()).cookie ?? "").includes(
      "careeros_google=",
    ),
  );
  await page.getByLabel("Email", { exact: true }).waitFor();
  check("Actual browser sends the Google challenge cookie to logout");
  invalidNonce = true;
  await google().click();
  await page.getByRole("button", { name: "重新載入 Google 登入" }).waitFor();
  invalidNonce = false;
  await page.getByRole("button", { name: "重新載入 Google 登入" }).click();
  await google().click();
  await dashboard();
  check("Invalid nonce fails closed and a fresh challenge permits safe retry");
  await settings();
  await page.screenshot({
    path: output + "/google-settings.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: output + "/google-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  check("Desktop/mobile rendering and browser runtime checks pass");
} catch (e) {
  failure = String(e);
  console.error(e);
  await page
    .screenshot({ path: output + "/failure.png", fullPage: true })
    .catch(() => {});
} finally {
  await writeFile(
    output + "/report.json",
    JSON.stringify(
      {
        passed: !failure,
        checks,
        errors,
        failure,
        provider:
          "synthetic GIS widget + production JWT verifier; real Google Console not tested",
      },
      null,
      2,
    ),
  );
  await writeFile(
    output + "/REPORT.md",
    "# Google login isolated E2E\n\n" +
      checks.map((x) => "- PASS " + x).join("\n") +
      (failure ? "\n\nFAIL " + failure : "") +
      "\n\nSynthetic credentials only. No real Google account, production database or paid AI provider used.\n",
  );
  await browser.close();
  await app.close();
  await pool.end();
}
if (failure) process.exitCode = 1;
