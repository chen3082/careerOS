# Shared catalog review and acceptance

Independent read-only review covered migration 011, public source transport, catalog API/MCP, leases, private job aliases, worker scheduling and browser state. The reviewer did not connect to production.

Issues found and fixed before release:

1. Existing private jobs and the same exact URL from multiple sources now resolve to one owner-scoped snapshot/application. `catalog_saves` preserves source aliases; list/save use the same owner + alias/URL identity rule.
2. Pausing periodic polling no longer strands explicit manual requests. The worker processes their separate persisted request flag.
3. An expired running manual request can be reclaimed after worker interruption even with periodic polling disabled. Publish still rejects stale lease tokens.
4. Legacy search results distinguish a fresh crawl, cached data and collection still in progress.
5. Personal export includes the current owner's catalog aliases.

Final bounded review found no remaining blocker. This is not a penetration-test certification or verification of LinkedIn/104 collection.

## Isolated acceptance

Run `careeros-mcp-e2e-20260919T203909Z-4152347`: six acceptance groups passed with a real PostgreSQL database, HTTP API, OAuth/PKCE MCP connections, browser contexts and background worker. The browser scenario explicitly disables periodic polling and verifies that a manual refresh still publishes into the common catalog and appears through automatic frontend refresh.

Covered: concurrent refresh/claim/save, two-user private-state isolation, source owner/CSRF permissions, exact-URL aliases and preexisting imports, pagination/filtering, unchanged/changed/partial/failed feeds, expired/revoked lease fencing, public transport constraints, browser save into private workflow, source-management form and mobile overflow.

The harness reported existing service container IDs, start times, restart counts and health unchanged, and verified removal of its disposable containers/network. Provider responses were synthetic and Internet egress was blocked. No employer submissions were sent. Local build/typecheck and four unit checks also passed.

The dedicated report and desktop/mobile screenshots are retained under ignored `test-results/catalog-acceptance/`. Production source refresh evidence is recorded separately during deployment; synthetic acceptance is not described as a live provider check.
