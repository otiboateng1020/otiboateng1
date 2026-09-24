
-- Agent credit accounts (opt-in per agent, admin-controlled)
CREATE TABLE public.agent_credit (
  agent_id UUID PRIMARY KEY REFERENCES public.agents(user_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  outstanding NUMERIC(14,2) NOT NULL DEFAULT 0,
  last_settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.agent_credit TO authenticated;
GRANT ALL ON public.agent_credit TO service_role;
ALTER TABLE public.agent_credit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents can view their own credit" ON public.agent_credit
  FOR SELECT TO authenticated USING (auth.uid() = agent_id);
CREATE TRIGGER trg_agent_credit_updated BEFORE UPDATE ON public.agent_credit
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Ledger of credit-paid orders (settled in batches)
CREATE TABLE public.credit_orders_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  order_type TEXT NOT NULL CHECK (order_type IN ('data','smm')),
  order_id UUID,
  amount NUMERIC(14,2) NOT NULL,
  settled BOOLEAN NOT NULL DEFAULT false,
  settled_at TIMESTAMPTZ,
  settlement_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.credit_orders_log TO authenticated;
GRANT ALL ON public.credit_orders_log TO service_role;
ALTER TABLE public.credit_orders_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents can view their own credit log" ON public.credit_orders_log
  FOR SELECT TO authenticated USING (auth.uid() = agent_id);
CREATE INDEX idx_credit_orders_log_agent ON public.credit_orders_log(agent_id, settled, created_at DESC);

-- Business hours settings (seeded defaults)
INSERT INTO public.site_settings (key, value) VALUES
  ('business_open_time', to_jsonb('08:00'::text)),
  ('business_close_time', to_jsonb('22:00'::text)),
  ('business_auto_schedule', to_jsonb(false)),
  ('business_manual_state', to_jsonb('open'::text)),
  ('settlement_reminder_minutes', to_jsonb(60))
ON CONFLICT (key) DO NOTHING;
