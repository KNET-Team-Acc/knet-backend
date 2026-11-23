/**
 * QR dinámico entre asistentes (también sirve como identificador NFC del teléfono).
 *
 * Token: knet1.<payload base64url>.<HMAC-SHA256 base64url> con QR_SECRET.
 * payload = { u: user_id, e: event_id | null, n: nonce, x: expiración (s epoch) }.
 * Caduca a los QR_TTL_S segundos y cada nonce se puede usar una sola vez (tabla qr_nonces): una foto o
 * captura del QR no sirve para conectarse después ni dos veces.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "./http.js";

const PREFIX = "knet1";

const sign = (data) => createHmac("sha256", config.qr.secret).update(data).digest("base64url");

/** Token nuevo para userId (y eventId opcional). Devuelve { token, nonce, expiresAt } */
export function signQrToken({ userId, eventId = null }, now = Date.now()) {
  const nonce = randomBytes(12).toString("base64url");
  const exp = Math.floor(now / 1000) + config.qr.ttlS;
  const payload = Buffer.from(JSON.stringify({ u: userId, e: eventId, n: nonce, x: exp })).toString("base64url");
  const data = `${PREFIX}.${payload}`;
  return { token: `${data}.${sign(data)}`, nonce, expiresAt: new Date(exp * 1000) };
}

/**
 * Comprueba firma y expiración. Devuelve { userId, eventId, nonce, expiresAt }.
 * 400 invalid_qr si está mal formado o alterado; 400 qr_expired si caducó.
 */
export function verifyQrToken(token, now = Date.now()) {
  const invalid = () => new HttpError(400, "El código QR no es válido", "invalid_qr");
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) throw invalid();
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();

  let p;
  try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { throw invalid(); }
  if (typeof p?.u !== "string" || typeof p?.n !== "string" || !Number.isInteger(p?.x)) throw invalid();
  if (p.x * 1000 <= now) throw new HttpError(400, "El código QR caducó: pide que lo actualicen", "qr_expired");
  return { userId: p.u, eventId: p.e ?? null, nonce: p.n, expiresAt: new Date(p.x * 1000) };
}

/**
 * Gasta el nonce dentro de la transacción `c`. 409 qr_used si ya se usó.
 * Aprovecha para purgar los nonces caducados (ya no pasarían la verificación).
 */
export async function consumeNonce(c, { nonce, userId, expiresAt }, usedBy) {
  await c.query("DELETE FROM qr_nonces WHERE expires_at < now()");
  const { rowCount } = await c.query(
    `INSERT INTO qr_nonces (nonce, user_id, used_by, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (nonce) DO NOTHING`, [nonce, userId, usedBy, expiresAt]);
  if (!rowCount) throw new HttpError(409, "Este código QR ya se usó: pide que lo actualicen", "qr_used");
}

/** Compara la credencial del tótem en tiempo constante */
export function isValidTotemKey(key) {
  if (!config.qr.totemSecret || typeof key !== "string") return false;
  const a = createHmac("sha256", "totem").update(key).digest();
  const b = createHmac("sha256", "totem").update(config.qr.totemSecret).digest();
  return timingSafeEqual(a, b);
}
