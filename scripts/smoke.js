/**
 * Prueba rápida de la API contra un servidor en marcha (npm run dev en otra terminal).
 * Uso: npm run smoke   (API_URL=http://localhost:4000 por defecto)
 * Usa el usuario demo de energía para no ensuciar el usuario demo por defecto (tech).
 * Se puede repetir: los check-ins/misiones ya hechos devuelven 409 y cuentan como OK.
 */
import "dotenv/config";

const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`;
let userId = null;
let failed = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(userId ? { "X-User-Id": userId } : {}) },
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
const { rows } = await import("pg").then(async ({ default: pg }) => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { return await c.query("SELECT id FROM users WHERE email = 'demo.energia@knet.local'"); } finally { await c.end(); }
});
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
await check("solicitud pendiente", "POST", "/api/me/connections", { name: "Paula B." }, [201, 409]);
await check("mis conexiones", "GET", "/api/me/connections");

await check("generar dossier", "POST", "/api/me/dossiers/bog", { ideas: ["Los gemelos digitales rinden más en activos críticos."], plan: ["Priorizar 2 activos críticos"] }, [200, 201]);
const dos = await check("leer dossier", "GET", "/api/me/dossiers/bog");
console.log(`    sesiones: ${dos.dossier.content.summary.sessionsAttended.length} · contactos: ${dos.dossier.content.summary.contacts.length} · XP: ${dos.dossier.content.summary.xp}`);
await check("dossier sin inscripción", "POST", "/api/me/dossiers/and", {}, [403]);

console.log(failed ? `\n${failed} prueba(s) fallaron` : "\nTodas las pruebas pasaron");
process.exit(failed ? 1 : 0);
