ALTER TABLE public.data_plans
  ADD COLUMN IF NOT EXISTS agent_markup_percent NUMERIC(6,2) NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS agent_price NUMERIC(12,2);

UPDATE public.data_plans
  SET agent_price = ROUND((api_price * (1 + agent_markup_percent/100))::numeric, 2)
  WHERE agent_price IS NULL;