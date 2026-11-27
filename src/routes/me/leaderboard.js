/**
 * Ranking de asistentes de un evento (pestaña Misiones).
 *
 * GET /api/me/leaderboard?eventId=<id>&scope=event|connections&limit=50
 *   → { eventId, scope, entries: [{ pos, userId, name, initials, xp, level, me }], me: { pos, xp, level }, total }
 * XP global del usuario (users.xp), no solo la ganada en ese evento. Mismas reglas de privacidad que el directorio
 * (GET /api/me/attendees): solo inscritos al evento que comparten su red (permiso «network»; sin fila = concedido),
 * sin cuentas admin. Quien consulta siempre aparece (aunque quede fuera del top `limit`).
 * scope=connections: solo tú y tus conexiones aceptadas con usuarios reales inscritas al mismo evento.
 * pos = RANK() por XP (empates comparten posición). total = participantes del ranking, incluido quien consulta.
 * 403 not_registered (no inscrito o el evento no existe), 403 network_off, 403 admin_account.
 */
import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo } from "../../lib/levels.js";
import { getScopes, isRegistered } from "../../lib/queries.js";
import { initialsOf } from "../../lib/serialize.js";
import { denyAdmin } from "../../middleware/roles.js";

const router = Router();

const querySchema = z.object({
  eventId: z.string().trim().min(1).max(40),
  scope: z.enum(["event", "connections"]).default("event"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// $1 evento, $2 quien consulta, $3 scope, $4 límite del top
const SQL = `
  WITH board AS (
    SELECT u.id, u.name, u.xp,
           RANK() OVER (ORDER BY u.xp DESC) AS pos,
           ROW_NUMBER() OVER (ORDER BY u.xp DESC, lower(u.name), u.id) AS rn,
           count(*) OVER () AS total
      FROM registrations r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN user_scopes sn ON sn.user_id = u.id AND sn.scope = 'network'
     WHERE r.event_id = $1 AND u.account_role <> 'admin'
       AND (u.id = $2 OR (COALESCE(sn.granted, true) AND ($3 = 'event' OR EXISTS (
             SELECT 1 FROM connections cn
              WHERE cn.user_id = $2 AND cn.peer_user_id = u.id AND cn.status = 'accepted'))))
  )
  SELECT id, name, xp, pos::int, total::int FROM board WHERE rn <= $4 OR id = $2 ORDER BY rn`;

router.get("/", denyAdmin(), async (req, res) => {
  const q = querySchema.parse(req.query);
  const me = req.user.id;
  if (!(await getScopes(pool, me)).network) {
    throw new HttpError(403, "Revocaste el permiso «network»: actívalo para ver el ranking", "network_off");
  }
  if (!(await isRegistered(pool, me, q.eventId))) throw new HttpError(403, "No estás inscrito en este evento", "not_registered");

  const { rows } = await pool.query(SQL, [q.eventId, me, q.scope, q.limit]);
  const entries = rows.map((r) => ({
    pos: r.pos,
    userId: r.id,
    name: r.name,
    initials: initialsOf(r.name),
    xp: r.xp,
    level: levelInfo(r.xp).level,
    me: r.id === me,
  }));
  const mine = entries.find((e) => e.me);
  res.json({
    eventId: q.eventId,
    scope: q.scope,
    entries,
    me: mine ? { pos: mine.pos, xp: mine.xp, level: mine.level } : null,
    total: rows[0]?.total ?? 0,
  });
});

export default router;
