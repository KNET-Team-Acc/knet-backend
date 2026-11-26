import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { pool } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { signQrToken } from "../../lib/qr.js";
import { getScopes } from "../../lib/queries.js";

const router = Router();

// GET /api/me/qr-token?eventId=and → token firmado y de corta vida para mostrar en el QR (o emitir por NFC).
// El frontend pide uno nuevo cada `refreshIn` segundos; cada token sirve una sola vez.
router.get("/", async (req, res) => {
  const eventId = z.string().max(40).optional().parse(req.query.eventId);
  const scopes = await getScopes(pool, req.user.id);
  if (!scopes.network) throw new HttpError(403, "Revocaste el permiso «network»: actívalo para compartir tu QR");
  if (eventId) {
    const { rowCount } = await pool.query("SELECT 1 FROM events WHERE id = $1", [eventId]);
    if (!rowCount) throw new HttpError(404, `No existe el evento ${eventId}`);
  }
  const { token, expiresAt } = signQrToken({ userId: req.user.id, eventId: eventId ?? null });
  res.set("Cache-Control", "no-store");
  res.json({ token, expiresAt, ttl: config.qr.ttlS, refreshIn: Math.max(5, config.qr.ttlS - 15) });
});

export default router;
