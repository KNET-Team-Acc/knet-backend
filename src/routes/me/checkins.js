import { Router } from "express";
import { z } from "zod";
import { pool, tx } from "../../db.js";
import { recordCheckin } from "../../lib/checkins.js";
import { levelInfo } from "../../lib/levels.js";
import { listCheckins } from "../../lib/queries.js";
import { toSession } from "../../lib/serialize.js";

const router = Router();

export const sessionCode = z.string().regex(/^[a-z0-9]+:\d+:\d+$/, "Formato esperado: evento:día:slot (p. ej. and:0:2)");

const postSchema = z.object({
  sessionCode,
  method: z.enum(["qr", "nfc", "manual"]).default("qr"),
}).strict();

// GET /api/me/checkins?eventId=and
router.get("/", async (req, res) => {
  const eventId = z.string().max(40).optional().parse(req.query.eventId);
  res.json({ checkins: await listCheckins(pool, req.user.id, req.user.industry, eventId ?? null) });
});

// POST /api/me/checkins → check-in a una sesión (+40 XP, una vez por sesión)
router.post("/", async (req, res) => {
  const { sessionCode, method } = postSchema.parse(req.body ?? {});
  const result = await tx((c) => recordCheckin(c, req.user, sessionCode, { method }));

  res.status(201).json({
    checkin: { id: result.checkin.id, sessionCode, eventId: result.session.event_id, method, createdAt: result.checkin.created_at },
    session: toSession(result.session),
    xpAwarded: result.xp.xpAwarded,
    xp: result.xp.xp,
    ...levelInfo(result.xp.xp),
  });
});

export default router;
