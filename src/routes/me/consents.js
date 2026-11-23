import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { query, tx } from "../../db.js";
import { compareVersions } from "../../lib/auth.js";
import { appendConsent, clientInfo, CONSENT_TYPES, LEGAL_DOCS, verifyChain } from "../../lib/consents.js";
import { toConsent } from "../../lib/serialize.js";

const router = Router();

// «supresion» solo la registra el servidor al ejecutar DELETE /api/me
const CLIENT_TYPES = CONSENT_TYPES.filter((t) => t !== "supresion");

const postSchema = z.object({
  type: z.enum(CLIENT_TYPES),
  documents: z.array(z.object({
    id: z.string().min(1).max(60),
    version: z.string().max(20).optional(),
    hash: z.string().max(128).optional(),
  }).strict()).max(20).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Versión legal que acredita una «aceptacion»: la menor entre Términos y Política (deben venir ambos) */
export function acceptedLegalVersion(type, documents) {
  if (type !== "aceptacion" || !documents) return null;
  const versions = LEGAL_DOCS.map((id) => documents.find((d) => d.id === id)?.version);
  if (versions.some((v) => !v)) return null;
  return versions.reduce((min, v) => (compareVersions(v, min) < 0 ? v : min));
}

// GET /api/me/consents → registro completo + verificación de la cadena de hashes
router.get("/", async (req, res) => {
  const { rows } = await query("SELECT * FROM consents WHERE user_id = $1 ORDER BY id", [req.user.id]);
  res.json({ consents: rows.map(toConsent), chain: verifyChain(rows) });
});

// POST /api/me/consents → agrega un evento a la cadena (el hash lo calcula el servidor).
// Una «aceptacion» de Términos y Política en una versión más nueva que la guardada actualiza
// users.legal_version: así se sale del 409 legal_outdated.
router.post("/", async (req, res) => {
  const { type, documents, details } = postSchema.parse(req.body ?? {});
  const accepted = acceptedLegalVersion(type, documents);
  const result = await tx(async (c) => {
    const row = await appendConsent(c, req.user.id, type, { documents, details }, clientInfo(req));
    let legalVersion = req.user.legal_version;
    if (accepted && compareVersions(accepted, legalVersion) > 0) {
      ({ rows: [{ legal_version: legalVersion }] } = await c.query(
        "UPDATE users SET legal_version = $2 WHERE id = $1 RETURNING legal_version", [req.user.id, accepted]));
    }
    return { row, legalVersion };
  });
  res.status(201).json({ consent: toConsent(result.row), legalVersion: result.legalVersion, legalRequired: config.legalVersion });
});

export default router;
