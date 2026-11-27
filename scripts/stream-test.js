/**
 * Prueba de GET /api/me/stream (SSE): recibe connection.request y connection.accepted sin recargar,
 * manda heartbeat y, al reconectar con Last-Event-ID, entrega los eventos perdidos.
 * Uso: npm run test:stream   (necesita la base de datos con el seed; no necesita la API en marcha)
 *      EVENTS_PG_NOTIFY=true npm run test:stream  → prueba el reparto entre instancias con LISTEN/NOTIFY
 */
process.env.SSE_HEARTBEAT_MS = "300";

const { createApp } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { startEventsBus, stopEventsBus } = await import("../src/lib/events-bus.js");
await startEventsBus(); // solo hace algo con EVENTS_PG_NOTIFY=true

const server = createApp().listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const { rows: [demo] } = await pool.query("SELECT id FROM users WHERE email = 'demo.energia@knet.local'");
const H = { "Content-Type": "application/json", "X-User-Id": demo.id };
let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Abre el stream y acumula los frames SSE parseados en `events` (y los heartbeats en `pings`) */
async function openStream(path, headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(BASE + path, { headers, signal: ctrl.signal });
  const state = { res, events: [], pings: 0, close: () => ctrl.abort() };
  if (res.status !== 200) return state;
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          if (raw.startsWith(": ping")) { state.pings++; continue; }
          const f = Object.fromEntries(raw.split("\n").filter((l) => !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
          if (f.event) state.events.push({ id: f.id, type: f.event, data: JSON.parse(f.data) });
        }
      }
    } catch { /* abortado */ }
  })();
  return state;
}

const api = (method, path, body) => fetch(BASE + path, { method, headers: H, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: r.status === 204 ? null : await r.json() }));

try {
  // Estado limpio: sin conexión con el contacto de prueba
  const name = "Paula B.";
  const prev = (await api("GET", "/api/me/connections")).json.connections.find((c) => c.contact.name === name);
  if (prev) await api("DELETE", `/api/me/connections/${prev.id}`);

  const s1 = await openStream(`/api/me/stream?userId=${demo.id}`); // EventSource no envía headers
  ok(s1.res.status === 200 && s1.res.headers.get("content-type").startsWith("text/event-stream"), "abre el stream (text/event-stream)");
  const created = await api("POST", "/api/me/connections", { name });
  await sleep(150);
  ok(s1.events.at(-1)?.type === "connection.request" && s1.events.at(-1).data.connection.id === created.json.connection.id, "recibe connection.request sin recargar");
  await sleep(500);
  ok(s1.pings >= 1, "envía heartbeat");
  const lastId = s1.events.at(-1).id;
  s1.close();

  // Mientras está desconectado se acepta la solicitud: el evento se guarda para la reconexión
  await api("PATCH", `/api/me/connections/${created.json.connection.id}`, { status: "accepted" });
  const s2 = await openStream("/api/me/stream", { ...H, "Last-Event-ID": lastId });
  await sleep(150);
  ok(s2.events.length === 1 && s2.events[0].type === "connection.accepted", "al reconectar con Last-Event-ID recibe solo lo que se perdió");
  s2.close();

  const login = await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `stream.${Date.now()}@knet.local`, password: "clave-segura-1", name: "Stream Test", acceptLegal: true, legalVersion: "1.2" }) }).then((r) => r.json());
  const s3 = await openStream(`/api/me/stream?access_token=${encodeURIComponent(login.accessToken)}`);
  ok(s3.res.status === 200, "acepta el access token por query (EventSource)");
  s3.close();
  const bad = await openStream("/api/me/stream?access_token=no.vale");
  ok(bad.res.status === 401, "token inválido → 401");
  await fetch(BASE + "/api/me", { method: "DELETE", headers: { Authorization: `Bearer ${login.accessToken}` } });

  await api("DELETE", `/api/me/connections/${created.json.connection.id}`);

  // Solicitud entre usuarios reales (knet-backend#24): le llega en vivo al destinatario y, si la rechaza, a quien la pidió
  const legal = process.env.LEGAL_VERSION || "1.2";
  const realUser = async (name) => (await pool.query(
    `INSERT INTO users (email, name, industry, role, company, legal_version) VALUES ($1, $2, 'tech', 'CTO', 'Acme', $3) RETURNING id`,
    [`stream.${name.toLowerCase()}.${Date.now()}@knet.local`, `Stream ${name}`, legal])).rows[0].id;
  const ana = await realUser("Ana"), beto = await realUser("Beto");
  try {
    await pool.query("INSERT INTO registrations (user_id, event_id) VALUES ($1, 'and'), ($2, 'and') ON CONFLICT DO NOTHING", [ana, beto]);
    const as = (id) => ({ "Content-Type": "application/json", "X-User-Id": id });
    const call = (id, method, path, body) => fetch(BASE + path, { method, headers: as(id), body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: r.status === 204 ? null : await r.json() }));
    const sA = await openStream(`/api/me/stream?userId=${ana}`), sB = await openStream(`/api/me/stream?userId=${beto}`);
    const req = await call(ana, "POST", "/api/me/connections", { peerUserId: beto, eventId: "and" });
    await sleep(150);
    const inB = sB.events.find((e) => e.type === "connection.request");
    ok(req.status === 201 && inB?.data.connection.direction === "incoming" && inB.data.connection.contact.userId === ana && inB.data.connection.status === "pending",
      "el destinatario recibe connection.request con direction incoming");
    ok(sA.events.at(-1)?.type === "connection.request" && sA.events.at(-1).data.connection.direction === "outgoing", "quien la pide la ve como outgoing en sus otras sesiones");
    const del = await call(beto, "DELETE", `/api/me/connections/${inB?.data.connection.id}`);
    await sleep(150);
    const rmA = sA.events.find((e) => e.type === "connection.removed");
    ok(del.status === 204 && rmA?.data.connectionId === req.json.connection.id && rmA.data.reason === "declined" && rmA.data.peerUserId === beto,
      "al rechazarla, quien la pidió recibe connection.removed (declined) con el id de su fila");
    sA.close(); sB.close();
  } finally {
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ana, beto]]);
  }
} finally {
  await stopEventsBus();
  server.closeAllConnections?.();
  server.close();
  await pool.end();
}
console.log(failed ? `\n${failed} prueba(s) fallaron` : "\nTiempo real OK");
process.exit(failed ? 1 : 0);
