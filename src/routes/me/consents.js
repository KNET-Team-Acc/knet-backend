import { Router } from "express";
import { z } from "zod";
import { query, tx } from "../../db.js";
import { appendConsent, clientInfo, CONSENT_TYPES, verifyChain } from "../../lib/consents.js";
import { toConsent } from "../../lib/serialize.js";

const router = Router();

const postSchema = z.object({
  type: z.enum(CONSENT_TYPES),
  documents: z.array(z.object({
    id: z.string().min(1).max(60),
    version: z.string().max(20).optional(),
    hash: z.string().max(128).optional(),
  }).strict()).max(20).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

// GET /api/me/consents → registro completo + verificación de la cadena de hashes
router.get("/", async (req, res) => {
  const { rows } = await query("SELECT * FROM consents WHERE user_id = $1 ORDER BY id", [req.user.id]);
  res.json({ consents: rows.map(toConsent), chain: verifyChain(rows) });
});

// POST /api/me/consents → agrega un evento a la cadena (el hash lo calcula el servidor)
router.post("/", async (req, res) => {
  const { type, documents, details } = postSchema.parse(req.body ?? {});
  const row = await tx((c) => appendConsent(c, req.user.id, type, { documents, details }, clientInfo(req)));
  res.status(201).json({ consent: toConsent(row) });
});

export default router;
