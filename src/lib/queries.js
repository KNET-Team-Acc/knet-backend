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

/* ---------- Contexto para la IA (src/routes/ai.js) ---------- */

/**
 * Perfil que se puede enviar al proveedor del LLM: solo lo cubierto por los permisos concedidos.
 * Nunca incluye correo, id ni foto. «profile» (nombre de pila y cargo) es obligatorio para usar KNET.
 */
export async function aiProfile(db, user) {
  const scopes = await getScopes(db, user.id);
  const p = { nombre: String(user.name || "").split(/\s+/)[0] || "Asistente", cargo: user.role || undefined };
  if (scopes.industry) Object.assign(p, { industria: user.industry, seniority: user.seniority || undefined, empresa: user.company || undefined });
  if (scopes.interests && user.interests?.length) p.intereses = user.interests.slice(0, 8);
  return { profile: p, scopes };
}

/**
 * RAG ligero del Concierge: evento, sesiones del día (variante de la industria del usuario) con su
 * estado de check-in y speakers. eventId por defecto: el primer evento en el que está inscrito.
 */
export async function eventContext(db, user, eventId, day) {
  let id = eventId;
  if (!id) {
    const { rows: [r] } = await db.query(
      "SELECT event_id FROM registrations WHERE user_id = $1 ORDER BY created_at LIMIT 1", [user.id]);
    id = r?.event_id ?? null;
  }
  if (!id) return null;
  const { rows: [ev] } = await db.query(
    `SELECT e.id, e.name, e.city, e.venue_name, e.date_label, count(d.*)::int AS days
       FROM events e LEFT JOIN event_days d ON d.event_id = e.id WHERE e.id = $1 GROUP BY e.id`, [id]);
  if (!ev) return null;
  const d = Math.min(Math.max(0, day ?? 0), Math.max(0, ev.days - 1));
  const sessions = ev.days ? await listSessions(db, ev.id, d, user.industry, user.id) : [];
  const { rows: speakers } = await db.query(
    "SELECT name, role, org, session_label, talk FROM speakers WHERE event_id = $1 ORDER BY id LIMIT 12", [ev.id]);
  return { event: ev, day: d, sessions, speakers };
}
