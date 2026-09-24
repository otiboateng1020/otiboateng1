-- 1) Withdrawals must be created as pending
DROP POLICY IF EXISTS "own withdrawal insert" ON public.withdrawals;
CREATE POLICY "own withdrawal insert" ON public.withdrawals
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND status = 'pending'::withdrawal_status AND amount > 0);

DROP POLICY IF EXISTS "agent_wd self insert" ON public.agent_withdrawals;
CREATE POLICY "agent_wd self insert" ON public.agent_withdrawals
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = agent_id AND status = 'pending' AND amount > 0);

-- 2) Agents may only self-edit safe profile fields
CREATE OR REPLACE FUNCTION public.protect_agent_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only restrict self-service updates by the signed-in agent.
  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.user_id AND NOT public.has_role(auth.uid(), 'admin') THEN
    NEW.profit_balance := OLD.profit_balance;
    NEW.global_markup_percent := OLD.global_markup_percent;
    NEW.auto_markup := OLD.auto_markup;
    NEW.active := OLD.active;
    NEW.activated_at := OLD.activated_at;
    NEW.user_id := OLD.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_agent_columns ON public.agents;
CREATE TRIGGER trg_protect_agent_columns
BEFORE UPDATE ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.protect_agent_columns();

DROP POLICY IF EXISTS "agents self update" ON public.agents;
CREATE POLICY "agents self update" ON public.agents
FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- 3) Users may not self-edit privileged profile fields
CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.id AND NOT public.has_role(auth.uid(), 'admin') THEN
    NEW.is_banned := OLD.is_banned;
    NEW.referral_active := OLD.referral_active;
    NEW.referral_code := OLD.referral_code;
    NEW.referred_by := OLD.referred_by;
    NEW.id := OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_columns
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.protect_profile_columns();