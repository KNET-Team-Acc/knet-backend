-- 001_init.sql · Esquema inicial de KNET
-- Requiere PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT). gen_random_uuid() es nativo desde la 13.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ───────────────────────── Catálogo ─────────────────────────

CREATE TABLE industries (
  id          text PRIMARY KEY,                 -- banca, tech, consultoria, energia
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  base_role   text NOT NULL,
  topic       text NOT NULL DEFAULT ''
);

-- ───────────────────────── Usuarios y perfil ─────────────────────────

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL UNIQUE,
  name               text NOT NULL,
  role               text NOT NULL DEFAULT '',
  company            text NOT NULL DEFAULT '',
  industry           text NOT NULL REFERENCES industries(id),
  seniority          text NOT NULL DEFAULT '',
  location           text NOT NULL DEFAULT '',
  interests          text[] NOT NULL DEFAULT '{}',
  avatar             jsonb,
  -- Origen de cada campo, igual que A.profile.src en el frontend: mcp | manual | edited
  field_sources      jsonb NOT NULL DEFAULT '{}'::jsonb,
  linkedin_connected boolean NOT NULL DEFAULT false,
  xp                 integer NOT NULL DEFAULT 0 CHECK (xp >= 0),  -- total en caché de xp_ledger
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Permisos MCP revocables (PERM_SCOPES en src/data/privacy.js)
CREATE TABLE user_scopes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      text NOT NULL CHECK (scope IN ('profile', 'industry', 'interests', 'network')),
  granted    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);

-- ───────────────────────── Consentimientos ─────────────────────────
-- Registro trazable y encadenado por hash (hash = sha256 del registro + prev_hash).
-- Solo se agregan filas; ON DELETE RESTRICT protege el periodo de retención legal.

CREATE TABLE consents (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN
               ('aceptacion', 'autorizacion_linkedin', 'vinculacion', 'revocacion', 'cambio_permiso', 'almacenamiento')),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  client     jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);
CREATE INDEX consents_user_idx ON consents (user_id, id);

CREATE FUNCTION consents_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consents es un registro de solo inserción';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER consents_no_update BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_append_only();

-- ───────────────────────── Eventos y agenda ─────────────────────────

CREATE TABLE events (
  id          text PRIMARY KEY,                -- bog, med, baq, and, x2…x5 (mismos ids que el frontend)
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('real', 'demo', 'exclusive')),
  city        text NOT NULL,
  venue_name  text NOT NULL DEFAULT '',
  date_label  text NOT NULL DEFAULT '',
  lat         double precision,
  lon         double precision,
  tags        text[] NOT NULL DEFAULT '{}',
  industries  text[] NOT NULL DEFAULT '{}',
  min_level   smallint NOT NULL DEFAULT 1 CHECK (min_level BETWEEN 1 AND 5),
  organizer   text,
  source_url  text,
  description text NOT NULL DEFAULT '',
  info        jsonb,                           -- EV_INFO: lema, para, formato, agenda, llevas, colores
  venue       jsonb,                           -- VENUES: recinto 3D (nodos, aristas, zonas)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_days (
  event_id  text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day_index smallint NOT NULL CHECK (day_index >= 0),
  date      date NOT NULL,
  PRIMARY KEY (event_id, day_index)
);

CREATE TABLE speakers (
  id            serial PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT '',
  org           text NOT NULL DEFAULT '',
  session_label text NOT NULL DEFAULT '',
  talk          text NOT NULL DEFAULT '',
  bio           text NOT NULL DEFAULT '',
  tags          text[] NOT NULL DEFAULT '{}',
  avatar        jsonb,
  UNIQUE (event_id, name)
);

-- code = "evento:día:slot", el mismo id que usa el frontend para los check-ins.
-- industry NULL = sesión genérica; con valor = variante por industria (agenda de bog día 1).
CREATE TABLE sessions (
  id         serial PRIMARY KEY,
  code       text NOT NULL,
  event_id   text NOT NULL,
  day_index  smallint NOT NULL,
  slot       smallint NOT NULL CHECK (slot >= 0),
  start_time text NOT NULL CHECK (start_time ~ '^\d{2}:\d{2}$'),
  kind       text NOT NULL,
  title      text NOT NULL,
  room       text NOT NULL DEFAULT '',
  tag        text,
  why        text,
  industry   text REFERENCES industries(id),
  FOREIGN KEY (event_id, day_index) REFERENCES event_days(event_id, day_index) ON DELETE CASCADE,
  CONSTRAINT sessions_code_format CHECK (code = event_id || ':' || day_index || ':' || slot),
  CONSTRAINT sessions_code_industry_key UNIQUE NULLS NOT DISTINCT (code, industry)
);
CREATE INDEX sessions_event_day_idx ON sessions (event_id, day_index, slot);

CREATE TABLE registrations (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);

CREATE TABLE checkins (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_code text NOT NULL,
  method       text NOT NULL DEFAULT 'qr' CHECK (method IN ('qr', 'nfc', 'manual')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_code)
);
CREATE INDEX checkins_user_event_idx ON checkins (user_id, event_id);

-- ───────────────────────── Misiones y XP ─────────────────────────

-- code: "<industria>-m<i>" (IND[*].missions), "c<i>" (COMMON_M), "g<i>" (GROUP_M)
CREATE TABLE missions (
  code       text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('industry', 'common', 'group')),
  industry   text REFERENCES industries(id),
  icon       text NOT NULL DEFAULT '',
  title      text NOT NULL,
  subtitle   text NOT NULL DEFAULT '',
  xp         integer NOT NULL CHECK (xp > 0),
  tags       text[] NOT NULL DEFAULT '{}',
  sort_order smallint NOT NULL DEFAULT 0,
  CHECK ((kind = 'industry') = (industry IS NOT NULL))
);

CREATE TABLE mission_progress (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_code text NOT NULL REFERENCES missions(code) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mission_code)
);

-- Cada XP otorgado deja rastro; UNIQUE evita sumar dos veces lo mismo.
CREATE TABLE xp_ledger (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     integer NOT NULL CHECK (amount <> 0),
  reason     text NOT NULL CHECK (reason IN ('checkin', 'mission', 'connection', 'manual')),
  ref        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, reason, ref)
);

-- ───────────────────────── Red y conexiones ─────────────────────────

-- Personas del Summit con las que se puede conectar (hoy: matches ficticios de la demo)
CREATE TABLE contacts (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  initials     text NOT NULL DEFAULT '',
  headline     text NOT NULL DEFAULT '',
  industry     text REFERENCES industries(id),
  affinity     smallint CHECK (affinity BETWEEN 0 AND 100),
  match_reason text NOT NULL DEFAULT '',
  interests    text[] NOT NULL DEFAULT '{}',
  likes        text[] NOT NULL DEFAULT '{}',
  goal         text NOT NULL DEFAULT '',
  base_xp      integer NOT NULL DEFAULT 0,      -- XP en el ranking del Summit (OTHERS)
  is_demo      boolean NOT NULL DEFAULT true
);

CREATE TABLE connections (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  integer NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  source      text NOT NULL DEFAULT 'request' CHECK (source IN ('request', 'match', 'qr')),
  context     text NOT NULL DEFAULT '',
  event_id    text REFERENCES events(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (user_id, contact_id),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
);

-- ───────────────────────── Dossier post-evento ─────────────────────────

CREATE TABLE dossiers (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  content      jsonb NOT NULL,                  -- ideas, plan de 30 días, notas + resumen calculado
  generated_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id)
);
CREATE TRIGGER dossiers_updated_at BEFORE UPDATE ON dossiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
