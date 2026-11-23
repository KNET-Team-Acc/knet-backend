/** Check-in a una sesión, compartido por la app (POST /api/me/checkins) y los tótems NFC. */
import { HttpError } from "./http.js";
import { XP_REWARDS } from "./levels.js";
import { findSession, isRegistered } from "./queries.js";
import { awardXp } from "./xp.js";

/**
 * Registra el check-in de `user` en `sessionCode` dentro de la transacción `c` (+40 XP una vez por sesión).
 * eventId: si se indica, la sesión debe ser de ese evento (404 si no).
 * 404 si la sesión no existe, 403 si no está inscrito, 409 si ya hizo check-in.
 */
export async function recordCheckin(c, user, sessionCode, { method, eventId = null, totemId = null }) {
  const session = await findSession(c, sessionCode, user.industry);
  if (!session || (eventId && session.event_id !== eventId)) throw new HttpError(404, `No existe la sesión ${sessionCode}`);
  if (!(await isRegistered(c, user.id, session.event_id))) {
    throw new HttpError(403, `Inscríbete en el evento ${session.event_id} antes de hacer check-in`);
  }
  const { rows: [checkin] } = await c.query(
    `INSERT INTO checkins (user_id, event_id, session_code, method, totem_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, session_code) DO NOTHING RETURNING *`,
    [user.id, session.event_id, sessionCode, method, totemId]);
  if (!checkin) throw new HttpError(409, `Ya hiciste check-in en ${sessionCode}`);
  const xp = await awardXp(c, user.id, XP_REWARDS.checkin, "checkin", sessionCode);
  return { checkin, session, xp };
}
