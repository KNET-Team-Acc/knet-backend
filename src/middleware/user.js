/**
 * Identifica al usuario de la petición:
 *  1. Authorization: Bearer <jwt> (access token de /api/auth/*) → req.authVia = "jwt"
 *  2. Solo con NODE_ENV=development: header X-User-Id → "header"; sin nada, el usuario demo
 *     (DEMO_USER_EMAIL) → "demo". En cualquier otro entorno, sin token responde 401.
 * resolveUser({ optional: true }) deja req.user = null en lugar de 401 (catálogo público).
 */
import { config } from "../config.js";
import { query } from "../db.js";
import { verifyAccessToken } from "../lib/auth.js";
import { HttpError } from "../lib/http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fromBearer(token) {
  const id = verifyAccessToken(token);
  const { rows: [u] } = await query("SELECT * FROM users WHERE id = $1", [id]);
  if (!u) throw new HttpError(401, "La cuenta de este token ya no existe", "invalid_token");
  return u;
}

async function fromDevHeaders(req) {
  const id = req.get("x-user-id");
  if (id && !UUID.test(id)) throw new HttpError(400, "X-User-Id debe ser un UUID");
  const { rows: [u] } = id
    ? await query("SELECT * FROM users WHERE id = $1", [id])
    : await query("SELECT * FROM users WHERE email = $1", [config.demoUserEmail]);
  if (!u) {
    throw id
      ? new HttpError(404, "Usuario no encontrado")
      : new HttpError(503, `No existe el usuario demo ${config.demoUserEmail}: ejecuta npm run db:seed`);
  }
  return { user: u, via: id ? "header" : "demo" };
}

export function resolveUser({ optional = false } = {}) {
  return async (req, _res, next) => {
    const auth = req.get("authorization") || "";
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m) {
      req.user = await fromBearer(m[1]);
      req.authVia = "jwt";
    } else if (auth) {
      throw new HttpError(401, "Usa Authorization: Bearer <token>", "invalid_token");
    } else if (config.devIdentity) {
      const r = await fromDevHeaders(req);
      req.user = r.user;
      req.authVia = r.via;
    } else if (optional) {
      req.user = null;
      req.authVia = null;
    } else {
      throw new HttpError(401, "Inicia sesión para continuar", "unauthorized");
    }
    next();
  };
}
