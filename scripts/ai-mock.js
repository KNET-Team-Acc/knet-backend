/**
 * Prueba de /api/ai/* sin gastar tokens: el SDK oficial de Anthropic hace sus peticiones normales y
 * fetch las intercepta antes de salir (respuestas simuladas de /v1/messages). Verifica el prompt (RAG
 * con sesiones reales, sin correo), el fallback de servidor, el manejo de rechazos y errores, que la key
 * no aparezca en logs ni respuestas, y el rate limit por usuario.
 * Uso: npm run test:ai   (necesita la base de datos con el seed; no necesita la API en marcha)
 */
const KEY = "sk-ant-test-key-que-no-debe-filtrarse";
process.env.AI_API_KEY = KEY;
process.env.AI_RATE_LIMIT = "12";
process.env.AI_TIMEOUT_MS = "5000";

const { createApp } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

const logs = [];
const origError = console.error;
console.error = (...a) => { logs.push(a.join(" ")); };

let mode = "ok";
let lastBody = null;
let lastHeaders = null;
let calls = 0;
const realFetch = globalThis.fetch;
const message = (content, stop = "end_turn") => new Response(JSON.stringify({
  id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5-5", content,
  stop_reason: stop, stop_sequence: null, stop_details: stop === "refusal" ? { type: "refusal", category: null, explanation: "" } : null,
  usage: { input_tokens: 10, output_tokens: 10 },
}), { status: 200, headers: { "content-type": "application/json", "request-id": "req_mock" } });

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith("https://api.anthropic.com/")) return realFetch(url, init);
  calls++;
  lastBody = JSON.parse(init.body);
  lastHeaders = new Headers(init.headers);
  if (mode === "error") return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }), { status: 500, headers: { "content-type": "application/json", "x-should-retry": "false" } });
  if (mode === "refusal") return message([], "refusal");
  if (lastBody.output_config?.format) {
    return message([{ type: "text", text: JSON.stringify({
      resumen: "Cerraste el Summit con buena actividad.", ideas: ["Los datos guían la transición energética."],
      plan: ["Escribir a tus conexiones esta semana."], paraTi: "Prioriza los pilotos con métricas claras." }) }]);
  }
  const sys = lastBody.system || "";
  const title = /"titulo":"([^"]+)"/.exec(sys)?.[1] ?? "sin sesiones";
  return message([{ type: "text", text: `Te recomiendo «${title}».` }]);
};

const server = createApp().listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const { rows: [demo] } = await pool.query("SELECT id, email FROM users WHERE email = 'demo.energia@knet.local'");
let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) failed++; };
const post = async (path, body) => {
  const r = await realFetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": demo.id }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

try {
  const chat = await post("/api/ai/chat", { message: "¿Qué sesión sigue?", eventId: "and", day: 0, history: [{ role: "assistant", content: "Hola" }, { role: "user", content: "Hola" }, { role: "assistant", content: "¿En qué te ayudo?" }] });
  ok(chat.status === 200 && chat.json.reply.startsWith("Te recomiendo"), "chat responde con el texto del modelo");
  ok(lastBody.model === "claude-opus-5-5" && lastBody.fallbacks === "default" && (lastHeaders.get("anthropic-beta") || "").includes("server-side-fallback-2026-07-01"), "usa claude-opus-5-5 con server-side fallback");
  ok(/sesionesDelDia/.test(lastBody.system) && chat.json.sources.length === 1, "RAG: el prompt lleva las sesiones reales y la respuesta cita una (sources)");
  ok(!lastBody.system.includes(demo.email) && !lastBody.system.includes(demo.id), "no envía correo ni id del usuario al proveedor");
  ok(lastBody.messages[0].role === "user" && lastBody.messages.at(-1).content === "¿Qué sesión sigue?", "historial empieza por el usuario y termina con el mensaje nuevo");

  const sim = await post("/api/ai/simulate", { contactName: "Felipe L.", message: "¡Hola! ¿Qué te trae al Summit?" });
  ok(sim.status === 200 && !!sim.json.reply && /Felipe L\./.test(lastBody.system), "simulate interpreta al contacto");
  ok((await post("/api/ai/simulate", { contactName: "Nadie Existe", message: "hola" })).status === 404, "simulate con contacto inexistente → 404");

  const dos = await post("/api/ai/dossier", { eventId: "and" });
  ok([200, 201].includes(dos.status) && dos.json.dossier.content.generatedBy === "ai", "dossier generado por la IA y guardado");
  ok(Array.isArray(dos.json.dossier.content.summary.sessionsAttended) && typeof dos.json.dossier.content.summary.xp === "number", "el dossier guarda el resumen real (check-ins, conexiones, XP)");
  ok(/sesionesConCheckIn/.test(lastBody.messages[0].content) && /porMotivo/.test(lastBody.messages[0].content), "el prompt del dossier usa check-ins y xp_ledger");
  await pool.query("DELETE FROM registrations WHERE user_id = $1 AND event_id = 'adc'", [demo.id]); // adc: sin inscripción
  ok((await post("/api/ai/dossier", { eventId: "adc" })).status === 403, "dossier de un evento sin inscripción → 403");

  mode = "refusal";
  const ref = await post("/api/ai/chat", { message: "hola" });
  ok(ref.status === 503 && ref.json.error === "ai_unavailable", "rechazo del modelo → 503 ai_unavailable");

  mode = "error"; calls = 0;
  const err = await post("/api/ai/chat", { message: "hola" });
  ok(err.status === 503 && err.json.error === "ai_unavailable", "error del proveedor → 503 ai_unavailable");

  mode = "ok";
  const bad = await post("/api/ai/chat", { message: "x".repeat(1001) });
  ok(bad.status === 400, "mensaje demasiado largo → 400");

  let limited = null;
  for (let i = 0; i < 15 && !limited; i++) { const r = await post("/api/ai/chat", { message: "hola" }); if (r.status === 429) limited = r; }
  ok(limited?.json?.error === "rate_limited", "superar el rate limit por usuario → 429");

  const everything = JSON.stringify(logs);
  ok(!everything.includes(KEY), "la key no aparece en los logs");
} finally {
  console.error = origError;
  server.close();
  await pool.end();
}
console.log(failed ? `\n${failed} prueba(s) fallaron` : "\nIA OK");
process.exit(failed ? 1 : 0);
