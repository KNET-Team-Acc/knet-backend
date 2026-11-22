import { Router } from "express";
import { z } from "zod";
import { pool, query } from "../db.js";
import { HttpError } from "../lib/http.js";
import { listSessions } from "../lib/queries.js";
import { toEvent } from "../lib/serialize.js";

const router = Router();

const EVENT_SELECT = `
  SELECT e.*, COALESCE(d.days, '{}') AS days, (r.user_id IS NOT NULL) AS registered
    FROM events e
    LEFT JOIN LATERAL (SELECT array_agg(date::text ORDER BY day_index) AS days
                         FROM event_days WHERE event_id = e.id) d ON true
    LEFT JOIN registrations r ON r.event_id = e.id AND r.user_id = $1`;

const listQuery = z.object({
  kind: z.enum(["real", "demo", "exclusive"]).optional(),
  industry: z.string().max(40).optional(),
});

// GET /api/events?kind=real&industry=tech
router.get("/", async (req, res) => {
  const { kind, industry } = listQuery.parse(req.query);
  const { rows } = await query(
    `${EVENT_SELECT}
      WHERE ($2::text IS NULL OR e.kind = $2) AND ($3::text IS NULL OR $3 = ANY (e.industries))
      ORDER BY d.days[1] NULLS LAST, e.id`,
    [req.user.id, kind ?? null, industry ?? null],
  );
  res.json({ events: rows.map((e) => toEvent(e, req.user.xp)) });
});

// GET /api/events/:id → detalle con ficha, recinto y speakers
router.get("/:id", async (req, res) => {
  const { rows: [ev] } = await query(`${EVENT_SELECT} WHERE e.id = $2`, [req.user.id, req.params.id]);
  if (!ev) throw new HttpError(404, `No existe el evento ${req.params.id}`);
  const { rows: speakers } = await query(
    `SELECT name, role, org, session_label AS "session", talk, bio, tags, avatar
       FROM speakers WHERE event_id = $1 ORDER BY id`, [ev.id]);
  res.json({ event: { ...toEvent(ev, req.user.xp), info: ev.info, venue: ev.venue, speakers } });
});

// GET /api/events/:id/sessions?day=0 → sesiones del día (variante de la industria del usuario)
router.get("/:id/sessions", async (req, res) => {
  const { day } = z.object({ day: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  const { rows: [ev] } = await query(
    `SELECT e.id, count(d.*)::int AS days FROM events e LEFT JOIN event_days d ON d.event_id = e.id
      WHERE e.id = $1 GROUP BY e.id`, [req.params.id]);
  if (!ev) throw new HttpError(404, `No existe el evento ${req.params.id}`);
  if (day >= ev.days) throw new HttpError(404, `El evento ${ev.id} tiene ${ev.days} día(s); day va de 0 a ${ev.days - 1}`);
  const sessions = await listSessions(pool, ev.id, day, req.user.industry, req.user.id);
  res.json({ eventId: ev.id, day, sessions });
});

export default router;
