import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { hash } from "./crypto.js";

export class SubmissionJournal {
  constructor(private directory: string) {}
  private file(identity: string) {
    return path.join(this.directory, hash(identity) + ".json");
  }
  async reserve(
    identity: string,
    record: { attemptId: string; dossierHash: string; formHash: string },
  ) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // An existing marker blocks another process, another task ID and DB rollback.
    const handle = await open(this.file(identity), "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          ...record,
          state: "permit_issued",
          recordedAt: new Date().toISOString(),
        }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async recordResult(
    identity: string,
    attemptId: string,
    outcome: "confirmed" | "outcome_unknown",
    receiptHash?: string,
  ) {
    const permit = JSON.parse(await readFile(this.file(identity), "utf8"));
    if (permit.attemptId !== attemptId)
      throw new Error("JOURNAL_ATTEMPT_MISMATCH");
    // Preserve the permit marker forever; a result cannot make a job sendable again.
    const handle = await open(this.file(identity) + ".result", "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          attemptId,
          outcome,
          receiptHash,
          recordedAt: new Date().toISOString(),
        }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
