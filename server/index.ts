import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { z } from "zod";
import path from "node:path";
import { config } from "./config.js";
import { pool, one, DomainError } from "./db.js";
import { authRoutes, requireUser } from "./auth.js";
import { apiRoutes } from "./routes.js";
import { groupRoutes } from "./groups.js";
import { assetRoutes } from "./assets.js";
import { mcpRoutes } from "./mcp.js";
import { googleRoutes } from "./google.js";
import { accountRoutes } from "./account.js";
import { googleLoginRoutes, type GoogleVerifier } from "./google-login.js";
export async function buildApp(
  options: { googleVerifier?: GoogleVerifier } = {},
) {
  if (options.googleVerifier && config.NODE_ENV !== "test")
    throw new Error("Test verifier is forbidden outside tests");
  const app = Fastify({
    trustProxy: (_address, hop) => hop === 0,
    bodyLimit: 1024 * 1024,
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
            level: "info",
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "res.headers.set-cookie",
            ],
            serializers: {
              req: (r: any) => ({
                method: r.method,
                url: r.url?.split("?")[0],
                remoteAddress: r.ip,
              }),
            },
          },
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
        styleSrc: ["'self'", "https://accounts.google.com/gsi/style"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "https://accounts.google.com/gsi/"],
        frameSrc: ["https://accounts.google.com/gsi/"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 20 * 1024 * 1024 },
  });
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  app.addHook("onSend", async (req, reply, payload) => {
    if (
      req.url.includes("/api/") ||
      req.url.includes("/oauth") ||
      req.url.endsWith("/mcp")
    )
      reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError)
      return reply
        .code(error.status)
        .send({ error: error.code, details: error.details });
    if (error instanceof z.ZodError)
      return reply.code(422).send({
        error: "INVALID_INPUT",
        details: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if ((error as any).code === "23505")
      return reply.code(409).send({ error: "ALREADY_EXISTS" });
    if ((error as any).statusCode === 413)
      return reply.code(413).send({ error: "FILE_TOO_LARGE" });
    req.log.error(
      { code: (error as any).code ?? "SERVER_ERROR", requestId: req.id },
      "Request failed",
    );
    return reply.code(500).send({ error: "SERVER_ERROR", requestId: req.id });
  });
  app.get(config.basePath + "/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true, service: "careeros", version: "0.1.0" };
  });
  await authRoutes(app);
  await googleLoginRoutes(app, options.googleVerifier);
  await apiRoutes(app);
  await groupRoutes(app);
  await assetRoutes(app);
  await googleRoutes(app);
  await accountRoutes(app);
  await mcpRoutes(app);
  app.get(config.basePath + "/api/signals", async (req) => {
    const u = await requireUser(req);
    return {
      items: (
        await pool.query(
          "SELECT * FROM sync_evidence WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
          [u.id],
        )
      ).rows,
    };
  });
  await app.register(staticFiles, {
    root: path.resolve("dist/web"),
    prefix: config.basePath + "/",
    index: ["index.html"],
    wildcard: true,
    list: false,
  });
  app.get(config.basePath, async (_req, reply) =>
    reply.redirect(config.basePath + "/"),
  );
  app.setNotFoundHandler((req, reply) => {
    if (
      req.method === "GET" &&
      req.url.startsWith(config.basePath + "/") &&
      !req.url.includes("/api/")
    )
      return reply.sendFile("index.html");
    return reply.code(404).send({ error: "NOT_FOUND" });
  });
  return app;
}
if (process.env.NODE_ENV !== "test") {
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  const close = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
