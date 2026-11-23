import { createHmac } from "node:crypto";
import "dotenv/config";

const nodeEnv = process.env.NODE_ENV || "development";
const list = (v, def) => (v || def).split(",").map((s) => s.trim()).filter(Boolean);

/** "15m", "30d", "3600s" o milisegundos → milisegundos (def si el valor no es válido) */
export function durationMs(v, def) {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(v ?? "").trim());
  if (!m) return def === undefined ? NaN : durationMs(def);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || "ms"];
  return Number(m[1]) * unit;
}

const DEV_SECRET = "knet-dev-secret-no-usar-en-produccion";
const jwtSecret = process.env.JWT_SECRET || (nodeEnv === "production" ? "" : DEV_SECRET);
if (!jwtSecret) throw new Error("Falta JWT_SECRET: es obligatorio con NODE_ENV=production");
// Sin QR_SECRET se deriva uno de JWT_SECRET (así un despliegue existente no deja de arrancar)
const qrSecret = process.env.QR_SECRET || createHmac("sha256", jwtSecret).update("knet-qr").digest("base64url");

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv,
  // Solo en desarrollo se acepta X-User-Id y el usuario demo sin token
  devIdentity: nodeEnv === "development",
  databaseUrl: process.env.DATABASE_URL || "postgres://knet:knet@localhost:5433/knet",
  // SSL de PostgreSQL: "true" = verifica el certificado; "no-verify" = cifra sin verificarlo (algunos
  // proveedores gestionados con certificados propios). Vacío = lo que diga DATABASE_URL (?sslmode=…).
  databaseSsl: process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : process.env.DATABASE_SSL === "true" ? true : undefined,
  // Tiempo real con varias instancias de la API: reparte los eventos SSE con LISTEN/NOTIFY de PostgreSQL
  eventsPgNotify: process.env.EVENTS_PG_NOTIFY === "true",
  sseHeartbeatMs: durationMs(process.env.SSE_HEARTBEAT_MS, "25000"),
  corsOrigin: list(process.env.CORS_ORIGIN, "http://localhost:5173"),
  demoUserEmail: process.env.DEMO_USER_EMAIL || "demo.tech@knet.local",
  // Proxies delante de la API (p. ej. 1 detrás del balanceador de la plataforma): el rate limit usa la IP real
  trustProxy: Number(process.env.TRUST_PROXY || 0),

  // Autenticación
  jwtSecret,
  jwtTtlMs: durationMs(process.env.JWT_TTL, "15m"),
  refreshTtlMs: durationMs(process.env.REFRESH_TTL, "30d"),
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT || 20), // intentos por IP cada 15 min en /login y /register
  // Versión vigente de Términos y Política: debe coincidir con LEGAL.version del frontend
  legalVersion: process.env.LEGAL_VERSION || "1.2",

  // IA (Claude). Sin AI_API_KEY, /api/ai/* responde 503 ai_unavailable y el frontend usa sus respuestas locales.
  ai: {
    apiKey: process.env.AI_API_KEY || "",
    model: process.env.AI_MODEL || "claude-opus-5-5",
    timeoutMs: durationMs(process.env.AI_TIMEOUT_MS, "20000"),
    rateLimit: Number(process.env.AI_RATE_LIMIT || 10), // peticiones por usuario y por minuto
  },

  // QR dinámico entre asistentes y check-in NFC desde tótems
  qr: {
    secret: qrSecret,
    ttlS: Math.min(Math.max(Number(process.env.QR_TTL_S || 45), 10), 300), // vida del token (s)
    scanRateLimit: Number(process.env.QR_SCAN_RATE_LIMIT || 30),           // escaneos por usuario y minuto
    // Sin TOTEM_SECRET, POST /api/events/:id/nfc-checkin responde 503 (en desarrollo hay uno por defecto)
    totemSecret: process.env.TOTEM_SECRET || (nodeEnv === "development" ? "knet-dev-totem" : ""),
  },

  // LinkedIn (OpenID Connect). Sin client id/secret, /api/auth/linkedin responde 503.
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID || "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || "",
    redirectUri: process.env.LINKEDIN_REDIRECT_URI || "http://localhost:4000/api/auth/linkedin/callback",
  },
};
