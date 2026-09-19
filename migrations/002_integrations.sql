CREATE TABLE integration_states (hash text PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,expires_at timestamptz NOT NULL);
