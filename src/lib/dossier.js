/**
 * Dossier post-evento: resumen calculado con la actividad real del usuario (check-ins, conexiones
 * aceptadas, misiones y XP) y guardado en `dossiers`. Lo usan POST /api/me/dossiers/:eventId (texto
 * redactado por el frontend) y POST /api/ai/dossier (texto redactado por el LLM).
 */
import { HttpError } from "./http.js";
import { levelInfo } from "./levels.js";
import { isRegistered, listCheckins } from "./queries.js";

/** Evento + resumen numérico. Lanza 404 si el evento no existe y 403 si el usuario no está inscrito. */
export async function dossierSummary(db, user, eventId) {
  const { rows: [ev] } = await db.query("SELECT id, name, city FROM events WHERE id = $1", [eventId]);
  if (!ev) throw new HttpError(404, `No existe el evento ${eventId}`);
  if (!(await isRegistered(db, user.id, ev.id))) throw new HttpError(403, `No estás inscrito en ${ev.id}`);

  const checkins = await listCheckins(db, user.id, user.industry, ev.id);
  const { rows: contacts } = await db.query(
    `SELECT ct.name, ct.headline, cn.context FROM connections cn JOIN contacts ct ON ct.id = cn.contact_id
      WHERE cn.user_id = $1 AND cn.status = 'accepted' AND (cn.event_id IS NULL OR cn.event_id = $2)
      ORDER BY cn.accepted_at`, [user.id, ev.id]);
  const { rows: [{ missions, xp }] } = await db.query(
    `SELECT (SELECT count(*) FROM mission_progress WHERE user_id = $1)::int AS missions,
            (SELECT xp FROM users WHERE id = $1) AS xp`, [user.id]);

  return {
    event: ev,
    sessionsAttended: checkins.map((k) => ({ code: k.sessionCode, title: k.session?.title ?? null, at: k.createdAt })),
    contacts,
    missionsCompleted: missions,
    xp,
    ...levelInfo(xp),
  };
}

/** Inserta o regenera el dossier (UNIQUE user_id + event_id). Devuelve { row, created }. */
export async function saveDossier(db, userId, eventId, content) {
  const { rows: [d] } = await db.query(
    `INSERT INTO dossiers (user_id, event_id, content) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, event_id) DO UPDATE SET content = EXCLUDED.content, generated_at = now()
     RETURNING *, (xmax = 0) AS inserted`, [userId, eventId, content]);
  return { row: d, created: d.inserted };
}
