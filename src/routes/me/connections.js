import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { pool, query, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo, XP_REWARDS } from "../../lib/levels.js";
import { publish } from "../../lib/events-bus.js";
import { CONN_SELECT as SELECT, acceptPeer, checkPeer, fetchConnections, removePendingPeer, requestPeer } from "../../lib/peers.js";
import { consumeNonce, verifyQrToken } from "../../lib/qr.js";
import { getScopes } from "../../lib/queries.js";
import { accountRoleOf, denyAdmin } from "../../middleware/roles.js";
import { toConnection } from "../../lib/serialize.js";
import { awardXp } from "../../lib/xp.js";

const router = Router();

const postSchema = z.object({
  contactId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  // Otro usuario real (directorio del evento): solicitud pendiente hasta que la acepte (knet-backend#24)
  peerUserId: z.string().uuid().optional(),
  // qr: intercambio en persona con un contacto del catálogo (queda aceptada); request/match: solicitud pendiente
  source: z.enum(["request", "match", "qr"]).default("request"),
  context: z.string().trim().max(280).optional(),
  eventId: z.string().max(40).optional(),
}).strict()
  .refine((o) => [o.contactId, o.name, o.peerUserId].filter((x) => x !== undefined).length === 1, "Envía contactId, name o peerUserId")
  .refine((o) => !o.peerUserId || o.source === "request", "Con peerUserId, source debe ser «request»");

const perUser = (limit, message) => rateLimit({
  windowMs: 60_000,
  limit,
  keyGenerator: (req) => req.user.id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "rate_limited", message }),
});
// Solo las solicitudes a usuarios reales: las del catálogo las genera la app y no molestan a nadie
const requestLimiter = perUser(config.connections.requestRateLimit, "Demasiadas solicitudes: espera un minuto");
const peerOnly = (mw) => (req, res, next) => (req.body?.peerUserId ? mw(req, res, next) : next());

/* Publica en el bus (después del commit) las filas espejo de una solicitud entre usuarios reales */
async function publishPair(type, me, peer, mineId, theirsId) {
  const rows = await fetchConnections(pool, [mineId, theirsId]);
  if (rows.get(mineId)) publish(me, type, { connection: toConnection(rows.get(mineId)) });
  if (rows.get(theirsId)) publish(peer, type, { connection: toConnection(rows.get(theirsId)) });
  return rows.get(mineId) ? toConnection(rows.get(mineId)) : null;
}

// GET /api/me/connections?status=accepted
router.get("/", async (req, res) => {
  const status = z.enum(["pending", "accepted"]).optional().parse(req.query.status);
  const { rows } = await query(
    `${SELECT} WHERE cn.user_id = $1 AND ($2::text IS NULL OR cn.status = $2) ORDER BY cn.created_at`,
    [req.user.id, status ?? null]);
  res.json({ connections: rows.map(toConnection) });
});

// POST /api/me/connections
router.post("/", peerOnly(requestLimiter), async (req, res) => {
  const body = postSchema.parse(req.body ?? {});
  if (body.peerUserId) return requestFromDirectory(req, res, body);
  const scopes = await getScopes(pool, req.user.id);
  if (!scopes.network) throw new HttpError(403, "Revocaste el permiso «network»: actívalo para sumar contactos");

  const result = await tx(async (c) => {
    const { rows: [contact] } = body.contactId
      ? await c.query("SELECT id, name FROM contacts WHERE id = $1", [body.contactId])
      : await c.query("SELECT id, name FROM contacts WHERE name = $1", [body.name]);
    if (!contact) throw new HttpError(404, `No existe el contacto ${body.contactId ?? body.name}`);
    if (body.eventId) {
      const { rowCount } = await c.query("SELECT 1 FROM events WHERE id = $1", [body.eventId]);
      if (!rowCount) throw new HttpError(404, `No existe el evento ${body.eventId}`);
    }
    const accepted = body.source === "qr";
    const { rows: [created] } = await c.query(
      `INSERT INTO connections (user_id, contact_id, status, source, context, event_id, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 = 'accepted' THEN now() END)
       ON CONFLICT (user_id, contact_id) DO NOTHING RETURNING id`,
      [req.user.id, contact.id, accepted ? "accepted" : "pending", body.source, body.context ?? "", body.eventId ?? null]);
    if (!created) throw new HttpError(409, `Ya tienes una conexión con ${contact.name}`);
    const xp = accepted
      ? await awardXp(c, req.user.id, XP_REWARDS.connection, "connection", String(contact.id))
      : { xpAwarded: 0, xp: req.user.xp };
    const { rows: [row] } = await c.query(`${SELECT} WHERE cn.id = $1`, [created.id]);
    return { row, xp };
  });

  const connection = toConnection(result.row);
  // Tiempo real: las demás sesiones abiertas del usuario se enteran sin recargar
  publish(req.user.id, connection.status === "accepted" ? "connection.accepted" : "connection.request", { connection });
  res.status(201).json({ connection, ...result.xp, ...levelInfo(result.xp.xp) });
});

/* POST /api/me/connections { peerUserId, eventId?, context? }: solicitud a otro usuario real.
   201 pendiente (sin XP), 409 request_pending / already_connected; si la otra persona ya te la había pedido,
   quedan conectados (200, +100 XP a cada uno). La recibe en vivo por connection.request (direction incoming). */
async function requestFromDirectory(req, res, body) {
  if (accountRoleOf(req.user) === "admin") throw new HttpError(403, "Las cuentas admin no participan como asistentes", "admin_account");
  const me = req.user.id, peer = body.peerUserId;
  const r = await tx(async (c) => {
    await checkPeer(c, me, peer, { eventId: body.eventId ?? null });
    return requestPeer(c, me, peer, { source: "request", context: body.context ?? "", eventId: body.eventId ?? null });
  });
  if (r.outcome === "pending") throw new HttpError(409, "Ya le enviaste una solicitud a esta persona", "request_pending");
  if (r.outcome === "connected") throw new HttpError(409, "Ya están conectados", "already_connected");
  const connection = await publishPair(r.outcome === "accepted" ? "connection.accepted" : "connection.request", me, peer, r.mineId, r.theirsId);
  res.status(r.outcome === "created" ? 201 : 200).json({ connection, ...r.xp, ...levelInfo(r.xp.xp) });
}

const scanLimiter = perUser(config.qr.scanRateLimit, "Demasiados escaneos: espera un minuto");

// POST /api/me/connections/scan { token, context? } → escanea el QR dinámico de otro asistente.
// Crea una solicitud pendiente hacia el dueño del QR (knet-backend#24): +100 XP a cada uno solo cuando la acepte.
// 201 solicitud nueva; 200 si ya estaban conectados, ya se la habías pedido o la otra persona te la había pedido
// (en ese caso quedan conectados con su XP). 400 invalid_qr / qr_expired / own_qr, 409 qr_used, 429 si se abusa.
router.post("/scan", denyAdmin(), scanLimiter, async (req, res) => {
  const body = z.object({
    token: z.string().min(1).max(1000),
    context: z.string().trim().max(280).optional(),
  }).strict().parse(req.body ?? {});
  const qr = verifyQrToken(body.token);
  if (qr.userId === req.user.id) throw new HttpError(400, "No puedes escanear tu propio código", "own_qr");
  const me = req.user.id;

  const result = await tx(async (c) => {
    const { rows: [owner] } = await c.query("SELECT id FROM users WHERE id = $1", [qr.userId]);
    if (!owner) throw new HttpError(400, "El código QR no es válido", "invalid_qr");
    await checkPeer(c, me, owner.id, { inPerson: true }); // en persona: no exige un evento en común
    await consumeNonce(c, qr, me);
    return { ownerId: owner.id, ...(await requestPeer(c, me, owner.id, { source: "qr", context: body.context ?? "", eventId: qr.eventId })) };
  });

  const created = result.outcome === "created";
  const type = result.outcome === "accepted" ? "connection.accepted" : result.outcome === "created" ? "connection.request" : null;
  const connection = type
    ? await publishPair(type, me, result.ownerId, result.mineId, result.theirsId)
    : toConnection((await fetchConnections(pool, [result.mineId])).get(result.mineId));
  res.status(created ? 201 : 200).json({ connection, created, ...result.xp, ...levelInfo(result.xp.xp) });
});

const idParam = z.coerce.number().int().positive();

// Referencia de XP: id del contacto del catálogo, o conn:<uuid> si es otro usuario real
export const connectionXpRef = (cn) => (cn.contact_id != null ? String(cn.contact_id) : `conn:${cn.peer_user_id}`);

// PATCH /api/me/connections/:id { status: "accepted" } → acepta una solicitud pendiente (+100 XP una sola vez).
// Entre usuarios reales solo la acepta quien la recibió (403 not_recipient) y se aceptan las dos filas espejo.
router.patch("/:id", async (req, res) => {
  const id = idParam.parse(req.params.id);
  z.object({ status: z.literal("accepted") }).strict().parse(req.body ?? {});
  const { rows: [own] } = await query("SELECT id, peer_user_id FROM connections WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  if (!own) throw new HttpError(404, `No existe la conexión ${id}`);

  if (own.peer_user_id) {
    const me = req.user.id, peer = own.peer_user_id;
    const r = await tx((c) => acceptPeer(c, me, peer));
    const connection = r.changed
      ? await publishPair("connection.accepted", me, peer, r.mineId, r.theirsId)
      : toConnection((await fetchConnections(pool, [r.mineId])).get(r.mineId));
    return res.json({ connection, ...r.xp, ...levelInfo(r.xp.xp) });
  }

  const result = await tx(async (c) => {
    const { rows: [cn] } = await c.query(
      "SELECT id, contact_id, peer_user_id, status FROM connections WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, req.user.id]);
    if (!cn) throw new HttpError(404, `No existe la conexión ${id}`);
    // Idempotente: aceptar una conexión ya aceptada no falla ni vuelve a sumar XP
    const changed = cn.status === "pending";
    if (changed) {
      await c.query("UPDATE connections SET status = 'accepted', accepted_at = now() WHERE id = $1", [id]);
    }
    const xp = await awardXp(c, req.user.id, XP_REWARDS.connection, "connection", connectionXpRef(cn));
    const { rows: [row] } = await c.query(`${SELECT} WHERE cn.id = $1`, [id]);
    return { row, xp, changed };
  });
  const connection = toConnection(result.row);
  if (result.changed) publish(req.user.id, "connection.accepted", { connection });
  res.json({ connection, ...result.xp, ...levelInfo(result.xp.xp) });
});

// DELETE /api/me/connections/:id → quita la conexión (la XP ya ganada se conserva).
// Una solicitud pendiente entre usuarios reales se rechaza o cancela: se borran las dos filas espejo y las dos
// partes reciben connection.removed { connectionId (el de su fila), peerUserId, reason: declined | cancelled }.
router.delete("/:id", async (req, res) => {
  const id = idParam.parse(req.params.id);
  const { rows: [own] } = await query("SELECT id, peer_user_id, status FROM connections WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  if (!own) throw new HttpError(404, `No existe la conexión ${id}`);

  if (own.peer_user_id && own.status === "pending") {
    const me = req.user.id, peer = own.peer_user_id;
    const r = await tx((c) => removePendingPeer(c, me, peer));
    publish(me, "connection.removed", { connectionId: r.mineId, peerUserId: peer, reason: r.reason });
    if (r.theirsId) publish(peer, "connection.removed", { connectionId: r.theirsId, peerUserId: me, reason: r.reason });
    return res.status(204).end();
  }

  const { rowCount } = await query("DELETE FROM connections WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  if (!rowCount) throw new HttpError(404, `No existe la conexión ${id}`);
  res.status(204).end();
});

export default router;
