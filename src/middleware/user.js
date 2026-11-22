/**
 * Identificación provisional (aún no hay login): header X-User-Id con el UUID del usuario.
 * Sin header se usa el usuario demo (DEMO_USER_EMAIL). Reemplazar por OAuth/JWT más adelante.
 */
import { config } from "../config.js";
import { query } from "../db.js";
import { HttpError } from "../lib/http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveUser(req, _res, next) {
  const id = req.get("x-user-id");
  if (id && !UUID.test(id)) throw new HttpError(400, "X-User-Id debe ser un UUID");
  const { rows } = id
    ? await query("SELECT * FROM users WHERE id = $1", [id])
    : await query("SELECT * FROM users WHERE email = $1", [config.demoUserEmail]);
  if (!rows[0]) {
    throw id
      ? new HttpError(404, "Usuario no encontrado")
      : new HttpError(503, `No existe el usuario demo ${config.demoUserEmail}: ejecuta npm run db:seed`);
  }
  req.user = rows[0];
  next();
}
