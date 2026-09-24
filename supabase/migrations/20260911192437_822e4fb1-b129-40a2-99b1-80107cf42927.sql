ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS data_orders_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS smm_orders_blocked boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.protect_profile_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.id AND NOT public.has_role(auth.uid(), 'admin') THEN
    NEW.is_banned := OLD.is_banned;
    NEW.referral_active := OLD.referral_active;
    NEW.referral_code := OLD.referral_code;
    NEW.referred_by := OLD.referred_by;
    NEW.data_orders_blocked := OLD.data_orders_blocked;
    NEW.smm_orders_blocked := OLD.smm_orders_blocked;
    NEW.id := OLD.id;
  END IF;
  RETURN NEW;
END;
$function$;