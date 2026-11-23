/**
 * Cafés 1:1 entre conexiones aceptadas.
 *  - Propone quien tiene la conexión; acepta o rechaza el invitado. Con un contacto del catálogo (demo,
 *    sin cuenta) no hay invitado real: la respuesta la registra quien propone (el frontend la simula).
 *  - Aceptar suma +50 XP a cada participante con cuenta, una sola vez (ref coffee:<id>).
 *  - Transiciones: proposed → accepted | declined | cancelled; accepted → done | cancelled.
 */
import { Router } from "express";
import { z } from "zod";
import { pool, tx } from "../../db.js";
import { publish } from "../../lib/events-bus.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo, XP_REWARDS } from "../../lib/levels.js";
import { toCoffee } from "../../lib/serialize.js";
import { resolveThread } from "../../lib/threads.js";
import { awardXp } from "../../lib/xp.js";

const router = Router();

// Café visto por $1: su rol, su conexión (la espejo si es el invitado) y con quién es
const SELECT = `
  SELECT cf.*,
         CASE WHEN cf.proposer_id = $1 THEN 'proposer' ELSE 'invitee' END AS role,
         CASE WHEN cf.proposer_id = $1 THEN cf.connection_id
              ELSE (SELECT m.id FROM connections m WHERE m.user_id = $1 AND m.peer_user_id = cf.proposer_id) END
           AS connection_id,
         CASE WHEN cf.proposer_id = $1 THEN COALESCE(ct.name, iu.name) ELSE pu.name END AS with_name,
         CASE WHEN cf.proposer_id = $1 THEN cf.invitee_id ELSE cf.proposer_id END AS with_user_id
    FROM coffees cf
    JOIN connections cn ON cn.id = cf.connection_id
    LEFT JOIN contacts ct ON ct.id = cn.contact_id
    LEFT JOIN users iu ON iu.id = cf.invitee_id
    JOIN users pu ON pu.id = cf.proposer_id`;

const STATUSES = ["proposed", "accepted", "declined", "done", "cancelled"];
const ACTIVE = ["proposed", "accepted"];

const postSchema = z.object({
  connectionId: z.number().int().positive(),
  slot: z.coerce.date().refine((d) => d.getTime() > Date.now(), "El horario debe ser futuro"),
  place: z.string().trim().max(120).default(""),
  eventId: z.string().max(40).optional(),
}).strict();

const patchSchema = z.object({ status: z.enum(["accepted", "declined", "done", "cancelled"]) }).strict();

// Desde qué estados y quién puede llevar el café a cada estado
const TRANSITIONS = {
  accepted: { from: ["proposed"], by: "invitee" },
  declined: { from: ["proposed"], by: "invitee" },
  done: { from: ["accepted"], by: "any" },
  cancelled: { from: ["proposed", "accepted"], by: "any" },
};

async function loadCoffee(db, userId, id) {
  const { rows: [row] } = await db.query(`${SELECT} WHERE cf.id = $2`, [userId, id]);
  return row;
}

/** Avisa en tiempo real a los participantes con cuenta (también a las otras sesiones de quien actúa) */
function notify(row) {
  for (const uid of [row.proposer_id, row.invitee_id].filter(Boolean)) {
    publish(uid, "coffee.updated", { coffeeId: row.id, status: row.status });
  }
}

// GET /api/me/coffees?status=proposed → cafés donde participo (como quien propone o como invitado)
router.get("/", async (req, res) => {
  const status = z.enum(STATUSES).optional().parse(req.query.status);
  const { rows } = await pool.query(
    `${SELECT} WHERE (cf.proposer_id = $1 OR cf.invitee_id = $1) AND ($2::text IS NULL OR cf.status = $2)
      ORDER BY cf.slot, cf.id`, [req.user.id, status ?? null]);
  res.json({ coffees: rows.map(toCoffee) });
});

// POST /api/me/coffees { connectionId, slot, place?, eventId? } → propone un café (solo con conexión aceptada)
router.post("/", async (req, res) => {
  const body = postSchema.parse(req.body ?? {});
  const row = await tx(async (c) => {
    const { conn, peerId, ids } = await resolveThread(c, req.user.id, body.connectionId, { lock: true });
    if (body.eventId) {
      const { rowCount } = await c.query("SELECT 1 FROM events WHERE id = $1", [body.eventId]);
      if (!rowCount) throw new HttpError(404, `No existe el evento ${body.eventId}`);
    }
    // Un solo café activo por pareja (lo haya propuesto cualquiera de los dos)
    const { rowCount: active } = await c.query(
      "SELECT 1 FROM coffees WHERE connection_id = ANY($1) AND status = ANY($2)", [ids, ACTIVE]);
    if (active) throw new HttpError(409, "Ya hay un café pendiente o confirmado con esta persona", "coffee_active");
    const { rows: [created] } = await c.query(
      `INSERT INTO coffees (connection_id, proposer_id, invitee_id, event_id, slot, place)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [conn.id, req.user.id, peerId, body.eventId ?? conn.event_id ?? null, body.slot, body.place]);
    return loadCoffee(c, req.user.id, created.id);
  });
  notify(row);
  res.status(201).json({ coffee: toCoffee(row) });
});

// PATCH /api/me/coffees/:id { status } → aceptar, rechazar, completar o cancelar
router.patch("/:id", async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const { status } = patchSchema.parse(req.body ?? {});
  const result = await tx(async (c) => {
    const { rows: [cf] } = await c.query(
      "SELECT * FROM coffees WHERE id = $1 AND (proposer_id = $2 OR invitee_id = $2) FOR UPDATE", [id, req.user.id]);
    if (!cf) throw new HttpError(404, `No existe el café ${id}`);
    const rule = TRANSITIONS[status];
    // Sin invitado con cuenta (contacto del catálogo), quien propone registra la respuesta
    const isResponder = cf.invitee_id ? cf.invitee_id === req.user.id : cf.proposer_id === req.user.id;
    if (rule.by === "invitee" && !isResponder) {
      throw new HttpError(403, "Solo la persona invitada puede responder el café", "not_invitee");
    }

    let changed = false;
    if (cf.status !== status) {
      if (!rule.from.includes(cf.status)) {
        throw new HttpError(409, `No se puede pasar de ${cf.status} a ${status}`, "invalid_transition");
      }
      // Para aceptar o completar, la conexión debe seguir activa por ambos lados
      if (status === "accepted" || status === "done") await resolveThread(c, cf.proposer_id, cf.connection_id);
      await c.query(
        `UPDATE coffees SET status = $2,
                responded_at = CASE WHEN $2 IN ('accepted', 'declined') THEN now() ELSE responded_at END
          WHERE id = $1`, [id, status]);
      changed = true;
    }

    // Idempotente: aceptar dos veces no vuelve a sumar (UNIQUE (user_id, reason, ref) en xp_ledger)
    const { rows: [me] } = await c.query("SELECT xp FROM users WHERE id = $1", [req.user.id]);
    let xp = { xpAwarded: 0, xp: me.xp };
    if (status === "accepted") {
      for (const uid of [cf.proposer_id, cf.invitee_id].filter(Boolean)) {
        const r = await awardXp(c, uid, XP_REWARDS.coffee, "coffee", `coffee:${id}`);
        if (uid === req.user.id) xp = r;
      }
    }
    return { row: await loadCoffee(c, req.user.id, id), xp, changed };
  });
  if (result.changed) notify(result.row);
  res.json({ coffee: toCoffee(result.row), ...result.xp, ...levelInfo(result.xp.xp) });
});

export default router;
