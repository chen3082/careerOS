// Runs in a separate, time- and memory-bounded process. No application secrets or DB access.
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(Buffer.from(c));
const buffer = Buffer.concat(chunks);
if (buffer.length > 20 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");
let text = "";
if (process.argv[2] === "pdf") {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText({ first: 30 });
    text = result.text;
  } finally {
    await parser.destroy();
  }
} else {
  text = (await mammoth.extractRawText({ buffer })).value;
}
process.stdout.write(text.slice(0, 100000));
