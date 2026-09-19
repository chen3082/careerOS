import type { FastifyInstance } from "fastify";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { requireUser, sameOrigin } from "./auth.js";
import { pool, id, owned, one, DomainError, tx, type DB } from "./db.js";
import { hash, encrypt, decrypt } from "./crypto.js";
import { uuid, escapeHTML, resumeMarkdown } from "./schemas.js";
import { z } from "zod";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { chromium } from "playwright";
const allowed = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "audio/webm",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/ogg",
]);
let rendering = false;
// The caller owns the DB transaction and registers each file for rollback cleanup.
export async function saveAssetInTransaction(
  db: DB,
  owner: string,
  name: string,
  mime: string,
  data: Buffer,
  onWrite: (assetId: string) => void,
) {
  if (!allowed.has(mime) || data.length > 20 * 1024 * 1024)
    throw new DomainError("FILE_TYPE_OR_SIZE_NOT_ALLOWED", 422);
  await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
  const usage = await one(
    db,
    "SELECT coalesce(sum(size),0)::bigint AS bytes,count(*)::int AS files FROM assets WHERE owner_id=$1",
    [owner],
  );
  if (
    Number(usage.bytes) + data.length > 512 * 1024 * 1024 ||
    usage.files >= 2000
  )
    throw new DomainError("STORAGE_QUOTA_REACHED", 413);
  const aid = id();
  const key = owner + "/" + aid;
  await mkdir(path.join(config.dataDir, "assets", owner), {
    recursive: true,
    mode: 0o700,
  });
  onWrite(aid);
  await writeFile(
    path.join(config.dataDir, "assets", key),
    encrypt(data.toString("base64"), config.ENCRYPTION_KEY, owner + ":" + aid),
    { mode: 0o600, flag: "wx" },
  );
  return one(
    db,
    "INSERT INTO assets(id,owner_id,name,mime,size,sha256,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,mime,size,sha256",
    [aid, owner, name.slice(0, 160), mime, data.length, hash(data), key],
  );
}
export async function removeUncommittedAsset(owner: string, assetId: string) {
  // Wait for the writer's transaction, including an uncertain COMMIT, to finish.
  await tx(async (db) => {
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
    const committed = await one(
      db,
      "SELECT id FROM assets WHERE owner_id=$1 AND id=$2",
      [owner, assetId],
    );
    if (!committed)
      await unlink(path.join(config.dataDir, "assets", owner, assetId)).catch(
        (e) => {
          if (e.code !== "ENOENT") throw e;
        },
      );
  });
}
export async function saveAsset(
  owner: string,
  name: string,
  mime: string,
  data: Buffer,
) {
  let written: string | undefined;
  try {
    return await tx((db) =>
      saveAssetInTransaction(db, owner, name, mime, data, (aid) => {
        written = aid;
      }),
    );
  } catch (error) {
    if (written) await removeUncommittedAsset(owner, written).catch(() => {});
    throw error;
  }
}
export async function readAsset(owner: string, aid: string) {
  const a = await owned(pool, "assets", owner, aid);
  const content = await readFile(
    path.join(config.dataDir, "assets", a.storage_key),
    "utf8",
  );
  return {
    asset: a,
    data: Buffer.from(
      decrypt(content, config.ENCRYPTION_KEY, owner + ":" + aid),
      "base64",
    ),
  };
}
export async function assetRoutes(app: FastifyInstance) {
  app.post(config.basePath + "/api/assets", async (req) => {
    sameOrigin(req);
    const u = await requireUser(req);
    const part = await req.file({
      limits: { fileSize: 20 * 1024 * 1024, files: 1 },
    });
    if (!part) throw new DomainError("FILE_REQUIRED");
    const data = await part.toBuffer();
    if (part.file.truncated) throw new DomainError("FILE_TOO_LARGE", 413);
    const mime = part.mimetype.split(";")[0];
    if (
      mime === "application/pdf" &&
      !data.subarray(0, 5).equals(Buffer.from("%PDF-"))
    )
      throw new DomainError("INVALID_PDF", 422);
    let content = "";
    if (mime.startsWith("text/")) {
      content = data.toString("utf8");
      if (content.length > 100000) throw new DomainError("TEXT_TOO_LARGE", 422);
    }
    const a = await saveAsset(u.id, part.filename, mime, data);
    const source = await one(
      pool,
      "INSERT INTO sources(id,owner_id,title,kind,content,asset_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        id(),
        u.id,
        part.filename,
        mime.startsWith("audio/") || mime === "video/webm" ? "audio" : "file",
        content,
        a.id,
      ],
    );
    if (mime === "application/pdf" || mime.includes("wordprocessingml"))
      await pool.query(
        "INSERT INTO tasks(id,owner_id,kind,input) VALUES($1,$2,'parse_document',$3)",
        [id(), u.id, JSON.stringify({ sourceId: source.id, assetId: a.id })],
      );
    return { asset: a, source };
  });
  app.get(config.basePath + "/api/assets/:id", async (req, reply) => {
    const u = await requireUser(req);
    const aid = z.object({ id: uuid }).parse(req.params).id;
    const { asset, data } = await readAsset(u.id, aid);
    return reply
      .type(asset.mime)
      .header("Cache-Control", "no-store")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      )
      .send(data);
  });
  app.get(
    config.basePath + "/api/resumes/:id/export/:format",
    async (req, reply) => {
      const u = await requireUser(req);
      const p = z
        .object({ id: uuid, format: z.enum(["pdf", "docx"]) })
        .parse(req.params);
      const r = await owned(pool, "resumes", u.id, p.id);
      const cached = await one(
        pool,
        "SELECT asset_id FROM resume_exports WHERE owner_id=$1 AND resume_id=$2 AND format=$3",
        [u.id, r.id, p.format],
      );
      if (cached) {
        const { asset, data } = await readAsset(u.id, cached.asset_id);
        return reply
          .type(asset.mime)
          .header(
            "Content-Disposition",
            `attachment; filename="resume.${p.format}"`,
          )
          .send(data);
      }
      if (rendering) throw new DomainError("EXPORT_BUSY_TRY_AGAIN", 429);
      rendering = true;
      try {
        const cache = async (data: Buffer, mime: string) => {
          const a = await saveAsset(u.id, `resume.${p.format}`, mime, data);
          await pool.query(
            "INSERT INTO resume_exports(owner_id,resume_id,format,asset_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [u.id, r.id, p.format, a.id],
          );
          return data;
        };
        if (p.format === "docx") {
          const doc = new Document({
            sections: [
              {
                children: [
                  new Paragraph({ text: u.name, heading: HeadingLevel.TITLE }),
                  new Paragraph({ text: u.email }),
                  ...r.blocks.flatMap((b: any) => [
                    new Paragraph({
                      text: b.heading,
                      heading: HeadingLevel.HEADING_1,
                    }),
                    ...b.text
                      .split("\n")
                      .map(
                        (line: string) =>
                          new Paragraph({ children: [new TextRun(line)] }),
                      ),
                  ]),
                ],
              },
            ],
          });
          return reply
            .type(
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            .header("Content-Disposition", 'attachment; filename="resume.docx"')
            .send(
              await cache(
                await Packer.toBuffer(doc),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              ),
            );
        }
        const browser = await chromium.launch({
          headless: true,
          args: ["--disable-dev-shm-usage"],
        });
        let pdf: Buffer;
        try {
          const page = await browser.newPage();
          await page.route("**/*", (route) => route.abort());
          await page.setContent(
            `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font-family:"Noto Sans CJK TC",sans-serif;font-size:11pt;color:#182f30;line-height:1.55}h1{font-size:24pt}h2{font-size:14pt;border-bottom:1px solid #ddd;padding-bottom:6px;break-after:avoid}p{white-space:pre-wrap;orphans:3;widows:3}</style><h1>${escapeHTML(u.name)}</h1><p>${escapeHTML(u.email)}</p>${r.blocks.map((b: any) => `<section><h2>${escapeHTML(b.heading)}</h2><p>${escapeHTML(b.text)}</p></section>`).join("")}`,
          );
          pdf = await cache(
            await page.pdf({ format: "A4", printBackground: true }),
            "application/pdf",
          );
        } finally {
          await browser.close();
        }
        return reply
          .type("application/pdf")
          .header("Content-Disposition", 'attachment; filename="resume.pdf"')
          .send(pdf);
      } finally {
        rendering = false;
      }
    },
  );
}
