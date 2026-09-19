import { z } from "zod";
export const uuid = z.string().uuid();
export const text = z.string().trim().min(1).max(20000);
export const factSchema = z
  .object({
    kind: z.enum([
      "work",
      "project",
      "skill",
      "education",
      "achievement",
      "license",
    ]),
    title: z.string().trim().min(1).max(160),
    content: text,
    sourceId: uuid.nullable().optional(),
    validUntil: z.string().datetime().nullable().optional(),
  })
  .strict();
export const jobSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    company: z.string().trim().min(1).max(200),
    location: z.string().max(200).default(""),
    market: z.enum(["TW", "US", "INTL"]).default("TW"),
    url: z.string().url().max(2000).or(z.literal("")).default(""),
    description: text,
  })
  .strict();
export const blockSchema = z
  .object({
    heading: z.string().max(160),
    text: z.string().min(1).max(6000),
    factIds: z.array(uuid).min(1).max(50),
  })
  .strict();
export const resumeSchema = z
  .object({
    title: z.string().min(1).max(160),
    language: z.enum(["zh-TW", "en"]),
    careerRevision: z.number().int().nonnegative(),
    jobId: uuid.nullable().optional(),
    parentId: uuid.nullable().optional(),
    blocks: z.array(blockSchema).min(1).max(40),
  })
  .strict();
export const eventTypes = [
  "submitted",
  "rejected",
  "withdrawn",
  "interview_invited",
] as const;
export const manualEventSchema = z
  .object({
    applicationId: uuid,
    type: z.enum(eventTypes),
    occurredAt: z.string().datetime(),
    notes: z.string().max(5000).default(""),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export const manualApplicationSchema = z
  .object({
    company: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    market: z.enum(["TW", "US", "INTL"]),
    url: z.string().trim().url().max(2000).or(z.literal("")).default(""),
    description: z.string().trim().max(20000).default(""),
    occurredAt: z.string().datetime(),
    channel: z.string().trim().max(100).default(""),
    notes: z.string().trim().max(5000).default(""),
    resumeId: uuid.optional(),
    externalResumeAssetId: uuid.optional(),
    externalResumeName: z.string().trim().max(160).default(""),
  })
  .strict()
  .refine(
    (b) => !b.resumeId || (!b.externalResumeAssetId && !b.externalResumeName),
    {
      message: "Choose a platform resume or an external resume, not both",
      path: ["resumeId"],
    },
  );
export const taskSchema = z
  .object({
    kind: z.enum([
      "extract_experience",
      "generate_resume",
      "career_analysis",
      "search_jobs",
      "transcribe",
      "sync_google",
    ]),
    input: z.record(z.unknown()).default({}),
  })
  .strict();
export const salarySchema = z.object({
  applicationId: uuid,
  currency: z.enum(["TWD", "USD", "EUR", "GBP", "JPY", "CAD", "AUD"]),
  amount: z.coerce.number().min(0).max(1e12).nullable(),
  period: z.enum(["month", "year", "hour"]),
  terms: z.string().max(12000).default(""),
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});
export function resumeMarkdown(
  name: string,
  blocks: z.infer<typeof blockSchema>[],
  email?: string,
) {
  return (
    `# ${name}\n\n` +
    (email ? `${email}\n\n` : "") +
    blocks.map((b) => `## ${b.heading}\n\n${b.text}`).join("\n\n")
  );
}
export function factsMarkdown(
  name: string,
  revision: number,
  facts: { id: string; kind: string; title: string; content: string }[],
) {
  return (
    `---\nformat: careeros-v1\nrevision: ${revision}\n---\n\n# ${name}\n\n` +
    facts
      .map((f) => `<!-- fact:${f.id} -->\n## ${f.title}\n\n${f.content}\n`)
      .join("\n")
  );
}
export const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
