-- 004_coffees_messages.sql · Conexiones entre asistentes reales, cafés 1:1 y chat directo

-- 1. Una conexión apunta a un contacto del catálogo (contact_id) o a otro usuario real (peer_user_id).
--    Entre usuarios reales hay dos filas espejo, una por cada lado (A→B y B→A).
ALTER TABLE connections
  ALTER COLUMN contact_id DROP NOT NULL,
  ADD COLUMN peer_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  ADD CONSTRAINT connections_target_check CHECK ((contact_id IS NULL) <> (peer_user_id IS NULL)),
  ADD CONSTRAINT connections_not_self CHECK (peer_user_id IS NULL OR peer_user_id <> user_id),
  ADD CONSTRAINT connections_user_peer_key UNIQUE (user_id, peer_user_id);
CREATE INDEX connections_peer_idx ON connections (peer_user_id) WHERE peer_user_id IS NOT NULL;

-- 2. Cafés 1:1. connection_id es la conexión de quien propone. invitee_id es NULL cuando el invitado es
--    un contacto del catálogo (demo): entonces la respuesta la registra quien propone (el frontend la simula).
CREATE TABLE coffees (
  id            bigserial PRIMARY KEY,
  connection_id bigint NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  proposer_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  event_id      text REFERENCES events(id) ON DELETE SET NULL,
  slot          timestamptz NOT NULL,
  place         text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'accepted', 'declined', 'done', 'cancelled')),
  responded_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (invitee_id IS NULL OR invitee_id <> proposer_id)
);
CREATE INDEX coffees_connection_idx ON coffees (connection_id);
CREATE INDEX coffees_proposer_idx ON coffees (proposer_id);
CREATE INDEX coffees_invitee_idx ON coffees (invitee_id) WHERE invitee_id IS NOT NULL;
CREATE TRIGGER coffees_updated_at BEFORE UPDATE ON coffees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Mensajes directos. connection_id es la conexión de quien envía; un hilo entre usuarios reales
--    reúne los mensajes de las dos filas espejo.
CREATE TABLE messages (
  id            bigserial PRIMARY KEY,
  connection_id bigint NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  sender_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX messages_connection_idx ON messages (connection_id, id);

-- 4. Nuevo motivo de XP: café aceptado (+50, ref coffee:<id>)
ALTER TABLE xp_ledger DROP CONSTRAINT xp_ledger_reason_check,
  ADD CONSTRAINT xp_ledger_reason_check CHECK (reason IN ('checkin', 'mission', 'connection', 'coffee', 'manual'));
