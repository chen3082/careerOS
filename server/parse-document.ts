// Runs in a separate, time- and memory-bounded process. No application secrets or DB access.
import mammoth from "mammoth";
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(Buffer.from(c));
const buffer = Buffer.concat(chunks);
if (buffer.length > 20 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");
if (process.argv[2] !== "docx")
  throw new Error("Expected docx; PDF uses bounded pdftotext process");
const text = (await mammoth.extractRawText({ buffer })).value;
process.stdout.write(text.slice(0, 100000));
