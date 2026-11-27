/**
 * Directorio de asistentes de un evento (knet-backend#24).
 *
 * GET /api/me/attendees?eventId=<id>&limit=50&offset=0 → { eventId, attendees: [...], total }
 * Solo para quien está inscrito al evento y comparte su red. Lista a los demás inscritos que comparten la suya
 * (sin fila en user_scopes = concedido, como getScopes), sin uno mismo ni cuentas admin. Cada asistente es su
 * tarjeta pública (sin correo) con los intereses solo si concedió «interests», y el estado de la conexión con
 * quien consulta ({ id, status, direction } o null). Orden: intereses en común, luego nombre.
 * 403 not_registered (no inscrito o el evento no existe), 403 network_off, 403 admin_account.
 */
import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { getScopes, isRegistered } from "../../lib/queries.js";
import { toAttendee } from "../../lib/serialize.js";
import { denyAdmin } from "../../middleware/roles.js";

const router = Router();

const querySchema = z.object({
  eventId: z.string().trim().min(1).max(40),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

// Inscritos al evento $1 que comparten su red, menos quien consulta ($2) y las cuentas admin
const FROM = `
    FROM registrations r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN user_scopes sn ON sn.user_id = u.id AND sn.scope = 'network'
    LEFT JOIN user_scopes si ON si.user_id = u.id AND si.scope = 'interests'
   WHERE r.event_id = $1 AND u.id <> $2 AND u.account_role <> 'admin' AND COALESCE(sn.granted, true)`;

router.get("/", denyAdmin(), async (req, res) => {
  const q = querySchema.parse(req.query);
  const me = req.user.id;
  if (!(await getScopes(pool, me)).network) {
    throw new HttpError(403, "Revocaste el permiso «network»: actívalo para ver a los asistentes", "network_off");
  }
  if (!(await isRegistered(pool, me, q.eventId))) throw new HttpError(403, "No estás inscrito en este evento", "not_registered");

  const mine = (req.user.interests || []).map((x) => String(x).toLowerCase());
  const [{ rows: [{ total }] }, { rows }] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${FROM}`, [q.eventId, me]),
    pool.query(
      `SELECT t.*, cn.id AS conn_id, cn.status AS conn_status, cn.requested_by
         FROM (SELECT u.id, u.name, u.role, u.company, u.industry, u.graph_role,
                      CASE WHEN COALESCE(si.granted, true) THEN u.interests ELSE '{}'::text[] END AS interests
                 ${FROM}) t
         LEFT JOIN connections cn ON cn.user_id = $2 AND cn.peer_user_id = t.id
        ORDER BY (SELECT count(*) FROM unnest(t.interests) x WHERE lower(x) = ANY($3::text[])) DESC, lower(t.name), t.id
        LIMIT $4 OFFSET $5`,
      [q.eventId, me, mine, q.limit, q.offset]),
  ]);
  res.json({ eventId: q.eventId, attendees: rows.map((r) => toAttendee(r, me)), total });
});

export default router;
