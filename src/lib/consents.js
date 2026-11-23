import { createHash } from "node:crypto";

/** Documentos cuya aceptación exige la versión legal vigente (ids de DOCS en el frontend) */
export const LEGAL_DOCS = ["terminos", "privacidad"];

export const CONSENT_TYPES =["aceptacion", "autorizacion_linkedin", "vinculacion", "revocacion", "cambio_permiso", "almacenamiento", "supresion"];

/** JSON con claves ordenadas: el hash no depende del orden en que jsonb devuelva las claves. */
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const hashOf = ({ userId, type, payload, client, createdAt, prevHash }) =>
  sha256(stableStringify({ userId, type, payload, client, createdAt, prevHash }));

/** Datos del cliente que se guardan con cada consentimiento (como hace el frontend hoy). */
export const clientInfo = (req) => ({
  userAgent: (req.get("user-agent") || "").slice(0, 300),
  language: (req.get("accept-language") || "").split(",")[0] || "",
});

/**
 * Agrega un registro a la cadena del usuario. Bloquea la fila del usuario para que dos
 * peticiones simultáneas no tomen el mismo prev_hash. Llamar dentro de tx().
 */
export async function appendConsent(db, userId, type, payload = {}, client = {}) {
  await db.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const { rows: [last] } = await db.query(
    "SELECT hash FROM consents WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [userId]);
  const createdAt = new Date().toISOString();
  const prevHash = last ? last.hash : "inicio";
  const clean = JSON.parse(JSON.stringify(payload)); // quita undefined, igual que jsonb
  const hash = hashOf({ userId, type, payload: clean, client, createdAt, prevHash });
  const { rows } = await db.query(
    `INSERT INTO consents (user_id, subject_id, event_type, payload, client, prev_hash, hash, created_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, type, clean, client, prevHash, hash, createdAt],
  );
  return rows[0];
}

/** Recalcula la cadena completa de un titular. Usa subject_id, que se conserva aunque el usuario
 *  se haya borrado (user_id = NULL). Devuelve { valid, brokenAt }. */
export function verifyChain(rows) {
  let prev = "inicio";
  for (const r of rows) {
    const expected = hashOf({ userId: r.subject_id, type: r.event_type, payload: r.payload, client: r.client,
      createdAt: new Date(r.created_at).toISOString(), prevHash: r.prev_hash });
    if (r.prev_hash !== prev || r.hash !== expected) return { valid: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { valid: true, brokenAt: null };
}
