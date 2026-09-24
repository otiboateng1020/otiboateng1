
CREATE TABLE IF NOT EXISTS public.admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.admin_sessions TO service_role;
ALTER TABLE public.admin_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own profile" ON public.profiles;
CREATE POLICY "Users read own profile" ON public.profiles
FOR SELECT TO authenticated USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile" ON public.profiles
FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users read own wallet" ON public.wallets;
CREATE POLICY "Users read own wallet" ON public.wallets
FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own transactions" ON public.transactions;
CREATE POLICY "Users read own transactions" ON public.transactions
FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own orders" ON public.orders;
CREATE POLICY "Users read own orders" ON public.orders
FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own payment intents" ON public.payment_intents;
CREATE POLICY "Users read own payment intents" ON public.payment_intents
FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own referrals" ON public.referrals;
CREATE POLICY "Users read own referrals" ON public.referrals
FOR SELECT TO authenticated USING (auth.uid() = referrer_id);

DROP POLICY IF EXISTS "Users read own withdrawals" ON public.withdrawals;
CREATE POLICY "Users read own withdrawals" ON public.withdrawals
FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Anyone can read active data plans" ON public.data_plans;
CREATE POLICY "Anyone can read active data plans" ON public.data_plans
FOR SELECT TO anon, authenticated USING (COALESCE(active, true) = true);

DROP POLICY IF EXISTS "Public read of safe settings" ON public.site_settings;
CREATE POLICY "Public read of safe settings" ON public.site_settings
FOR SELECT TO anon, authenticated
USING (key IN ('referral_activation_fee','referral_reward','withdrawal_min','global_markup','auto_markup'));

GRANT ALL ON public.api_credentials TO service_role;
GRANT ALL ON public.email_verification_codes TO service_role;
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE ON public.profiles TO authenticated;
GRANT SELECT ON public.wallets TO authenticated;
GRANT SELECT ON public.transactions TO authenticated;
GRANT SELECT ON public.orders TO authenticated;
GRANT SELECT ON public.payment_intents TO authenticated;
GRANT SELECT ON public.referrals TO authenticated;
GRANT SELECT ON public.withdrawals TO authenticated;
GRANT SELECT ON public.data_plans TO anon, authenticated;
GRANT SELECT ON public.site_settings TO anon, authenticated;
