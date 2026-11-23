import { legalOutdated, legalOutdatedError } from "../lib/auth.js";

/**
 * 409 legal_outdated si el usuario no ha aceptado la versión vigente de Términos y Política.
 * except(req) → true para dejar pasar (re-aceptar y suprimir la cuenta nunca se bloquean).
 */
export function requireLegal(except = () => false) {
  return (req, _res, next) => {
    if (!except(req) && legalOutdated(req.user)) throw legalOutdatedError();
    next();
  };
}
