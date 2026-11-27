/**
 * Grafo de la red de quien consulta, con conexiones de 1.º y 2.º grado (knet-backend#30).
 *
 * GET /api/me/network?depth=2&eventId=<id>&limit=60 →
 *   { me: { id, graphRole }, nodes: [{ id, kind, name, headline, industry, graphRole, degree, via }], edges: [{ a, b }] }
 *
 * - 1.er grado: conexiones `accepted` de quien consulta: otros usuarios (kind "user", id = uuid) y contactos del
 *   catálogo (kind "contact", id = "c:<id>"; no tienen red propia, así que no abren 2.º grado).
 * - 2.º grado (depth=2): conexiones `accepted` de esos usuarios que no son quien consulta ni ya de 1.er grado.
 *   `via` = ids de los contactos de 1.er grado que llevan a cada uno (en 1.er grado, []).
 * - Aristas: todas las conexiones aceptadas entre los nodos incluidos y quien consulta (1.º–1.º y 2.º–2.º
 *   también), una por pareja, más quien consulta ↔ cada contacto del catálogo. Quien consulta no va en `nodes`:
 *   sus aristas usan su propio id (`me.id`).
 * - Privacidad: solo usuarios que conceden «network» (sin fila en user_scopes = concedido, como getScopes), sin
 *   cuentas admin. Cada nodo expone solo nombre, titular (cargo · empresa), industria y graphRole; nunca correo.
 * - eventId filtra el primer salto a las conexiones hechas en ese evento.
 * - limit (por defecto 60, máx. 150) acota el total de nodos: primero 1.er grado (usuarios, luego catálogo),
 *   luego 2.º grado por número de intermediarios.
 * 403 network_off (quien consulta revocó «network»), 403 admin_account.
 */
import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { getScopes } from "../../lib/queries.js";
import { denyAdmin } from "../../middleware/roles.js";

const router = Router();

const querySchema = z.object({
  depth: z.coerce.number().int().min(1).max(2).default(2),
  eventId: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(150).default(60),
});

// Usuario visible en la red de otros: comparte su red y no es admin (alias u + sn)
const VISIBLE = `u.account_role <> 'admin' AND COALESCE(sn.granted, true)`;

// $1 = quien consulta, $2 = eventId | null, $3 = limit, $4 = depth
const NETWORK_SQL = `
WITH d1 AS (
  SELECT u.id, u.name, u.role, u.company, u.industry, u.graph_role, cn.accepted_at
    FROM connections cn
    JOIN users u ON u.id = cn.peer_user_id
    LEFT JOIN user_scopes sn ON sn.user_id = u.id AND sn.scope = 'network'
   WHERE cn.user_id = $1 AND cn.status = 'accepted' AND ${VISIBLE}
     AND ($2::text IS NULL OR cn.event_id = $2)
   ORDER BY cn.accepted_at DESC NULLS LAST, u.id
   LIMIT $3
), d1c AS (
  SELECT ct.id, ct.name, ct.headline, ct.industry, cn.accepted_at
    FROM connections cn
    JOIN contacts ct ON ct.id = cn.contact_id
   WHERE cn.user_id = $1 AND cn.status = 'accepted' AND ($2::text IS NULL OR cn.event_id = $2)
   ORDER BY cn.accepted_at DESC NULLS LAST, ct.id
   LIMIT GREATEST($3 - (SELECT count(*) FROM d1), 0)
), d2 AS (
  SELECT u.id, u.name, u.role, u.company, u.industry, u.graph_role,
         array_agg(DISTINCT c2.user_id ORDER BY c2.user_id) AS via
    FROM d1
    JOIN connections c2 ON c2.user_id = d1.id AND c2.status = 'accepted'
    JOIN users u ON u.id = c2.peer_user_id
    LEFT JOIN user_scopes sn ON sn.user_id = u.id AND sn.scope = 'network'
   WHERE $4 >= 2 AND u.id <> $1 AND u.id NOT IN (SELECT id FROM d1) AND ${VISIBLE}
   GROUP BY u.id
   ORDER BY count(DISTINCT c2.user_id) DESC, lower(u.name), u.id
   LIMIT GREATEST($3 - (SELECT count(*) FROM d1) - (SELECT count(*) FROM d1c), 0)
), ids AS (
  SELECT $1::uuid AS id UNION SELECT id FROM d1 UNION SELECT id FROM d2
), edges AS (
  SELECT DISTINCT LEAST(cn.user_id::text, cn.peer_user_id::text) AS a, GREATEST(cn.user_id::text, cn.peer_user_id::text) AS b
    FROM connections cn
   WHERE cn.status = 'accepted' AND cn.user_id IN (SELECT id FROM ids) AND cn.peer_user_id IN (SELECT id FROM ids)
)
SELECT
  (SELECT COALESCE(jsonb_agg(d1 ORDER BY d1.accepted_at DESC NULLS LAST, d1.id), '[]') FROM d1) AS d1,
  (SELECT COALESCE(jsonb_agg(d1c ORDER BY d1c.accepted_at DESC NULLS LAST, d1c.id), '[]') FROM d1c) AS d1c,
  (SELECT COALESCE(jsonb_agg(d2 ORDER BY cardinality(d2.via) DESC, lower(d2.name), d2.id), '[]') FROM d2) AS d2,
  (SELECT COALESCE(jsonb_agg(edges ORDER BY edges.a, edges.b), '[]') FROM edges) AS edges`;

const headline = (u) => [u.role, u.company].filter(Boolean).join(" · ");
const userNode = (u, degree) => ({
  id: u.id,
  kind: "user",
  name: u.name,
  headline: headline(u),
  industry: u.industry,
  graphRole: u.graph_role ?? null,
  degree,
  via: degree === 2 ? u.via : [],
});

router.get("/", denyAdmin(), async (req, res) => {
  const q = querySchema.parse(req.query);
  const me = req.user.id;
  if (!(await getScopes(pool, me)).network) {
    throw new HttpError(403, "Revocaste el permiso «network»: actívalo para ver tu red", "network_off");
  }
  const { rows: [g] } = await pool.query(NETWORK_SQL, [me, q.eventId ?? null, q.limit, q.depth]);
  const nodes = [
    ...g.d1.map((u) => userNode(u, 1)),
    ...g.d1c.map((c) => ({
      id: `c:${c.id}`, kind: "contact", name: c.name, headline: c.headline || "", industry: c.industry,
      graphRole: null, degree: 1, via: [],
    })),
    ...g.d2.map((u) => userNode(u, 2)),
  ];
  const edges = [...g.edges, ...g.d1c.map((c) => ({ a: me, b: `c:${c.id}` }))];
  res.json({ me: { id: me, graphRole: req.user.graph_role ?? null }, nodes, edges });
});

export default router;
