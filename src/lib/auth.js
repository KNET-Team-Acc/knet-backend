/**
 * Sesiones: access token JWT corto (HS256) + refresh token opaco rotatorio guardado como SHA-256.
 * Reutilizar un refresh ya rotado revoca toda su familia (detección de robo).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { tx } from "../db.js";
import { HttpError } from "./http.js";

const BCRYPT_ROUNDS = 12;
// Hash fijo para comparar aunque el usuario no exista o no tenga contraseña (tiempo de respuesta parejo)
const DUMMY_HASH = bcrypt.hashSync("knet-dummy-password", BCRYPT_ROUNDS);

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 48) => randomBytes(bytes).toString("base64url");

export const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash || DUMMY_HASH).then((ok) => ok && !!hash);

export function signAccessToken(userId) {
  return jwt.sign({ typ: "access" }, config.jwtSecret, {
    algorithm: "HS256", subject: userId, expiresIn: Math.floor(config.jwtTtlMs / 1000),
  });
}

/** Devuelve el id del usuario del token o lanza 401 (token_expired / invalid_token) */
export function verifyAccessToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    if (p.typ !== "access" || !p.sub) throw new Error("tipo de token incorrecto");
    return p.sub;
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw new HttpError(401, "La sesión caducó: refresca el token", "token_expired");
    throw new HttpError(401, "Token de acceso inválido", "invalid_token");
  }
}

/** Crea un refresh token (nueva familia o la de una rotación) y lo guarda. db = pool o client */
export async function issueRefreshToken(db, userId, family = randomUUID()) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.refreshTtlMs);
  await db.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, family, expires_at) VALUES ($1, $2, $3, $4)",
    [userId, sha256(token), family, expiresAt]);
  return { token, expiresAt };
}

/** Par de tokens que devuelven /register, /login, /refresh y /exchange */
export async function issueSession(db, userId, family) {
  const refresh = await issueRefreshToken(db, userId, family);
  return {
    accessToken: signAccessToken(userId),
    tokenType: "Bearer",
    expiresIn: Math.floor(config.jwtTtlMs / 1000),
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt.toISOString(),
  };
}

/**
 * Rota un refresh token: revoca el actual y emite otro de la misma familia. Lanza 401 si no sirve.
 * Si el token ya estaba revocado (reutilización), revoca toda la familia y lo confirma ANTES de lanzar
 * el error (por eso maneja su propia transacción en lugar de recibir una).
 */
export async function rotateRefreshToken(token) {
  const reused = await tx(async (c) => {
    const { rows: [rt] } = await c.query(
      "SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE", [sha256(token)]);
    if (!rt) throw new HttpError(401, "Refresh token inválido", "invalid_refresh");
    if (rt.revoked_at) {
      await c.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL", [rt.family]);
      return true; // se confirma la revocación y después se responde 401
    }
    if (new Date(rt.expires_at) <= new Date()) throw new HttpError(401, "Refresh token caducado", "invalid_refresh");
    await c.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [rt.id]);
    return issueSession(c, rt.user_id, rt.family);
  });
  if (reused === true) throw new HttpError(401, "Refresh token revocado: inicia sesión de nuevo", "invalid_refresh");
  return reused;
}

/** "1.10" > "1.9": compara versiones numéricas separadas por puntos. NULL/"" cuenta como la más antigua. */
export function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const legalOutdated = (user) => !user.is_demo && compareVersions(user.legal_version, config.legalVersion) < 0;

export const legalOutdatedError = () =>
  new HttpError(409, `Debes aceptar la versión ${config.legalVersion} de los Términos y la Política de privacidad`,
    "legal_outdated", { required: config.legalVersion });
