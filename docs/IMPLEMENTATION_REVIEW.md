# CareerOS independent implementation review

Review date: 2026-09-19 UTC. Scope: the initial invite-only, single-host release. The reviewer examined the application and migration code, OAuth/MCP integration, worker execution, privacy boundaries, frontend routing, and backup/restore procedures. No production credentials or personal data were read, and the reviewer did not change the remote host.

This is a code and targeted behavior review, not a penetration test or a certification of public-launch readiness. Automatic application submission and independent offsite recovery were explicitly deferred by the user; their absence is not treated as an unauthorized omission. Live paid inference, live Google account authorization, and an actual Claude account connection require separate acceptance checks.

Final disposition: all seven findings below have inspected fixes. No unresolved P1 blocker was identified for the documented invite-only release. The reviewer independently rechecked the frontend isolation fix and local unit/type checks; remote verification supplied by the implementation agent is explicitly distinguished below.

## Findings and disposition

### R1 — P1: switching populated pages crashes the entire interface

- Original location: `web/main.tsx`, the `App` route/data effect and final page selection (original lines 3248–3281 and 3417–3424); `Resumes` dereferences `r.validation.eligible` (original line 955).
- Reproduction: open Jobs with one saved job, then select Resumes. The route changes before the effect sets `loading`, so the resume component receives the job response stored in the single shared `data` object. There is no React error boundary, and the whole interface becomes blank.
- Independently reproduced with Chromium/Playwright against the built bundle and synthetic API responses: `Cannot read properties of undefined (reading 'eligible')`; resulting body text length was zero. No production data was used.
- Correction requested: only render data when its route and authenticated owner match the current view. Clearing owner-specific data and open dialogs on logout is necessary as well: otherwise a second account can briefly see the first account's old view before the next request finishes.
- Recheck: **closed**. The render gate now requires both the authenticated owner and route to match, and logout clears private view/dialog state. An independent fresh frontend build passed Jobs → Resumes → Career → Jobs with populated, differently shaped responses and no page errors. A synthetic account A → B switch with B's response deliberately delayed displayed no A job data and subsequently rendered B's data.

### R2 — P1: independent offer records can overwrite an accepted outcome

- Original location: `server/routes.ts`, `POST /offers` and `POST /offers/:id/decision` (original lines 476–539).
- Reproduction: create offer A and offer B for the same application; accept A, then decline B. Each decision checks only its offer, so the application becomes `offer_declined` even though A remains accepted. Creating another offer after acceptance similarly resets the application to `offer`.
- Correction requested: one offer identity per application, immutable revisions for negotiations, application-first locking, and terminal-state checks shared by creation and decisions.
- Recheck: **closed**. The implementation added `migrations/005_offer_identity.sql`, a closed-application guard when creating an offer, and application-first locking with an `offer` state requirement on decisions. These changes address the inspected paths. The implementation agent reports the updated PostgreSQL integration regression passed.

### R3 — P2: membership revocation races with sharing mutations

- Original location: `server/groups.ts`, `POST /groups/:id/notes` and the other membership-dependent handlers.
- Reproduction schedule: a share request passes `member()`; an owner removes that member and deletes their shares; the first request then inserts its share. The membership join initially hides it, but it reappears if that person later rejoins. An invite creation can similarly finish after its actor has lost membership.
- Correction requested: serialize membership-dependent reads and writes with membership removal/transfer, using a transaction and group `FOR SHARE` lock before the membership check. Removal and transfer already use `FOR UPDATE`.
- Recheck: **closed in code**. Group detail, invite creation/revocation, sharing preferences, job sharing, comments, and note sharing now use this locking order. The inspected fix prevents the reported interleaving. Existing integration coverage checks access after removal; a deterministic concurrent-sharing regression remains worthwhile follow-up coverage.

### R4 — P2: non-reusable answers are included in new dossiers

- Location: `server/domain.ts`, `prepareDossier` answer query/filter (original lines 332–344).
- Reproduction: create a confirmed answer with `reusable=false`, then prepare a new application in the same market. The query checks revocation and expiry, and the filter checks country/company, but neither checks `reusable`; the answer is copied into the dossier anyway.
- Impact: there is no current external submission because automatic submission is disabled, but the stored application payload exceeds the user's reuse preference. This must be corrected before any executor can consume dossiers.
- Correction requested: include only explicitly reusable matching answers, or require explicit per-application selection for one-shot answers. Add a regression for both reusable and non-reusable answers.
- Recheck: **closed**. `prepareDossier` now selects `reusable=true` answers before applying country/company matching. The implementation agent reports the integration assertion excluding a one-time answer and a wrong-market answer passed.

### R5 — P2: restore instructions must fail closed when deletion history is unavailable

- Location: `docs/DEPLOYMENT.md`, restore steps 1 and 6; `server/replay-deletions.ts`.
- Scenario: restoring a backup created before an account deletion without the latest deletion ledger resurrects that user's private data. Keeping only automatic submission disabled does not prevent this privacy failure.
- Correction requested: explicitly prevent all restored user traffic and background processing until the current deletion ledger has been replayed and verified. If that history cannot be established, do not promote the restore. The offsite copy remains a user-deferred prerequisite for disaster recovery.
- Related limitation: `server/backup-stream.mjs` buffers ciphertext and plaintext and rejects inputs above 512 MiB. A user's 512 MiB raw asset allowance can exceed that backup size after storage encoding. The separate large-backup restore process must be implemented and tested before claiming recovery at the advertised storage limit; merely mentioning an offline procedure does not supply one.
- Recheck: **closed**. Restore instructions now forbid restored login/public traffic when current deletion history cannot be established. The helper decrypts into a mode-0600 file in a private temporary directory and emits plaintext only after authentication succeeds, removing the full-memory/512 MiB implementation cap. The runbook explicitly requires a sufficiently large disk-backed `BACKUP_TMP_DIR` for large restores rather than the web container's 256 MiB tmpfs. The implementation agent reports a successful 520 MiB encryption/decryption run with a 128 MiB JavaScript heap, plus an isolated PostgreSQL/asset restore and newer deletion-ledger replay.

### R6 — P2: downloaded resumes omit the contact email shown in preview

- Location: `server/assets.ts`, PDF and DOCX rendering; `server/schemas.ts`, `resumeMarkdown`; compared with the resume preview in `web/main.tsx`.
- Reproduction: generate a resume from work/project facts. Its preview includes the account email, but all download formats contain only the name and experience blocks. An employer receiving the document loses the only contact address shown in the website preview.
- Correction requested: use a shared explicit contact/header representation across preview and all export formats, and check that generated files contain the intended contact address.
- Recheck: **closed**. PDF and DOCX renderers now include the account email, and Markdown exports pass it to the shared header function. The integration suite parses PDF/DOCX contents and asserts the email appears, in addition to checking Markdown. The implementation agent reports those assertions passed.

### R7 — P2: the standalone backup helper accepts a missing encryption key

- Original location: `server/backup-stream.mjs`, HKDF key initialization (original lines 9–16).
- Scenario: run the documented standalone helper without `ENCRYPTION_KEY` in its environment. The helper derives a deterministic key from empty bytes rather than failing. The normal compose path supplies the configured key, but an offline encryption invocation can silently produce publicly decryptable backups.
- Correction requested: validate a 64-character hexadecimal key before deriving any subkey, consistent with application startup; cover absent and malformed keys in tests.
- Recheck: **closed**. The helper rejects a missing or malformed 64-character hexadecimal key before HKDF. The reviewer independently ran the new absent-key test and the backup tampering test; both passed, and invalid input emitted no plaintext.

## Checks performed independently

- `npm run check`: passed.
- `npm test`: all four tests passed after the fixes, covering authenticated asset ownership, canonical idempotency hashing, backup authentication/tampering, and absent backup keys.
- Chromium reproduction of populated Jobs → Resumes navigation: failed as described in R1 before the fix; the repaired populated navigation and delayed account-switch isolation both passed an independent recheck.
- Static inspection found owner-qualified lookups and composite owner foreign keys on the principal personal-data relationships; no concrete cross-tenant IDOR was identified in the reviewed paths.
- OAuth authorization codes are hashed, short-lived, single-use and tied to client/redirect; SDK handlers enforce PKCE. Refresh reuse revokes the grant family, scopes cannot expand, access tokens are resource-bound, and MCP tools are scope-filtered.
- MCP generation and event tools create unconfirmed facts/drafts/proposals. Website session-only handlers confirm facts, resume text and status events. Interview practice is recorded separately from real invitations.
- Attachments use authenticated encryption with owner/asset-specific additional data. Rendered resume HTML is escaped and browser requests are blocked. Uploads, storage quota, parsing subprocesses, audio duration, and export concurrency have bounds.
- BYOK usage is reserved before paid calls, with a user-row lock around the daily budget. Interrupted paid tasks are not automatically retried. Real provider behavior remains unverified without customer credentials.
- `SUBMISSIONS_ENABLED` values other than `false` fail startup; no working external submission path is exposed.

## Additional verification reported by the implementation agent

These results were supplied by the implementation agent after remediation. The independent reviewer inspected the relevant code and tests but did not rerun commands on the remote host:

- Production build and four unit tests passed; dependency audit reported zero vulnerabilities.
- Eleven of eleven integration tests passed against a dedicated PostgreSQL test database, including offer identity/terminal-state guards, reusable-only dossier answers, extracted contact text in all export formats, secret-free personal export, and account deletion.
- Chromium real UI flows passed at 1440 × 1050 desktop and 390 × 844 mobile sizes, including populated-page navigation and mobile navigation opening/closing, with no page errors. Screenshots were inspected by the implementation agent.
- An encrypted database/asset backup restored to a separate `careeros_restore_test` database; a real exported asset passed SHA-256 verification. Replaying a newer deletion ledger reduced the restored user count to zero.
- A 520 MiB encryption/decryption exercise passed under a 128 MiB JavaScript heap using disk-backed `BACKUP_TMP_DIR`.
- HTTPS health and MCP discovery returned HTTP 200. CareerOS containers were healthy, and the unrelated existing application remained running.

This evidence does not establish live Google consent/synchronization, real paid BYOK provider behavior, or connection through an actual Claude user interface; none is claimed as verified.

## Release boundary

The defensible scope is an invite-only first release with explicit integration limitations. Do not describe it as fully production-ready for public onboarding while independent disaster recovery, live provider acceptance, password recovery, resource/load testing, and independent uptime/error alerts remain outstanding. Keep the UI and README consistent with the actual enabled capabilities.
