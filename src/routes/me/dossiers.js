import { Router } from "express";
import { z } from "zod";
import { query, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo } from "../../lib/levels.js";
import { isRegistered, listCheckins } from "../../lib/queries.js";
import { toDossier } from "../../lib/serialize.js";

const router = Router();

// Lo que hoy redacta el frontend (o, más adelante, el LLM). El resumen numérico lo arma el servidor.
const postSchema = z.object({
  ideas: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  plan: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  notes: z.string().max(5000).optional(),
}).strict();

// GET /api/me/dossiers → todos mis dossiers
router.get("/", async (req, res) => {
  const { rows } = await query("SELECT * FROM dossiers WHERE user_id = $1 ORDER BY generated_at", [req.user.id]);
  res.json({ dossiers: rows.map(toDossier) });
});

// GET /api/me/dossiers/:eventId
router.get("/:eventId", async (req, res) => {
  const { rows: [d] } = await query(
    "SELECT * FROM dossiers WHERE user_id = $1 AND event_id = $2", [req.user.id, req.params.eventId]);
  if (!d) throw new HttpError(404, `Aún no hay dossier para ${req.params.eventId}`);
  res.json({ dossier: toDossier(d) });
});

// POST /api/me/dossiers/:eventId → genera (o regenera) el dossier con mi actividad del evento
router.post("/:eventId", async (req, res) => {
  const body = postSchema.parse(req.body ?? {});
  const eventId = req.params.eventId;

  const { row, created } = await tx(async (c) => {
    const { rows: [ev] } = await c.query("SELECT id, name, city FROM events WHERE id = $1", [eventId]);
    if (!ev) throw new HttpError(404, `No existe el evento ${eventId}`);
    if (!(await isRegistered(c, req.user.id, ev.id))) throw new HttpError(403, `No estás inscrito en ${ev.id}`);

    const checkins = await listCheckins(c, req.user.id, req.user.industry, ev.id);
    const { rows: contacts } = await c.query(
      `SELECT ct.name, ct.headline, cn.context FROM connections cn JOIN contacts ct ON ct.id = cn.contact_id
        WHERE cn.user_id = $1 AND cn.status = 'accepted' AND (cn.event_id IS NULL OR cn.event_id = $2)
        ORDER BY cn.accepted_at`, [req.user.id, ev.id]);
    const { rows: [{ missions, xp }] } = await c.query(
      `SELECT (SELECT count(*) FROM mission_progress WHERE user_id = $1)::int AS missions,
              (SELECT xp FROM users WHERE id = $1) AS xp`, [req.user.id]);

    const content = {
      ideas: body.ideas ?? [],
      plan: body.plan ?? [],
      notes: body.notes ?? "",
      summary: {
        event: ev,
        sessionsAttended: checkins.map((k) => ({ code: k.sessionCode, title: k.session?.title ?? null, at: k.createdAt })),
        contacts,
        missionsCompleted: missions,
        xp,
        ...levelInfo(xp),
      },
    };
    const { rows: [d] } = await c.query(
      `INSERT INTO dossiers (user_id, event_id, content) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, event_id) DO UPDATE SET content = EXCLUDED.content, generated_at = now()
       RETURNING *, (xmax = 0) AS inserted`, [req.user.id, ev.id, content]);
    return { row: d, created: d.inserted };
  });

  res.status(created ? 201 : 200).json({ dossier: toDossier(row) });
});

export default router;
