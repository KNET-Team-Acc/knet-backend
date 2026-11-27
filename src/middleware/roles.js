/**
 * Roles de cuenta (users.account_role): attendee | organizer | admin.
 * Se usa después de resolveUser(): sin usuario → 401; con un rol que no está en la lista → 403.
 */
import { HttpError } from "../lib/http.js";

export const ACCOUNT_ROLES = ["attendee", "organizer", "admin"];

export const accountRoleOf = (u) => (u && ACCOUNT_ROLES.includes(u.account_role) ? u.account_role : "attendee");

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) throw new HttpError(401, "Inicia sesión para continuar", "unauthorized");
    if (!roles.includes(accountRoleOf(req.user))) {
      throw new HttpError(403, "Tu cuenta no tiene permisos de organizador de eventos", "forbidden_role");
    }
    next();
  };
}

// Las cuentas admin son de gestión: no se inscriben, no comparten QR ni escanean credenciales,
// así no cuentan como asistentes ni aparecen en la red de nadie.
export function denyAdmin() {
  return (req, _res, next) => {
    if (accountRoleOf(req.user) === "admin") {
      throw new HttpError(403, "Las cuentas admin no participan como asistentes", "admin_account");
    }
    next();
  };
}
