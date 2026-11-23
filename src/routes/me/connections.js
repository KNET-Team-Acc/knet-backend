import { Router } from "express";
import { z } from "zod";
import { pool, query, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo, XP_REWARDS } from "../../lib/levels.js";
import { publish } from "../../lib/events-bus.js";
import { getScopes } from "../../lib/queries.js";
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
