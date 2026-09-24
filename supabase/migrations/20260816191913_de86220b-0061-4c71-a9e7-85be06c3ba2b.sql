UPDATE public.data_plans
SET active = false
WHERE updated_at < now() - interval '10 minutes';

DELETE FROM public.agent_plans
WHERE plan_id IN (SELECT id FROM public.data_plans WHERE active = false);