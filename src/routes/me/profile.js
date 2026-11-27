import { Router } from "express";
import { z } from "zod";
import { pool, query, tx } from "../../db.js";
import { appendConsent, clientInfo } from "../../lib/consents.js";
import { HttpError } from "../../lib/http.js";
import { getScopes } from "../../lib/queries.js";
import { GRAPH_ROLES, toUser } from "../../lib/serialize.js";

const router = Router();

// Igual que SENIORITY en db/data/industries.js
const SENIORITY = ["Analista", "Profesional", "Gerencia", "Directivo", "C-level"];

// campo de la API → [columna, clave de field_sources (P_FIELDS del frontend)]
const FIELDS = {
  name: ["name", "name"],
  role: ["role", "role"],
  company: ["company", "company"],
  industry: ["industry", "ind"],
  seniority: ["seniority", "seniority"],
  location: ["location", "location"],
  interests: ["interests", "interests"],
  avatar: ["avatar", null],
  graphRole: ["graph_role", null], // rol «Soy» del grafo de red (knet-backend#30)
};
const SOURCE_FIELDS = Object.values(FIELDS).map(([, src]) => src).filter(Boolean);

const patchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.string().trim().min(1).max(120).optional(),
  company: z.string().trim().max(120).optional(),
  industry: z.string().trim().min(1).max(40).optional(),
  seniority: z.enum(SENIORITY).optional(),
  location: z.string().trim().max(120).optional(),
  interests: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  avatar: z.record(z.string(), z.unknown()).nullable().optional(),
  graphRole: z.enum(GRAPH_ROLES).nullable().optional(),
  // Origen explícito de los campos (p. ej. "mcp" al importar desde LinkedIn). Si se envía,
  // reemplaza el marcado automático como "edited" para esos campos.
  fieldSources: z.partialRecord(z.enum(SOURCE_FIELDS), z.enum(["mcp", "manual", "edited"])).optional(),
  scopes: z.object({
    profile: z.boolean().optional(),
    industry: z.boolean().optional(),
    interests: z.boolean().optional(),
    network: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine((o) => Object.keys(o).length > 0, "Envía al menos un campo");

async function stats(userId) {
  const { rows: [s] } = await query(
    `SELECT (SELECT count(*) FROM checkins WHERE user_id = $1)::int AS checkins,
            (SELECT count(*) FROM mission_progress WHERE user_id = $1)::int AS missions,
            (SELECT count(*) FROM connections WHERE user_id = $1 AND status = 'accepted')::int AS connections,
            COALESCE((SELECT array_agg(event_id ORDER BY created_at) FROM registrations WHERE user_id = $1), '{}') AS registrations`,
    [userId]);
  return s;
}

// GET /api/me
router.get("/", async (req, res) => {
  const [scopes, s] = await Promise.all([getScopes(pool, req.user.id), stats(req.user.id)]);
  const { registrations, ...counts } = s;
  res.json({ user: toUser(req.user, scopes), stats: counts, registrations });
});

// PATCH /api/me → edita campos del perfil y/o permisos
router.patch("/", async (req, res) => {
  const body = patchSchema.parse(req.body ?? {});
  if (body.scopes?.profile === false) throw new HttpError(400, "El permiso «profile» es obligatorio para usar KNET");
  if (body.industry) {
    const { rowCount } = await query("SELECT 1 FROM industries WHERE id = $1", [body.industry]);
    if (!rowCount) throw new HttpError(400, `Industria desconocida: ${body.industry}`);
  }

  const result = await tx(async (c) => {
    const { rows: [current] } = await c.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    const sources = { ...current.field_sources };
    const sets = [];
    const vals = [current.id];
    for (const [key, [col, src]] of Object.entries(FIELDS)) {
      if (body[key] === undefined) continue;
      vals.push(body[key]);
      sets.push(`${col} = $${vals.length}`);
      // Lo escrito a mano al crear el perfil sigue siendo "manual"; lo demás pasa a "edited"
      if (src) sources[src] = sources[src] === "manual" ? "manual" : "edited";
    }
    if (body.fieldSources) Object.assign(sources, body.fieldSources);
    let user = current;
    if (sets.length || body.fieldSources) {
      vals.push(sources);
      sets.push(`field_sources = $${vals.length}`);
      ({ rows: [user] } = await c.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals));
    }

    if (body.scopes) {
      const before = await getScopes(c, current.id);
      for (const [scope, granted] of Object.entries(body.scopes)) {
        if (granted === undefined || before[scope] === granted) continue;
        await c.query(
          `INSERT INTO user_scopes (user_id, scope, granted, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id, scope) DO UPDATE SET granted = EXCLUDED.granted, updated_at = now()`,
          [current.id, scope, granted]);
        // Cada cambio de permiso queda en el registro trazable
        await appendConsent(c, current.id, granted ? "cambio_permiso" : "revocacion", { scope, granted }, clientInfo(req));
      }
    }
    return { user, scopes: await getScopes(c, current.id) };
  });

  res.json({ user: toUser(result.user, result.scopes) });
});

// DELETE /api/me → suprime el perfil y el progreso del titular (derecho de supresión, Ley 1581).
// Las tablas de progreso se borran por ON DELETE CASCADE. El registro de consentimientos se conserva
// como prueba (ON DELETE SET NULL deja user_id = NULL; subject_id mantiene verificable la cadena) y
// recibe un último evento «supresion» con lo que se borró. Exige identificarse explícitamente (Bearer o,
// en desarrollo, X-User-Id) para no borrar por accidente el usuario por defecto; las cuentas demo
// (compartidas) no se pueden borrar. Las sesiones (refresh_tokens) caen por ON DELETE CASCADE.
router.delete("/", async (req, res) => {
  if (req.authVia !== "jwt" && req.authVia !== "header") throw new HttpError(400, "Para borrar una cuenta inicia sesión (o envía su X-User-Id en desarrollo)");
  if (req.user.is_demo) throw new HttpError(403, "Las cuentas demo son compartidas y no se pueden borrar", "demo_account");

  const result = await tx(async (c) => {
    const { rows: [u] } = await c.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    if (!u) throw new HttpError(404, "Usuario no encontrado");
    const { rows: [deleted] } = await c.query(
      `SELECT (SELECT count(*) FROM user_scopes WHERE user_id = $1)::int AS scopes,
              (SELECT count(*) FROM registrations WHERE user_id = $1)::int AS registrations,
              (SELECT count(*) FROM checkins WHERE user_id = $1)::int AS checkins,
              (SELECT count(*) FROM mission_progress WHERE user_id = $1)::int AS missions,
              (SELECT count(*) FROM xp_ledger WHERE user_id = $1)::int AS "xpEntries",
              (SELECT count(*) FROM connections WHERE user_id = $1)::int AS connections,
              (SELECT count(*) FROM coffees WHERE proposer_id = $1 OR invitee_id = $1)::int AS coffees,
              (SELECT count(*) FROM messages WHERE sender_id = $1
                  OR connection_id IN (SELECT id FROM connections WHERE user_id = $1 OR peer_user_id = $1))::int AS messages,
              (SELECT count(*) FROM dossiers WHERE user_id = $1)::int AS dossiers,
              (SELECT count(*) FROM refresh_tokens WHERE user_id = $1)::int AS "refreshTokens"`, [u.id]);
    await appendConsent(c, u.id, "supresion", { details: { motivo: "Solicitud del titular (DELETE /api/me)", borrado: { profile: 1, ...deleted } } }, clientInfo(req));
    await c.query("DELETE FROM users WHERE id = $1", [u.id]);
    const { rows: [kept] } = await c.query("SELECT count(*)::int AS n FROM consents WHERE subject_id = $1", [u.id]);
    return { deleted, consentsRetained: kept.n };
  });

  res.json({ deleted: { profile: 1, ...result.deleted }, consentsRetained: result.consentsRetained });
});

export default router;
