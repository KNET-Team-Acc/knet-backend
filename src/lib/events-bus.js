/**
 * Bus de eventos en tiempo real para GET /api/me/stream (Server-Sent Events).
 *
 * - En memoria: cada evento va dirigido a un usuario (userId) y se entrega a todas sus conexiones SSE.
 * - Reanudación: se guardan los últimos REPLAY_MAX eventos de cada usuario durante REPLAY_TTL_MS; un
 *   cliente que vuelve con Last-Event-ID recibe los que se perdió (si el id ya no está en el buffer,
 *   recibe todo lo que quede guardado).
 * - Varias instancias: con EVENTS_PG_NOTIFY=true cada evento se publica con NOTIFY en PostgreSQL y todas
 *   las instancias lo reciben con LISTEN (también la que lo emitió), así el cliente puede estar
 *   conectado a cualquiera. Sin esa opción el bus es local al proceso (suficiente con una instancia).
 *
 * Tipos: connection.request, connection.accepted, message.new, coffee.updated.
 */
import { EventEmitter } from "node:events";
import pg from "pg";
import { config } from "../config.js";

export const EVENT_TYPES = ["connection.request", "connection.accepted", "message.new", "coffee.updated"];
const CHANNEL = "knet_events";
const REPLAY_MAX = 100;
const REPLAY_TTL_MS = 5 * 60_000;

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // una escucha por conexión SSE
const replay = new Map(); // userId → [{ id, type, data, at }]
let seq = 0;
let listener = null; // cliente pg dedicado a LISTEN

/** Id ordenable y único entre instancias: <ms>-<pid>-<secuencia> */
const nextId = () => `${Date.now()}-${process.pid}-${++seq}`;

function remember(ev) {
  const now = Date.now();
  const list = (replay.get(ev.userId) || []).filter((e) => now - e.at < REPLAY_TTL_MS);
  list.push(ev);
  if (list.length > REPLAY_MAX) list.splice(0, list.length - REPLAY_MAX);
  replay.set(ev.userId, list);
}

function deliver(ev) {
  remember(ev);
  emitter.emit(ev.userId, ev);
}

/** Publica un evento para userId. Nunca lanza: el tiempo real no debe romper la petición que lo origina. */
export function publish(userId, type, data = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Tipo de evento desconocido: ${type}`);
  const ev = { id: nextId(), userId, type, data, at: Date.now() };
  if (listener) {
    const payload = JSON.stringify(ev);
    if (Buffer.byteLength(payload) < 7900) { // límite de NOTIFY: 8000 bytes
      listener.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]).catch((e) => {
        console.error(`[eventos] NOTIFY falló, se entrega solo en esta instancia: ${e.message}`);
        deliver(ev);
      });
      return ev;
    }
  }
  deliver(ev);
  return ev;
}

/** Suscribe fn(ev) a los eventos de userId. Devuelve la función para cancelar. */
export function subscribe(userId, fn) {
  emitter.on(userId, fn);
  return () => emitter.off(userId, fn);
}

/** Eventos guardados de userId posteriores a lastId (todos si lastId no está o no se envió) */
export function missedSince(userId, lastId) {
  const now = Date.now();
  const list = (replay.get(userId) || []).filter((e) => now - e.at < REPLAY_TTL_MS);
  if (!lastId) return [];
  const i = list.findIndex((e) => e.id === lastId);
  return i === -1 ? list : list.slice(i + 1);
}

export const subscriberCount = (userId) => emitter.listenerCount(userId);

/** Activa LISTEN/NOTIFY (EVENTS_PG_NOTIFY=true). Se llama al arrancar el servidor. */
export async function startEventsBus() {
  if (!config.eventsPgNotify || listener) return;
  const c = new pg.Client({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  c.on("notification", (msg) => {
    try { deliver(JSON.parse(msg.payload)); } catch { /* payload inválido: se ignora */ }
  });
  c.on("error", (e) => { console.error(`[eventos] LISTEN perdió la conexión: ${e.message}`); listener = null; });
  await c.connect();
  await c.query(`LISTEN ${CHANNEL}`);
  listener = c;
  console.log("[eventos] LISTEN/NOTIFY activo (varias instancias)");
}

export async function stopEventsBus() {
  emitter.emit("__close__");
  if (listener) { const c = listener; listener = null; await c.end().catch(() => {}); }
}

/** fn() se llama cuando el servidor se apaga (las conexiones SSE se cierran para no bloquear el cierre) */
export const onClose = (fn) => { emitter.once("__close__", fn); return () => emitter.off("__close__", fn); };
