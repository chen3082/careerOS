import { spawn } from "node:child_process";
import { pool, one, id, tx } from "../server/db.js";
import { config } from "../server/config.js";
import { newTask } from "../server/domain.js";
import assert from "node:assert/strict";
if (!new URL(config.DATABASE_URL).pathname.endsWith("_test"))
  throw new Error("Requires isolated test database");
const asset = await one(
  pool,
  "SELECT * FROM assets WHERE mime='application/pdf' ORDER BY created_at DESC LIMIT 1",
);
assert.ok(asset);
const source = await one(
  pool,
  "INSERT INTO sources(id,owner_id,title,kind,asset_id) VALUES($1,$2,'Worker PDF verification','file',$3) RETURNING *",
  [id(), asset.owner_id, asset.id],
);
const parsed = await one(
  pool,
  "INSERT INTO tasks(id,owner_id,kind,input) VALUES($1,$2,'parse_document',$3) RETURNING *",
  [
    id(),
    asset.owner_id,
    JSON.stringify({ assetId: asset.id, sourceId: source.id }),
  ],
);
const search = await tx((db) =>
  newTask(db, asset.owner_id, "search_jobs", {
    provider: "lever",
    board: "Gogolook",
    market: "TW",
    query: "",
  }),
);
const child = spawn(process.execPath, ["--import", "tsx", "server/worker.ts"], {
  env: { ...process.env, NODE_ENV: "test" },
  stdio: "inherit",
});
const stopped = new Promise<void>((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error("Worker exited " + code)),
  );
});
try {
  const deadline = Date.now() + 60000;
  let rows: any[] = [];
  while (Date.now() < deadline) {
    rows = (
      await pool.query(
        "SELECT id,kind,status,error,result FROM tasks WHERE id=ANY($1::uuid[])",
        [[parsed.id, search.id]],
      )
    ).rows;
    if (rows.every((t) => ["succeeded", "failed"].includes(t.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(
    rows.every((t) => t.status === "succeeded"),
    JSON.stringify(rows),
  );
  const document = await one(pool, "SELECT content FROM sources WHERE id=$1", [
    source.id,
  ]);
  assert.match(document.content, /browser@example\.test/);
  console.log(
    JSON.stringify({
      workerTasks: rows.map((t) => ({ kind: t.kind, status: t.status })),
      parsedCharacters: document.content.length,
    }),
  );
} finally {
  child.kill("SIGTERM");
  await stopped;
  await pool.end();
}
