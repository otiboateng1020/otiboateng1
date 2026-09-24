
-- AGENTS
CREATE TABLE public.agents (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  store_name TEXT UNIQUE,
  whatsapp_link TEXT,
  contact_number TEXT,
  profit_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  global_markup_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  auto_markup BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_store_name_lower_unique ON public.agents (lower(store_name)) WHERE store_name IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents TO authenticated;
GRANT SELECT ON public.agents TO anon;
GRANT ALL ON public.agents TO service_role;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agents self read" ON public.agents FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "agents self update" ON public.agents FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "agents public store read" ON public.agents FOR SELECT TO anon USING (active = true AND store_name IS NOT NULL);

CREATE TRIGGER agents_updated_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- AGENT PLANS (per-plan pricing overrides)
CREATE TABLE public.agent_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES public.data_plans(id) ON DELETE CASCADE,
  agent_price NUMERIC(14,2),
  markup_percent NUMERIC(6,2),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, plan_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_plans TO authenticated;
GRANT SELECT ON public.agent_plans TO anon;
GRANT ALL ON public.agent_plans TO service_role;
ALTER TABLE public.agent_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_plans self all" ON public.agent_plans FOR ALL TO authenticated USING (auth.uid() = agent_id) WITH CHECK (auth.uid() = agent_id);
CREATE POLICY "agent_plans public read active" ON public.agent_plans FOR SELECT TO anon USING (active = true);

CREATE TRIGGER agent_plans_updated_at BEFORE UPDATE ON public.agent_plans FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- AGENT ORDERS (buyer purchases on public store)
CREATE TABLE public.agent_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES public.data_plans(id),
  buyer_phone TEXT NOT NULL,
  payment_phone TEXT NOT NULL,
  payment_network TEXT NOT NULL,
  agent_price NUMERIC(14,2) NOT NULL,
  base_price NUMERIC(14,2) NOT NULL,
  profit NUMERIC(14,2) NOT NULL,
  payment_reference TEXT UNIQUE,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  order_id UUID REFERENCES public.orders(id),
  order_status TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_orders TO authenticated;
GRANT ALL ON public.agent_orders TO service_role;
ALTER TABLE public.agent_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_orders self read" ON public.agent_orders FOR SELECT TO authenticated USING (auth.uid() = agent_id);

CREATE TRIGGER agent_orders_updated_at BEFORE UPDATE ON public.agent_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- AGENT WITHDRAWALS
CREATE TABLE public.agent_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL,
  method TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_withdrawals TO authenticated;
GRANT ALL ON public.agent_withdrawals TO service_role;
ALTER TABLE public.agent_withdrawals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_wd self read" ON public.agent_withdrawals FOR SELECT TO authenticated USING (auth.uid() = agent_id);
CREATE POLICY "agent_wd self insert" ON public.agent_withdrawals FOR INSERT TO authenticated WITH CHECK (auth.uid() = agent_id);

CREATE TRIGGER agent_withdrawals_updated_at BEFORE UPDATE ON public.agent_withdrawals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- SETTINGS
INSERT INTO public.site_settings (key, value) VALUES
  ('agent_activation_fee', '100'::jsonb),
  ('agent_withdrawal_min', '150'::jsonb)
ON CONFLICT (key) DO NOTHING;
