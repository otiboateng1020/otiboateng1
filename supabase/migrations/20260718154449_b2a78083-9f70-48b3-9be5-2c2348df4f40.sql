
CREATE TABLE public.email_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('signup','login','reset')),
  payload jsonb,
  user_id uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_evc_email_purpose ON public.email_verification_codes (email, purpose, created_at DESC);
GRANT ALL ON public.email_verification_codes TO service_role;
ALTER TABLE public.email_verification_codes ENABLE ROW LEVEL SECURITY;
-- No policies: only service role (server) accesses this table.
