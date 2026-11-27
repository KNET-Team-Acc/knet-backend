-- 008_graph_role.sql · Rol «Soy» del grafo de red y conexiones de 2.º grado (knet-backend#30)
-- Aditiva: el código anterior sigue funcionando mientras Vercel y esta migración se despliegan en paralelo
-- (la columna nueva admite NULL y nada la exige).

-- 1. Rol con el que la persona se presenta en el grafo de su red («Soy»). NULL = sin elegir: el frontend lo
--    deduce de la industria. Los ids son los de la API; el frontend los traduce a los suyos (cliente, experto…).
ALTER TABLE users ADD COLUMN graph_role text
  CHECK (graph_role IN ('client', 'expert', 'speaker', 'partner'));

-- 2. GET /api/me/network recorre connections por (user_id, status) en los dos saltos. connections_peer_idx
--    (peer_user_id) ya existe desde 004; IF NOT EXISTS lo deja como está.
CREATE INDEX IF NOT EXISTS connections_user_status_idx ON connections (user_id, status);
CREATE INDEX IF NOT EXISTS connections_peer_idx ON connections (peer_user_id);
