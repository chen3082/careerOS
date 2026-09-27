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

**Historical status at the September 19 review:** real Google sign-in had not been verified or enabled, and no `GOOGLE_LOGIN_CLIENT_ID` was configured yet. See the September 27 incident below for the newer deployment state. Synthetic tests use locally generated RSA keys and a synthetic Google widget, never a real Google credential or a paid provider. Follow [GOOGLE-LOGIN.md](GOOGLE-LOGIN.md) for real-account acceptance. This sign-in setup does not grant Gmail/Calendar access.

## GCP isolated acceptance

- Candidate image: `sha256:bf35f0e5b7847c9d0d6ae6290216cf4d06438a7ec305fc6a99dc80e53ef8511e`.
- Report: `careeros-google-qa/test-results/careeros-mcp-e2e-20260919T083355Z-3625702` (private host path; synthetic artifacts copied locally to ignored `test-results/google-login`).
- 4 unit, 28 integration and 8 Google browser checkpoints passed on PostgreSQL 17. Desktop/mobile screenshots were visually inspected.
- All 47 runtime/frontend/migration/dependency/test file hashes match the reviewed source. Existing service IDs, start times, restart counts and health remained unchanged; disposable containers and network were verified removed. Test database/files lived only in tmpfs; no production secrets were mounted.

## September 27 incident: origin rejection and oversized Google button

The user reported `401 invalid_client / no registered origin`. Inspection of the actual Google Console Web client confirmed that **Authorized JavaScript origins was empty**, while the application URL was entered under redirect URIs. The deployed client ID matched that client. The correct origin (`https://gptig.allenchencode.com`) was entered in the Console form; saving the new OAuth trust origin is pending the user's browser confirmation. This is still a blocker to real-account acceptance.

Separately, the real GIS SDK injected a button stylesheet blocked by the site's CSP. The official SDK copies `document.currentScript.nonce` onto that stylesheet. The fix generates fresh per-response CSP nonces, serves uncached HTML containing the style nonce, and attaches it to the official SDK script. OIDC challenges, token verification and account policies are unchanged. No `unsafe-inline` or `unsafe-eval` was added.

Independent agent review found no blocking issue. The reviewer independently checked TypeScript and eight HTML/HEAD entry variants, including encoded index paths. All nonce-bearing HTML responses used fresh matching nonces, `no-store`, and no ETag/Last-Modified; static assets retained cache validators.

Verification and deployment:

- Local TypeScript/Vite build passed. The isolated GCP runner passed 4 unit tests, 41 PostgreSQL integration tests and 9 synthetic Google browser checkpoints. A browser assertion verifies nonce-bearing CSS works and nonce-less injected CSS remains blocked.
- Report: `/home/yehca3144_gmail_com/careeros-login-fix-20260927/test-results/careeros-mcp-e2e-20260927T220441Z-3910862`; local copy is under ignored `test-results/google-login-fix-20260927/report.json`.
- Deployed web image: `sha256:0ac664cbee391104548ce35f6cbcdd565f7e01ca35c71da90fb9b08837df95c6`. Previous image retained as `careeros:rollback-google-fix-20260927`. No database migration or worker restart.
- Test cleanup verified. Deployment compared every other container's ID, start time, restart count and health: all unchanged, including CareerOS worker/database and unrelated habit services.
- **Actual official SDK verified on the production site via Chrome:** Google button height 40px, Google icon 18×18px (previously 380×380px); screenshot visibly shows the normal button. This proves the live styling fix, not successful account sign-in.
- **Still pending:** save the Console origin, allow propagation, then complete a real Google sign-in and verify the authenticated workspace. No production Google login success is claimed by this report.
