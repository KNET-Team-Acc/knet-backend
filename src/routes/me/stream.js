/**
 * GET /api/me/stream → Server-Sent Events con los eventos en tiempo real del usuario:
 * connection.request, connection.accepted, message.new, coffee.updated (ver src/lib/events-bus.js).
 *
 * - Heartbeat (comentario «: ping») cada SSE_HEARTBEAT_MS (25 s) para que proxies y balanceadores no corten.
 * - Reanudación: EventSource reenvía solo el header Last-Event-ID al reconectar; también se acepta
 *   ?lastEventId=. Se envían primero los eventos perdidos que sigan en el buffer (5 min).
 * - EventSource no permite headers propios: el token puede ir en ?access_token= (lo copia
 *   streamAuthFromQuery antes de resolveUser). El token se valida al conectar; si caduca, la conexión
 *   abierta sigue viva y el cliente debe reconectar con uno nuevo cuando reciba 401.
 *
 * WebSockets: SSE basta mientras el tiempo real sea solo servidor → cliente (las acciones siguen por REST).
 * Si más adelante hace falta canal bidireccional (p. ej. «escribiendo…» en DMs), migrar a WebSockets
 * reutilizando el mismo bus.
 */
import { Router } from "express";
import { config } from "../../config.js";
import { missedSince, onClose, subscribe } from "../../lib/events-bus.js";

const router = Router();

/** Antes de resolveUser: token (o, en desarrollo, userId) por query string, solo para esta ruta */
export function streamAuthFromQuery(req, _res, next) {
  const t = typeof req.query.access_token === "string" ? req.query.access_token : "";
  if (t && !req.headers.authorization) req.headers.authorization = `Bearer ${t}`;
  const u = typeof req.query.userId === "string" ? req.query.userId : "";
  if (u && config.devIdentity && !req.headers["x-user-id"]) req.headers["x-user-id"] = u;
  next();
}

const frame = (ev) => `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify({ ...ev.data, at: new Date(ev.at).toISOString() })}\n\n`;

router.get("/", (req, res) => {
  const userId = req.user.id;
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: no acumular la respuesta
  });
  res.flushHeaders();
  res.write(`retry: 5000\n: conectado a KNET\n\n`);

  const lastId = req.get("last-event-id") || (typeof req.query.lastEventId === "string" ? req.query.lastEventId : "");
  for (const ev of missedSince(userId, lastId)) res.write(frame(ev));

  const unsubscribe = subscribe(userId, (ev) => res.write(frame(ev)));
  const heartbeat = setInterval(() => res.write(": ping\n\n"), config.sseHeartbeatMs);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    offClose();
    res.end();
  };
  const offClose = onClose(cleanup); // apagado del servidor
  req.on("close", cleanup);
});

export default router;
