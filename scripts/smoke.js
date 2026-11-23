/**
 * Prueba rápida de la API contra un servidor en marcha (npm run dev en otra terminal).
 * Uso: npm run smoke   (API_URL=http://localhost:4000 por defecto)
 * Usa el usuario demo de energía para no ensuciar el usuario demo por defecto (tech).
 * Se puede repetir: los check-ins/misiones ya hechos devuelven 409 y cuentan como OK.
 */
import "dotenv/config";

const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`;
let userId = null;
let token = null; // access token: si está, se envía Authorization: Bearer en lugar de X-User-Id
let failed = 0;

async function call(method, path, body) {
  const auth = token ? { Authorization: `Bearer ${token}` } : userId ? { "X-User-Id": userId } : {};
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function check(label, method, path, body, ok = [200]) {
  const r = await call(method, path, body);
  const pass = ok.includes(r.status);
  if (!pass) failed++;
  console.log(`${pass ? "✓" : "✗"} ${String(r.status).padEnd(3)} ${method.padEnd(6)} ${path}  ${label}`);
  if (!pass) console.log("    ", JSON.stringify(r.json));
  return r.json;
}

const health = await check("health", "GET", "/health");
if (!health) process.exit(1);

// Busca el id del usuario demo de energía
const demo = await check("perfil demo por defecto", "GET", "/api/me");
console.log(`    usuario por defecto: ${demo.user.email}`);
// Consulta directa a PostgreSQL (para lo que la API no expone)
async function sql(text, params) {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await c.query(text, params); } finally { await c.end(); }
}
const { rows } = await sql("SELECT id FROM users WHERE email = 'demo.energia@knet.local'");
userId = rows[0].id;
console.log(`    usando demo.energia@knet.local (${userId})\n`);

const evs = await check("listar eventos", "GET", "/api/events");
console.log(`    ${evs.events.length} eventos · reales: ${evs.events.filter((e) => e.kind === "real").map((e) => e.id).join(", ")}`);
await check("solo reales", "GET", "/api/events?kind=real");
await check("detalle bog", "GET", "/api/events/bog");
const ses = await check("sesiones bog día 0", "GET", "/api/events/bog/sessions?day=0");
console.log(`    1ª sesión: ${ses.sessions[0].time} · ${ses.sessions[0].title}`);
await check("evento inexistente", "GET", "/api/events/nope", undefined, [404]);
await check("día fuera de rango", "GET", "/api/events/med/sessions?day=5", undefined, [404]);

await check("mi perfil", "GET", "/api/me");
await check("editar perfil", "PATCH", "/api/me", { location: "Cali, Colombia", interests: ["Gemelos digitales", "Datos"] });
const imp = await check("importar con fieldSources", "PATCH", "/api/me", { company: "Energía del Valle", fieldSources: { company: "mcp" } });
if (imp?.user?.fieldSources?.company !== "mcp") { failed++; console.log("    ✗ fieldSources.company debería ser mcp"); }
const ed = await check("editar sin fieldSources", "PATCH", "/api/me", { role: "Director de Operaciones" });
if (ed?.user?.fieldSources?.role !== "edited") { failed++; console.log("    ✗ fieldSources.role debería ser edited"); }
await check("fieldSources inválido", "PATCH", "/api/me", { fieldSources: { company: "robado" } }, [400]);
await check("perfil inválido", "PATCH", "/api/me", { seniority: "Rey" }, [400]);
await check("revocar profile (prohibido)", "PATCH", "/api/me", { scopes: { profile: false } }, [400]);

await check("consentimiento", "POST", "/api/me/consents", { type: "almacenamiento", details: { prefs: true } }, [201]);
const cons = await check("cadena de consentimientos", "GET", "/api/me/consents");
console.log(`    ${cons.consents.length} registros · cadena válida: ${cons.chain.valid}`);
if (!cons.chain.valid) failed++;

await check("check-in", "POST", "/api/me/checkins", { sessionCode: "bog:0:1", method: "qr" }, [201, 409]);
await check("check-in repetido", "POST", "/api/me/checkins", { sessionCode: "bog:0:1" }, [409]);
await check("check-in sin inscripción", "POST", "/api/me/checkins", { sessionCode: "and:0:0" }, [403]); // and: el smoke nunca inscribe en este evento
await check("mis check-ins", "GET", "/api/me/checkins");

await check("misiones", "GET", "/api/me/missions");
await check("completar misión", "POST", "/api/me/missions/energia-m0/complete", undefined, [201, 409]);
await check("misión de otra industria", "POST", "/api/me/missions/tech-m0/complete", undefined, [404]);

await check("evento exclusivo bloqueado", "POST", "/api/me/registrations/x5", undefined, [403]);
await check("inscribirse en med", "POST", "/api/me/registrations/med", undefined, [200, 201]);

await check("conectar por QR", "POST", "/api/me/connections", { name: "Felipe L.", source: "qr", eventId: "bog", context: "Gemelos digitales" }, [201, 409]);
await check("QR con asistente de SUMMIT_POOL", "POST", "/api/me/connections", { name: "Andrea P.", source: "qr" }, [201, 409]);
// Ciclo completo de una solicitud: pendiente → aceptada → eliminada (se deja eliminada para poder repetir el smoke)
await check("solicitud pendiente", "POST", "/api/me/connections", { name: "Paula B." }, [201]);
const conns = await check("mis conexiones", "GET", "/api/me/connections");
const paula = conns.connections.find((c) => c.contact.name === "Paula B.");
if (paula?.status !== "pending") { failed++; console.log("    ✗ Paula B. debería estar pendiente"); }
const acc1 = await check("aceptar solicitud", "PATCH", `/api/me/connections/${paula.id}`, { status: "accepted" });
console.log(`    aceptada · +${acc1.xpAwarded} XP (100 la primera vez, 0 si ya la había ganado antes)`);
const acc2 = await check("aceptar otra vez (idempotente)", "PATCH", `/api/me/connections/${paula.id}`, { status: "accepted" });
if (acc2.xpAwarded !== 0) { failed++; console.log("    ✗ aceptar dos veces no debe sumar XP"); }
await check("estado inválido", "PATCH", `/api/me/connections/${paula.id}`, { status: "pending" }, [400]);
await check("quitar conexión", "DELETE", `/api/me/connections/${paula.id}`, undefined, [204]);
await check("quitar otra vez", "DELETE", `/api/me/connections/${paula.id}`, undefined, [404]);
await check("conexión inexistente", "PATCH", "/api/me/connections/999999", { status: "accepted" }, [404]);

await check("generar dossier", "POST", "/api/me/dossiers/bog", { ideas: ["Los gemelos digitales rinden más en activos críticos."], plan: ["Priorizar 2 activos críticos"] }, [200, 201]);
const dos = await check("leer dossier", "GET", "/api/me/dossiers/bog");
console.log(`    sesiones: ${dos.dossier.content.summary.sessionsAttended.length} · contactos: ${dos.dossier.content.summary.contacts.length} · XP: ${dos.dossier.content.summary.xp}`);
await check("dossier sin inscripción", "POST", "/api/me/dossiers/and", {}, [403]);

// Supresión (DELETE /api/me) con un usuario desechable: no hay endpoint para crear usuarios.
// Cada corrida deja sus consentimientos desvinculados (user_id NULL): son inmutables a propósito.
await check("borrar cuenta demo (prohibido)", "DELETE", "/api/me", undefined, [403]);
const demoId = userId;
userId = null;
await check("borrar sin X-User-Id", "DELETE", "/api/me", undefined, [400]);
const { rows: [tmp] } = await sql(
  `INSERT INTO users (email, name, industry) VALUES ($1, 'Smoke Borrado', 'energia') RETURNING id`,
  [`smoke.borrado.${Date.now()}@knet.local`]);
userId = tmp.id;
// Sin versión legal aceptada: /api/me/* responde 409 legal_outdated hasta registrar la aceptación
const out = await check("sin aceptación legal → 409", "GET", "/api/me", undefined, [409]);
if (out?.error !== "legal_outdated" || !out?.required) { failed++; console.log("    ✗ debería ser legal_outdated con required"); }
const acc = await check("consentimiento del usuario a borrar", "POST", "/api/me/consents",
  { type: "aceptacion", documents: [{ id: "terminos", version: "1.2" }, { id: "privacidad", version: "1.2" }] }, [201]);
if (acc?.legalVersion !== "1.2") { failed++; console.log("    ✗ la aceptación debería fijar legalVersion 1.2"); }
await check("inscripción del usuario a borrar", "POST", "/api/me/registrations/bog", undefined, [200, 201]);
await check("cliente no puede registrar «supresion»", "POST", "/api/me/consents", { type: "supresion" }, [400]);
const del = await check("borrar mi cuenta", "DELETE", "/api/me");
console.log(`    borrado: ${JSON.stringify(del?.deleted)} · consentimientos conservados: ${del?.consentsRetained}`);
if (del?.deleted?.registrations !== 1) { failed++; console.log("    ✗ debería haber borrado 1 inscripción"); }
await check("perfil borrado", "GET", "/api/me", undefined, [404]);
const { rows: kept } = await sql("SELECT * FROM consents WHERE subject_id = $1 ORDER BY id", [tmp.id]);
const { verifyChain } = await import("../src/lib/consents.js");
const keptChain = verifyChain(kept);
console.log(`    ${kept.length} consentimientos conservados · user_id NULL: ${kept.every((r) => r.user_id === null)} · último: ${kept.at(-1)?.event_type} · cadena válida: ${keptChain.valid}`);
if (kept.length !== 2 || !kept.every((r) => r.user_id === null) || kept.at(-1)?.event_type !== "supresion" || !keptChain.valid) {
  failed++; console.log("    ✗ el registro de consentimientos debería conservarse desvinculado, con la cadena válida");
}
let blocked = false;
try { await sql("UPDATE consents SET payload = '{}'::jsonb WHERE id = $1", [kept[0].id]); } catch { blocked = true; }
console.log(`    modificar un consentimiento conservado: ${blocked ? "bloqueado" : "PERMITIDO"}`);
if (!blocked) failed++;
userId = demoId;

// ───── Autenticación: registro → login → /api/me con Bearer → refresh rotatorio → logout ─────
userId = null;
const mail = `smoke.auth.${Date.now()}@knet.local`;
const LEGAL = process.env.LEGAL_VERSION || "1.2";
await check("registro sin aceptar lo legal", "POST", "/api/auth/register", { email: mail, password: "clave-segura-1", name: "Smoke Auth", legalVersion: LEGAL }, [400]);
await check("registro con versión legal vieja", "POST", "/api/auth/register", { email: mail, password: "clave-segura-1", name: "Smoke Auth", acceptLegal: true, legalVersion: "0.1" }, [409]);
const reg = await check("registro", "POST", "/api/auth/register",
  { email: mail, password: "clave-segura-1", name: "Smoke Auth", industry: "banca", acceptLegal: true, legalVersion: LEGAL }, [201]);
if (!reg?.accessToken || !reg?.refreshToken || reg?.consent?.type !== "aceptacion") { failed++; console.log("    ✗ el registro debe devolver tokens y la aceptación"); }
await check("correo repetido", "POST", "/api/auth/register",
  { email: mail.toUpperCase(), password: "clave-segura-1", name: "Otro", acceptLegal: true, legalVersion: LEGAL }, [409]);
await check("contraseña incorrecta", "POST", "/api/auth/login", { email: mail, password: "no-es-esta" }, [401]);
await check("demo sin contraseña", "POST", "/api/auth/login", { email: "demo.tech@knet.local", password: "cualquiera" }, [401]);
const login = await check("login", "POST", "/api/auth/login", { email: mail, password: "clave-segura-1" });
token = login.accessToken;
const meAuth = await check("GET /api/me con Bearer", "GET", "/api/me");
if (meAuth?.user?.email !== mail || meAuth?.user?.industry !== "banca") { failed++; console.log("    ✗ /api/me debería ser la cuenta registrada"); }
token = "no.es.un.jwt";
await check("Bearer inválido", "GET", "/api/me", undefined, [401]);
token = null;
const ref1 = await check("refresh", "POST", "/api/auth/refresh", { refreshToken: login.refreshToken });
await check("refresh reutilizado → 401", "POST", "/api/auth/refresh", { refreshToken: login.refreshToken }, [401]);
await check("la familia queda revocada", "POST", "/api/auth/refresh", { refreshToken: ref1.refreshToken }, [401]);
await check("logout", "POST", "/api/auth/logout", { refreshToken: reg.refreshToken }, [204]);
await check("refresh tras logout → 401", "POST", "/api/auth/refresh", { refreshToken: reg.refreshToken }, [401]);
// Versión legal antigua: 409 hasta re-aceptar por POST /api/me/consents (que no se bloquea)
const login2 = await check("login otra vez", "POST", "/api/auth/login", { email: mail, password: "clave-segura-1" });
token = login2.accessToken;
await sql("UPDATE users SET legal_version = '0.9' WHERE lower(email) = $1", [mail]);
await check("versión legal antigua → 409", "GET", "/api/me/missions", undefined, [409]);
await check("re-aceptar", "POST", "/api/me/consents", { type: "aceptacion", documents: [{ id: "terminos", version: LEGAL }, { id: "privacidad", version: LEGAL }] }, [201]);
await check("acceso tras re-aceptar", "GET", "/api/me/missions");
const delAuth = await check("borrar cuenta con Bearer", "DELETE", "/api/me");
if (!(delAuth?.deleted?.refreshTokens >= 2)) { failed++; console.log("    ✗ el borrado debería incluir los refresh tokens"); }
const { rows: [{ n: leftTokens }] } = await sql(
  "SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id NOT IN (SELECT id FROM users)");
if (leftTokens !== 0) { failed++; console.log("    ✗ quedaron refresh tokens huérfanos"); }
await check("token de cuenta borrada", "GET", "/api/me", undefined, [401]);
token = null;
const prov = await check("proveedores de acceso", "GET", "/api/auth/providers");
console.log(`    LinkedIn configurado: ${prov?.linkedin} · versión legal: ${prov?.legalVersion}`);

console.log(failed ? `\n${failed} prueba(s) fallaron` : "\nTodas las pruebas pasaron");
process.exit(failed ? 1 : 0);
