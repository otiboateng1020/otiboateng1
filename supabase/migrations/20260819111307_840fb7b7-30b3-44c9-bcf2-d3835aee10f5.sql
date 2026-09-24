CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE public.app_role AS ENUM ('admin', 'user');
CREATE TYPE public.tx_type AS ENUM ('topup','purchase','refund','referral','withdrawal','fee','adjustment');
CREATE TYPE public.tx_status AS ENUM ('pending','completed','failed','reversed');
CREATE TYPE public.order_status AS ENUM ('pending','processing','completed','failed','refunded');
CREATE TYPE public.withdrawal_status AS ENUM ('pending','approved','rejected','paid');
CREATE TYPE public.payment_status AS ENUM ('pending','success','failed','expired');

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own roles readable" ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role)
$$;

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  referral_active BOOLEAN NOT NULL DEFAULT false,
  is_banned BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own profile" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE TRIGGER profiles_uat BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE UNIQUE INDEX profiles_username_lower_unique ON public.profiles (lower(username));

CREATE TABLE public.wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wallets TO authenticated;
GRANT ALL ON public.wallets TO service_role;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own wallet" ON public.wallets FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TRIGGER wallets_uat BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type tx_type NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  balance_after NUMERIC(12,2),
  reference TEXT,
  status tx_status NOT NULL DEFAULT 'completed',
  description TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_user_created_idx ON public.transactions(user_id, created_at DESC);
GRANT SELECT ON public.transactions TO authenticated;
GRANT ALL ON public.transactions TO service_role;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own transactions" ON public.transactions FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  plan_id UUID,
  plan_code TEXT,
  plan_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount_charged NUMERIC(12,2) NOT NULL,
  api_cost NUMERIC(12,2),
  status order_status NOT NULL DEFAULT 'pending',
  api_reference TEXT,
  api_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  batch_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_created_idx ON public.orders(user_id, created_at DESC);
CREATE INDEX orders_batch_id_idx ON public.orders(batch_id);
GRANT SELECT ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own orders" ON public.orders FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TRIGGER orders_uat BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.data_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  name TEXT NOT NULL,
  size TEXT,
  validity TEXT,
  api_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  markup_percent NUMERIC(6,2) NOT NULL DEFAULT 10,
  custom_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  auto_rate BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  agent_markup_percent NUMERIC(6,2) NOT NULL DEFAULT 20,
  agent_price NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(network, plan_code)
);
GRANT SELECT ON public.data_plans TO authenticated, anon;
GRANT ALL ON public.data_plans TO service_role;
ALTER TABLE public.data_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read active data plans" ON public.data_plans FOR SELECT TO anon, authenticated USING (COALESCE(active, true) = true);
CREATE TRIGGER data_plans_uat BEFORE UPDATE ON public.data_plans FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  earned_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(referred_id)
);
CREATE INDEX referrals_referrer_idx ON public.referrals(referrer_id);
GRANT SELECT ON public.referrals TO authenticated;
GRANT ALL ON public.referrals TO service_role;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own referrals" ON public.referrals FOR SELECT TO authenticated USING (referrer_id = auth.uid());

CREATE TABLE public.withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  method TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status withdrawal_status NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.withdrawals TO authenticated;
GRANT ALL ON public.withdrawals TO service_role;
ALTER TABLE public.withdrawals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own withdrawals" ON public.withdrawals FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own withdrawal insert" ON public.withdrawals FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE TRIGGER withdrawals_uat BEFORE UPDATE ON public.withdrawals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.site_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.site_settings TO anon, authenticated;
GRANT ALL ON public.site_settings TO service_role;
ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read of safe settings" ON public.site_settings
FOR SELECT TO anon, authenticated
USING (key IN ('referral_activation_fee','referral_reward','withdrawal_min','global_markup','auto_markup'));
CREATE TRIGGER site_settings_uat BEFORE UPDATE ON public.site_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.api_credentials (
  provider TEXT PRIMARY KEY,
  encrypted_key TEXT NOT NULL,
  label TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.api_credentials TO service_role;
ALTER TABLE public.api_credentials ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER api_credentials_uat BEFORE UPDATE ON public.api_credentials FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'bridge',
  reference TEXT NOT NULL UNIQUE,
  amount NUMERIC(12,2) NOT NULL,
  fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(12,2) NOT NULL,
  status payment_status NOT NULL DEFAULT 'pending',
  checkout_url TEXT,
  webhook_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_intents_user_idx ON public.payment_intents(user_id, created_at DESC);
GRANT SELECT ON public.payment_intents TO authenticated;
GRANT ALL ON public.payment_intents TO service_role;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own payment intents" ON public.payment_intents FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TRIGGER payment_intents_uat BEFORE UPDATE ON public.payment_intents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.gen_referral_code()
RETURNS TEXT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  code TEXT;
BEGIN
  LOOP
    code := upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = code);
  END LOOP;
  RETURN code;
END; $$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ref UUID;
  v_ref_code TEXT;
BEGIN
  v_ref_code := NEW.raw_user_meta_data->>'referred_by_code';
  IF v_ref_code IS NOT NULL AND length(v_ref_code) > 0 THEN
    SELECT id INTO v_ref FROM public.profiles WHERE referral_code = upper(v_ref_code) LIMIT 1;
  END IF;

  INSERT INTO public.profiles (id, full_name, username, phone, email, referral_code, referred_by)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'username', 'user_' || substring(NEW.id::text from 1 for 8)),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    NEW.email,
    public.gen_referral_code(),
    v_ref
  );

  INSERT INTO public.wallets (user_id, balance) VALUES (NEW.id, 0);
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user') ON CONFLICT DO NOTHING;

  IF v_ref IS NOT NULL THEN
    INSERT INTO public.referrals (referrer_id, referred_id) VALUES (v_ref, NEW.id) ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

REVOKE EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gen_referral_code() FROM PUBLIC, anon, authenticated;

CREATE TABLE public.email_verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('signup','login','reset','topup')),
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

CREATE TABLE public.admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.admin_sessions TO service_role;
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;

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
CREATE POLICY "Agents can view their own credit" ON public.agent_credit FOR SELECT TO authenticated USING (auth.uid() = agent_id);
CREATE TRIGGER trg_agent_credit_updated BEFORE UPDATE ON public.agent_credit FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

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
CREATE POLICY "Agents can view their own credit log" ON public.credit_orders_log FOR SELECT TO authenticated USING (auth.uid() = agent_id);
CREATE INDEX idx_credit_orders_log_agent ON public.credit_orders_log(agent_id, settled, created_at DESC);

CREATE TABLE public.smm_services (
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
CREATE POLICY "smm_services read active" ON public.smm_services FOR SELECT TO authenticated USING (active = true);
CREATE TRIGGER update_smm_services_updated_at BEFORE UPDATE ON public.smm_services FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX smm_services_platform_idx ON public.smm_services (platform);
CREATE INDEX smm_services_active_idx ON public.smm_services (active);

CREATE TABLE public.smm_orders (
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
  start_count INTEGER,
  remains INTEGER,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.smm_orders TO authenticated;
GRANT ALL ON public.smm_orders TO service_role;
ALTER TABLE public.smm_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smm_orders read own" ON public.smm_orders FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER update_smm_orders_updated_at BEFORE UPDATE ON public.smm_orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX smm_orders_user_idx ON public.smm_orders (user_id, created_at DESC);
CREATE INDEX smm_orders_status_idx ON public.smm_orders (status);

INSERT INTO public.site_settings (key, value) VALUES
  ('admin_password_hash', to_jsonb('15fc36b3e80b9d7f87f7dc90cd7a2845c5d8501c30f03379fcf14154f1680380'::text)),
  ('fee_tiers', '[
    {"upTo":50,"type":"flat","value":2},
    {"upTo":200,"type":"flat","value":4},
    {"upTo":500,"type":"flat","value":7},
    {"upTo":null,"type":"percent","value":2}
  ]'::jsonb),
  ('referral_activation_fee', '50'::jsonb),
  ('referral_reward_per_signup', '10'::jsonb),
  ('site_name', to_jsonb('JONISH-DATA-Hub'::text)),
  ('agent_activation_fee', '100'::jsonb),
  ('agent_withdrawal_min', '150'::jsonb),
  ('smm_global_markup_percent', '30'::jsonb),
  ('smm_xd_to_ghs_rate', '1'::jsonb),
  ('business_open_time', to_jsonb('08:00'::text)),
  ('business_close_time', to_jsonb('22:00'::text)),
  ('business_auto_schedule', to_jsonb(false)),
  ('business_manual_state', to_jsonb('open'::text)),
  ('settlement_reminder_minutes', to_jsonb(60))
ON CONFLICT (key) DO NOTHING;