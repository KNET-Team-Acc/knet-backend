import { Router } from "express";
import { z } from "zod";
import { pool, query, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo, XP_REWARDS } from "../../lib/levels.js";
import { getScopes } from "../../lib/queries.js";
import { toConnection } from "../../lib/serialize.js";
import { awardXp } from "../../lib/xp.js";

const router = Router();

const SELECT = `
  SELECT cn.id, cn.status, cn.source, cn.context, cn.event_id, cn.created_at, cn.accepted_at, to_jsonb(ct) AS contact
    FROM connections cn JOIN contacts ct ON ct.id = cn.contact_id`;

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

  res.status(201).json({ connection: toConnection(result.row), ...result.xp, ...levelInfo(result.xp.xp) });
});

export default router;
