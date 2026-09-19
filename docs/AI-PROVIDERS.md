# Claude, ChatGPT, Codex and API providers

The CareerOS MCP endpoint is provider-neutral: `https://gptig.allenchencode.com/careeros/mcp`. Each assistant authenticates to the same user account using OAuth/PKCE and receives only its approved scopes. The website, resume versions, career facts, applications and interview records remain the shared source of truth.

## Use an existing assistant

- **Claude:** Add a custom connection in Connectors with the endpoint above, then sign in to CareerOS and approve access.
- **ChatGPT:** Use Developer mode and create a remote MCP app/plugin with OAuth. CareerOS supports Dynamic Client Registration (DCR), not CIMD. Entry points and availability depend on the account/workspace. See [OpenAI Developer mode](https://developers.openai.com/api/docs/guides/developer-mode).
- **Codex:** Add the remote HTTP MCP server in settings, or run `codex mcp add careeros --url https://gptig.allenchencode.com/careeros/mcp`, followed by `codex mcp login careeros`. See [official MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Ask the connected assistant to process pending CareerOS generation tasks. The tool flow is `generation_list_pending` → `generation_get_context` → `generation_submit_result`. Outputs remain drafts requiring confirmation. This uses the assistant's own inference; CareerOS does not obtain the user's subscription cookies or call a stored API key for MCP tasks. The website cannot wake an idle assistant. Real client UI/account acceptance is separate from protocol tests and remains user-side.

## Run generation in the website

In Settings, choose **背景執行 · 我的 API key**, select **OpenAI · GPT** or **Anthropic · Claude**, and save that provider's own API key. Both providers support experience extraction, resume drafting/tailoring and analysis of saved job samples. OpenAI also retains the existing separate audio transcription capability.

Keys remain encrypted per user/provider. There is no fallback to another provider, another user's key or a shared platform key. The provider/model are frozen in server-controlled task columns at creation; changing settings affects new tasks only. Old tasks without provider metadata retain the original Anthropic behavior. Caller-supplied task input cannot choose the billed provider or model. MCP-created tasks clear the API execution plan even if the user's website mode is BYOK.

Operator models: `OPENAI_MODEL=gpt-4.1-mini-2025-04-14` and existing `ANTHROPIC_MODEL=claude-sonnet-4-6`. OpenAI uses the fixed Responses API endpoint with `store:false`, JSON output mode and a 4,500 output-token cap. Domain validation still checks ownership, confirmed facts, revisions and sampled job evidence; valid JSON alone is insufficient. See [Responses JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs) and [model specification](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

Before sending any request, CareerOS reserves a conservative token budget. Known rejected requests release it. Successful usage is recorded with provider, model and request ID; missing usage, timeout or ambiguous failure retains the reservation for reconciliation. There are no automatic paid retries. The token setting is an execution limit, not an exact currency budget; provider billing applies separately from assistant subscriptions. Actual paid generation quality and provider-account permissions need acceptance using the user's own keys; synthetic tests do not prove those.

## Rollout constraint

The previous worker always used Anthropic and cannot safely consume newly created OpenAI tasks. **Drain and stop the old CareerOS worker before making the new web release available.** Apply migration 008, deploy the matched web/worker image, and verify no older worker remains. Do not roll back to an older worker while OpenAI jobs may exist. If promotion fails, restore the previous web and leave the worker stopped until a compatible worker is repaired. Other host services must remain running and unchanged.

The `providers` scenario in `scripts/test-mcp-e2e.sh` uses isolated PostgreSQL, private tmpfs storage, capped containers, synthetic provider transports and real browser/worker flows. It has no production mounts or Internet egress. The provider stub is imported by the test worker only; product code has no configurable provider URL or HTTP test endpoint.
