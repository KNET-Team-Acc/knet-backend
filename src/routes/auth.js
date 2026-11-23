/**
 * Autenticación: correo + contraseña (bcrypt), JWT de acceso corto + refresh rotatorio, y LinkedIn
 * por OpenID Connect. Todas las rutas son públicas (van antes de resolveUser).
 *
 * LinkedIn con OIDC estándar (scopes openid profile email) solo entrega nombre, foto y correo:
 * cargo, empresa, industria e intereses no vienen en /v2/userinfo, así que el frontend los pide a mano.
 * Los permisos que el usuario marcó en la pantalla de KNET (LI_FIELDS) viajan en el state y quedan en
 * su registro de consentimientos; solo se importa lo que esté autorizado y disponible.
 */
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import { pool, query, tx } from "../db.js";
import {
  checkPassword, compareVersions, hashPassword, issueSession, legalOutdatedError, randomToken, rotateRefreshToken, sha256,
} from "../lib/auth.js";
import { appendConsent, clientInfo, LEGAL_DOCS } from "../lib/consents.js";
import { HttpError } from "../lib/http.js";
import { getScopes } from "../lib/queries.js";
import { toConsent, toUser } from "../lib/serialize.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.authRateLimit,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "rate_limited", message: "Demasiados intentos: espera unos minutos" }),
});

const email = z.string().trim().toLowerCase().email().max(254);
// bcrypt solo usa los primeros 72 bytes
const password = z.string().min(8, "Mínimo 8 caracteres").refine((p) => Buffer.byteLength(p) <= 72, "Máximo 72 bytes");
const version = z.string().regex(/^\d+(\.\d+)*$/, "Versión con formato 1.2").max(20);

const LI_SCOPES = ["basic", "work", "industry", "skills"]; // LI_FIELDS del frontend
const STATE_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 8000;

const legalDocuments = (v) => LEGAL_DOCS.map((id) => ({ id, version: v }));
const linkedinEnabled = () => !!(config.linkedin.clientId && config.linkedin.clientSecret);

async function userPayload(db, u) {
  return toUser(u, await getScopes(db, u.id));
}

// GET /api/auth/providers → qué métodos de acceso están activos y la versión legal vigente
router.get("/providers", (_req, res) => {
  res.json({ password: true, linkedin: linkedinEnabled(), legalVersion: config.legalVersion });
});

// POST /api/auth/register
const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().min(2).max(120),
  industry: z.string().trim().min(1).max(40).default("tech"),
  acceptLegal: z.literal(true, { message: "Debes aceptar los Términos y la Política de privacidad" }),
  legalVersion: version,
  // Datos del registro local del frontend (idLocal, hashLocal, casillas…) para cruzar ambas cadenas
  consentDetails: z.record(z.string(), z.unknown()).optional(),
}).strict();

router.post("/register", authLimiter, async (req, res) => {
  const body = registerSchema.parse(req.body ?? {});
  if (compareVersions(body.legalVersion, config.legalVersion) < 0) throw legalOutdatedError();
  const { rowCount: indOk } = await query("SELECT 1 FROM industries WHERE id = $1", [body.industry]);
  if (!indOk) throw new HttpError(400, `Industria desconocida: ${body.industry}`);
  const hash = await hashPassword(body.password);

  const result = await tx(async (c) => {
    const { rowCount: taken } = await c.query("SELECT 1 FROM users WHERE lower(email) = $1", [body.email]);
    if (taken) throw new HttpError(409, "Ya existe una cuenta con ese correo", "email_taken");
    const { rows: [u] } = await c.query(
      `INSERT INTO users (email, name, industry, password_hash, legal_version, field_sources)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [body.email, body.name, body.industry, hash, body.legalVersion, { name: "manual", ind: "manual" }]);
    // La aceptación queda en la cadena del servidor desde el primer momento
    const consent = await appendConsent(c, u.id, "aceptacion",
      { documents: legalDocuments(body.legalVersion), details: { formulario: "Registro con correo y contraseña", ...body.consentDetails } },
      clientInfo(req));
    const session = await issueSession(c, u.id);
    return { u, consent, session };
  });
  res.status(201).json({ user: await userPayload(pool, result.u), consent: toConsent(result.consent), ...result.session });
});

// POST /api/auth/login
router.post("/login", authLimiter, async (req, res) => {
  const body = z.object({ email, password: z.string().min(1).max(200) }).strict().parse(req.body ?? {});
  const { rows: [u] } = await query("SELECT * FROM users WHERE lower(email) = $1", [body.email]);
  // Misma respuesta si no existe, no tiene contraseña (demo/LinkedIn) o la contraseña no coincide
  if (!(await checkPassword(body.password, u?.password_hash))) {
    throw new HttpError(401, "Correo o contraseña incorrectos", "invalid_credentials");
  }
  const session = await issueSession(pool, u.id);
  res.json({ user: await userPayload(pool, u), ...session });
});

const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) }).strict();

// POST /api/auth/refresh → rota el refresh token (el anterior deja de servir)
router.post("/refresh", async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body ?? {});
  res.json(await rotateRefreshToken(refreshToken));
});

// POST /api/auth/logout → revoca el refresh token (idempotente)
router.post("/logout", async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body ?? {});
  await query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sha256(refreshToken)]);
  res.status(204).end();
});

// POST /api/auth/exchange → canjea el código de un solo uso que deja el callback de LinkedIn
router.post("/exchange", authLimiter, async (req, res) => {
  const { code } = z.object({ code: z.string().min(20).max(200) }).strict().parse(req.body ?? {});
  const result = await tx(async (c) => {
    const { rows: [h] } = await c.query(
      `UPDATE auth_handoffs SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`, [sha256(code)]);
    if (!h) throw new HttpError(401, "El código de acceso no es válido o ya se usó", "invalid_code");
    const { rows: [u] } = await c.query("SELECT * FROM users WHERE id = $1", [h.user_id]);
    return { u, h, session: await issueSession(c, u.id) };
  });
  res.json({ user: await userPayload(pool, result.u), created: result.h.created, linkedinScopes: result.h.scopes, ...result.session });
});

/* ---------- LinkedIn (OAuth 2.0 + OpenID Connect) ---------- */

function allowedReturnTo(raw) {
  try {
    const u = new URL(raw);
    return config.corsOrigin.includes(u.origin) ? u : null;
  } catch {
    return null;
  }
}

function redirectWith(res, returnTo, params) {
  const u = new URL(returnTo);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  res.redirect(302, u.toString());
}

async function fetchJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`LinkedIn respondió ${r.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/auth/linkedin?scopes=work,industry&legalVersion=1.2&returnTo=http://localhost:5173/
router.get("/linkedin", async (req, res) => {
  if (!linkedinEnabled()) throw new HttpError(503, "El acceso con LinkedIn no está configurado", "linkedin_unavailable");
  const q = z.object({
    scopes: z.string().max(100).optional(),
    legalVersion: version,
    returnTo: z.string().max(500),
  }).parse(req.query);
  const returnTo = allowedReturnTo(q.returnTo);
  if (!returnTo) throw new HttpError(400, "returnTo debe ser un origen permitido (CORS_ORIGIN)");
  if (compareVersions(q.legalVersion, config.legalVersion) < 0) throw legalOutdatedError();
  // basic (nombre) es obligatorio; el resto, solo lo que el usuario marcó
  const scopes = ["basic", ...(q.scopes || "").split(",").map((s) => s.trim()).filter((s) => LI_SCOPES.includes(s) && s !== "basic")];

  const state = randomToken(32);
  await query(
    "INSERT INTO oauth_states (state, scopes, legal_version, return_to, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [state, [...new Set(scopes)], q.legalVersion, returnTo.toString(), new Date(Date.now() + STATE_TTL_MS)]);
  await query("DELETE FROM oauth_states WHERE expires_at < now()"); // limpieza oportunista

  const auth = new URL("https://www.linkedin.com/oauth/v2/authorization");
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: config.linkedin.clientId,
    redirect_uri: config.linkedin.redirectUri,
    state,
    scope: "openid profile email",
  }).toString();
  res.redirect(302, auth.toString());
});

// GET /api/auth/linkedin/callback?code=…&state=…  (o ?error=…&state=… si el usuario cancela)
router.get("/linkedin/callback", async (req, res) => {
  const q = z.object({
    code: z.string().max(2000).optional(),
    state: z.string().max(200).optional(),
    error: z.string().max(200).optional(),
  }).parse(req.query);
  const { rows: [st] } = q.state
    ? await query("DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING *", [q.state])
    : { rows: [] };
  if (!st) throw new HttpError(400, "El enlace de LinkedIn caducó o ya se usó: vuelve a intentarlo", "invalid_state");
  if (q.error || !q.code) return redirectWith(res, st.return_to, { knet_auth_error: "linkedin_denied" });

  let info;
  try {
    const tok = await fetchJson("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: q.code, redirect_uri: config.linkedin.redirectUri,
        client_id: config.linkedin.clientId, client_secret: config.linkedin.clientSecret,
      }),
    });
    info = await fetchJson("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!info?.sub) throw new Error("userinfo sin sub");
  } catch (e) {
    console.error(`LinkedIn OAuth: ${e.message}`); // nunca se registran tokens ni el client secret
    return redirectWith(res, st.return_to, { knet_auth_error: "linkedin_failed" });
  }

  const verifiedEmail = info.email && info.email_verified ? String(info.email).toLowerCase() : null;
  const code = randomToken(32);
  await tx(async (c) => {
    let { rows: [u] } = await c.query("SELECT * FROM users WHERE linkedin_sub = $1 FOR UPDATE", [info.sub]);
    if (!u && verifiedEmail) {
      ({ rows: [u] } = await c.query("SELECT * FROM users WHERE lower(email) = $1 AND NOT is_demo FOR UPDATE", [verifiedEmail]));
    }
    let created = false;
    if (u) {
      // Vincula sin pisar lo que el usuario ya escribió: solo completa lo vacío
      ({ rows: [u] } = await c.query(
        `UPDATE users SET linkedin_sub = $2, linkedin_connected = true,
                email_verified_at = COALESCE(email_verified_at, CASE WHEN $3 THEN now() END),
                photo_url = COALESCE(photo_url, $4)
          WHERE id = $1 RETURNING *`,
        [u.id, info.sub, !!verifiedEmail, info.picture || null]));
    } else {
      const name = String(info.name || [info.given_name, info.family_name].filter(Boolean).join(" ") || "Asistente KNET").slice(0, 120);
      ({ rows: [u] } = await c.query(
        `INSERT INTO users (email, name, industry, linkedin_sub, linkedin_connected, email_verified_at, photo_url, field_sources)
         VALUES ($1, $2, 'tech', $3, true, $4, $5, $6) RETURNING *`,
        [verifiedEmail || `linkedin.${info.sub}@users.knet.local`, name, info.sub, verifiedEmail ? new Date() : null,
          info.picture || null, { name: "mcp" }]));
      created = true;
    }
    const client = clientInfo(req);
    await appendConsent(c, u.id, "autorizacion_linkedin",
      { details: { formulario: "OAuth LinkedIn (OpenID Connect)", campos: st.scopes, importados: ["name", ...(info.picture ? ["photo"] : [])] } }, client);
    if (compareVersions(st.legal_version, u.legal_version) > 0) {
      await c.query("UPDATE users SET legal_version = $2 WHERE id = $1", [u.id, st.legal_version]);
      await appendConsent(c, u.id, "aceptacion",
        { documents: legalDocuments(st.legal_version), details: { formulario: "Pantalla de permiso de LinkedIn" } }, client);
    }
    await c.query(
      "INSERT INTO auth_handoffs (code_hash, user_id, created, scopes, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [sha256(code), u.id, created, st.scopes, new Date(Date.now() + HANDOFF_TTL_MS)]);
  });
  redirectWith(res, st.return_to, { knet_auth: code });
});

export default router;
