-- Public provider data only. Never migrate user-imported jobs into this table.
CREATE TABLE catalog_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL CHECK(provider IN ('greenhouse','lever','arbeitnow')),
 board text NOT NULL DEFAULT '', label text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 interval_hours integer NOT NULL DEFAULT 6 CHECK(interval_hours BETWEEN 1 AND 24),
 version integer NOT NULL DEFAULT 0,
 refresh_requested boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','idle','failed')),
 next_fetch_at timestamptz NOT NULL DEFAULT now(),
 last_attempt_at timestamptz, last_success_at timestamptz,
 lease_token uuid, lease_until timestamptz,
 failures integer NOT NULL DEFAULT 0,
 last_error text, job_count integer NOT NULL DEFAULT 0,
 new_count integer NOT NULL DEFAULT 0, changed_count integer NOT NULL DEFAULT 0,
 complete boolean NOT NULL DEFAULT false,
 UNIQUE(provider,board)
);
CREATE TABLE catalog_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL REFERENCES catalog_sources(id),
 external_id text NOT NULL,
 title text NOT NULL, company text NOT NULL, location text NOT NULL,
 markets text[] NOT NULL DEFAULT '{}', url text NOT NULL, description text NOT NULL,
 content_hash text NOT NULL,
 availability text NOT NULL DEFAULT 'listed' CHECK(availability IN ('listed','not_listed')),
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 changed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id,external_id)
);
CREATE INDEX catalog_recent ON catalog_jobs(first_seen_at DESC,id);
CREATE INDEX catalog_source_state ON catalog_jobs(source_id,availability);
CREATE INDEX catalog_markets ON catalog_jobs USING gin(markets);
CREATE TABLE catalog_saves (
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 catalog_job_id uuid NOT NULL REFERENCES catalog_jobs(id),
 job_id uuid NOT NULL,
 PRIMARY KEY(owner_id,catalog_job_id),
 FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX jobs_owner_url ON jobs(owner_id,url);
INSERT INTO catalog_sources(provider,board,label) VALUES
 ('lever','Gogolook','Gogolook'),('lever','shopback-2','ShopBack'),
 ('greenhouse','figma','Figma'),('greenhouse','stripe','Stripe'),
 ('arbeitnow','','Arbeitnow');
