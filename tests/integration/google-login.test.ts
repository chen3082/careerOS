import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { googleFixture, testClient } from "../google-fixture.js";
import { config } from "../../server/config.js";
import { buildApp } from "../../server/index.js";
import { pool } from "../../server/db.js";
import { hash, passwordHash } from "../../server/crypto.js";
import { oauthProvider } from "../../server/mcp.js";

assert.equal(config.NODE_ENV, "test");
assert.ok(new URL(config.DATABASE_URL).pathname.endsWith("_test"));
config.GOOGLE_LOGIN_CLIENT_ID = testClient;
const fixture = await googleFixture();
const app = await buildApp({ googleVerifier: fixture.verify });
const password = "synthetic-password-only-123";
const cookie = (r: any) =>
  r.cookies
    .filter((c: any) => c.value)
    .map((c: any) => `${c.name}=${c.value}`)
    .join("; ");
async function call(
  path: string,
  body?: any,
  cookies = "",
  expected = 200,
  origin = config.origin,
) {
  const r = await app.inject({
    method: body === undefined ? "GET" : "POST",
    url: config.basePath + "/api" + path,
    headers: { origin, cookie: cookies },
    payload: body,
  });
  assert.equal(r.statusCode, expected, `${path}: ${r.body}`);
  return r;
}
async function challenge(intent = "login", session = "") {
  const r = await call("/auth/google/challenge", { intent }, session);
  assert.equal(r.cookies[0].path, config.basePath + "/api/auth");
  return {
    nonce: r.json().nonce,
    cookies: [session, cookie(r)].filter(Boolean).join("; "),
  };
}
async function login(
  subject = "synthetic-subject",
  email = "synthetic@example.test",
  invite?: string,
  expected = 200,
) {
  const c = await challenge();
  return call(
    "/auth/google/complete",
    {
      credential: await fixture.sign(c.nonce, { sub: subject, email }),
      invite,
    },
    c.cookies,
    expected,
  );
}
let owner: any;
before(async () => {
  await pool.query(
    "TRUNCATE users,oauth_clients,auth_throttles,google_login_challenges CASCADE",
  );
  owner = await call("/auth/register", {
    name: "Synthetic owner",
    email: "owner@example.test",
    password,
    invite: config.BOOTSTRAP_TOKEN,
  });
});
beforeEach(async () => {
  await pool.query("TRUNCATE auth_throttles");
});
after(async () => {
  await app.close();
  await pool.end();
});
async function invite() {
  return (await call("/auth/invites", {}, cookie(owner))).json().token;
}

test("RS256 identity rejects wrong signature, issuer, audience, nonce, time and unverified email", async () => {
  assert.equal(
    (await fixture.verify(await fixture.sign("nonce"), hash("nonce"))).subject,
    "synthetic-subject",
  );
  const now = Math.floor(Date.now() / 1000);
  for (const override of [
    { iss: "https://attacker.invalid" },
    { aud: "other" },
    { azp: "other" },
    { nonce: "other" },
    { exp: now - 20 },
    { iat: now + 60 },
    { iat: now - 700 },
    { email_verified: false },
    { email_verified: "true" },
    { sub: "" },
    { aud: [testClient, "other"] },
  ]) {
    await assert.rejects(
      fixture.verify(await fixture.sign("nonce", override), hash("nonce")),
      /GOOGLE_IDENTITY_INVALID/,
    );
  }
  const foreign = await googleFixture();
  await assert.rejects(
    fixture.verify(await foreign.sign("nonce"), hash("nonce")),
    /GOOGLE_IDENTITY_INVALID/,
  );
});

test("invite-only Google registration, stable subject and replay prevention", async () => {
  await login("new", "new@example.test", undefined, 403);
  const invitation = await invite();
  const c = await challenge();
  const credential = await fixture.sign(c.nonce, {
    sub: "new",
    email: "new@example.test",
  });
  const r = await call(
    "/auth/google/complete",
    { credential, invite: invitation },
    c.cookies,
  );
  assert.equal(r.json().user.hasPassword, false);
  assert.equal(
    (
      await pool.query("SELECT password_hash FROM users WHERE id=$1", [
        r.json().user.id,
      ])
    ).rows[0].password_hash,
    null,
  );
  await call("/auth/google/complete", { credential }, c.cookies, 401);
  const again = await login("new", "changed@example.test");
  assert.equal(again.json().user.id, r.json().user.id);
  await login("another", "another@example.test", invitation, 403);
});

test("same email never auto-links; password linking is explicit and retryable", async () => {
  await login("owner-google", "owner@example.test", undefined, 409);
  let c = await challenge("link", cookie(owner));
  await call(
    "/auth/google/complete",
    {
      credential: await fixture.sign(c.nonce, {
        sub: "owner-google",
        email: "owner@example.test",
      }),
      currentPassword: "wrong",
    },
    c.cookies,
    401,
  );
  c = await challenge("link", cookie(owner));
  owner = await call(
    "/auth/google/complete",
    {
      credential: await fixture.sign(c.nonce, {
        sub: "owner-google",
        email: "owner@example.test",
      }),
      currentPassword: password,
    },
    c.cookies,
  );
  const r = await login("owner-google", "owner@example.test");
  assert.equal(r.json().user.id, owner.json().user.id);
});

test("CSRF, browser binding, expiry and cross-account reauthentication fail closed", async () => {
  await call(
    "/auth/google/challenge",
    { intent: "login" },
    "",
    403,
    "https://attacker.invalid",
  );
  let c = await challenge();
  await call(
    "/auth/google/complete",
    { credential: await fixture.sign(c.nonce) },
    "",
    401,
  );
  await call(
    "/auth/google/complete",
    { credential: await fixture.sign("different") },
    c.cookies,
    401,
  );
  c = await challenge();
  await pool.query(
    "UPDATE google_login_challenges SET expires_at=now()-interval '1 second' WHERE hash=$1",
    [hash(c.cookies.split("=")[1])],
  );
  await call(
    "/auth/google/complete",
    { credential: await fixture.sign(c.nonce) },
    c.cookies,
    401,
  );
  c = await challenge("reauth", cookie(owner));
  await call(
    "/auth/google/complete",
    {
      credential: await fixture.sign(c.nonce, {
        sub: "new",
        email: "new@example.test",
      }),
    },
    c.cookies,
    403,
  );
});

test("logout cancels both pending and concurrently completed Google requests", async () => {
  let c = await challenge();
  await call("/auth/logout", {}, c.cookies);
  await call(
    "/auth/google/complete",
    { credential: await fixture.sign(c.nonce, { sub: "owner-google" }) },
    c.cookies,
    401,
  );
  c = await challenge();
  const r = await call(
    "/auth/google/complete",
    { credential: await fixture.sign(c.nonce, { sub: "owner-google" }) },
    c.cookies,
  );
  // Logout was dispatched with the browser cookie from before complete's response.
  await call("/auth/logout", {}, c.cookies);
  await call("/auth/google/status", undefined, cookie(r), 401);
});

test("password login invalidates an in-flight Google session", async () => {
  const c = await challenge();
  const r = await call(
    "/auth/google/complete",
    { credential: await fixture.sign(c.nonce, { sub: "owner-google" }) },
    c.cookies,
  );
  const p = await call(
    "/auth/login",
    { email: "owner@example.test", password },
    c.cookies,
  );
  await call("/auth/google/status", undefined, cookie(r), 401);
  await call("/auth/google/status", undefined, cookie(p));
});

test("Google-only account requires fresh verification before setting password", async () => {
  let r = await login("new", "new@example.test");
  await pool.query(
    "UPDATE sessions SET google_verified_at=now()-interval '6 minutes' WHERE user_id=$1",
    [r.json().user.id],
  );
  await call("/account/password", { newPassword: password }, cookie(r), 403);
  const c = await challenge("reauth", cookie(r));
  const old = cookie(r);
  r = await call(
    "/auth/google/complete",
    {
      credential: await fixture.sign(c.nonce, {
        sub: "new",
        email: "new@example.test",
      }),
    },
    c.cookies,
  );
  await call("/auth/google/status", undefined, old, 401);
  await call("/account/password", { newPassword: password }, cookie(r));
  await call("/auth/google/status", undefined, cookie(r), 401);
  assert.equal(
    (await call("/auth/login", { email: "new@example.test", password })).json()
      .user.hasPassword,
    true,
  );
});

test("unlink revokes sessions, unspent MCP codes and refresh tokens", async () => {
  const r = await login("new", "new@example.test");
  const user = r.json().user.id,
    client = randomUUID(),
    code = randomUUID(),
    refresh = randomUUID();
  await pool.query("INSERT INTO oauth_clients(id,metadata) VALUES($1,'{}')", [
    client,
  ]);
  await pool.query(
    "INSERT INTO oauth_codes(hash,user_id,client_id,redirect_uri,challenge,scopes,resource,expires_at) VALUES($1,$2,$3,'https://example.test/callback','challenge',ARRAY['careeros:read'],$4,now()+interval '2 minutes')",
    [hash(code), user, client, config.PUBLIC_URL + "/mcp"],
  );
  await pool.query(
    "INSERT INTO oauth_tokens(hash,user_id,client_id,scopes,resource,expires_at,kind,grant_id) VALUES($1,$2,$3,ARRAY['careeros:read'],$4,now()+interval '1 day','refresh',$5)",
    [hash(refresh), user, client, config.PUBLIC_URL + "/mcp", randomUUID()],
  );
  await call("/auth/google/unlink", { currentPassword: password }, cookie(r));
  await call("/auth/google/status", undefined, cookie(r), 401);
  await assert.rejects(
    oauthProvider.exchangeAuthorizationCode(
      { client_id: client } as any,
      code,
      undefined,
      "https://example.test/callback",
    ),
  );
  await assert.rejects(
    oauthProvider.exchangeRefreshToken({ client_id: client } as any, refresh),
  );
  await login("new", "new@example.test", undefined, 409);
});

test("Google-only account can delete its data with fresh proof", async () => {
  const r = await login("delete-user", "delete@example.test", await invite());
  await call(
    "/auth/google/unlink",
    { currentPassword: password },
    cookie(r),
    409,
  );
  await call("/account/delete", { confirmation: "DELETE" }, cookie(r));
  assert.equal(
    (
      await pool.query("SELECT 1 FROM google_identities WHERE owner_id=$1", [
        r.json().user.id,
      ])
    ).rowCount,
    0,
  );
  await call("/auth/google/status", undefined, cookie(r), 401);
});

test("logout without challenge cookie revokes a session rotated by reauthentication", async () => {
  const original = await login("owner-google", "owner@example.test");
  const c = await challenge("reauth", cookie(original));
  const rotated = await call(
    "/auth/google/complete",
    {
      credential: await fixture.sign(c.nonce, {
        sub: "owner-google",
        email: "owner@example.test",
      }),
    },
    c.cookies,
  );
  await call("/auth/logout", {}, cookie(original));
  await call("/auth/google/status", undefined, cookie(rotated), 401);
});

async function waitForOwnerLock() {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const r = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM users%FOR UPDATE%'",
    );
    if (r.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected authorization issuance to wait for owner lock");
}

test("password login rechecks credentials after a concurrent password change", async () => {
  const changed = await passwordHash("rotated-password-12345");
  const db = await pool.connect();
  let pending: Promise<any> | undefined;
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT id FROM users WHERE email='new@example.test' FOR UPDATE",
    );
    pending = call(
      "/auth/login",
      { email: "new@example.test", password },
      "",
      401,
    );
    await waitForOwnerLock();
    await db.query(
      "UPDATE users SET password_hash=$1 WHERE email='new@example.test'",
      [changed],
    );
    await db.query(
      "DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email='new@example.test')",
    );
    await db.query("COMMIT");
    await pending;
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pending?.catch(() => {});
  }
});

test("MCP refresh waits for account revocation and cannot issue new tokens afterward", async () => {
  const user = owner.json().user.id,
    client = randomUUID(),
    refresh = randomUUID();
  await pool.query("INSERT INTO oauth_clients(id,metadata) VALUES($1,'{}')", [
    client,
  ]);
  await pool.query(
    "INSERT INTO oauth_tokens(hash,user_id,client_id,scopes,resource,expires_at,kind,grant_id) VALUES($1,$2,$3,ARRAY['careeros:read'],$4,now()+interval '1 day','refresh',$5)",
    [hash(refresh), user, client, config.PUBLIC_URL + "/mcp", randomUUID()],
  );
  const db = await pool.connect();
  let result: Promise<{ ok: boolean }> | undefined;
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user]);
    result = oauthProvider
      .exchangeRefreshToken({ client_id: client } as any, refresh)
      .then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      );
    await waitForOwnerLock();
    await db.query(
      "UPDATE oauth_tokens SET revoked_at=now() WHERE user_id=$1",
      [user],
    );
    await db.query("COMMIT");
    assert.deepEqual(await result, { ok: false });
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await result;
  }
});
