// Runs with a deadline and a bounded JS heap; application credentials are not inherited through the environment.
import mammoth from "mammoth";
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(Buffer.from(c));
const buffer = Buffer.concat(chunks);
if (buffer.length > 20 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");
if (process.argv[2] !== "docx")
  throw new Error("Expected docx; PDF uses bounded pdftotext process");
const text = (await mammoth.extractRawText({ buffer })).value;
process.stdout.write(text.slice(0, 100000));
