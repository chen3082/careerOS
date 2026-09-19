SET LOCAL lock_timeout = '5s';
ALTER TABLE applications
  ADD COLUMN external_resume_asset_id uuid,
  ADD COLUMN external_resume_name text NOT NULL DEFAULT '',
  ADD COLUMN submission_channel text NOT NULL DEFAULT '',
  ADD CONSTRAINT applications_external_resume_owner
    FOREIGN KEY (owner_id,external_resume_asset_id) REFERENCES assets(owner_id,id),
  ADD CONSTRAINT applications_one_resume_source
    CHECK (resume_id IS NULL OR (external_resume_asset_id IS NULL AND external_resume_name=''));
