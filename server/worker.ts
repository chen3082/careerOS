import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pool, one, tx, owned, id, DomainError } from "./db.js";
import { config } from "./config.js";
import { executeGenerationTask, credential, reserve } from "./ai-generation.js";
import { runCatalogSource } from "./catalog.js";
import { searchJobs } from "./connectors.js";
import { readAsset } from "./assets.js";
async function parseDocument(t: any) {
  const { asset, data } = await readAsset(t.owner_id, t.input.assetId);
  const format = asset.mime === "application/pdf" ? "pdf" : "docx";
  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      format === "pdf" ? "pdftotext" : process.execPath,
      format === "pdf"
        ? ["-f", "1", "-l", "30", "-layout", "-enc", "UTF-8", "-", "-"]
        : [
            "--max-old-space-size=192",
            "--import",
            "tsx",
            "server/parse-document.ts",
            format,
          ],
      {
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20000,
      },
    );
    let out = "";
    let outputExceeded = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (b) => {
      if (outputExceeded) return;
      if (out.length + b.length > 150000) {
        outputExceeded = true;
        child.kill("SIGKILL");
      } else out += b;
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && !outputExceeded
        ? resolve(out)
        : reject(new DomainError("DOCUMENT_PARSE_FAILED", 422)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(data);
  });
  await pool.query(
    "UPDATE sources SET content=$1 WHERE id=$2 AND owner_id=$3",
    [text, t.input.sourceId, t.owner_id],
  );
  return { sourceId: t.input.sourceId, characters: text.length };
}
async function transcribe(t: any) {
  const key = await credential(t.owner_id, "openai");
  const source = await owned(pool, "sources", t.owner_id, t.input.sourceId);
  if (!source.asset_id) throw new DomainError("AUDIO_REQUIRED");
  const { asset, data } = await readAsset(t.owner_id, source.asset_id);
  if (!asset.mime.startsWith("audio/") && asset.mime !== "video/webm")
    throw new DomainError("AUDIO_REQUIRED");
  // Decode a maximum of 181 seconds into a bounded, known format before any paid request.
  const wav = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "pipe",
        "-i",
        "pipe:0",
        "-t",
        "181",
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        "pipe:1",
      ],
      {
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 180 * 32000 + 200) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 && size > 100
        ? resolve(Buffer.concat(chunks))
        : reject(new DomainError("AUDIO_INVALID_OR_OVER_3_MINUTES", 422)),
    );
    child.stdin.end(data);
  });
  await reserve(t.owner_id, t.id, 10000, {
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
  });
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
    "recording.wav",
  );
  form.append("model", "gpt-4o-mini-transcribe");
  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      body: form,
      signal: AbortSignal.timeout(90000),
    },
  );
  if (!response.ok) {
    if ([400, 401, 403, 413, 429].includes(response.status))
      await pool.query(
        "UPDATE usage SET state='released',actual_tokens=0 WHERE task_id=$1",
        [t.id],
      );
    throw new DomainError("TRANSCRIPTION_PROVIDER_" + response.status, 502);
  }
  const body: any = await response.json();
  const text = String(body.text ?? "").slice(0, 100000);
  await pool.query(
    "UPDATE sources SET content=$1 WHERE id=$2 AND owner_id=$3",
    [text, source.id, t.owner_id],
  );
  await pool.query(
    "UPDATE usage SET state='settled',actual_tokens=$1 WHERE task_id=$2",
    [body.usage?.total_tokens ?? 10000, t.id],
  );
  return { sourceId: source.id, characters: text.length };
}
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
async function run() {
  await pool.query(
    "UPDATE tasks SET status='failed',error='WORKER_INTERRUPTED_REVIEW_BEFORE_RETRY',updated_at=now() WHERE status='running' AND lease_until<now()",
  );
  const t = await tx(async (db) => {
    const row = await one(
      db,
      "SELECT * FROM tasks WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!row) return;
    return one(
      db,
      "UPDATE tasks SET status='running',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '120 seconds',updated_at=now() WHERE id=$2 RETURNING *",
      [id(), row.id],
    );
  });
  if (!t) return false;
  const heartbeat = setInterval(() => {
    void pool
      .query(
        "UPDATE tasks SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'",
        [t.id, t.lease_token],
      )
      .catch(() => {});
  }, 15000);
  try {
    let result: any;
    if (
      ["extract_experience", "generate_resume", "career_analysis"].includes(
        t.kind,
      )
    )
      result = await executeGenerationTask(t);
    else if (t.kind === "search_jobs")
      result = await searchJobs(t.owner_id, t.input);
    else if (t.kind === "parse_document") result = await parseDocument(t);
    else if (t.kind === "transcribe") result = await transcribe(t);
    else if (t.kind === "sync_google") {
      const { syncGoogle } = await import("./google.js");
      result = await syncGoogle(t.owner_id);
    } else throw new DomainError("CONNECTOR_NOT_CONFIGURED");
    await pool.query(
      "UPDATE tasks SET status='succeeded',result=$1,lease_until=NULL,updated_at=now() WHERE id=$2 AND lease_token=$3 AND status='running'",
      [JSON.stringify(result), t.id, t.lease_token],
    );
  } catch (e) {
    const code =
      e instanceof DomainError
        ? e.code
        : e instanceof SyntaxError
          ? "AI_OUTPUT_INVALID"
          : "TASK_FAILED";
    await pool.query(
      "UPDATE tasks SET status='failed',error=$1,lease_until=NULL,updated_at=now() WHERE id=$2 AND lease_token=$3 AND status='running'",
      [code, t.id, t.lease_token],
    );
    console.error(JSON.stringify({ taskId: t.id, kind: t.kind, error: code }));
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
let lastSchedule = 0;
const liveness = setInterval(() => {
  void writeFile("/tmp/careeros-worker-heartbeat", String(Date.now())).catch(
    () => {},
  );
}, 15000);
async function schedule() {
  if (Date.now() - lastSchedule < 60000) return;
  lastSchedule = Date.now();
  await tx(async (db) => {
    if (
      !(await one(db, "SELECT pg_try_advisory_xact_lock(901238) AS locked"))
        .locked
    )
      return;
    await db.query("DELETE FROM sessions WHERE expires_at<now()");
    await db.query("DELETE FROM auth_throttles WHERE expires_at<now()");
    await db.query("DELETE FROM oauth_requests WHERE expires_at<now()");
    if (config.GOOGLE_CLIENT_ID)
      await db.query(
        `INSERT INTO tasks(id,owner_id,kind,input) SELECT gen_random_uuid(),c.owner_id,'sync_google','{}'::jsonb FROM connections c WHERE c.provider='google' AND c.state='active' AND (c.last_synced_at IS NULL OR c.last_synced_at<now()-interval '15 minutes') AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.owner_id=c.owner_id AND t.kind='sync_google' AND (t.status IN ('queued','running') OR t.created_at>now()-interval '15 minutes'))`,
      );
  });
}
while (!stopped) {
  try {
    await schedule();
    const worked = await run();
    if (!stopped)
      await runCatalogSource(
        undefined,
        undefined,
        config.CATALOG_POLLING === "true",
      );
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch {
    console.error("WORKER_DATABASE_UNAVAILABLE");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
clearInterval(liveness);
await pool.end();
