
-- SMM Services (cached catalog with pricing overrides)
CREATE TABLE IF NOT EXISTS public.smm_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  platform TEXT NOT NULL,
  min_quantity INTEGER NOT NULL DEFAULT 1,
  max_quantity INTEGER NOT NULL DEFAULT 100000,
  base_price_per_1000 NUMERIC(14,4) NOT NULL DEFAULT 0,
  custom_price_per_1000 NUMERIC(14,4),
  markup_percent NUMERIC(6,2),
  auto_markup BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, provider)
);

GRANT SELECT ON public.smm_services TO authenticated;
GRANT ALL ON public.smm_services TO service_role;
ALTER TABLE public.smm_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smm_services read active" ON public.smm_services
  FOR SELECT TO authenticated USING (active = true);

CREATE TRIGGER update_smm_services_updated_at BEFORE UPDATE ON public.smm_services
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS smm_services_platform_idx ON public.smm_services (platform);
CREATE INDEX IF NOT EXISTS smm_services_active_idx ON public.smm_services (active);

-- SMM Orders
CREATE TABLE IF NOT EXISTS public.smm_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  smm_service_id UUID REFERENCES public.smm_services(id) ON DELETE SET NULL,
  service_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  service_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  link TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_charged NUMERIC(14,4) NOT NULL,
  cost_price NUMERIC(14,4) NOT NULL DEFAULT 0,
  profit NUMERIC(14,4) NOT NULL DEFAULT 0,
  provider_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.smm_orders TO authenticated;
GRANT ALL ON public.smm_orders TO service_role;
ALTER TABLE public.smm_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smm_orders read own" ON public.smm_orders
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER update_smm_orders_updated_at BEFORE UPDATE ON public.smm_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS smm_orders_user_idx ON public.smm_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS smm_orders_status_idx ON public.smm_orders (status);

-- Default settings
INSERT INTO public.site_settings (key, value)
VALUES ('smm_global_markup_percent', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.site_settings (key, value)
VALUES ('smm_xd_to_ghs_rate', '1'::jsonb)
ON CONFLICT (key) DO NOTHING;
