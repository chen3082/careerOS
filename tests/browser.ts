import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { buildApp } from "../server/index.js";
import { pool } from "../server/db.js";
import { config } from "../server/config.js";
if (!new URL(config.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Browser tests require *_test database");
await pool.query("TRUNCATE users,oauth_clients,auth_throttles CASCADE");
const app = await buildApp();
await app.listen({ port: config.PORT, host: "127.0.0.1" });
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await mkdir("/tmp/careeros-e2e", { recursive: true });
try {
  await page.goto(config.PUBLIC_URL + "/");
  await page.getByLabel("怎麼稱呼你").fill("驗收使用者");
  await page.getByLabel("Email", { exact: true }).fill("browser@example.test");
  await page
    .getByLabel("密碼", { exact: true })
    .fill("browser-test-password-2026");
  await page.getByLabel("工作台邀請碼").fill(config.BOOTSTRAP_TOKEN!);
  await page.getByRole("button", { name: "建立工作台" }).click();
  await page.getByRole("heading", { name: "求職總覽", exact: true }).waitFor();
  await page.screenshot({
    path: "/tmp/careeros-e2e/dashboard-empty.png",
    fullPage: true,
  });
  await page.goto(config.PUBLIC_URL + "/#experience");
  await page.getByRole("button", { name: "＋ 新增經驗" }).click();
  await page.getByLabel("類型").selectOption("project");
  await page.getByLabel("標題", { exact: false }).fill("API Platform");
  await page
    .getByLabel("經驗與成果")
    .fill(
      "Built a TypeScript API with PostgreSQL. Led testing and deployment.",
    );
  await page.getByRole("button", { name: "確認並加入經驗庫" }).click();
  await page
    .getByRole("heading", { name: "API Platform", exact: true })
    .waitFor();
  await page.goto(config.PUBLIC_URL + "/#resumes");
  await page.getByRole("button", { name: "從經驗直接建立" }).click();
  await page.getByLabel("履歷名稱").fill("Backend Engineer");
  await page.getByLabel("語言").selectOption("en");
  await page.getByRole("button", { name: "建立可編輯草稿" }).click();
  await page.locator(".resume-card").first().click();
  await page.getByRole("button", { name: "確認履歷內容" }).click();
  await page.getByRole("button", { name: "我已核對，確認內容" }).click();
  await page.locator(".resume-card").first().click();
  await page.screenshot({
    path: "/tmp/careeros-e2e/resume.png",
    fullPage: true,
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "下載 PDF" }).click();
  const download = await downloadPromise;
  await download.saveAs("/tmp/careeros-e2e/resume.pdf");
  await page.goto(config.PUBLIC_URL + "/#jobs");
  await page.getByRole("button", { name: "貼上職缺" }).click();
  await page.getByLabel("職位名稱").fill("Backend Engineer");
  await page.getByLabel("公司", { exact: false }).fill("Example Company");
  await page
    .getByRole("dialog")
    .getByLabel("市場", { exact: false })
    .selectOption("US");
  await page
    .getByLabel("職缺描述")
    .fill("TypeScript and PostgreSQL experience required.");
  await page.getByRole("button", { name: "保存職缺" }).click();
  await page.getByRole("button", { name: "準備申請" }).first().click();
  await page
    .getByLabel("使用履歷")
    .selectOption({ label: "Backend Engineer · 已確認" });
  await page.getByRole("button", { name: /建立申請草稿/ }).click();
  await page.goto(config.PUBLIC_URL + "/#applications");
  await page.getByText("Example Company", { exact: true }).waitFor();
  await page.screenshot({
    path: "/tmp/careeros-e2e/applications.png",
    fullPage: true,
  });
  for (const route of ["jobs", "resumes", "career", "jobs", "resumes"]) {
    await page.goto(config.PUBLIC_URL + "/#" + route);
    await page.locator(".content .card, .content .notice").first().waitFor();
  }
  for (const route of [
    "interviews",
    "offers",
    "collections",
    "groups",
    "career",
    "tasks",
    "settings",
  ]) {
    await page.goto(config.PUBLIC_URL + "/#" + route);
    await page.locator(".content .card, .content .notice").first().waitFor();
    assert.equal(
      await page.locator(".content > .card > .error").count(),
      0,
      route + " shows page error",
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(config.PUBLIC_URL + "/#experience");
  await page.getByRole("heading", { name: "我的經驗", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".sidebar")!.getBoundingClientRect().right <= 1,
  );
  await page.getByRole("button", { name: "開啟導覽" }).click();
  await page.getByRole("button", { name: "關閉導覽" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".sidebar")!.getBoundingClientRect().right <= 1,
  );
  await page.screenshot({
    path: "/tmp/careeros-e2e/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  const width = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.ok(width.body <= width.viewport + 1, JSON.stringify(width));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: "Chromium",
      desktop: "1440x1050",
      mobile: "390x844",
      errors,
      passed: true,
    }),
  );
} finally {
  await browser.close();
  await app.close();
  await pool.end();
}
