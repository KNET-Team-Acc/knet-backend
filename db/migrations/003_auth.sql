-- 003_auth.sql · Cuentas reales: contraseña, LinkedIn (OpenID Connect), versión legal y sesiones
-- Los usuarios demo no tienen contraseña ni LinkedIn: solo se usan con X-User-Id en desarrollo.

-- 1. Credenciales y estado legal del usuario
ALTER TABLE users
  ADD COLUMN password_hash     text,                -- bcrypt; NULL = sin contraseña (demo o solo LinkedIn)
  ADD COLUMN linkedin_sub      text UNIQUE,         -- "sub" del ID token de LinkedIn; NULL = sin vincular
  ADD COLUMN legal_version     text,                -- versión de Términos/Política aceptada (LEGAL.version del front)
  ADD COLUMN email_verified_at timestamptz,         -- hoy solo lo confirma LinkedIn (email_verified)
  ADD COLUMN photo_url         text;                -- foto de LinkedIn (scope basic); el avatar del Summit va en avatar

-- El correo se compara sin mayúsculas: dos cuentas no pueden diferir solo en eso
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- 2. Refresh tokens rotatorios. Se guarda solo el SHA-256 del token. family agrupa una cadena de
--    rotaciones: si se reutiliza un token ya rotado, se revoca toda la familia (posible robo).
CREATE TABLE refresh_tokens (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  family      uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family);

-- 3. Estado anti-CSRF del flujo OAuth de LinkedIn (un solo uso, caduca en minutos).
--    scopes = campos que el usuario autorizó en la pantalla de permiso (LI_FIELDS del front).
CREATE TABLE oauth_states (
  state         text PRIMARY KEY,
  scopes        text[] NOT NULL DEFAULT '{}',
  legal_version text,
  return_to     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 4. Código de un solo uso con el que el frontend canjea la sesión tras volver de LinkedIn
--    (así los tokens no viajan en la URL). Se guarda el SHA-256 del código.
CREATE TABLE auth_handoffs (
  code_hash   text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created     boolean NOT NULL DEFAULT false,     -- true = la cuenta se creó en este login
  scopes      text[] NOT NULL DEFAULT '{}',
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
