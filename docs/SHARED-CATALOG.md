# Shared public job catalog

The Find Jobs page opens on a common catalog. A platform background collector refreshes enabled public sources every six hours by default. Any signed-in user can request a refresh of an existing source; the current list remains usable and the browser reloads catalog results while visible. A refresh updates the public catalog for every user, not just its requester.

## Public data and private workflow

`catalog_sources` stores provider/company identifiers, schedule, lease and health. `catalog_jobs` stores only the public provider response: job title, company, location, description, source URL and observation timestamps. Nothing from personal resumes, experience, manual imports, private search text or applications is promoted into the catalog.

`catalog_saves` maps a user's catalog aliases to an owner-scoped job snapshot. Saving, preparing a resume, grouping or preparing an application first creates or reuses that private snapshot. An exact source URL already saved privately is reused. Identical URLs across sources reuse one private job and application. Different URLs are not guessed to be the same position. Public refreshes never rewrite a private application snapshot. Existing private application state is overlaid for the current owner only, including jobs saved before this release.

The catalog is shared among authenticated CareerOS users, not exposed through an anonymous endpoint. Personal export includes only the user's alias mappings and existing private snapshots. Deleting the user cascades their mappings without deleting the public feed.

## Sources and coverage

Initial sources: Gogolook and ShopBack on Lever; Figma and Stripe on Greenhouse; the first public page from Arbeitnow. Only the website owner can add a company board, pause/resume a source or set its interval (1–24 hours via the API). At most 50 sources are configured. Regular users and MCP clients can request an existing source refresh but cannot create arbitrary sources.

Provider API destinations are fixed in code. Source identifiers are validated; redirects are rejected; each response is limited to 8 MiB and 25 seconds. Lever uses bounded pagination (up to four 500-row pages). Greenhouse checks returned total metadata when available. Arbeitnow is explicitly a partial sample. Public description HTML is converted to plain text and rendered by React as text.

References: [Greenhouse public Job Board API](https://docs.greenhouse.io/job-board.html), [Lever public postings API](https://github.com/lever/postings-api).

This release does not crawl LinkedIn or 104. Market filters use source location text, not eligibility or work authorization. First-seen dates are CareerOS discovery dates, not claimed original publication dates. A feed failure is not an empty successful search. Partial feeds never mark missing jobs as removed; their older observations remain visibly dated. A successful complete feed can mark missing rows `not_listed`; this means absence from that feed, not verified closure at the employer.

## Scheduling, limits and recovery

The existing CareerOS worker handles one public source per loop alongside private tasks. A PostgreSQL row lock and three-minute lease make concurrent requests share a single crawl. Publish checks the current lease token, expiry and enabled state inside the transaction. Disabling/editing a source invalidates its lease. Expired running leases can be recovered, including when periodic polling is paused. Stale workers cannot replace newer results.

User-requested refreshes share a five-minute per-source cooldown. Scheduled failures back off from 15 minutes with a capped exponential delay. No LLM calls, provider API keys, candidate credentials or resume uploads are used for collection. `CATALOG_POLLING=false` pauses periodic due-source collection; explicit manual refreshes still execute. Tests default periodic polling off. Production defaults it on.

Website API:

- `GET /api/catalog/jobs`: paginated keyword, market and source filters; only the current user's save/application overlay.
- `GET /api/catalog/sources`: coverage, last successful refresh, counts and errors; no lease tokens.
- `POST /api/catalog/sources/:id/refresh`: authenticated/CSRF-protected deduplicated request.
- `POST /api/catalog/jobs/:id/save`: private snapshot/alias creation, serialized by owner.
- `POST /api/catalog/sources`, `PATCH /api/catalog/sources/:id`: owner-only configuration, optimistic version checks for changes.

MCP exposes `catalog_search`, `catalog_sources`, `catalog_refresh` and `catalog_save`. Reads never silently trigger collection. Refresh/save require write scope. The existing private `jobs_search` stays private. Legacy website `search_jobs` tasks refresh/reuse the shared source cache and save their filtered matches privately; results explicitly distinguish fresh, cached and still-pending collection.

## Acceptance and deployment

`tests/catalog-e2e.ts` uses an isolated PostgreSQL database, real HTTP server, OAuth/PKCE MCP clients, two signed-in browser contexts and a real worker with a test-only public transport. It covers concurrent claims/saves, private data isolation, source permissions, exact-URL aliases, freshness/partial/failure behavior, revoked/expired fencing, paused-scheduler manual recovery, and worker-to-browser refresh. The disposable-container harness blocks Internet egress and verifies that existing server containers are unchanged.

Deploy migration 011 before the matched web/worker release. Keep the PostgreSQL volume and other host services untouched. Migration is additive. Program rollback may retain the new tables; it must not copy public data into the old private tables or replay application submission.
