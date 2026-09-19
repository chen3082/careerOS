// Loaded only by the disposable browser test worker; never imported by product code.
import assert from "node:assert/strict";
assert.equal(process.env.NODE_ENV, "test");
assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith("_test"));
globalThis.fetch = async (url, init) => {
  const openai = String(url) === "https://api.openai.com/v1/responses";
  assert.ok(
    openai || String(url) === "https://api.anthropic.com/v1/messages",
    "Unexpected network request in synthetic worker",
  );
  const header = new Headers(init?.headers);
  assert.equal(
    header.get(openai ? "authorization" : "x-api-key"),
    openai
      ? "Bearer sk-synthetic-browser-openai-only"
      : "sk-ant-synthetic-browser-only",
  );
  const body = JSON.parse(String(init?.body));
  const payload = JSON.parse(
    openai ? body.input[0].content : body.messages[0].content,
  );
  assert.equal(payload.purpose, "extract_experience");
  const value = {
    facts: [
      {
        kind: "project",
        title: "Synthetic " + (openai ? "OpenAI" : "Anthropic") + " draft",
        content: payload.inputs.source.content,
        validUntil: null,
      },
    ],
  };
  return Response.json(
    openai
      ? {
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify(value) }],
            },
          ],
          usage: { input_tokens: 120, output_tokens: 40 },
        }
      : {
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(value) }],
          usage: { input_tokens: 130, output_tokens: 30 },
        },
  );
};
