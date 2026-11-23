-- 005_qr_nfc.sql · QR dinámico entre asistentes y check-in NFC desde tótems

-- 1. Anti-replay: cada token QR (su nonce) se usa una sola vez. Se purgan al caducar.
CREATE TABLE qr_nonces (
  nonce      text PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,  -- dueño del token
  used_by    uuid REFERENCES users(id) ON DELETE CASCADE,  -- quien lo escaneó (NULL: un tótem)
  expires_at timestamptz NOT NULL,
  used_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qr_nonces_expires_idx ON qr_nonces (expires_at);

-- 2. checkins.method ya admite 'nfc' (001). Se guarda qué tótem registró el check-in.
ALTER TABLE checkins ADD COLUMN totem_id text;
