# OpenAI and provider-neutral MCP — 2026-09-19

Implementation: `dc58fda32acf9cb8074e46680dce9b6d32d56281`.
[Successful CI](https://github.com/chen3082/careerOS/actions/runs/35433090775).
Setup and limitations: [AI-PROVIDERS.md](AI-PROVIDERS.md).

## Delivered behavior

- Shared OAuth/PKCE MCP endpoint with connection instructions for Claude, ChatGPT and Codex. MCP generation waits for the connected assistant and never invokes a stored API key.
- Website background generation supports OpenAI Responses and Anthropic Messages for experience extraction, resume drafting/tailoring and career guidance grounded in saved job samples. Existing OpenAI transcription remains separate.
- Provider/model selection is fixed in server-controlled task columns at creation. Changing preferences affects new tasks only; legacy queued tasks retain Anthropic behavior. Missing keys never fall back to another provider, user or platform account.
- Fixed HTTPS endpoints, encrypted per-user credentials, output caps, budget reservations, provider/model/request-ID usage records, no automatic paid retries, and existing ownership/evidence/draft-confirmation checks.

## Independent review and corrections

A separate reviewer inspected the implementation and exercised an independent synthetic transport/DB harness covering 25 assertions. This harness is distinct from the real PostgreSQL integration tests below.

1. **P1 rollout:** The prior worker always selected Anthropic. Deployment must drain and stop it before exposing web code that can queue OpenAI tasks, then promote matching web/worker images. Rollback restores the web but leaves the worker stopped until a compatible worker is available. The reviewer checked the concrete deployment script and confirmed this ordering closes the issue.
2. **P2 release verification:** Isolated E2E mounts the QA frontend over the candidate image. Promotion now compares the recorded QA frontend hashes with files inside the exact image before any production change. Runtime files are also checked against reviewed source.
3. Strengthened the integration test with an actual second owner's synthetic encrypted OpenAI key; removed the remaining Claude-only MCP tool description. Browser CI identified an ambiguous client-selector label; an explicit accessible name corrected it before the successful run.

No remaining blocking issue was found within the reviewed scope. This is not an exhaustive security audit.

## Verification

- TypeScript/Vite build; 4 unit tests; 40 real PostgreSQL integration tests, including 12 new provider tests and the 28 existing product/auth tests.
- Provider routing/model freezing, owner-key isolation, missing-key rejection, legacy tasks, budget refusal, known 4xx release, ambiguous failure and missing-usage reservations, refusal/truncation/schema handling, resume fact references, career job evidence, and MCP/stale-worker no-spend checks.
- Real browser, app, worker and database with test-only synthetic provider responses: select/save OpenAI key, create experience draft, switch to Anthropic with its separate key, verify attributed usage, switch to MCP without spending keys, and desktop/mobile settings without overflow or browser errors.
- Existing Google browser, product browser and offline worker regressions pass. Dependency audit reports zero known vulnerabilities at the recorded CI run.

## Remaining acceptance

No real API keys or paid inference were used. These tests do not establish provider-account permission, live-model output quality or actual Claude/ChatGPT/Codex account UI acceptance. Each user still connects their own assistant or saves their own provider API key; subscriptions and API billing are separate. Background execution cannot use an idle assistant's subscription through MCP. Google sign-in configuration and deferred offsite recovery work remain documented separately.

## GCP isolated acceptance

- Candidate image: `sha256:90dc3b572b79d6d932c35bd1f0a2986296469c2d8bce1399a05bfdb09b3542d8`.
- Final clean-artifact report: `careeros-providers-qa/test-results/careeros-mcp-e2e-20260919T085449Z-3645123`. Synthetic artifacts are copied locally to ignored `test-results/ai-providers/final`.
- 4 unit tests, 40 real PostgreSQL integration tests and 6 browser/worker checkpoints pass; desktop/mobile screenshots were visually inspected.
- All 52 runtime/frontend/migration/dependency/test file hashes match the reviewed source. Existing service IDs, start times, restart counts and health remained unchanged; disposable containers/network were verified removed. Test database/files used tmpfs, with no production secrets or volumes and no Internet egress.
