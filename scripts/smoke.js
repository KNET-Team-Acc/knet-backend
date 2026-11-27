/**
 * Prueba rápida de la API contra un servidor en marcha (npm run dev en otra terminal).
 * Uso: npm run smoke   (API_URL=http://localhost:4000 por defecto)
 * Usa el usuario demo de energía para no ensuciar el usuario demo por defecto (tech).
 * Se puede repetir: los check-ins/misiones ya hechos devuelven 409 y cuentan como OK.
 */
import "dotenv/config";
import { isDeepStrictEqual } from "node:util";
import { VENUES } from "../db/data/venues.js";

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
// Catálogo real (issue #16): exactamente los 4 eventos con fuente oficial, sin los retirados
const REAL_IDS = ["and", "ais", "edu", "adc"];
// (los creados por organizadores en el panel, hosted, no son del catálogo sembrado)
const catalog = (evs?.events || []).filter((e) => !e.hosted);
const listed = catalog.map((e) => e.id).sort();
if (listed.join() !== [...REAL_IDS].sort().join() || !catalog.every((e) => e.kind === "real" && e.sourceUrl)) {
  failed++; console.log(`    ✗ /api/events debería traer solo ${REAL_IDS.join(", ")} (reales, con fuente); llegaron: ${listed.join(", ")}`);
}
const venues = {};
for (const id of REAL_IDS) {
  const d = await check(`detalle ${id}`, "GET", `/api/events/${id}`);
  if (d?.event?.id !== id || !d.event.info || !d.event.venue || !Array.isArray(d.event.speakers)) {
    failed++; console.log(`    ✗ el detalle de ${id} debería traer ficha, recinto y speakers`);
  }
  venues[id] = d?.event?.venue;
  if (!isDeepStrictEqual(venues[id], VENUES[id])) { failed++; console.log(`    ✗ el recinto de ${id} no coincide con db/data/venues.js (¿falta db:seed?)`); }
}
// Multievento (issue #20): cada evento real tiene su propio escenario 3D/AR, no una copia del plano de otro
const layout = (v) => JSON.stringify(v && [v.floor, v.nodes, v.edges, v.ground, v.deco]);
const shared = REAL_IDS.filter((a, i) => REAL_IDS.some((b, j) => j > i && layout(venues[a]) === layout(venues[b])));
if (shared.length) { failed++; console.log(`    ✗ recintos con la misma distribución: ${shared.join(", ")}`); }
for (const id of ["bog", "med", "baq", "x2", "x3", "x4", "x5"]) await check(`retirado ${id}`, "GET", `/api/events/${id}`, undefined, [404]);
await check("evento sin días publicados", "GET", "/api/events/ais/sessions?day=0", undefined, [404]);
const ses = await check("sesiones and día 0", "GET", "/api/events/and/sessions?day=0");
console.log(`    1ª sesión: ${ses.sessions[0].time} · ${ses.sessions[0].title}`);
// Agenda personalizada por industria (paridad completa con el frontend: npm run parity)
const agMine = await check("agenda edu día 0 (industria del perfil)", "GET", "/api/events/edu/sessions?day=0");
const agTech = await check("agenda edu día 0 con industry=tech", "GET", "/api/events/edu/sessions?day=0&industry=tech");
const titles = (r) => r?.sessions?.map((s) => `${s.title} @ ${s.room} · ${s.why}`).join("|");
if (agMine?.industry !== "energia" || agTech?.industry !== "tech") { failed++; console.log("    ✗ industry debería ser energia (perfil) y tech (explícita)"); }
if (titles(agMine) === titles(agTech)) { failed++; console.log("    ✗ la agenda de energía y la de tecnología deberían ser distintas"); }
if (!agMine?.sessions?.length || !agMine.sessions.every((s) => s.why && /^edu:0:\d$/.test(s.code))) {
  failed++; console.log("    ✗ cada sesión debe traer why y un código edu:0:i");
}
console.log(`    energía: ${agMine?.sessions?.[0]?.title} · tech: ${agTech?.sessions?.[0]?.title}`);
await check("agenda con industria inexistente", "GET", "/api/events/edu/sessions?day=0&industry=nope", undefined, [400]);
await check("evento inexistente", "GET", "/api/events/nope", undefined, [404]);
await check("día fuera de rango", "GET", "/api/events/edu/sessions?day=5", undefined, [404]);

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

await check("check-in", "POST", "/api/me/checkins", { sessionCode: "and:0:1", method: "qr" }, [201, 409]);
await check("check-in repetido", "POST", "/api/me/checkins", { sessionCode: "and:0:1" }, [409]);
await check("mis check-ins", "GET", "/api/me/checkins");

await check("misiones", "GET", "/api/me/missions");
await check("completar misión", "POST", "/api/me/missions/energia-m0/complete", undefined, [201, 409]);
await check("misión de otra industria", "POST", "/api/me/missions/tech-m0/complete", undefined, [404]);

await check("evento retirado (bog)", "POST", "/api/me/registrations/bog", undefined, [404]);
// Sin inscripción en edu (se borra la de una corrida anterior) el check-in se rechaza
await check("cancelar inscripción previa en edu", "DELETE", "/api/me/registrations/edu", undefined, [204, 404]);
await check("check-in sin inscripción", "POST", "/api/me/checkins", { sessionCode: "edu:0:0" }, [403]);
// Inscribirse en los eventos reales (adc no: el smoke nunca inscribe ahí, ver «dossier sin inscripción»)
for (const id of ["and", "ais"]) await check(`inscribirse en ${id}`, "POST", `/api/me/registrations/${id}`, undefined, [200, 201]);
await check("inscribirse en edu", "POST", "/api/me/registrations/edu", undefined, [200, 201]);
await check("check-in en sesión generada edu:0:2", "POST", "/api/me/checkins", { sessionCode: "edu:0:2" }, [201, 409]);
const eduCk = await check("mis check-ins en edu", "GET", "/api/me/checkins?eventId=edu");
const ck = eduCk?.checkins?.find((c) => c.sessionCode === "edu:0:2");
if (ck?.session?.title !== agMine?.sessions?.[2]?.title) { failed++; console.log("    ✗ el check-in debería mostrar la sesión de la agenda de energía"); }

await check("conectar por QR", "POST", "/api/me/connections", { name: "Felipe L.", source: "qr", eventId: "and", context: "Gemelos digitales" }, [201, 409]);
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

// ───── Cafés 1:1 y chat directo ─────
const energiaId = userId;
const soon = new Date(Date.now() + 86_400_000).toISOString();
const accepted = await check("conexiones aceptadas", "GET", "/api/me/connections?status=accepted");
const felipe = accepted.connections.find((c) => c.contact.name === "Felipe L.");
await check("café con horario pasado", "POST", "/api/me/coffees", { connectionId: felipe.id, slot: "2020-01-01T10:00:00Z" }, [400]);
const cafe = await check("proponer café (contacto del catálogo)", "POST", "/api/me/coffees", { connectionId: felipe.id, slot: soon, place: "Lounge 2" }, [201]);
await check("segundo café activo con la misma persona", "POST", "/api/me/coffees", { connectionId: felipe.id, slot: soon }, [409]);
const cafeOk = await check("aceptar café (respuesta simulada)", "PATCH", `/api/me/coffees/${cafe.coffee.id}`, { status: "accepted" });
if (cafeOk?.xpAwarded !== 50 || cafeOk?.coffee?.status !== "accepted") { failed++; console.log("    ✗ aceptar debería sumar 50 XP"); }
const cafeOk2 = await check("aceptar otra vez (idempotente)", "PATCH", `/api/me/coffees/${cafe.coffee.id}`, { status: "accepted" });
if (cafeOk2?.xpAwarded !== 0) { failed++; console.log("    ✗ aceptar dos veces no debería sumar XP"); }
await check("completar café", "PATCH", `/api/me/coffees/${cafe.coffee.id}`, { status: "done" });
await check("café completado no vuelve a aceptarse", "PATCH", `/api/me/coffees/${cafe.coffee.id}`, { status: "declined" }, [409]);
const misCafes = await check("mis cafés", "GET", "/api/me/coffees?status=done");
if (!misCafes?.coffees?.some((c) => c.id === cafe.coffee.id && c.role === "proposer" && c.with?.name === "Felipe L.")) {
  failed++; console.log("    ✗ el café completado debería aparecer como propuesto a Felipe L.");
}
await check("mensaje a contacto del catálogo", "POST", `/api/me/messages/${felipe.id}`, { body: "¡Hola Felipe! ¿Café mañana?" }, [201]);
const pend = await check("solicitud pendiente", "POST", "/api/me/connections", { name: "Paula B." }, [201]);
const noCafe = await check("café con conexión pendiente → 403", "POST", "/api/me/coffees", { connectionId: pend.connection.id, slot: soon }, [403]);
const noMsg = await check("mensaje con conexión pendiente → 403", "POST", `/api/me/messages/${pend.connection.id}`, { body: "hola" }, [403]);
if (noCafe?.error !== "not_connected" || noMsg?.error !== "not_connected") { failed++; console.log("    ✗ debería ser not_connected"); }
await check("quitar solicitud pendiente", "DELETE", `/api/me/connections/${pend.connection.id}`, undefined, [204]);

// Entre usuarios reales: dos filas espejo. Escanear el QR del otro las crea pendientes; aceptar las conecta.
const LEGAL_V = process.env.LEGAL_VERSION || "1.2";
const realUser = async (name) => (await sql(
  `INSERT INTO users (email, name, industry, role, company, legal_version) VALUES ($1, $2, 'tech', 'CTO', 'Acme', $3) RETURNING id`,
  [`smoke.${name.toLowerCase()}.${Date.now()}@knet.local`, `Smoke ${name}`, LEGAL_V])).rows[0].id;
const ana = await realUser("Ana"), beto = await realUser("Beto"), caro = await realUser("Caro");
// QR dinámico: Beto muestra su código y Ana lo escanea
userId = beto;
const qrB = await check("token QR de Beto", "GET", "/api/me/qr-token?eventId=and");
if (!/^knet1\.[\w-]+\.[\w-]+$/.test(qrB?.token ?? "") || !(qrB?.refreshIn < qrB?.ttl)) { failed++; console.log("    ✗ el token debería ser knet1.<payload>.<firma> con refreshIn < ttl"); }
const ownQr = await check("Beto escanea su propio QR", "POST", "/api/me/connections/scan", { token: qrB.token }, [400]);
userId = ana;
const [head, payload] = qrB.token.split(".");
const forged = `${head}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), u: caro })).toString("base64url")}.${qrB.token.split(".")[2]}`;
const bad = await check("token alterado", "POST", "/api/me/connections/scan", { token: forged }, [400]);
const { signQrToken } = await import("../src/lib/qr.js");
const old = await check("token caducado", "POST", "/api/me/connections/scan", { token: signQrToken({ userId: beto }, Date.now() - 600_000).token }, [400]);
if (ownQr?.error !== "own_qr" || bad?.error !== "invalid_qr" || old?.error !== "qr_expired") { failed++; console.log("    ✗ errores esperados: own_qr, invalid_qr, qr_expired"); }
// knet-backend#24: escanear crea una solicitud pendiente hacia el dueño del QR; la XP llega cuando la acepta
const sc = await check("Ana escanea a Beto (solicitud)", "POST", "/api/me/connections/scan", { token: qrB.token, context: "Charla de RAG" }, [201]);
if (sc?.xpAwarded !== 0 || !sc?.created || sc?.connection?.status !== "pending" || sc?.connection?.direction !== "outgoing"
    || sc?.connection?.contact?.userId !== beto || sc?.connection?.eventId !== "and") {
  failed++; console.log("    ✗ el escaneo debería crear una solicitud pendiente hacia Beto, sin XP");
}
const used = await check("token ya usado", "POST", "/api/me/connections/scan", { token: qrB.token }, [409]);
if (used?.error !== "qr_used") { failed++; console.log("    ✗ debería ser qr_used"); }
userId = beto;
const qrB2 = await check("nuevo token de Beto", "GET", "/api/me/qr-token");
userId = ana;
const sc2 = await check("escanear de nuevo a Beto", "POST", "/api/me/connections/scan", { token: qrB2.token }, [200]);
if (sc2?.created !== false || sc2?.xpAwarded !== 0 || sc2?.connection?.status !== "pending") { failed++; console.log("    ✗ reescanear no debería crear otra solicitud ni sumar XP"); }
userId = caro;
let scanLimited = false;
for (let i = 0; i < 40 && !scanLimited; i++) scanLimited = (await call("POST", "/api/me/connections/scan", { token: "knet1.x.y" })).status === 429;
console.log(`${scanLimited ? "✓" : "✗"} 429 POST   /api/me/connections/scan  rate limit por usuario`);
if (!scanLimited) failed++;
// Beto ve la solicitud entrante; solo él puede aceptarla (+100 XP a cada uno, una sola vez)
userId = beto;
const betoReq = (await check("solicitudes de Beto", "GET", "/api/me/connections?status=pending")).connections.find((c) => c.contact.userId === ana);
if (betoReq?.direction !== "incoming" || betoReq?.source !== "qr") { failed++; console.log("    ✗ Beto debería ver la solicitud de Ana como entrante (qr)"); }
userId = ana;
const anaReq = (await check("solicitudes de Ana", "GET", "/api/me/connections?status=pending")).connections.find((c) => c.contact.userId === beto);
const selfAcc = await check("Ana no acepta su propia solicitud", "PATCH", `/api/me/connections/${anaReq?.id}`, { status: "accepted" }, [403]);
if (selfAcc?.error !== "not_recipient") { failed++; console.log("    ✗ debería ser not_recipient"); }
userId = beto;
const qrAcc1 = await check("Beto acepta la solicitud de Ana", "PATCH", `/api/me/connections/${betoReq?.id}`, { status: "accepted" });
const qrAcc2 = await check("Beto acepta otra vez", "PATCH", `/api/me/connections/${betoReq?.id}`, { status: "accepted" });
const { rows: xpAB } = await sql("SELECT id, xp FROM users WHERE id = ANY($1)", [[ana, beto]]);
if (qrAcc1?.xpAwarded !== 100 || qrAcc1?.connection?.status !== "accepted" || qrAcc2?.xpAwarded !== 0 || !xpAB.every((u) => u.xp === 100)) {
  failed++; console.log(`    ✗ aceptar debería dar +100 XP a Ana y a Beto una sola vez: ${JSON.stringify(xpAB)}`);
}

// Directorio del evento y solicitudes por peerUserId (knet-backend#24)
const dani = await realUser("Dani");
await sql("INSERT INTO registrations (user_id, event_id) SELECT unnest($1::uuid[]), 'and' ON CONFLICT DO NOTHING", [[ana, beto, caro, dani]]);
userId = caro;
const dir = await check("directorio de and (Caro)", "GET", "/api/me/attendees?eventId=and&limit=100");
const dirIds = (dir?.attendees ?? []).map((a) => a.userId), anaCard = dir?.attendees?.find((a) => a.userId === ana);
if (dir?.eventId !== "and" || typeof dir?.total !== "number" || !dirIds.includes(ana) || !dirIds.includes(dani) || dirIds.includes(caro)
    || anaCard?.headline !== "CTO · Acme" || anaCard?.connection !== null || dir.attendees.some((a) => "email" in a)) {
  failed++; console.log("    ✗ el directorio debería listar a los demás inscritos (sin Caro ni correos) con su conexión");
}
await sql(`INSERT INTO user_scopes (user_id, scope, granted) VALUES ($1, 'network', false)
           ON CONFLICT (user_id, scope) DO UPDATE SET granted = false`, [dani]);
const dirOff = await check("directorio sin quien oculta su red", "GET", "/api/me/attendees?eventId=and&limit=100");
if (dirOff?.attendees?.some((a) => a.userId === dani)) { failed++; console.log("    ✗ Dani ocultó su red: no debería aparecer"); }
const offReq = await check("pedir a quien oculta su red", "POST", "/api/me/connections", { peerUserId: dani }, [403]);
if (offReq?.error !== "peer_network_off") { failed++; console.log("    ✗ debería ser peer_network_off"); }
await sql("UPDATE user_scopes SET granted = true WHERE user_id = $1 AND scope = 'network'", [dani]);
const notReg = await check("directorio de un evento sin inscripción", "GET", "/api/me/attendees?eventId=adc", undefined, [403]);
if (notReg?.error !== "not_registered") { failed++; console.log("    ✗ debería ser not_registered"); }
const own = await check("solicitud a uno mismo", "POST", "/api/me/connections", { peerUserId: caro }, [400]);
const noShared = await check("solicitud fuera de un evento común", "POST", "/api/me/connections", { peerUserId: dani, eventId: "adc" }, [403]);
if (own?.error !== "own_request" || noShared?.error !== "no_shared_event") { failed++; console.log("    ✗ errores esperados: own_request, no_shared_event"); }
const rq1 = await check("Caro pide conectar con Dani", "POST", "/api/me/connections", { peerUserId: dani, eventId: "and" }, [201]);
if (rq1?.connection?.status !== "pending" || rq1?.connection?.direction !== "outgoing" || rq1?.xpAwarded !== 0) { failed++; console.log("    ✗ la solicitud debería quedar pendiente y sin XP"); }
const dup = await check("Caro repite la solicitud", "POST", "/api/me/connections", { peerUserId: dani }, [409]);
if (dup?.error !== "request_pending") { failed++; console.log("    ✗ debería ser request_pending"); }
const pairCount = async () => (await sql("SELECT count(*)::int AS n FROM connections WHERE (user_id = $1 AND peer_user_id = $2) OR (user_id = $2 AND peer_user_id = $1)", [caro, dani])).rows[0].n;
userId = dani;
const daniReq = (await check("solicitudes de Dani", "GET", "/api/me/connections?status=pending")).connections.find((c) => c.contact.userId === caro);
if (daniReq?.direction !== "incoming") { failed++; console.log("    ✗ Dani debería ver la solicitud de Caro como entrante"); }
await check("Dani rechaza", "DELETE", `/api/me/connections/${daniReq?.id}`, undefined, [204]);
if (await pairCount() !== 0) { failed++; console.log("    ✗ rechazar debería borrar las dos filas"); }
userId = caro;
const rq2 = await check("Caro vuelve a pedir", "POST", "/api/me/connections", { peerUserId: dani }, [201]);
await check("Caro cancela", "DELETE", `/api/me/connections/${rq2?.connection?.id}`, undefined, [204]);
if (await pairCount() !== 0) { failed++; console.log("    ✗ cancelar debería borrar las dos filas"); }
await check("Caro pide otra vez", "POST", "/api/me/connections", { peerUserId: dani }, [201]);
userId = dani;
const mutual = await check("Dani también pide: quedan conectados", "POST", "/api/me/connections", { peerUserId: caro }, [200]);
const { rows: xpCD } = await sql("SELECT xp FROM users WHERE id = ANY($1)", [[caro, dani]]);
if (mutual?.connection?.status !== "accepted" || mutual?.xpAwarded !== 100 || !xpCD.every((u) => u.xp === 100)) {
  failed++; console.log(`    ✗ la solicitud mutua debería conectar con +100 XP a cada uno: ${JSON.stringify(xpCD)}`);
}
const again = await check("pedir a quien ya es conexión", "POST", "/api/me/connections", { peerUserId: caro }, [409]);
if (again?.error !== "already_connected") { failed++; console.log("    ✗ debería ser already_connected"); }
userId = caro;
const dirAfter = await check("directorio con la conexión", "GET", "/api/me/attendees?eventId=and&limit=100");
if (dirAfter?.attendees?.find((a) => a.userId === dani)?.connection?.status !== "accepted") { failed++; console.log("    ✗ el directorio debería mostrar la conexión con Dani"); }

// Ranking del evento (Misiones): XP global, mismas reglas de privacidad que el directorio
{
  const { tx } = await import("../src/db.js");
  const { awardXp } = await import("../src/lib/xp.js");
  await tx((c) => awardXp(c, dani, 50, "manual", "smoke:leaderboard")); // Dani 150, Ana/Beto/Caro 100
  const lb = await check("ranking de and (Caro)", "GET", "/api/me/leaderboard?eventId=and");
  const ids = (lb?.entries ?? []).map((e) => e.userId), at = (id) => lb?.entries?.find((e) => e.userId === id);
  const sorted = (lb?.entries ?? []).every((e, i, a) => i === 0 || a[i - 1].xp >= e.xp);
  if (lb?.eventId !== "and" || lb?.scope !== "event" || ![ana, beto, caro, dani].every((id) => ids.includes(id)) || !sorted
      || !at(caro)?.me || at(ana)?.me || at(dani)?.xp !== 150 || at(dani)?.level !== 1 || at(ana)?.pos !== at(caro)?.pos
      || at(dani)?.pos >= at(caro)?.pos || lb?.me?.pos !== at(caro)?.pos || lb?.me?.xp !== 100 || typeof lb?.total !== "number"
      || lb.entries.some((e) => "email" in e)) {
    failed++; console.log(`    ✗ el ranking debería listar a los inscritos por XP (empates en la misma posición), sin correos: ${JSON.stringify(lb?.entries)}`);
  }
  const lbTop = await check("ranking con limit=1", "GET", "/api/me/leaderboard?eventId=and&limit=1");
  if (!lbTop?.entries?.some((e) => e.me) || lbTop.total !== lb?.total) { failed++; console.log("    ✗ quien consulta debería aparecer aunque quede fuera del top"); }
  const lbConn = await check("ranking de mis conexiones (Caro)", "GET", "/api/me/leaderboard?eventId=and&scope=connections");
  if (lbConn?.scope !== "connections" || lbConn?.total !== 2 || JSON.stringify(lbConn?.entries?.map((e) => e.userId)) !== JSON.stringify([dani, caro])
      || lbConn?.me?.pos !== 2) {
    failed++; console.log(`    ✗ el ranking de conexiones debería ser Dani (#1) y Caro (#2): ${JSON.stringify(lbConn?.entries)}`);
  }
  await sql(`INSERT INTO user_scopes (user_id, scope, granted) VALUES ($1, 'network', false)
             ON CONFLICT (user_id, scope) DO UPDATE SET granted = false`, [dani]);
  const lbOff = await check("ranking sin quien oculta su red", "GET", "/api/me/leaderboard?eventId=and&scope=connections");
  if (lbOff?.entries?.some((e) => e.userId === dani) || lbOff?.total !== 1) { failed++; console.log("    ✗ Dani ocultó su red: no debería aparecer en el ranking"); }
  userId = dani;
  const lbMineOff = await check("ranking con la red oculta", "GET", "/api/me/leaderboard?eventId=and", undefined, [403]);
  if (lbMineOff?.error !== "network_off") { failed++; console.log("    ✗ debería ser network_off"); }
  await sql("UPDATE user_scopes SET granted = true WHERE user_id = $1 AND scope = 'network'", [dani]);
  userId = caro;
  const lbNotReg = await check("ranking de un evento sin inscripción", "GET", "/api/me/leaderboard?eventId=adc", undefined, [403]);
  const lbBad = await check("ranking con scope inválido", "GET", "/api/me/leaderboard?eventId=and&scope=amigos", undefined, [400]);
  if (lbNotReg?.error !== "not_registered" || !lbBad) { failed++; console.log("    ✗ errores esperados: not_registered y 400 por scope"); }
}
userId = ana;
const anaConn = (await check("conexiones de Ana", "GET", "/api/me/connections")).connections.find((c) => c.contact.userId === beto);
userId = beto;
const betoConn = (await check("conexiones de Beto", "GET", "/api/me/connections")).connections.find((c) => c.contact.userId === ana);
if (!anaConn || !betoConn || anaConn.contact.name !== "Smoke Beto" || anaConn.contact.headline !== "CTO · Acme") {
  failed++; console.log("    ✗ cada lado debería ver al otro como conexión");
}
userId = caro;
await check("Caro no lee el chat de Ana y Beto", "GET", `/api/me/messages/${anaConn.id}`, undefined, [404]);
await check("Caro no escribe en él", "POST", `/api/me/messages/${anaConn.id}`, { body: "intruso" }, [404]);
await check("Caro no ve cafés ajenos", "PATCH", "/api/me/coffees/999999", { status: "accepted" }, [404]);
userId = ana;
await check("mensaje vacío", "POST", `/api/me/messages/${anaConn.id}`, { body: "   " }, [400]);
await check("mensaje demasiado largo", "POST", `/api/me/messages/${anaConn.id}`, { body: "x".repeat(2001) }, [400]);
for (const body of ["Hola Beto", "¿Viste la charla de RAG?", "Te propongo un café"]) {
  await check("Ana escribe", "POST", `/api/me/messages/${anaConn.id}`, { body }, [201]);
}
userId = beto;
await check("Beto responde", "POST", `/api/me/messages/${betoConn.id}`, { body: "¡Claro, Ana!" }, [201]);
const p1 = await check("chat de Beto, página 1", "GET", `/api/me/messages/${betoConn.id}?limit=2`);
const p2 = await check("chat de Beto, página 2", "GET", `/api/me/messages/${betoConn.id}?limit=2&before=${p1?.nextCursor}`);
const thread = [...(p2?.messages ?? []), ...(p1?.messages ?? [])];
if (thread.map((m) => m.body).join("|") !== "Hola Beto|¿Viste la charla de RAG?|Te propongo un café|¡Claro, Ana!"
    || p2?.nextCursor !== null || !thread.at(-1)?.fromMe || thread[0]?.fromMe) {
  failed++; console.log("    ✗ el hilo paginado debería tener los 4 mensajes en orden");
}
userId = ana;
const c1 = await check("Ana propone café a Beto", "POST", "/api/me/coffees", { connectionId: anaConn.id, slot: soon, place: "Cafetería piso 2" }, [201]);
await check("Beto no puede proponer otro mientras tanto", "POST", "/api/me/coffees", { connectionId: anaConn.id, slot: soon }, [409]);
await check("Ana no acepta su propia invitación", "PATCH", `/api/me/coffees/${c1.coffee.id}`, { status: "accepted" }, [403]);
userId = beto;
const inv = (await check("cafés de Beto", "GET", "/api/me/coffees?status=proposed")).coffees.find((c) => c.id === c1.coffee.id);
if (inv?.role !== "invitee" || inv?.connectionId !== betoConn.id || inv?.with?.name !== "Smoke Ana") {
  failed++; console.log("    ✗ Beto debería ver el café como invitado, con su propia conexión");
}
const a1 = await check("Beto acepta el café", "PATCH", `/api/me/coffees/${c1.coffee.id}`, { status: "accepted" });
const a2 = await check("Beto acepta otra vez", "PATCH", `/api/me/coffees/${c1.coffee.id}`, { status: "accepted" });
const { rows: [{ xp: anaXp }] } = await sql("SELECT xp FROM users WHERE id = $1", [ana]);
if (a1?.xpAwarded !== 50 || a2?.xpAwarded !== 0 || anaXp !== 150) { failed++; console.log("    ✗ aceptar debería dar 50 XP a cada uno, una sola vez (Ana: 100 del QR + 50)"); }

// Check-in NFC desde un tótem (X-Totem-Key)
const TOTEM = process.env.TOTEM_SECRET || "knet-dev-totem";
async function totem(path, body, key = TOTEM) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-Totem-Key": key } : {}), "X-Totem-Id": "smoke-1" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
async function totemCheck(label, path, body, ok, key) {
  const r = await totem(path, body, key);
  const pass = ok.includes(r.status);
  if (!pass) { failed++; console.log("    ", JSON.stringify(r.json)); }
  console.log(`${pass ? "✓" : "✗"} ${String(r.status).padEnd(3)} POST   ${path}  ${label}`);
  return r.json;
}
userId = ana;
await check("Ana se inscribe en and", "POST", "/api/me/registrations/and", undefined, [200, 201]);
await totemCheck("NFC sin credencial de tótem", "/api/events/and/nfc-checkin", { sessionCode: "and:0:1", userId: ana }, [401], null);
await totemCheck("NFC con credencial inválida", "/api/events/and/nfc-checkin", { sessionCode: "and:0:1", userId: ana }, [401], "no-es-la-clave");
const nfc1 = await totemCheck("NFC con la credencial (UUID)", "/api/events/and/nfc-checkin", { sessionCode: "and:0:1", userId: ana }, [201]);
if (nfc1?.checkin?.method !== "nfc" || nfc1?.xpAwarded !== 40) { failed++; console.log("    ✗ el check-in NFC debería quedar con method nfc y +40 XP"); }
await totemCheck("NFC repetido", "/api/events/and/nfc-checkin", { sessionCode: "and:0:1", userId: ana }, [409]);
const qrA = await check("token QR de Ana", "GET", "/api/me/qr-token?eventId=and");
await totemCheck("NFC con el teléfono (token)", "/api/events/and/nfc-checkin", { sessionCode: "and:0:2", token: qrA.token }, [201]);
await totemCheck("NFC con token ya usado", "/api/events/and/nfc-checkin", { sessionCode: "and:0:3", token: qrA.token }, [409]);
await totemCheck("NFC con sesión de otro evento", "/api/events/and/nfc-checkin", { sessionCode: "edu:0:1", userId: ana }, [404]);
const nfcList = await check("check-ins de Ana", "GET", "/api/me/checkins?eventId=and");
if (nfcList?.checkins?.filter((k) => k.method === "nfc").length !== 2) { failed++; console.log("    ✗ deberían aparecer 2 check-ins NFC"); }
const delAna = await check("Ana borra su cuenta", "DELETE", "/api/me");
console.log(`    borrado: cafés ${delAna?.deleted?.coffees} · mensajes ${delAna?.deleted?.messages}`);
const { rows: [left] } = await sql(
  `SELECT (SELECT count(*) FROM coffees WHERE proposer_id = $1 OR invitee_id = $1)::int AS coffees,
          (SELECT count(*) FROM messages m JOIN connections cn ON cn.id = m.connection_id
            WHERE m.sender_id = $1 OR cn.user_id = $1 OR cn.peer_user_id = $1)::int AS messages,
          (SELECT count(*) FROM connections WHERE user_id = $1 OR peer_user_id = $1)::int AS connections`, [ana]);
if (delAna?.deleted?.coffees !== 1 || delAna?.deleted?.messages !== 4 || left.coffees + left.messages + left.connections !== 0) {
  failed++; console.log(`    ✗ borrar la cuenta debería eliminar sus cafés, mensajes y conexiones: ${JSON.stringify(left)}`);
}
for (const id of [beto, caro, dani]) { userId = id; await check("limpiar usuario de prueba", "DELETE", "/api/me"); }
userId = energiaId;

await check("generar dossier", "POST", "/api/me/dossiers/and", { ideas: ["Los gemelos digitales rinden más en activos críticos."], plan: ["Priorizar 2 activos críticos"] }, [200, 201]);
const dos = await check("leer dossier", "GET", "/api/me/dossiers/and");
console.log(`    sesiones: ${dos.dossier.content.summary.sessionsAttended.length} · contactos: ${dos.dossier.content.summary.contacts.length} · XP: ${dos.dossier.content.summary.xp}`);
await check("cancelar inscripción previa en adc", "DELETE", "/api/me/registrations/adc", undefined, [204, 404]);
await check("dossier sin inscripción", "POST", "/api/me/dossiers/adc", {}, [403]); // adc: el smoke no inscribe al demo en este evento

// IA: sin AI_API_KEY los tres endpoints responden 503 ai_unavailable (con key: npm run test:ai)
if (!process.env.AI_API_KEY) {
  for (const [path, body] of [["/api/ai/chat", { message: "¿Qué sesión sigue?" }], ["/api/ai/simulate", { contactName: "Felipe L.", message: "Hola" }], ["/api/ai/dossier", { eventId: "and" }]]) {
    const r = await check("IA sin key → 503", "POST", path, body, [503]);
    if (r?.error !== "ai_unavailable") { failed++; console.log("    ✗ debería ser ai_unavailable"); }
  }
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await call("POST", "/api/ai/chat", { message: "hola" })).status === 429;
  console.log(`${limited ? "✓" : "✗"} 429 POST   /api/ai/chat  rate limit por usuario`);
  if (!limited) failed++;
}

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
// Un usuario nuevo puede inscribirse en cualquiera de los 4 eventos reales
for (const id of REAL_IDS) await check(`inscripción del usuario a borrar en ${id}`, "POST", `/api/me/registrations/${id}`, undefined, [201]);
// Cambiar la industria del perfil cambia la agenda (con el usuario desechable, para no tocar los demo)
await check("cambiar industria a tech", "PATCH", "/api/me", { industry: "tech" });
const agAfter = await check("agenda edu día 0 tras el cambio", "GET", "/api/events/edu/sessions?day=0");
if (titles(agAfter) !== titles(agTech) || titles(agAfter) === titles(agMine)) {
  failed++; console.log("    ✗ tras cambiar a tech la agenda debería ser la de tecnología");
}
await check("cliente no puede registrar «supresion»", "POST", "/api/me/consents", { type: "supresion" }, [400]);
const del = await check("borrar mi cuenta", "DELETE", "/api/me");
console.log(`    borrado: ${JSON.stringify(del?.deleted)} · consentimientos conservados: ${del?.consentsRetained}`);
if (del?.deleted?.registrations !== REAL_IDS.length) { failed++; console.log(`    ✗ debería haber borrado ${REAL_IDS.length} inscripciones`); }
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

// ───── Panel de creador de eventos (/api/admin/*): roles, borrador → publicado, agenda y misiones ─────
{
  const legalUser = async (name, role) => (await sql(
    `INSERT INTO users (email, name, industry, role, company, legal_version, account_role) VALUES ($1, $2, 'tech', 'Producer', 'KNET Smoke', $3, $4) RETURNING id`,
    [`smoke.${name.toLowerCase()}.${Date.now()}@knet.local`, `Smoke ${name}`, LEGAL_V, role])).rows[0].id;
  const orgA = await legalUser("OrgA", "organizer"), orgB = await legalUser("OrgB", "organizer"), att = await legalUser("Asistente", "attendee");
  const adm = await legalUser("Admin", "admin");
  token = null;
  userId = att;
  const noRole = await check("asistente en /api/admin → 403", "GET", "/api/admin/events", undefined, [403]);
  if (noRole?.error !== "forbidden_role") { failed++; console.log("    ✗ debería ser forbidden_role"); }
  token = "no.es.un.jwt";
  await check("admin con token inválido → 401", "GET", "/api/admin/events", undefined, [401]);
  token = null;

  userId = orgA;
  const meOrg = await check("perfil del organizador", "GET", "/api/me");
  if (meOrg?.user?.accountRole !== "organizer") { failed++; console.log("    ✗ /api/me debería traer accountRole organizer"); }
  const badEv = await check("crear evento sin nombre válido", "POST", "/api/admin/events", { name: "x", city: "Cali" }, [400]);
  if (!badEv?.issues?.some((i) => i.path === "name" && /al menos 3/.test(i.message))) { failed++; console.log("    ✗ el error de validación debería estar en español"); }
  const created = await check("crear borrador", "POST", "/api/admin/events",
    { name: "Smoke Summit de Datos", city: "Cali", venueName: "Centro de eventos Valle", tags: ["Datos", "IA"], industries: ["tech"],
      description: "Encuentro de prueba del smoke para equipos de datos." }, [201]);
  const evId = created?.event?.id;
  if (!/^o[a-z0-9]{9}$/.test(evId ?? "") || created?.event?.status !== "draft" || !created?.event?.hosted) { failed++; console.log("    ✗ el evento debería nacer como borrador hosted con id o<9>"); }
  const mine = await check("mis eventos creados", "GET", "/api/admin/events");
  if (!mine?.events?.some((e) => e.id === evId)) { failed++; console.log("    ✗ el borrador debería aparecer en mis eventos"); }
  await check("publicar incompleto → 400", "POST", `/api/admin/events/${evId}/publish`, undefined, [400]);
  userId = att;
  const pubList = await check("catálogo sin el borrador", "GET", "/api/events");
  if (pubList?.events?.some((e) => e.id === evId)) { failed++; console.log("    ✗ el borrador no debería salir en /api/events"); }
  await check("detalle del borrador → 404", "GET", `/api/events/${evId}`, undefined, [404]);
  await check("inscribirse en un borrador → 404", "POST", `/api/me/registrations/${evId}`, undefined, [404]);

  userId = orgA;
  await check("días desordenados → 400", "PUT", `/api/admin/events/${evId}/days`, { days: ["2027-05-11", "2027-05-10"] }, [400]);
  await check("días", "PUT", `/api/admin/events/${evId}/days`, { days: ["2027-05-10", "2027-05-11"] });
  await check("ficha", "PUT", `/api/admin/events/${evId}/info`, { info: {
    tone: ["#1E1452", "#0E3A4A"], accent: "#BE82FF", lema: "Datos que se usan", para: "Equipos de datos", formato: ["Presencial", "2 días"],
    agenda: [["08:00", "Registro", "Entrega de credenciales"]], llevas: ["Casos aplicables"] } });
  await check("ficha con color inválido → 400", "PUT", `/api/admin/events/${evId}/info`, { info: { tone: ["rojo", "#000"], accent: "#fff", lema: "", para: "", formato: [], agenda: [], llevas: [] } }, [400]);
  const tpl = await check("plantilla de recinto (and)", "GET", "/api/events/and");
  await check("recinto 3D", "PUT", `/api/admin/events/${evId}/venue`, { venue: tpl.event.venue });
  await check("recinto inválido → 400", "PUT", `/api/admin/events/${evId}/venue`, { venue: { ...tpl.event.venue, ent: "NOPE" } }, [400]);
  const sp = await check("speaker", "POST", `/api/admin/events/${evId}/speakers`, { name: "Laura Gómez", role: "CDO", org: "Datalab", bio: "Lidera datos.", talk: "Gobierno de datos" }, [201]);
  await check("speaker repetido → 409", "POST", `/api/admin/events/${evId}/speakers`, { name: "Laura Gómez" }, [409]);
  await check("editar speaker", "PATCH", `/api/admin/events/${evId}/speakers/${sp.speaker.id}`, { org: "Datalab S.A.S." });
  await check("charla en un día inexistente → 400", "POST", `/api/admin/events/${evId}/sessions`, { day: 5, time: "09:00", kind: "Keynote", title: "Nunca" }, [400]);
  const s0 = await check("charla día 1", "POST", `/api/admin/events/${evId}/sessions`, { day: 0, time: "10:00", kind: "Keynote", title: "Gobierno de datos en la práctica", room: "Auditorio", speaker: "Laura Gómez", tag: "Datos" }, [201]);
  await check("otra charla día 1", "POST", `/api/admin/events/${evId}/sessions`, { day: 0, time: "08:30", kind: "Taller", title: "Taller de calidad de datos", room: "Sala 2" }, [201]);
  await check("charla día 2", "POST", `/api/admin/events/${evId}/sessions`, { day: 1, time: "09:00", kind: "Panel", title: "Panel de IA responsable" }, [201]);
  await check("charla con hora inválida → 400", "POST", `/api/admin/events/${evId}/sessions`, { day: 0, time: "25:00", kind: "Panel", title: "Hora mala" }, [400]);
  if (s0?.session?.code !== `${evId}:0:0`) { failed++; console.log("    ✗ la primera charla debería tener el código evento:0:0"); }
  const mi = await check("misión", "POST", `/api/admin/events/${evId}/missions`, { type: "presencial", title: "Visita la feria de datos", condition: "Escanea el tótem de la feria", xp: 120 }, [201]);
  await check("misión con XP fuera de rango → 400", "POST", `/api/admin/events/${evId}/missions`, { type: "quiz", title: "Demasiada XP", xp: 9999 }, [400]);

  userId = orgB;
  await check("otro organizador no lo ve", "GET", `/api/admin/events/${evId}`, undefined, [403]);
  const notOwner = await check("otro organizador no lo edita", "PATCH", `/api/admin/events/${evId}`, { name: "Robado" }, [403]);
  if (notOwner?.error !== "not_owner") { failed++; console.log("    ✗ debería ser not_owner"); }
  await check("otro organizador no lo borra", "DELETE", `/api/admin/events/${evId}`, undefined, [403]);

  userId = orgA;
  const pub = await check("publicar", "POST", `/api/admin/events/${evId}/publish`);
  if (pub?.event?.status !== "published" || pub?.event?.counts?.sessions !== 3) { failed++; console.log("    ✗ debería quedar publicado con 3 charlas"); }

  userId = att;
  const list2 = await check("catálogo con el evento publicado", "GET", "/api/events");
  if (!list2?.events?.some((e) => e.id === evId && e.hosted && e.days.length === 2)) { failed++; console.log("    ✗ el evento publicado debería salir en /api/events con hosted y 2 días"); }
  const det = await check("detalle del evento publicado", "GET", `/api/events/${evId}`);
  if (det?.event?.sessions?.length !== 3 || det?.event?.missions?.length !== 1 || !det?.event?.venue || det?.event?.speakers?.[0]?.org !== "Datalab S.A.S.") {
    failed++; console.log("    ✗ el detalle debería traer 3 charlas, 1 misión, recinto y el speaker editado");
  }
  const day0 = await check("agenda del día 1", "GET", `/api/events/${evId}/sessions?day=0`);
  if (day0?.sessions?.length !== 2 || !day0.sessions.some((s) => s.speaker === "Laura Gómez")) { failed++; console.log("    ✗ la agenda del día 1 debería tener 2 charlas con su ponente"); }
  await check("misión del evento sin inscripción → 404", "POST", `/api/me/missions/${mi.mission.code}/complete`, undefined, [404]);
  await check("inscribirse en el evento creado", "POST", `/api/me/registrations/${evId}`, undefined, [201]);
  const myMs = await check("mis misiones incluyen la del evento", "GET", "/api/me/missions");
  if (!myMs?.missions?.some((m) => m.code === mi.mission.code && m.kind === "event" && m.eventId === evId)) { failed++; console.log("    ✗ la misión del evento debería salir para el inscrito"); }
  const done = await check("completar la misión del evento", "POST", `/api/me/missions/${mi.mission.code}/complete`, undefined, [201]);
  if (done?.xpAwarded !== 120) { failed++; console.log("    ✗ la misión del evento debería sumar 120 XP"); }
  await check("check-in en una charla creada", "POST", "/api/me/checkins", { sessionCode: `${evId}:0:0` }, [201]);

  // Admin: ve los eventos de todos los organizadores (con su dueño) y los del catálogo (solo lectura)
  userId = orgB;
  const onlyMine = await check("un organizador con ?all=1 solo ve los suyos", "GET", "/api/admin/events?all=1");
  if (onlyMine?.events?.some((e) => e.id === evId || e.catalog)) { failed++; console.log("    ✗ ?all=1 solo aplica a los admin"); }
  userId = adm;
  const all = await check("admin: todos los eventos", "GET", "/api/admin/events?all=1");
  const other = all?.events?.find((e) => e.id === evId), cat = all?.events?.find((e) => e.id === "and");
  if (other?.owner?.name !== "Smoke OrgA" || other?.catalog !== false || cat?.catalog !== true || cat?.owner !== null) {
    failed++; console.log("    ✗ el admin debería ver el evento de OrgA con su dueño y los del catálogo marcados");
  }
  const admMine = await check("admin sin ?all: solo los suyos", "GET", "/api/admin/events");
  if (admMine?.events?.length !== 0) { failed++; console.log("    ✗ sin ?all=1 el admin solo ve los que creó"); }
  const admEdit = await check("admin edita el evento de otro organizador", "PATCH", `/api/admin/events/${evId}`, { venueName: "Centro de eventos (editado por admin)" });
  if (admEdit?.event?.venueName !== "Centro de eventos (editado por admin)" || admEdit?.event?.owner?.name !== "Smoke OrgA") { failed++; console.log("    ✗ la edición del admin debería guardarse sin cambiar el dueño"); }
  await check("admin agrega una charla a ese evento", "POST", `/api/admin/events/${evId}/sessions`, { day: 1, time: "11:00", kind: "Charla", title: "Charla agregada por el admin" }, [201]);
  await check("admin lee un evento del catálogo", "GET", "/api/admin/events/and");
  const catEdit = await check("admin no edita el catálogo sembrado", "PATCH", "/api/admin/events/and", { name: "Cambiado" }, [409]);
  if (catEdit?.error !== "catalog_event") { failed++; console.log("    ✗ debería ser catalog_event"); }
  // La cuenta admin es de gestión: no se inscribe, no comparte QR ni escanea credenciales
  const admReg = await check("admin no se inscribe a eventos", "POST", "/api/me/registrations/and", undefined, [403]);
  const admQr = await check("admin no tiene QR de asistente", "GET", "/api/me/qr-token", undefined, [403]);
  const admScan = await check("admin no escanea credenciales", "POST", "/api/me/connections/scan", { token: "x" }, [403]);
  if ([admReg, admQr, admScan].some((r) => r?.error !== "admin_account")) { failed++; console.log("    ✗ debería ser admin_account"); }

  userId = orgA;
  await check("despublicar", "POST", `/api/admin/events/${evId}/unpublish`);
  userId = att;
  await check("despublicado → 404 en el catálogo", "GET", `/api/events/${evId}`, undefined, [404]);
  userId = orgA;
  await check("un organizador no borra el catálogo sembrado", "DELETE", "/api/admin/events/and", undefined, [403]);
  await check("borrar el evento", "DELETE", `/api/admin/events/${evId}`, undefined, [204]);
  await check("evento borrado → 404", "GET", `/api/admin/events/${evId}`, undefined, [404]);
  for (const id of [att, orgA, orgB, adm]) { userId = id; await check("limpiar usuario de prueba", "DELETE", "/api/me"); }
  userId = null;
}

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
