/**
 * Cambia el rol de una cuenta (users.account_role). No hay endpoint para esto a propósito:
 * dar permisos de organizador o admin es una decisión del equipo de KNET, no de la app.
 *
 *   npm run user:role -- correo@dominio.com organizer     (attendee | organizer | admin)
 *   npm run user:role -- correo@dominio.com               → muestra el rol actual
 */
import { pool } from "../src/db.js";
import { ACCOUNT_ROLES } from "../src/middleware/roles.js";

const [email, role] = process.argv.slice(2);

async function main() {
  if (!email) throw new Error("Uso: npm run user:role -- <correo> [attendee|organizer|admin]");
  if (role && !ACCOUNT_ROLES.includes(role)) throw new Error(`Rol desconocido: ${role}. Usa ${ACCOUNT_ROLES.join(", ")}`);
  const { rows: [u] } = role
    ? await pool.query("UPDATE users SET account_role = $2 WHERE lower(email) = lower($1) RETURNING email, account_role", [email, role])
    : await pool.query("SELECT email, account_role FROM users WHERE lower(email) = lower($1)", [email]);
  if (!u) throw new Error(`No existe una cuenta con el correo ${email}`);
  console.log(`${u.email}: ${u.account_role}${role ? " (actualizado)" : ""}`);
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
