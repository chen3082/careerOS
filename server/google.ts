import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { requireUser, sameOrigin } from "./auth.js";
import { pool, one, tx, id, DomainError } from "./db.js";
import { hash, token, encrypt, decrypt } from "./crypto.js";
import { jsonFetch } from "./connectors.js";
const redirect = config.PUBLIC_URL + "/google/callback";
export async function googleRoutes(app: FastifyInstance) {
  app.post(config.basePath + "/api/connections/google/start", async (req) => {
    sameOrigin(req);
    const u = await requireUser(req);
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET)
      throw new DomainError("GOOGLE_OAUTH_NOT_CONFIGURED", 503);
    const state = token();
    await pool.query(
      "INSERT INTO integration_states(hash,owner_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
      [hash(state), u.id],
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: redirect,
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly",
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return { url: url.href };
  });
  app.get(config.basePath + "/google/callback", async (req, reply) => {
    const u = await requireUser(req);
    const q = z
      .object({ state: z.string().max(200), code: z.string().max(2000) })
      .parse(req.query);
    const state = await one(
      pool,
      "DELETE FROM integration_states WHERE hash=$1 AND owner_id=$2 AND expires_at>now() RETURNING owner_id",
      [hash(q.state), u.id],
    );
    if (!state) throw new DomainError("OAUTH_STATE_INVALID", 400);
    const result = await jsonFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID!,
        client_secret: config.GOOGLE_CLIENT_SECRET!,
        code: q.code,
        grant_type: "authorization_code",
        redirect_uri: redirect,
      }),
    });
    if (!result.refresh_token)
      throw new DomainError("GOOGLE_REFRESH_TOKEN_REQUIRED", 422);
    await pool.query(
      "INSERT INTO connections(id,owner_id,provider,encrypted) VALUES($1,$2,'google',$3) ON CONFLICT(owner_id,provider) DO UPDATE SET encrypted=excluded.encrypted,state='active',cursor=NULL",
      [
        id(),
        u.id,
        encrypt(result.refresh_token, config.ENCRYPTION_KEY, u.id + ":google"),
      ],
    );
    return reply.redirect(config.PUBLIC_URL + "/#settings");
  });
  app.delete(config.basePath + "/api/connections/google", async (req) => {
    sameOrigin(req);
    const u = await requireUser(req);
    const c = await one(
      pool,
      "DELETE FROM connections WHERE owner_id=$1 AND provider='google' RETURNING encrypted",
      [u.id],
    );
    if (c) {
      const token = decrypt(
        c.encrypted,
        config.ENCRYPTION_KEY,
        u.id + ":google",
      );
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        /* Local deletion immediately blocks future reads, even if provider revoke is down. */
      }
    }
    return { ok: true };
  });
}
export async function syncGoogle(owner: string) {
  const c = await one(
    pool,
    "SELECT * FROM connections WHERE owner_id=$1 AND provider='google' AND state='active'",
    [owner],
  );
  if (!c) throw new DomainError("GOOGLE_NOT_CONNECTED");
  const refresh = decrypt(
    c.encrypted,
    config.ENCRYPTION_KEY,
    owner + ":google",
  );
  let auth;
  try {
    auth = await jsonFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID!,
        client_secret: config.GOOGLE_CLIENT_SECRET!,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
  } catch (e) {
    if (
      e instanceof DomainError &&
      ["PROVIDER_HTTP_400", "PROVIDER_HTTP_401"].includes(e.code)
    )
      await pool.query(
        "UPDATE connections SET state='needs_reauth' WHERE id=$1 AND encrypted=$2",
        [c.id, c.encrypted],
      );
    throw e;
  }
  const headers = { authorization: "Bearer " + auth.access_token };
  const mails = await jsonFetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
      new URLSearchParams({
        q: "newer_than:30d (interview OR application OR offer OR 面試 OR 應徵 OR 錄取)",
        maxResults: "50",
      }),
    { headers },
  );
  let received = 0;
  const pending: { provider: string; externalId: string; payload: any }[] = [];
  for (const m of mails.messages ?? []) {
    if (
      await one(
        pool,
        "SELECT 1 FROM sync_evidence WHERE owner_id=$1 AND provider='gmail' AND external_id=$2",
        [owner, m.id],
      )
    )
      continue;
    const message = await jsonFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers },
    );
    const h = Object.fromEntries(
      (message.payload?.headers ?? []).map((v: any) => [
        v.name.toLowerCase(),
        v.value,
      ]),
    );
    const payload = {
      subject: h.subject ?? "",
      from: h.from ?? "",
      date: h.date ?? "",
      snippet: message.snippet ?? "",
      externalId: m.id,
      note: "僅為相關訊息，尚未判定面試或 offer。請在申請詳情確認歸屬及事件。",
    };
    pending.push({ provider: "gmail", externalId: m.id, payload });
    received++;
  }
  const events = await jsonFetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
      new URLSearchParams({
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + 30 * 86400000).toISOString(),
        maxResults: "100",
        singleEvents: "true",
        orderBy: "startTime",
      }),
    { headers },
  );
  for (const e of events.items ?? []) {
    if (!/interview|面試/i.test(e.summary ?? "")) continue;
    pending.push({
      provider: "calendar",
      externalId: e.id,
      payload: {
        title: e.summary,
        start: e.start,
        status: e.status,
        note: "日曆標題不構成正式面試邀請，請確認。",
      },
    });
  }
  await tx(async (db) => {
    const active = await one(
      db,
      "SELECT id FROM connections WHERE id=$1 AND encrypted=$2 AND state='active' FOR UPDATE",
      [c.id, c.encrypted],
    );
    if (!active) throw new DomainError("CONNECTION_REVOKED", 409);
    for (const item of pending)
      await db.query(
        "INSERT INTO sync_evidence(id,owner_id,provider,external_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,provider,external_id) DO UPDATE SET payload=excluded.payload",
        [
          id(),
          owner,
          item.provider,
          item.externalId,
          JSON.stringify(item.payload),
        ],
      );
    await db.query("UPDATE connections SET last_synced_at=now() WHERE id=$1", [
      c.id,
    ]);
  });
  return {
    received,
    scope:
      "最近 30 天，最多 50 封相关郵件及 100 個近期日曆事件；未自動改變申請狀態。",
  };
}
