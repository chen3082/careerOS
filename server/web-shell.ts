import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyReply } from "fastify";

export function webShell() {
  let template: Promise<string> | undefined;
  return async (reply: FastifyReply) => {
    template ??= readFile(path.resolve("dist/web/index.html"), "utf8");
    const html = await template;
    // GIS copies its script element's nonce onto its injected button stylesheet.
    // The HTML and CSP must be generated together; never cache a nonce-bearing page.
    const nonce = reply.cspNonce.style;
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(
        html.replace(
          "</head>",
          `<meta name="csp-style-nonce" content="${nonce}" /></head>`,
        ),
      );
  };
}
