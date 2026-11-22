-- ───────────────────── Supresión de usuarios (DELETE /api/me) ─────────────────────
-- Borrar un usuario borra su perfil y progreso (ON DELETE CASCADE en las demás tablas), pero su
-- registro de consentimientos se conserva como prueba durante el periodo de retención legal
-- (Ley 1581, art. 17): queda desvinculado (user_id = NULL), no anonimizado; subject_id guarda el
-- UUID del titular para poder seguir verificando la cadena de hashes.

-- 1. subject_id: UUID del titular sin llave foránea; sobrevive al borrado y entra en el hash
ALTER TABLE consents ADD COLUMN subject_id uuid;
ALTER TABLE consents DISABLE TRIGGER consents_no_update;  -- solo para rellenar la columna nueva
UPDATE consents SET subject_id = user_id;
ALTER TABLE consents ENABLE TRIGGER consents_no_update;
ALTER TABLE consents ALTER COLUMN subject_id SET NOT NULL;
CREATE INDEX consents_subject_idx ON consents (subject_id, id);

-- 2. Borrar el usuario desvincula sus consentimientos en lugar de bloquear el borrado
ALTER TABLE consents ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE consents DROP CONSTRAINT consents_user_id_fkey,
  ADD CONSTRAINT consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- 3. Nuevo tipo de evento: constancia de la supresión
ALTER TABLE consents DROP CONSTRAINT consents_event_type_check,
  ADD CONSTRAINT consents_event_type_check CHECK (event_type IN
    ('aceptacion', 'autorizacion_linkedin', 'vinculacion', 'revocacion', 'cambio_permiso', 'almacenamiento', 'supresion'));

-- 4. El trigger sigue bloqueando DELETE y todo UPDATE, salvo pasar user_id a NULL sin tocar nada más
--    (es lo que hace ON DELETE SET NULL al borrar el usuario)
CREATE OR REPLACE FUNCTION consents_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
     AND (NEW.id, NEW.subject_id, NEW.event_type, NEW.payload, NEW.client, NEW.prev_hash, NEW.hash, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.subject_id, OLD.event_type, OLD.payload, OLD.client, OLD.prev_hash, OLD.hash, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'consents es un registro de solo inserción';
END;
$$ LANGUAGE plpgsql;
