import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "../../config.js";
import { pool, query, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo, XP_REWARDS } from "../../lib/levels.js";
import { publish } from "../../lib/events-bus.js";
import { consumeNonce, verifyQrToken } from "../../lib/qr.js";
import { getScopes } from "../../lib/queries.js";
import { denyAdmin } from "../../middleware/roles.js";
import { toConnection } from "../../lib/serialize.js";
import { awardXp } from "../../lib/xp.js";

const router = Router();

const SELECT = `
  SELECT cn.id, cn.status, cn.source, cn.context, cn.event_id, cn.created_at, cn.accepted_at,
         to_jsonb(ct) AS contact,
         CASE WHEN pu.id IS NOT NULL THEN jsonb_build_object(
           'id', pu.id, 'name', pu.name, 'role', pu.role, 'company', pu.company, 'industry', pu.industry) END AS peer
    FROM connections cn
    LEFT JOIN contacts ct ON ct.id = cn.contact_id
    LEFT JOIN users pu ON pu.id = cn.peer_user_id`;

const postSchema = z.object({
  contactId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  // qr: intercambio en persona (queda aceptada); request/match: solicitud pendiente
  source: z.enum(["request", "match", "qr"]).default("request"),
  context: z.string().trim().max(280).optional(),
  eventId: z.string().max(40).optional(),
}).strict().refine((o) => o.contactId || o.name, "Envía contactId o name");

// GET /api/me/connections?status=accepted
router.get("/", async (req, res) => {
  const status = z.enum(["pending", "accepted"]).optional().parse(req.query.status);
  const { rows } = await query(
    `${SELECT} WHERE cn.user_id = $1 AND ($2::text IS NULL OR cn.status = $2) ORDER BY cn.created_at`,
    [req.user.id, status ?? null]);
  res.json({ connections: rows.map(toConnection) });
});

// POST /api/me/connections
router.post("/", async (req, res) => {
  const body = postSchema.parse(req.body ?? {});
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

const scanLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.qr.scanRateLimit,
  keyGenerator: (req) => req.user.id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "rate_limited", message: "Demasiados escaneos: espera un minuto" }),
});

// Crea o reactiva la fila de un lado de la conexión entre usuarios reales
const UPSERT_PEER = `
  INSERT INTO connections (user_id, peer_user_id, status, source, context, event_id, accepted_at)
  VALUES ($1, $2, 'accepted', 'qr', $3, (SELECT id FROM events WHERE id = $4), now())
  ON CONFLICT (user_id, peer_user_id) DO UPDATE
    SET status = 'accepted', accepted_at = COALESCE(connections.accepted_at, now())
  RETURNING id, (xmax = 0) AS created`;

// POST /api/me/connections/scan { token, context? } → escanea el QR dinámico de otro asistente.
// Crea la conexión en ambos sentidos (aceptada) y suma +100 XP a cada uno una sola vez (ref conn:<uuid>).
// 400 invalid_qr / qr_expired / own_qr, 409 qr_used (cada token sirve una vez), 429 si se abusa.
router.post("/scan", denyAdmin(), scanLimiter, async (req, res) => {
  const body = z.object({
    token: z.string().min(1).max(1000),
    context: z.string().trim().max(280).optional(),
  }).strict().parse(req.body ?? {});
  const qr = verifyQrToken(body.token);
  if (qr.userId === req.user.id) throw new HttpError(400, "No puedes escanear tu propio código", "own_qr");

  const result = await tx(async (c) => {
    const { rows: [owner] } = await c.query("SELECT id FROM users WHERE id = $1", [qr.userId]);
    if (!owner) throw new HttpError(400, "El código QR no es válido", "invalid_qr");
    if (!(await getScopes(c, req.user.id)).network) {
      throw new HttpError(403, "Revocaste el permiso «network»: actívalo para sumar contactos");
    }
    if (!(await getScopes(c, owner.id)).network) {
      throw new HttpError(403, "Esta persona no está compartiendo su red", "peer_network_off");
    }
    await consumeNonce(c, qr, req.user.id);
    const context = body.context ?? "";
    const { rows: [mine] } = await c.query(UPSERT_PEER, [req.user.id, owner.id, context, qr.eventId]);
    const { rows: [theirs] } = await c.query(UPSERT_PEER, [owner.id, req.user.id, context, qr.eventId]);
    const xp = await awardXp(c, req.user.id, XP_REWARDS.connection, "connection", `conn:${owner.id}`);
    await awardXp(c, owner.id, XP_REWARDS.connection, "connection", `conn:${req.user.id}`);
    const { rows: [rowMine] } = await c.query(`${SELECT} WHERE cn.id = $1`, [mine.id]);
    const { rows: [rowTheirs] } = await c.query(`${SELECT} WHERE cn.id = $1`, [theirs.id]);
    return { rowMine, rowTheirs, ownerId: owner.id, created: mine.created || theirs.created, xp };
  });

  const connection = toConnection(result.rowMine);
  if (result.created) {
    publish(req.user.id, "connection.accepted", { connection });
    publish(result.ownerId, "connection.accepted", { connection: toConnection(result.rowTheirs) });
  }
  res.status(result.created ? 201 : 200).json({ connection, created: result.created, ...result.xp, ...levelInfo(result.xp.xp) });
});

const idParam = z.coerce.number().int().positive();

// Referencia de XP: id del contacto del catálogo, o conn:<uuid> si es otro usuario real
export const connectionXpRef = (cn) => (cn.contact_id != null ? String(cn.contact_id) : `conn:${cn.peer_user_id}`);

// PATCH /api/me/connections/:id { status: "accepted" } → acepta una solicitud pendiente (+100 XP una sola vez)
router.patch("/:id", async (req, res) => {
  const id = idParam.parse(req.params.id);
  z.object({ status: z.literal("accepted") }).strict().parse(req.body ?? {});
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

// DELETE /api/me/connections/:id → quita la conexión (la XP ya ganada se conserva)
router.delete("/:id", async (req, res) => {
  const id = idParam.parse(req.params.id);
  const { rowCount } = await query("DELETE FROM connections WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  if (!rowCount) throw new HttpError(404, `No existe la conexión ${id}`);
  res.status(204).end();
});

export default router;
