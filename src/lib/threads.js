/**
 * Hilos 1:1 sobre una conexión (cafés y mensajes).
 *
 * Una conexión con un contacto del catálogo es una sola fila. Entre dos usuarios reales hay dos filas
 * espejo (A→B y B→A): el hilo reúne ambas y solo existe mientras las dos sigan aceptadas.
 */
import { HttpError } from "./http.js";

/**
 * Conexión `connId` del usuario `userId` lista para cafés o mensajes.
 * 404 si no existe o es de otro usuario (no se revela que existe); 403 not_connected si no está aceptada
 * o, entre usuarios reales, si el otro lado ya la quitó.
 * Devuelve { conn, mirror, peerId, ids } (ids = filas del hilo).
 * lock: bloquea las filas del hilo (las dos espejo, en orden de id para no provocar deadlocks), así
 * dos peticiones simultáneas desde lados opuestos se serializan.
 */
export async function resolveThread(db, userId, connId, { lock = false } = {}) {
  const { rows: [conn] } = await db.query(
    `SELECT id, user_id, contact_id, peer_user_id, status, event_id FROM connections
      WHERE id = $1 AND user_id = $2`, [connId, userId]);
  if (!conn) throw new HttpError(404, `No existe la conexión ${connId}`);
  if (conn.status !== "accepted") throw new HttpError(403, "La conexión aún no está aceptada", "not_connected");
  if (!conn.peer_user_id) {
    if (lock) await db.query("SELECT 1 FROM connections WHERE id = $1 FOR UPDATE", [conn.id]);
    return { conn, mirror: null, peerId: null, ids: [conn.id] };
  }

  const { rows: [mirror] } = await db.query(
    "SELECT id, status FROM connections WHERE user_id = $1 AND peer_user_id = $2",
    [conn.peer_user_id, userId]);
  if (!mirror || mirror.status !== "accepted") {
    throw new HttpError(403, "La otra persona ya no está conectada contigo", "not_connected");
  }
  const ids = [conn.id, mirror.id];
  if (lock) await db.query("SELECT 1 FROM connections WHERE id = ANY($1) ORDER BY id FOR UPDATE", [ids]);
  return { conn, mirror, peerId: conn.peer_user_id, ids };
}
