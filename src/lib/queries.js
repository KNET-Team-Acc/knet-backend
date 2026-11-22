/**
 * Consultas compartidas entre rutas. `db` puede ser el pool o el client de una transacción.
 *
 * Sesiones con variante: para un mismo code puede haber una fila genérica (industry NULL) y
 * filas por industria. Siempre se elige la de la industria del usuario y, si no hay, la genérica.
 */
import { toCheckin, toSession } from "./serialize.js";

export const SCOPES = ["profile", "industry", "interests", "network"];

export async function getScopes(db, userId) {
  const { rows } = await db.query("SELECT scope, granted FROM user_scopes WHERE user_id = $1", [userId]);
  const scopes = Object.fromEntries(SCOPES.map((s) => [s, true]));
  for (const r of rows) scopes[r.scope] = r.granted;
  return scopes;
}

export async function isRegistered(db, userId, eventId) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM registrations WHERE user_id = $1 AND event_id = $2", [userId, eventId]);
  return rowCount > 0;
}

export async function findSession(db, code, industry) {
  const { rows } = await db.query(
    `SELECT * FROM sessions WHERE code = $1 AND (industry IS NULL OR industry = $2)
     ORDER BY industry NULLS LAST LIMIT 1`, [code, industry]);
  return rows[0] || null;
}

export async function listSessions(db, eventId, day, industry, userId) {
  const { rows } = await db.query(
    `SELECT t.*, (c.id IS NOT NULL) AS checked_in
       FROM (SELECT DISTINCT ON (s.code) s.* FROM sessions s
              WHERE s.event_id = $1 AND s.day_index = $2 AND (s.industry IS NULL OR s.industry = $3)
              ORDER BY s.code, s.industry NULLS LAST) t
       LEFT JOIN checkins c ON c.session_code = t.code AND c.user_id = $4
      ORDER BY t.slot`, [eventId, day, industry, userId]);
  return rows.map(toSession);
}

export async function listCheckins(db, userId, industry, eventId = null) {
  const { rows } = await db.query(
    `SELECT c.id, c.session_code, c.event_id, c.method, c.created_at,
            s.title, s.start_time, s.room, s.kind, s.day_index
       FROM checkins c
       LEFT JOIN LATERAL (
         SELECT title, start_time, room, kind, day_index FROM sessions s
          WHERE s.code = c.session_code AND (s.industry IS NULL OR s.industry = $2)
          ORDER BY s.industry NULLS LAST LIMIT 1) s ON true
      WHERE c.user_id = $1 AND ($3::text IS NULL OR c.event_id = $3)
      ORDER BY c.created_at`, [userId, industry, eventId]);
  return rows.map(toCheckin);
}
