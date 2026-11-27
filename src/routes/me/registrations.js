import { Router } from "express";
import { query } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo } from "../../lib/levels.js";
import { denyAdmin } from "../../middleware/roles.js";

const router = Router();

// GET /api/me/registrations
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT r.event_id AS "eventId", e.name, e.city, r.created_at AS "createdAt"
       FROM registrations r JOIN events e ON e.id = r.event_id
      WHERE r.user_id = $1 ORDER BY r.created_at`, [req.user.id]);
  res.json({ registrations: rows });
});

// POST /api/me/registrations/:eventId → inscribirse (respeta los eventos exclusivos por nivel)
router.post("/:eventId", denyAdmin(), async (req, res) => {
  // Los borradores del panel de creador no admiten inscripciones hasta publicarse
  const { rows: [ev] } = await query("SELECT id, name, min_level FROM events WHERE id = $1 AND status = 'published'", [req.params.eventId]);
  if (!ev) throw new HttpError(404, `No existe el evento ${req.params.eventId}`);
  const { level } = levelInfo(req.user.xp);
  if (level < ev.min_level) throw new HttpError(403, `«${ev.name}» es exclusivo del nivel ${ev.min_level}; vas en el nivel ${level}`);
  const { rowCount } = await query(
    "INSERT INTO registrations (user_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.user.id, ev.id]);
  res.status(rowCount ? 201 : 200).json({ eventId: ev.id, registered: true, created: rowCount > 0 });
});

// DELETE /api/me/registrations/:eventId → cancelar inscripción
router.delete("/:eventId", async (req, res) => {
  const { rowCount } = await query(
    "DELETE FROM registrations WHERE user_id = $1 AND event_id = $2", [req.user.id, req.params.eventId]);
  if (!rowCount) throw new HttpError(404, `No estás inscrito en ${req.params.eventId}`);
  res.status(204).end();
});

export default router;
