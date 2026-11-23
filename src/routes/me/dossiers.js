import { Router } from "express";
import { z } from "zod";
import { query, tx } from "../../db.js";
import { dossierSummary, saveDossier } from "../../lib/dossier.js";
import { HttpError } from "../../lib/http.js";
import { toDossier } from "../../lib/serialize.js";

const router = Router();

// Lo que redacta el frontend (POST /api/ai/dossier lo redacta con el LLM). El resumen numérico lo arma el servidor.
const dossierTextSchema = z.object({
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
  const body = dossierTextSchema.parse(req.body ?? {});
  const { row, created } = await tx(async (c) => {
    const summary = await dossierSummary(c, req.user, req.params.eventId);
    const content = { ideas: body.ideas ?? [], plan: body.plan ?? [], notes: body.notes ?? "", summary };
    return saveDossier(c, req.user.id, summary.event.id, content);
  });
  res.status(created ? 201 : 200).json({ dossier: toDossier(row) });
});

export default router;
