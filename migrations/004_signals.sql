ALTER TABLE sync_evidence ADD COLUMN dismissed_at timestamptz;
CREATE INDEX sources_owner ON sources(owner_id,created_at DESC);
CREATE INDEX facts_owner ON facts(owner_id,created_at DESC);
CREATE INDEX jobs_owner ON jobs(owner_id,created_at DESC);
CREATE INDEX tasks_owner ON tasks(owner_id,created_at DESC);
CREATE INDEX group_members_by_user ON memberships(user_id);
