ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS store_open_time text NOT NULL DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS store_close_time text NOT NULL DEFAULT '22:00',
  ADD COLUMN IF NOT EXISTS store_hours_mode text NOT NULL DEFAULT 'open';

DO $$ BEGIN
  ALTER TABLE public.agents ADD CONSTRAINT agents_store_hours_mode_check CHECK (store_hours_mode IN ('open','auto','closed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;