/**
 * Solicitudes de conexión entre usuarios reales (knet-backend#24).
 *
 * Entre dos usuarios hay dos filas espejo en `connections` (A→B y B→A). Una solicitud crea las dos en
 * `pending` con `requested_by` = quien la pide; aceptarla (solo quien la recibe) pone las dos en `accepted` y
 * suma +100 XP a cada uno una sola vez (ref `conn:<uuid del otro>`, la misma que usaba el QR antes, así los ya
 * conectados no vuelven a sumar). Rechazarla o cancelarla borra las dos.
 *
 * Todas las funciones reciben el client de una tx() y bloquean la pareja con un advisory lock: dos peticiones
 * simultáneas (A pide a B mientras B pide a A, o dos escaneos) se serializan. Publicar en el bus es cosa de la
 * ruta, después del commit.
 */
import { HttpError } from "./http.js";
import { XP_REWARDS } from "./levels.js";
import { getScopes } from "./queries.js";
import { awardXp } from "./xp.js";

/** Conexiones con su contacto del catálogo o la tarjeta del otro usuario (ver toConnection) */
export const CONN_SELECT = `
  SELECT cn.id, cn.user_id, cn.status, cn.source, cn.context, cn.event_id, cn.created_at, cn.accepted_at, cn.requested_by,
         to_jsonb(ct) AS contact,
         CASE WHEN pu.id IS NOT NULL THEN jsonb_build_object(
           'id', pu.id, 'name', pu.name, 'role', pu.role, 'company', pu.company, 'industry', pu.industry, 'graph_role', pu.graph_role,
           -- intereses solo si concedió «interests» (misma regla que el directorio de asistentes)
           'interests', CASE WHEN COALESCE(psi.granted, true) THEN pu.interests ELSE '{}'::text[] END) END AS peer
    FROM connections cn
    LEFT JOIN contacts ct ON ct.id = cn.contact_id
    LEFT JOIN users pu ON pu.id = cn.peer_user_id
    LEFT JOIN user_scopes psi ON psi.user_id = pu.id AND psi.scope = 'interests'`;

const lockPair = (c, a, b) => c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [[a, b].sort().join(":")]);

/** Las dos filas de la pareja: { mine, theirs } (null si no existe) */
async function pairRows(c, me, peer) {
  const { rows } = await c.query(
    `SELECT id, user_id, status, requested_by FROM connections
      WHERE (user_id = $1 AND peer_user_id = $2) OR (user_id = $2 AND peer_user_id = $1) ORDER BY id FOR UPDATE`, [me, peer]);
  return { mine: rows.find((r) => r.user_id === me) || null, theirs: rows.find((r) => r.user_id === peer) || null };
}

export async function fetchConnections(c, ids) {
  const { rows } = await c.query(`${CONN_SELECT} WHERE cn.id = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Acepta las dos filas y suma +100 XP a cada uno (idempotente). Devuelve { mineId, theirsId, xp } */
async function acceptPair(c, me, peer) {
  const { rows } = await c.query(
    `UPDATE connections SET status = 'accepted', accepted_at = COALESCE(accepted_at, now())
      WHERE (user_id = $1 AND peer_user_id = $2) OR (user_id = $2 AND peer_user_id = $1) RETURNING id, user_id`, [me, peer]);
  const xp = await awardXp(c, me, XP_REWARDS.connection, "connection", `conn:${peer}`);
  await awardXp(c, peer, XP_REWARDS.connection, "connection", `conn:${me}`);
  return { mineId: rows.find((r) => r.user_id === me).id, theirsId: rows.find((r) => r.user_id === peer).id, xp };
}

/**
 * Comprueba que `peer` se puede pedir como conexión: existe, no es admin, los dos comparten su red y, fuera del
 * QR (que es en persona), comparten al menos una inscripción (con `eventId`, la de ese evento).
 */
export async function checkPeer(c, me, peerId, { eventId = null, inPerson = false } = {}) {
  if (peerId === me) throw new HttpError(400, "No puedes enviarte una solicitud a ti mismo", "own_request");
  const { rows: [peer] } = await c.query("SELECT id, account_role FROM users WHERE id = $1", [peerId]);
  if (!peer || peer.account_role === "admin") throw new HttpError(404, "No existe ese asistente", "not_found");
  if (!(await getScopes(c, me)).network) throw new HttpError(403, "Revocaste el permiso «network»: actívalo para sumar contactos", "network_off");
  if (!(await getScopes(c, peerId)).network) throw new HttpError(403, "Esta persona no está compartiendo su red", "peer_network_off");
  if (inPerson) return;
  const { rowCount } = await c.query(
    `SELECT 1 FROM registrations a JOIN registrations b ON b.event_id = a.event_id AND b.user_id = $2
      WHERE a.user_id = $1 AND ($3::text IS NULL OR a.event_id = $3) LIMIT 1`, [me, peerId, eventId]);
  if (!rowCount) throw new HttpError(403, eventId ? "Los dos deben estar inscritos en ese evento" : "Solo puedes conectar con asistentes de tus eventos", "no_shared_event");
}

/**
 * Solicitud de `me` a `peer`. Según el estado de la pareja:
 *  - sin conexión (o a medias porque alguien la quitó): crea/reinicia las dos filas en pending → outcome "created"
 *  - ya pendiente y pedida por `me` → "pending";  ya aceptada por los dos → "connected"
 *  - pendiente y pedida por `peer` (los dos lo quieren) → se aceptan → "accepted" (con XP)
 * Devuelve { outcome, mineId, theirsId, xp } (xp = { xpAwarded, xp } de `me`).
 */
export async function requestPeer(c, me, peer, { source = "request", context = "", eventId = null } = {}) {
  await lockPair(c, me, peer);
  const { mine, theirs } = await pairRows(c, me, peer);
  const noXp = async () => ({ xpAwarded: 0, xp: (await c.query("SELECT xp FROM users WHERE id = $1", [me])).rows[0].xp });
  if (mine?.status === "accepted" && theirs?.status === "accepted") return { outcome: "connected", mineId: mine.id, theirsId: theirs.id, xp: await noXp() };
  if (mine?.status === "pending" && theirs?.status === "pending") {
    if (mine.requested_by === peer) return { outcome: "accepted", ...(await acceptPair(c, me, peer)) };
    return { outcome: "pending", mineId: mine.id, theirsId: theirs.id, xp: await noXp() };
  }
  const UPSERT = `
    INSERT INTO connections (user_id, peer_user_id, status, source, context, event_id, requested_by)
    VALUES ($1, $2, 'pending', $3, $4, (SELECT id FROM events WHERE id = $5), $6)
    ON CONFLICT (user_id, peer_user_id) DO UPDATE
      SET status = 'pending', accepted_at = NULL, source = EXCLUDED.source, context = EXCLUDED.context,
          event_id = EXCLUDED.event_id, requested_by = EXCLUDED.requested_by, created_at = now()
    RETURNING id`;
  const { rows: [m] } = await c.query(UPSERT, [me, peer, source, context, eventId, me]);
  const { rows: [t] } = await c.query(UPSERT, [peer, me, source, context, eventId, me]);
  return { outcome: "created", mineId: m.id, theirsId: t.id, xp: await noXp() };
}

/** Acepta la solicitud que `peer` envió a `me`. 403 not_recipient si la pidió `me`. */
export async function acceptPeer(c, me, peer) {
  await lockPair(c, me, peer);
  const { mine, theirs } = await pairRows(c, me, peer);
  if (!mine) throw new HttpError(404, "No existe la conexión");
  if (mine.status === "accepted" && theirs?.status === "accepted") return { changed: false, ...(await acceptPair(c, me, peer)) };
  if (!theirs) throw new HttpError(404, "La otra persona ya retiró la solicitud");
  if (mine.requested_by === me) throw new HttpError(403, "Solo puede aceptarla la persona que recibió la solicitud", "not_recipient");
  return { changed: true, ...(await acceptPair(c, me, peer)) };
}

/** Rechaza (si la pidió `peer`) o cancela (si la pidió `me`) una solicitud pendiente: borra las dos filas */
export async function removePendingPeer(c, me, peer) {
  await lockPair(c, me, peer);
  const { mine, theirs } = await pairRows(c, me, peer);
  if (!mine) throw new HttpError(404, "No existe la conexión");
  await c.query("DELETE FROM connections WHERE id = ANY($1)", [[mine.id, theirs?.id].filter(Boolean)]);
  return { mineId: mine.id, theirsId: theirs?.id ?? null, reason: mine.requested_by === me ? "cancelled" : "declined" };
}
