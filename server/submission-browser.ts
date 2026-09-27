import type { Page } from "playwright";
import { createHash } from "node:crypto";

export const submissionAdapterVersion = "browser-review-v1";
export type SubmissionPlatform = "linkedin" | "104";
export type SubmissionPlan = {
  platform: SubmissionPlatform;
  jobUrl: string;
  accountEmail: string;
  resume: { name: string; bytes: Buffer; sha256: string };
  answers: Record<string, string>;
  testFixtureOrigin?: string;
};
export class SubmissionHandoff extends Error {
  constructor(
    public reason: string,
    public fields: string[] = [],
  ) {
    super(reason);
  }
}
export function canonicalSubmissionJob(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new SubmissionHandoff("UNSUPPORTED_JOB_URL");
  if (["linkedin.com", "www.linkedin.com"].includes(url.hostname)) {
    const jobId =
      url.pathname.match(/^\/jobs\/view\/(\d+)\/?$/)?.[1] ??
      (url.pathname.startsWith("/jobs/search")
        ? url.searchParams.get("currentJobId")
        : null);
    if (!jobId || !/^\d+$/.test(jobId))
      throw new SubmissionHandoff("SPECIFIC_JOB_REQUIRED");
    return {
      platform: "linkedin" as const,
      jobId,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
    };
  }
  if (["104.com.tw", "www.104.com.tw"].includes(url.hostname)) {
    const jobId = url.pathname.match(/^\/job\/([a-z0-9]+)\/?$/)?.[1];
    if (!jobId) throw new SubmissionHandoff("SPECIFIC_JOB_REQUIRED");
    return {
      platform: "104" as const,
      jobId,
      url: `https://www.104.com.tw/job/${jobId}`,
    };
  }
  throw new SubmissionHandoff("UNSUPPORTED_JOB_URL");
}
const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const normalized = (s: string) => s.replace(/\s+/g, " ").trim();

function controlledEndpoint(
  state: Awaited<ReturnType<typeof inspectApplicationForm>>,
  origin: string,
) {
  if (state.forms.length !== 1)
    throw new SubmissionHandoff("AMBIGUOUS_APPLICATION_FORM");
  const form = state.forms[0];
  const submits = state.submitControls.filter((c) => c.type === "submit");
  if (submits.length !== 1)
    throw new SubmissionHandoff("AMBIGUOUS_SUBMIT_CONTROL");
  const button = submits[0];
  const endpoint = new URL(button.formAction || form.action);
  if (
    endpoint.origin !== origin ||
    endpoint.username ||
    endpoint.password ||
    (button.formMethod || form.method).toLowerCase() !== "post" ||
    (button.formEnctype || form.enctype) !== "multipart/form-data" ||
    !["", "_self"].includes(button.formTarget || form.target)
  )
    throw new SubmissionHandoff("SUBMISSION_DESTINATION_FORBIDDEN");
  return endpoint.href;
}

export async function inspectApplicationForm(page: Page) {
  return page.evaluate(async () => {
    // Object methods survive tsx/esbuild serialization without its Node-only
    // function-name helper leaking into this browser evaluation.
    const helpers = {
      visible(el: Element) {
        return (
          !!el.getClientRects().length &&
          getComputedStyle(el).visibility !== "hidden"
        );
      },
      label(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
        return (
          el.getAttribute("aria-label") ||
          Array.from(el.labels ?? [])
            .map((l) => l.textContent ?? "")
            .join(" ") ||
          ""
        );
      },
    };
    const dialog = Array.from(
      document.querySelectorAll('[role="dialog"]'),
    ).find(helpers.visible);
    const root = dialog ?? document.querySelector("main") ?? document.body;
    const controls = await Promise.all(
      Array.from(
        root.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >("input,select,textarea"),
      )
        .filter(
          (el) =>
            !el.disabled &&
            !(
              el instanceof HTMLInputElement &&
              ["submit", "button"].includes(el.type)
            ),
        )
        .map(async (el) => ({
          label: helpers.label(el).replace(/\s+/g, " ").trim(),
          name: el.name,
          visible: helpers.visible(el),
          type:
            el instanceof HTMLSelectElement
              ? "select"
              : el instanceof HTMLTextAreaElement
                ? "textarea"
                : el.type,
          required:
            el.required ||
            el.getAttribute("aria-required") === "true" ||
            /\*/.test(helpers.label(el)),
          value:
            el instanceof HTMLInputElement && el.type === "file"
              ? Array.from(el.files ?? [])
                  .map((f) => f.name)
                  .join(",")
              : el.value,
          checked: el instanceof HTMLInputElement ? el.checked : undefined,
          options:
            el instanceof HTMLSelectElement
              ? Array.from(el.options).map((o) => ({
                  value: o.value,
                  label: o.label,
                }))
              : [],
          files:
            el instanceof HTMLInputElement && el.type === "file"
              ? await Promise.all(
                  Array.from(el.files ?? []).map(async (f) => ({
                    name: f.name,
                    size: f.size,
                    sha256: Array.from(
                      new Uint8Array(
                        await crypto.subtle.digest(
                          "SHA-256",
                          await f.arrayBuffer(),
                        ),
                      ),
                      (b) => b.toString(16).padStart(2, "0"),
                    ).join(""),
                  })),
                )
              : [],
        })),
    );
    return {
      title:
        root.querySelector("h1,h2,h3")?.textContent?.trim() ?? document.title,
      text: (root as HTMLElement).innerText.slice(0, 30000),
      controls,
      forms: Array.from(root.querySelectorAll("form")).map((f) => ({
        action: f.action,
        method: f.method,
        enctype: f.enctype,
        target: f.target,
      })),
      submitControls: Array.from(
        root.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
          "button,input[type=submit]",
        ),
      )
        .filter(helpers.visible)
        .map((b) => ({
          text: b.getAttribute("aria-label") || b.textContent || "",
          formAction: b.hasAttribute("formaction") ? b.formAction : "",
          formMethod: b.hasAttribute("formmethod") ? b.formMethod : "",
          formEnctype: b.hasAttribute("formenctype") ? b.formEnctype : "",
          formTarget: b.hasAttribute("formtarget") ? b.formTarget : "",
          type: b.type,
          name: b.name,
          value: b.value,
        })),
      buttons: Array.from(root.querySelectorAll("button,input[type=submit]"))
        .filter(helpers.visible)
        .map(
          (el) =>
            el.getAttribute("aria-label") ||
            (el as HTMLElement).innerText ||
            el.getAttribute("value") ||
            "",
        ),
      captcha: !!Array.from(
        document.querySelectorAll(
          'iframe[src*="captcha"],iframe[src*="challenge"],input[name*="captcha"],.g-recaptcha,.h-captcha',
        ),
      ).find(helpers.visible),
    };
  });
}
export type FormReview = Awaited<ReturnType<typeof inspectApplicationForm>> & {
  url: string;
  fingerprint: string;
  resumeHash: string;
  binding: {
    externalJobKey: string;
    accountEmail: string;
    origin: string;
    controlledFixture: true;
  };
};
async function verifyBrowserBinding(page: Page, plan: SubmissionPlan) {
  const target = canonicalSubmissionJob(plan.jobUrl);
  if (target.platform !== plan.platform)
    throw new SubmissionHandoff("PLATFORM_MISMATCH");
  // Production LinkedIn/104 account and receipt selectors still need real-account
  // acceptance. Never infer platform readiness from our controlled receiver.
  if (!plan.testFixtureOrigin)
    throw new SubmissionHandoff("LIVE_PLATFORM_ADAPTER_UNVERIFIED");
  const origin = new URL(plan.testFixtureOrigin);
  if (
    process.env.NODE_ENV !== "test" ||
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    page.url().split("/").slice(0, 3).join("/") !== origin.origin
  )
    throw new SubmissionHandoff("TEST_RECEIVER_FORBIDDEN");
  const identity = await page.evaluate(() => ({
    externalJobKey: document.querySelector<HTMLElement>(
      "[data-careeros-job-key]",
    )?.innerText,
    accountEmail: document.querySelector<HTMLElement>("[data-careeros-account]")
      ?.innerText,
  }));
  if (
    identity.externalJobKey !== target.platform + ":" + target.jobId ||
    identity.accountEmail?.toLowerCase() !== plan.accountEmail.toLowerCase()
  )
    throw new SubmissionHandoff("BROWSER_JOB_OR_ACCOUNT_MISMATCH");
  return {
    externalJobKey: identity.externalJobKey,
    accountEmail: identity.accountEmail.toLowerCase(),
    origin: origin.origin,
    controlledFixture: true as const,
  };
}

// This performs form interaction only. The caller owns authentication, the approved
// immutable dossier, a durable one-use permit and authoritative result persistence.
// Unknown questions always hand off; this module never asks a model to guess them.
export async function prepareBrowserSubmission(
  page: Page,
  plan: SubmissionPlan,
): Promise<FormReview> {
  if (
    sha256(plan.resume.bytes) !== plan.resume.sha256 ||
    !plan.resume.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
  )
    throw new SubmissionHandoff("RESUME_BYTES_MISMATCH");
  let uploaded = false;
  const seen = new Set<string>();
  for (let step = 0; step < 12; step++) {
    const binding = await verifyBrowserBinding(page, plan);
    const state = await inspectApplicationForm(page);
    if (state.captcha) throw new SubmissionHandoff("CAPTCHA_REQUIRES_USER");
    if (
      state.controls.some((c) => c.type === "password") ||
      /\/login|\/checkpoint|\/uas\/login/.test(new URL(page.url()).pathname)
    )
      throw new SubmissionHandoff("LOGIN_REQUIRED");
    const dialog = page.getByRole("dialog");
    const root = (await dialog.count()) === 1 ? dialog : page.locator("body");
    const missing: string[] = [];
    for (const control of state.controls) {
      if (!control.visible || control.type === "hidden") continue;
      if (["checkbox", "radio"].includes(control.type)) {
        // Consent, demographics and site-resume selection require an exact answer.
        const value = plan.answers[control.label];
        if (
          value !== undefined &&
          ["true", "false"].includes(value) &&
          control.label
        )
          await root
            .getByLabel(control.label, { exact: true })
            .setChecked(value === "true");
        else if (control.required && !control.checked)
          missing.push(control.label || "Unlabelled consent");
        continue;
      }
      if (control.type === "file") {
        const files = root.locator('input[type="file"]');
        if ((await files.count()) !== 1)
          throw new SubmissionHandoff("AMBIGUOUS_RESUME_UPLOAD");
        await files.setInputFiles({
          name: plan.resume.name,
          mimeType: "application/pdf",
          buffer: plan.resume.bytes,
        });
        uploaded = true;
        continue;
      }
      if (!control.label) {
        if (control.required) missing.push("Unlabelled required field");
        continue;
      }
      const supplied = plan.answers[control.label];
      if (supplied === undefined) {
        // Existing account data is not silently accepted into a new dossier.
        if (control.required || control.value) missing.push(control.label);
        continue;
      }
      const field = root.getByLabel(control.label, { exact: true });
      if (control.type === "select") {
        const choice = control.options.find(
          (o) => o.label === supplied || o.value === supplied,
        );
        if (!choice)
          throw new SubmissionHandoff("ANSWER_NOT_IN_OPTIONS", [control.label]);
        await field.selectOption(choice.value);
      } else await field.fill(supplied);
    }
    if (missing.length)
      throw new SubmissionHandoff("ANSWERS_REQUIRED", missing);
    const next = root.getByRole("button", {
      name: /^(Continue to next step|Next|Review|Review your application|下一步|預覽|確認應徵內容)$/i,
    });
    const submit = root.getByRole("button", {
      name: /^(Submit application|Send application|送出應徵|確認送出|送出履歷)$/i,
    });
    if ((await submit.count()) === 1) {
      if (!uploaded) throw new SubmissionHandoff("ATTACHMENT_NOT_VERIFIED");
      const review = await inspectApplicationForm(page);
      controlledEndpoint(review, binding.origin);
      const actualFiles = review.controls.flatMap((c) => c.files);
      if (
        actualFiles.length !== 1 ||
        actualFiles[0].sha256 !== plan.resume.sha256
      )
        throw new SubmissionHandoff("ATTACHMENT_NOT_VERIFIED");
      return {
        ...review,
        url: page.url(),
        resumeHash: plan.resume.sha256,
        binding,
        fingerprint: sha256(
          JSON.stringify({
            adapter: submissionAdapterVersion,
            url: page.url(),
            title: review.title,
            text: normalized(review.text),
            controls: review.controls,
            forms: review.forms,
            submitControls: review.submitControls,
            binding,
            resume: plan.resume.sha256,
          }),
        ),
      };
    }
    if ((await next.count()) !== 1)
      throw new SubmissionHandoff("UNSUPPORTED_APPLICATION_FORM");
    const key = sha256(
      JSON.stringify({
        title: state.title,
        controls: state.controls,
        buttons: state.buttons,
      }),
    );
    if (seen.has(key)) throw new SubmissionHandoff("FORM_DID_NOT_ADVANCE");
    seen.add(key);
    await next.click();
    await page
      .waitForFunction(
        (old) => {
          const root =
            document.querySelector('[role="dialog"]') ??
            document.querySelector("main") ??
            document.body;
          return (root as HTMLElement).innerText !== old;
        },
        state.text,
        { timeout: 5000 },
      )
      .catch(() => {});
  }
  throw new SubmissionHandoff("TOO_MANY_APPLICATION_STEPS");
}

export async function clickApprovedSubmission(
  page: Page,
  review: FormReview,
  acquirePermit: (fingerprint: string) => Promise<void>,
) {
  const endpoint = controlledEndpoint(review, review.binding.origin);
  const validate = async () => {
    const observed = await page.evaluate(() => ({
      externalJobKey: document.querySelector<HTMLElement>(
        "[data-careeros-job-key]",
      )?.innerText,
      accountEmail: document
        .querySelector<HTMLElement>("[data-careeros-account]")
        ?.innerText?.toLowerCase(),
    }));
    if (
      process.env.NODE_ENV !== "test" ||
      !review.binding.controlledFixture ||
      new URL(page.url()).origin !== review.binding.origin ||
      observed.externalJobKey !== review.binding.externalJobKey ||
      observed.accountEmail !== review.binding.accountEmail
    )
      throw new SubmissionHandoff("BROWSER_JOB_OR_ACCOUNT_MISMATCH");
    const state = await inspectApplicationForm(page);
    const fingerprint = sha256(
      JSON.stringify({
        adapter: submissionAdapterVersion,
        url: page.url(),
        title: state.title,
        text: normalized(state.text),
        controls: state.controls,
        forms: state.forms,
        submitControls: state.submitControls,
        binding: review.binding,
        resume: review.resumeHash,
      }),
    );
    if (fingerprint !== review.fingerprint)
      throw new SubmissionHandoff("FORM_CHANGED_REVIEW_AGAIN");
    controlledEndpoint(state, review.binding.origin);
  };
  await validate();
  const dialog = page.getByRole("dialog");
  const root = (await dialog.count()) === 1 ? dialog : page.locator("body");
  const submit = root.getByRole("button", {
    name: /^(Submit application|Send application|送出應徵|確認送出|送出履歷)$/i,
  });
  if ((await submit.count()) !== 1 || !(await submit.isEnabled()))
    throw new SubmissionHandoff("SUBMIT_UNAVAILABLE");
  // Check the actual native multipart request too: DOM can mutate in a submit
  // listener after the last snapshot. This controlled adapter cannot send elsewhere.
  let permitIssued = false,
    requestSent = false;
  const expected = review.controls
    .filter(
      (c) =>
        (c.name && !["checkbox", "radio"].includes(c.type)) ||
        (c.name && c.checked),
    )
    .flatMap((c) =>
      c.type === "file"
        ? c.files.map((f) => [c.name, f.name, f.sha256])
        : [[c.name, c.value]],
    );
  const submitControl = review.submitControls.find((c) => c.type === "submit")!;
  if (submitControl.name)
    expected.push([submitControl.name, submitControl.value]);
  const sorted = (rows: string[][]) =>
    JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== review.binding.origin)
      return route.abort();
    if (request.method() === "GET") return route.continue();
    if (
      !permitIssued ||
      requestSent ||
      request.url() !== endpoint ||
      request.method() !== "POST" ||
      request.redirectedFrom()
    )
      return route.abort();
    try {
      const bytes = request.postDataBuffer();
      if (!bytes || bytes.length > 22 * 1024 * 1024) return route.abort();
      const data = await new Response(new Uint8Array(bytes), {
        headers: { "content-type": request.headers()["content-type"] ?? "" },
      }).formData();
      const actual: string[][] = [];
      for (const [name, value] of data.entries())
        actual.push(
          typeof value === "string"
            ? [name, value]
            : [
                name,
                value.name,
                sha256(Buffer.from(await value.arrayBuffer())),
              ],
        );
      if (sorted(actual) !== sorted(expected)) return route.abort();
      requestSent = true;
      // Browser routing does not intercept subsequent requests in an HTTP
      // redirect chain. Perform exactly one real request without redirects or
      // transport retries, then expose that response to the page.
      const response = await route.fetch({
        maxRedirects: 0,
        maxRetries: 0,
        timeout: 10000,
      });
      if (response.status() >= 300 && response.status() < 400)
        return route.abort();
      return route.fulfill({ response });
    } catch {
      return route.abort();
    }
  });
  await acquirePermit(review.fingerprint); // Must commit independently before the click.
  permitIssued = true;
  // Any exception after this boundary means outcome_unknown, never safe to retry.
  await validate();
  await submit.click({ timeout: 15000 });
}
