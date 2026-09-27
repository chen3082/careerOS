// A separate HTTP process receives real multipart bytes. Never uses a production
// account, database, environment file, employer endpoint or provider credential.
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cookie from "@fastify/cookie";
import { mkdir, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

assert.equal(process.env.NODE_ENV, "test");
const directory = process.env.RECEIVER_DIRECTORY!;
assert.ok(directory.includes("careeros-submission-test"));
await mkdir(directory, { recursive: true, mode: 0o700 });
const app = Fastify({ logger: false });
await app.register(multipart, {
  limits: { files: 1, fileSize: 20 * 1024 * 1024 },
});
await app.register(cookie);
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
app.get("/health", async () => ({ ok: true }));
app.get<{
  Params: { platform: string; job: string };
  Querystring: { scenario?: string };
}>("/forms/:platform/:job", async (req, reply) => {
  assert.ok(["linkedin", "104"].includes(req.params.platform));
  assert.match(req.params.job, /^[a-z0-9]+$/);
  const key = req.params.platform + ":" + req.params.job;
  const tw = req.params.platform === "104";
  const labels = tw
    ? ["姓名", "電子郵件", "聯絡電話"]
    : ["Name", "Email address *", "Mobile phone number*"];
  const scenario = [
    "drop",
    "question",
    "captcha",
    "redirect307",
    "redirect308",
  ].includes(req.query.scenario ?? "")
    ? req.query.scenario!
    : "normal";
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'",
  );
  return reply.type("text/html")
    .send(`<!doctype html><html><meta charset="utf-8"><title>Controlled ATS receiver</title>
    <main><h1>FICTIONAL ACCEPTANCE ONLY</h1><p data-careeros-job-key>${key}</p><p data-careeros-account>${escape(req.cookies.fixture_account ?? "signed-out")}</p>
    <form action="/receive/${req.params.platform}/${req.params.job}?scenario=${scenario}" method="post" enctype="multipart/form-data">
    <input type="hidden" name="jobKey" value="${key}"><section data-step="0"><h2>Contact information</h2>
    ${labels.map((label, i) => `<label>${label}<input name="${["name", "email", "phone"][i]}" ${i === 1 ? 'type="email"' : 'type="text"'} required></label>`).join("")}
    ${scenario === "question" ? '<label>Work authorization<input name="workAuthorization" required></label>' : ""}
    ${scenario === "captcha" ? '<div class="h-captcha">Complete CAPTCHA</div>' : ""}
    <button type="button" onclick="step(1)">${tw ? "下一步" : "Next"}</button></section>
    <section data-step="1" hidden><h2>Attach resume</h2><label>Resume PDF<input name="resume" type="file" accept="application/pdf" required></label><button type="button" onclick="step(2)">${tw ? "預覽" : "Review"}</button></section>
    <section data-step="2" hidden><h2>Review application</h2><p>Review your entered values and PDF before sending.</p><button type="submit">${tw ? "確認送出" : "Submit application"}</button></section>
    </form></main><script>function step(n){document.querySelectorAll('[data-step]').forEach(el=>el.hidden=Number(el.dataset.step)!==n)}</script></html>`);
});
app.post<{
  Params: { platform: string; job: string };
  Querystring: { scenario?: string };
}>("/receive/:platform/:job", async (req, reply) => {
  let pdf: Buffer | undefined;
  const fields: Record<string, string> = {};
  for await (const part of req.parts()) {
    if (part.type === "file") {
      assert.equal(part.fieldname, "resume");
      pdf = await part.toBuffer();
    } else fields[part.fieldname] = String(part.value);
  }
  assert.ok(pdf?.subarray(0, 5).equals(Buffer.from("%PDF-")));
  const externalJobKey = req.params.platform + ":" + req.params.job;
  assert.equal(fields.jobKey, externalJobKey);
  assert.equal(fields.email, req.cookies.fixture_account);
  assert.ok(fields.name && fields.phone);
  if (req.query.scenario?.startsWith("redirect"))
    return reply
      .code(Number(req.query.scenario.slice(8)))
      .header(
        "Location",
        `http://127.0.0.1:${Number(process.env.RECEIVER_PORT) + 1}/foreign-receiver`,
      )
      .send();
  const receipt = {
    receiptId: randomUUID(),
    externalJobKey,
    resumeHash: createHash("sha256").update(pdf!).digest("hex"),
    fields,
    receivedAt: new Date().toISOString(),
  };
  for (const [extension, bytes] of [
    ["pdf", pdf!],
    ["json", Buffer.from(JSON.stringify(receipt))],
  ] as const) {
    const file = await open(
      path.join(directory, receipt.receiptId + "." + extension),
      "wx",
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Deliberately lose the reply AFTER persisting the received bytes.
  if (req.query.scenario === "drop") {
    reply.hijack();
    reply.raw.destroy();
    return;
  }
  return receipt;
});
await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.RECEIVER_PORT),
});
process.send?.("ready");
process.on("SIGTERM", async () => {
  await app.close();
  process.exit(0);
});
