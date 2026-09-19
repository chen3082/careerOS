SET LOCAL lock_timeout = '5s';
CREATE TABLE account_setup_runs (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 job_id uuid NOT NULL,
 realm text NOT NULL,
 provider text NOT NULL,
 entry_url text NOT NULL,
 candidate_email text NOT NULL,
 candidate_name text NOT NULL,
 allow_registration boolean NOT NULL,
 state text NOT NULL CHECK(state IN ('waiting_client','working','login_required','registration_required','awaiting_email','awaiting_phone','captcha_required','password_required','terms_required','external_login_required','account_ready','no_account_needed','unsupported','cancelled')),
 version integer NOT NULL DEFAULT 0,
 claim_id uuid,
 observed_email text,
 observed_path text,
 observed_at timestamptz,
 authorized_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX account_setup_one_active ON account_setup_runs(owner_id,realm,candidate_email) WHERE state<>'cancelled';
CREATE INDEX account_setup_owner ON account_setup_runs(owner_id,updated_at DESC);
