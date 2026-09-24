ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payer_phone text;
ALTER TABLE public.orders ALTER COLUMN user_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS orders_source_idx ON public.orders(source);

CREATE TABLE IF NOT EXISTS public.ussd_sessions (
  id text PRIMARY KEY,
  msisdn text NOT NULL,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.ussd_sessions TO service_role;
ALTER TABLE public.ussd_sessions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;
DROP TRIGGER IF EXISTS update_ussd_sessions_updated_at ON public.ussd_sessions;
CREATE TRIGGER update_ussd_sessions_updated_at BEFORE UPDATE ON public.ussd_sessions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.site_settings(key, value)
VALUES ('ussd_settings', '{"enabled": true, "service_code": "129"}'::jsonb)
ON CONFLICT (key) DO NOTHING;