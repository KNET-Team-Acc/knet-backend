-- 007_curated.sql · Eventos reales que un admin añade al catálogo desde el panel (sin organizador en KNET)
-- Aditiva: por defecto false, así los eventos existentes (catálogo sembrado y creados en el panel) no cambian.
-- curated = true → el evento es del catálogo (kind 'real' con su web oficial): el frontend arma su agenda como la
-- de los eventos sembrados (no es «hosted»). Tiene owner_id (el admin que lo dio de alta), así db:seed no lo retira.
ALTER TABLE events ADD COLUMN curated boolean NOT NULL DEFAULT false;
