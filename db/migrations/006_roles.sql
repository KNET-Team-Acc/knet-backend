-- 006_roles.sql · Roles de cuenta y eventos creados por organizadores (knet-backend#18)
-- Aditiva: el código anterior sigue funcionando mientras Vercel y esta migración se despliegan en paralelo
-- (los valores por defecto dejan todo lo existente como antes: asistentes y eventos publicados).

-- 1. Rol de la cuenta. users.role ya es el cargo del perfil («CTO», «Analista»…), por eso se llama account_role.
ALTER TABLE users ADD COLUMN account_role text NOT NULL DEFAULT 'attendee'
  CHECK (account_role IN ('attendee', 'organizer', 'admin'));

-- 2. Dueño y estado de cada evento. owner_id NULL = evento del catálogo sembrado (solo lo edita un admin).
ALTER TABLE events
  ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  ADD COLUMN published_at timestamptz;
UPDATE events SET published_at = created_at WHERE status = 'published' AND published_at IS NULL;
CREATE INDEX events_owner_idx ON events (owner_id) WHERE owner_id IS NOT NULL;

-- 3. Ponente de cada charla (texto libre: puede no estar en la lista de speakers)
ALTER TABLE sessions ADD COLUMN speaker text NOT NULL DEFAULT '';

-- 4. Misiones propias de un evento: kind 'event' con event_id (se borran con el evento)
ALTER TABLE missions ADD COLUMN event_id text REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE missions DROP CONSTRAINT missions_kind_check;
ALTER TABLE missions ADD CONSTRAINT missions_kind_check CHECK (kind IN ('industry', 'common', 'group', 'event'));
ALTER TABLE missions ADD CONSTRAINT missions_event_check CHECK ((kind = 'event') = (event_id IS NOT NULL));
CREATE INDEX missions_event_idx ON missions (event_id) WHERE event_id IS NOT NULL;
