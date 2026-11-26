/**
 * Paridad de los recintos 3D/AR: compara VENUES y GROUND de knet-frontend/src/data/venues.js con la copia
 * del backend (db/data/venues.js, la que siembra events.venue). Si la API está en marcha, comprueba también
 * que GET /api/events/:id devuelva el recinto sembrado (solo GET).
 *
 * Uso: npm run parity:venues   (FRONTEND_DIR=../knet-frontend y API_URL=http://localhost:4000 por defecto)
 * Con --no-api se salta la comprobación de la API.
 */
import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as BACK from "../db/data/venues.js";

const FRONT = path.resolve(process.env.FRONTEND_DIR || "../knet-frontend");
const BASE = process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`;
const skipApi = process.argv.includes("--no-api");

let FRONT_V;
try { FRONT_V = await import(pathToFileURL(path.join(FRONT, "src/data/venues.js")).href); } catch {
  console.error(`No encuentro ${path.join(FRONT, "src/data/venues.js")}. Indica la ruta del frontend con FRONTEND_DIR.`);
  process.exit(1);
}

let cases = 0, failed = 0;
const check = (label, ok, detail = "") => { cases++; if (!ok) { failed++; console.log(`✗ ${label}${detail ? `\n    ${detail}` : ""}`); } };

const ids = [...new Set([...Object.keys(FRONT_V.VENUES), ...Object.keys(BACK.VENUES)])].sort();
for (const id of ids) {
  const f = FRONT_V.VENUES[id], b = BACK.VENUES[id];
  check(`recinto ${id}`, isDeepStrictEqual(f, b), !f ? "solo está en el backend" : !b ? "solo está en el frontend" : "difiere: copia src/data/venues.js del frontend a db/data/venues.js");
}
check("GROUND", isDeepStrictEqual(FRONT_V.GROUND, BACK.GROUND), "difiere: copia src/data/venues.js del frontend a db/data/venues.js");

const apiUp = !skipApi && await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
if (!skipApi && !apiUp) console.log(`(API no disponible en ${BASE}: solo se comparan los archivos)\n`);
if (apiUp) {
  for (const id of Object.keys(BACK.VENUES)) {
    const r = await fetch(`${BASE}/api/events/${id}`);
    if (r.status === 404) continue; // recinto sin evento publicado
    const body = await r.json().catch(() => null);
    check(`api ${id}`, r.ok && isDeepStrictEqual(body?.event?.venue, BACK.VENUES[id]), r.ok ? "el venue de la API no coincide: vuelve a correr npm run db:seed" : `HTTP ${r.status}`);
  }
}

console.log(failed ? `\n${failed} de ${cases} comprobaciones fallaron` : `\nParidad de recintos OK: ${cases} comprobaciones (${apiUp ? "archivos + API" : "solo archivos"})`);
process.exit(failed ? 1 : 0);
