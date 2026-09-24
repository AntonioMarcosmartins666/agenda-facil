-- Compatibility aliases for the current React frontend.
-- Existing owner_id duplicates are intentional/retained; no unique index is added.

BEGIN;

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS whatsapp text;

UPDATE public.businesses
SET user_id = owner_id
WHERE user_id IS NULL;

UPDATE public.businesses
SET whatsapp = phone
WHERE whatsapp IS NULL;

ALTER TABLE public.businesses
  ALTER COLUMN user_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_business_app_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.owner_id := COALESCE(NEW.owner_id, NEW.user_id, (SELECT auth.uid()));
    NEW.user_id := COALESCE(NEW.user_id, NEW.owner_id);
    NEW.phone := COALESCE(NEW.phone, NEW.whatsapp, '');
    NEW.whatsapp := COALESCE(NEW.whatsapp, NEW.phone);
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      NEW.owner_id := NEW.user_id;
    ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
      NEW.user_id := NEW.owner_id;
    END IF;

    IF NEW.whatsapp IS DISTINCT FROM OLD.whatsapp THEN
      NEW.phone := COALESCE(NEW.whatsapp, '');
    ELSIF NEW.phone IS DISTINCT FROM OLD.phone THEN
      NEW.whatsapp := NEW.phone;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_business_app_columns ON public.businesses;
CREATE TRIGGER sync_business_app_columns
  BEFORE INSERT OR UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.sync_business_app_columns();

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS duration_minutes integer;

UPDATE public.services
SET duration_minutes = duration
WHERE duration_minutes IS NULL;

ALTER TABLE public.services
  ALTER COLUMN duration_minutes SET NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_service_duration_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.duration_minutes := COALESCE(NEW.duration_minutes, NEW.duration, 60);
    NEW.duration := NEW.duration_minutes;
  ELSIF NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes THEN
    NEW.duration := NEW.duration_minutes;
  ELSIF NEW.duration IS DISTINCT FROM OLD.duration THEN
    NEW.duration_minutes := NEW.duration;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_service_duration_columns ON public.services;
CREATE TRIGGER sync_service_duration_columns
  BEFORE INSERT OR UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.sync_service_duration_columns();

NOTIFY pgrst, 'reload schema';

COMMIT;
