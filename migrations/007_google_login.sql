SET LOCAL lock_timeout = '5s';
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN google_verified_at timestamptz;
CREATE TABLE google_identities (
 owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 subject text NOT NULL UNIQUE,
 email text NOT NULL,
 linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE google_login_challenges (
 hash text PRIMARY KEY,
 nonce_hash text NOT NULL,
 intent text NOT NULL CHECK (intent IN ('login','link','reauth')),
 owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
 session_hash text,
 completed_session_hash text,
 expires_at timestamptz NOT NULL,
 CHECK ((intent='login' AND owner_id IS NULL AND session_hash IS NULL) OR
        (intent<>'login' AND owner_id IS NOT NULL AND session_hash IS NOT NULL))
);
CREATE INDEX google_login_challenges_expiry ON google_login_challenges(expires_at);
