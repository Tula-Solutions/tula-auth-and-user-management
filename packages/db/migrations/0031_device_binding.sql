ALTER TABLE "tula"."sessions" ADD COLUMN "device_thumbprint" text;--> statement-breakpoint
ALTER TABLE "tula"."sessions" ADD CONSTRAINT "sessions_device_thumbprint_shape" CHECK ("tula"."sessions"."device_thumbprint" is null or ("tula"."sessions"."type" = 'hybrid' and "tula"."sessions"."device_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'));--> statement-breakpoint
-- Added by hand (Drizzle declares no triggers).
--
-- DEVICE BINDING (ADR 0043). `sessions.device_thumbprint` is the thumbprint of the key a
-- session was bound to when its sign-in started; a refresh of such a session needs a proof
-- signed by that key. Existing sessions get NULL: they are not bound, and behave as before.
--
-- The thumbprint is written when the session is created and never again. A session that
-- could be bound later, moved to another key or unbound would let whoever can write the row
-- (or holds a copied refresh token on a path that forgot the check) take the binding off.
-- The runtime role has UPDATE on the whole table (0003) and a column cannot be taken out of a
-- table-level grant, so the rule is a trigger: it refuses every UPDATE that would change the
-- column, whichever role sends it. It runs with the rights of whoever updates and reads
-- nothing but the row.
CREATE FUNCTION "tula"."sessions_device_thumbprint_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."device_thumbprint" IS DISTINCT FROM OLD."device_thumbprint" THEN
    RAISE EXCEPTION 'sessions.device_thumbprint is fixed when the session is created'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sessions_device_thumbprint_immutable"
  BEFORE UPDATE OF "device_thumbprint" ON "tula"."sessions"
  FOR EACH ROW EXECUTE FUNCTION "tula"."sessions_device_thumbprint_immutable"();
