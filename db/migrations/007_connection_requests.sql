-- 007_connection_requests.sql · Solicitudes de conexión entre usuarios reales (knet-backend#24)
-- Aditiva: el código anterior sigue funcionando mientras Vercel y esta migración se despliegan en paralelo
-- (la columna nueva admite NULL y nada la exige).

-- 1. Quién pidió la conexión. Las dos filas espejo (A→B y B→A) guardan el mismo valor, así cada lado sabe si la
--    solicitud es suya (direction "outgoing") o de la otra persona ("incoming"). NULL = contactos del catálogo y
--    conexiones anteriores a esta migración (las de QR nacían ya aceptadas).
ALTER TABLE connections ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE CASCADE;

-- 2. Directorio de asistentes (GET /api/me/attendees): inscritos por evento. La clave primaria de registrations
--    empieza por user_id y no sirve para buscar por evento.
CREATE INDEX registrations_event_idx ON registrations (event_id, user_id);
