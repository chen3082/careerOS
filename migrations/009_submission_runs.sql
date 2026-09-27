SET LOCAL lock_timeout='5s';
ALTER TABLE dossiers ADD CONSTRAINT dossier_application_identity UNIQUE(owner_id,application_id,id);
CREATE TABLE submission_runs (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 application_id uuid NOT NULL,
 dossier_id uuid NOT NULL,
 external_job_key text NOT NULL,
 cycle integer NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','approved','sending','confirmed','outcome_unknown','cancelled','failed_safe','needs_input')),
 manifest jsonb NOT NULL,
 manifest_hash text NOT NULL,
 review jsonb,
 approved_hash text,
 permit_at timestamptz,
 receipt jsonb,
 error text,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,application_id) REFERENCES applications(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,application_id,dossier_id) REFERENCES dossiers(owner_id,application_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX submission_external_blocker ON submission_runs(owner_id,external_job_key,cycle)
 WHERE status NOT IN ('cancelled','failed_safe','needs_input');
