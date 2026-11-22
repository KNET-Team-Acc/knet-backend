import { Router } from "express";
import { z } from "zod";
import { pool, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { levelInfo, XP_REWARDS } from "../../lib/levels.js";
import { findSession, isRegistered, listCheckins } from "../../lib/queries.js";
import { toSession } from "../../lib/serialize.js";
import { awardXp } from "../../lib/xp.js";

const router = Router();

const postSchema = z.object({
  sessionCode: z.string().regex(/^[a-z0-9]+:\d+:\d+$/, "Formato esperado: evento:día:slot (p. ej. bog:0:2)"),
  method: z.enum(["qr", "nfc", "manual"]).default("qr"),
}).strict();

// GET /api/me/checkins?eventId=bog
router.get("/", async (req, res) => {
  const eventId = z.string().max(40).optional().parse(req.query.eventId);
  res.json({ checkins: await listCheckins(pool, req.user.id, req.user.industry, eventId ?? null) });
});

// POST /api/me/checkins → check-in a una sesión (+40 XP, una vez por sesión)
router.post("/", async (req, res) => {
  const { sessionCode, method } = postSchema.parse(req.body ?? {});
  const result = await tx(async (c) => {
    const session = await findSession(c, sessionCode, req.user.industry);
    if (!session) throw new HttpError(404, `No existe la sesión ${sessionCode}`);
    if (!(await isRegistered(c, req.user.id, session.event_id))) {
      throw new HttpError(403, `Inscríbete en el evento ${session.event_id} antes de hacer check-in`);
    }
    const { rows: [checkin] } = await c.query(
      `INSERT INTO checkins (user_id, event_id, session_code, method) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, session_code) DO NOTHING RETURNING *`,
      [req.user.id, session.event_id, sessionCode, method]);
    if (!checkin) throw new HttpError(409, `Ya hiciste check-in en ${sessionCode}`);
    const xp = await awardXp(c, req.user.id, XP_REWARDS.checkin, "checkin", sessionCode);
    return { checkin, session, xp };
  });

  res.status(201).json({
    checkin: { id: result.checkin.id, sessionCode, eventId: result.session.event_id, method, createdAt: result.checkin.created_at },
    session: toSession(result.session),
    xpAwarded: result.xp.xpAwarded,
    xp: result.xp.xp,
    ...levelInfo(result.xp.xp),
  });
});

export default router;
