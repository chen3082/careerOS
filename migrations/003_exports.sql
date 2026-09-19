CREATE TABLE resume_exports (
 owner_id uuid NOT NULL,
 resume_id uuid NOT NULL,
 format text NOT NULL CHECK(format IN ('pdf','docx')),
 asset_id uuid NOT NULL,
 template_version text NOT NULL DEFAULT '1',
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(resume_id,format),
 FOREIGN KEY(owner_id,resume_id) REFERENCES resumes(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,asset_id) REFERENCES assets(owner_id,id) ON DELETE CASCADE
);
