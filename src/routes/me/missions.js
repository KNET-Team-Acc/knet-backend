import { Router } from "express";
import { query, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo } from "../../lib/levels.js";
import { toMission } from "../../lib/serialize.js";
import { awardXp } from "../../lib/xp.js";

const router = Router();

// Misiones visibles: las de la industria del usuario + comunes + grupales
const APPLIES = "(m.kind <> 'industry' OR m.industry = $2)";

// GET /api/me/missions
router.get("/", async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, p.completed_at FROM missions m
       LEFT JOIN mission_progress p ON p.mission_code = m.code AND p.user_id = $1
      WHERE ${APPLIES}
      ORDER BY CASE m.kind WHEN 'industry' THEN 0 WHEN 'common' THEN 1 ELSE 2 END, m.sort_order`,
    [req.user.id, req.user.industry]);
  const missions = rows.map(toMission);
  res.json({ missions, completed: missions.filter((m) => m.completed).length, xp: req.user.xp, ...levelInfo(req.user.xp) });
});

// POST /api/me/missions/:code/complete → marca la misión y suma su XP
router.post("/:code/complete", async (req, res) => {
  const result = await tx(async (c) => {
    const { rows: [m] } = await c.query(
      `SELECT * FROM missions m WHERE m.code = $1 AND ${APPLIES}`, [req.params.code, req.user.industry]);
    if (!m) throw new HttpError(404, `No existe la misión ${req.params.code} para tu industria`);
    const { rows: [p] } = await c.query(
      `INSERT INTO mission_progress (user_id, mission_code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING completed_at`, [req.user.id, m.code]);
    if (!p) throw new HttpError(409, `Ya completaste la misión ${m.code}`);
    const xp = await awardXp(c, req.user.id, m.xp, "mission", m.code);
    return { mission: { ...m, completed_at: p.completed_at }, xp };
  });
  res.status(201).json({ mission: toMission(result.mission), ...result.xp, ...levelInfo(result.xp.xp) });
});

export default router;
