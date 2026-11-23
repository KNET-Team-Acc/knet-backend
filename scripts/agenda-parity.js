/**
 * Prueba de paridad de la agenda: compara sessionsFor() del frontend con el port del servidor.
 *
 * 1. Extrae sessionsFor(), seeded() y hashStr() de knet-frontend/src/lib/engine/knetApp.js y los
 *    ejecuta con los datos del frontend (src/data/). Compara cada (industria, evento, día) distinto
 *    de bog:0 con generateAgenda() de src/lib/agenda.js.
 * 2. Si la API está en marcha, compara también GET /api/events/:id/sessions?day=&industry= (lo sembrado).
 *    Solo hace GET: no modifica ningún usuario.
 *
 * Uso: npm run parity   (FRONTEND_DIR=../knet-frontend y API_URL=http://localhost:4000 por defecto)
 * Con --no-api se salta la parte 2.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateAgenda } from "../src/lib/agenda.js";

const FRONT = path.resolve(process.env.FRONTEND_DIR || "../knet-frontend");
const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`;
const skipApi = process.argv.includes("--no-api");
const engineFile = path.join(FRONT, "src/lib/engine/knetApp.js");

let src;
try { src = await readFile(engineFile, "utf8"); } catch {
  console.error(`No encuentro ${engineFile}. Indica la ruta del frontend con FRONTEND_DIR.`);
  process.exit(1);
}
const { EVENTS, EV_DAYS } = await import(pathToFileURL(path.join(FRONT, "src/data/events.js")).href);
EVENTS.forEach((e) => { e.days = EV_DAYS[e.id] || ["2026-12-10"]; }); // igual que bootKnetApp()
const { IND, PERSONAS } = await import(pathToFileURL(path.join(FRONT, "src/data/industries.js")).href);

/** Devuelve el texto de la función `function <name>(` hasta su llave de cierre */
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`No encontré function ${name}() en knetApp.js`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name}() sin cierre`);
}
const hashLine = src.match(/const hashStr = .*;\s*$/m)?.[0];
if (!hashLine) throw new Error("No encontré const hashStr en knetApp.js");

// sessionsFor() del frontend, aislado: A.ind se cambia por industria; ideaOf/INSIGHTS no influyen en la paridad
const A = { ind: null };
const frontSessionsFor = new Function("EVENTS", "IND", "PERSONAS", "A", "INSIGHTS", "ideaOf",
  `${hashLine}\n${extractFunction("seeded")}\nfunction evById(id) { return EVENTS.find(e => e.id === id); }\n` +
  `${extractFunction("sessionsFor")}\nreturn sessionsFor;`)(EVENTS, IND, PERSONAS, A, {}, () => null);

const frontToApi = (s) => ({ code: s.id, day: s.day, slot: s.i, time: s.tm, kind: s.kind, title: s.ttl, room: s.room, tag: s.tag, why: s.why });
const FIELDS = ["code", "day", "slot", "time", "kind", "title", "room", "tag", "why"];

let cases = 0, failed = 0;
function compare(label, expected, actual) {
  cases++;
  const diffs = [];
  if (expected.length !== actual.length) diffs.push(`${expected.length} sesiones esperadas, llegaron ${actual.length}`);
  expected.forEach((e, i) => {
    for (const f of FIELDS) if (e[f] !== actual[i]?.[f]) diffs.push(`[${i}].${f}: «${e[f]}» ≠ «${actual[i]?.[f]}»`);
  });
  if (diffs.length) { failed++; console.log(`✗ ${label}\n    ${diffs.slice(0, 5).join("\n    ")}`); }
}

const apiUp = !skipApi && await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
if (!skipApi && !apiUp) console.log(`(API no disponible en ${BASE}: solo se compara el port)\n`);

for (const ind of Object.keys(IND)) {
  A.ind = ind;
  for (const ev of EVENTS) {
    for (let di = 0; di < ev.days.length; di++) {
      if (ev.id === "bog" && di === 0) continue; // agenda curada, no generada
      const expected = frontSessionsFor(ev.id, di).map(frontToApi);
      compare(`port ${ind} ${ev.id}:${di}`, expected, generateAgenda(ev, di, ind, IND[ind], PERSONAS[ind].interests));
      if (apiUp) {
        const r = await fetch(`${BASE}/api/events/${ev.id}/sessions?day=${di}&industry=${ind}`);
        const body = await r.json();
        if (!r.ok) { cases++; failed++; console.log(`✗ api ${ind} ${ev.id}:${di} → ${r.status} ${JSON.stringify(body)}`); continue; }
        compare(`api ${ind} ${ev.id}:${di}`, expected, body.sessions);
      }
    }
  }
}

console.log(failed ? `\n${failed} de ${cases} comparaciones fallaron` : `\nParidad OK: ${cases} comparaciones (${apiUp ? "port + API" : "solo port"})`);
process.exit(failed ? 1 : 0);
