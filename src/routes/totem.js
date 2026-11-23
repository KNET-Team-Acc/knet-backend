/**
 * Tótems NFC del recinto. No usan sesión de usuario: se autentican con X-Totem-Key (TOTEM_SECRET).
 * El asistente acerca el teléfono (que emite su token QR dinámico) o la credencial con su UUID.
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { query, tx } from "../db.js";
import { recordCheckin } from "../lib/checkins.js";
import { HttpError } from "../lib/http.js";
import { levelInfo } from "../lib/levels.js";
import { consumeNonce, isValidTotemKey, verifyQrToken } from "../lib/qr.js";
import { toSession } from "../lib/serialize.js";
import { sessionCode } from "./me/checkins.js";

const router = Router();

const bodySchema = z.object({
  sessionCode,
  token: z.string().max(1000).optional(),  // token QR dinámico emitido por el teléfono
  userId: z.string().uuid().optional(),    // UUID grabado en la credencial física
}).strict().refine((b) => Boolean(b.token) !== Boolean(b.userId), "Envía token o userId (uno de los dos)");

function requireTotem(req, _res, next) {
  if (!config.qr.totemSecret) throw new HttpError(503, "El check-in NFC no está configurado (TOTEM_SECRET)", "nfc_unavailable");
  if (!isValidTotemKey(req.get("x-totem-key"))) throw new HttpError(401, "Credencial de tótem inválida", "invalid_totem");
  next();
}

// POST /api/events/:id/nfc-checkin { sessionCode, token | userId } → check-in con method = 'nfc'
router.post("/:id/nfc-checkin", requireTotem, async (req, res) => {
  const body = bodySchema.parse(req.body ?? {});
  const eventId = req.params.id;
  const totemId = (req.get("x-totem-id") || "").slice(0, 60) || null;
  const qr = body.token ? verifyQrToken(body.token) : null;
  if (qr?.eventId && qr.eventId !== eventId) throw new HttpError(400, "El código es de otro evento", "invalid_qr");

  const { rows: [user] } = await query("SELECT id, industry, xp FROM users WHERE id = $1", [qr?.userId ?? body.userId]);
  if (!user) throw new HttpError(404, "No existe el asistente");
  const result = await tx(async (c) => {
    if (qr) await consumeNonce(c, qr, null);
    return recordCheckin(c, user, body.sessionCode, { method: "nfc", eventId, totemId });
  });
  res.status(201).json({
    checkin: { id: result.checkin.id, sessionCode: body.sessionCode, eventId, method: "nfc", createdAt: result.checkin.created_at },
    session: toSession(result.session),
    xpAwarded: result.xp.xpAwarded,
    xp: result.xp.xp,
    ...levelInfo(result.xp.xp),
  });
});

export default router;
