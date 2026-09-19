# Google sign-in implementation and review — 2026-09-19

Implementation: `3961c4e8ae03840e594c1c3f156c3625d45748f4`.
[Successful CI](https://github.com/chen3082/careerOS/actions/runs/35432223126).

## Delivered behavior

- Official Google Identity Services button, server-verified ID token, invite-only new accounts.
- Existing accounts link explicitly with their CareerOS password; equal email addresses never merge identities automatically.
- Stable Google subject mapping, one-time browser nonce, session-bound link/reauth, recent proof for passwordless sensitive account actions.
- Unlink, password changes, and deletion serialize against authorization issuance. Unlink/password changes revoke sessions, pending challenges, MCP tokens, and unspent authorization codes.
- Public privacy page; disabled-until-configured behavior; password sign-in remains available.

## Independent review and corrections

A separate reviewer inspected the authentication implementation and used an independent local-key JWT harness and Chromium UI checks. Findings resolved:

1. **P1:** Unspent MCP codes and concurrent refresh/password-login requests could issue new authorization after revocation. Added owner locking and post-lock rechecks across issuance and revocation, removed pending codes, and revalidated consent sessions.
2. **P2:** Google challenge cookie path excluded normal auth routes. Moved it to `/api/auth`; retained completed-session hashes for five minutes and serialized auth changes so logout can revoke an in-flight result. Standardized lock order to avoid challenge/session/owner deadlocks.
3. **P2:** A wrong linking password became uneditable. Kept the field editable; retry uses the updated value and a fresh nonce.

The reviewer confirmed the fixes, cookie delivery to logout, and editable-password retry. Browser-test locator/header corrections were applied before the successful CI run. No remaining blocker was found within the reviewed scope; this is not a claim of an exhaustive security audit.

## Verification

- TypeScript and Vite build; 4 unit tests; 28 PostgreSQL integration tests (12 Google/auth-specific and 16 existing product tests).
- JWT positive case plus rejected signature, issuer, audience, authorized-party, nonce, issued/expiry time, email-verification and subject cases.
- Actual PostgreSQL row-lock waiting tests: password login versus a concurrent SQL password update, and real MCP refresh issuance versus a concurrent SQL revocation. These exercise the production issuance code; they do not claim two simultaneous HTTP revocation requests.
- Google browser flow: invited signup, passwordless reauthentication/password setup, password fallback, unlink, wrong-password correction, real browser-cookie logout, invalid nonce/retry, public privacy page, desktop/mobile rendering and no page errors.
- Existing product browser regression and offline worker smoke pass. Dependency audit reports zero known vulnerabilities at the recorded CI run.

## Remaining provider setup

**Real Google sign-in is not yet verified or enabled.** CareerOS currently has no configured `GOOGLE_LOGIN_CLIENT_ID`; Google Cloud Console requires user login to inspect existing clients. The tests use locally generated RSA keys and a synthetic Google widget, never a real Google credential or a paid provider. Follow [GOOGLE-LOGIN.md](GOOGLE-LOGIN.md) to configure the Web Client ID and authorized JavaScript origin, then perform real-account acceptance. This sign-in setup does not grant Gmail/Calendar access.

## GCP isolated acceptance

- Candidate image: `sha256:bf35f0e5b7847c9d0d6ae6290216cf4d06438a7ec305fc6a99dc80e53ef8511e`.
- Report: `careeros-google-qa/test-results/careeros-mcp-e2e-20260919T083355Z-3625702` (private host path; synthetic artifacts copied locally to ignored `test-results/google-login`).
- 4 unit, 28 integration and 8 Google browser checkpoints passed on PostgreSQL 17. Desktop/mobile screenshots were visually inspected.
- All 47 runtime/frontend/migration/dependency/test file hashes match the reviewed source. Existing service IDs, start times, restart counts and health remained unchanged; disposable containers and network were verified removed. Test database/files lived only in tmpfs; no production secrets were mounted.
