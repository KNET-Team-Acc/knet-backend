/**
 * Chat directo 1:1 sobre una conexión aceptada.
 * Entre usuarios reales el hilo reúne los mensajes de las dos filas espejo de la conexión.
 * Paginación por cursor: ?before=<nextCursor de la página anterior>&limit=30.
 */
import { Router } from "express";
import { z } from "zod";
import { pool, tx } from "../../db.js";
import { publish } from "../../lib/events-bus.js";
import { toMessage } from "../../lib/serialize.js";
import { resolveThread } from "../../lib/threads.js";

const router = Router();

export const MESSAGE_MAX = 2000;
const connParam = z.coerce.number().int().positive();
const pageSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const postSchema = z.object({ body: z.string().trim().min(1, "El mensaje está vacío").max(MESSAGE_MAX) }).strict();

// GET /api/me/messages/:connId?before=&limit= → página de mensajes, del más antiguo al más reciente.
// nextCursor: valor de `before` para pedir los anteriores (null si no hay más). Marca como leídos los recibidos.
router.get("/:connId", async (req, res) => {
  const connId = connParam.parse(req.params.connId);
  const { before, limit } = pageSchema.parse(req.query);
  const { ids } = await resolveThread(pool, req.user.id, connId);
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE connection_id = ANY($1) AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC LIMIT $3`, [ids, before ?? null, limit + 1]);
  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  await pool.query(
    "UPDATE messages SET read_at = now() WHERE connection_id = ANY($1) AND sender_id <> $2 AND read_at IS NULL",
    [ids, req.user.id]);
  res.json({
    connectionId: connId,
    messages: page.map((m) => toMessage(m, req.user.id)),
    nextCursor: more ? page[0].id : null,
  });
});

// POST /api/me/messages/:connId { body } → envía un mensaje (403 not_connected si la conexión no está aceptada)
router.post("/:connId", async (req, res) => {
  const connId = connParam.parse(req.params.connId);
  const { body } = postSchema.parse(req.body ?? {});
  const { msg, thread } = await tx(async (c) => {
    const thread = await resolveThread(c, req.user.id, connId);
    const { rows: [msg] } = await c.query(
      "INSERT INTO messages (connection_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *",
      [thread.conn.id, req.user.id, body]);
    return { msg, thread };
  });
  // Tiempo real: al destinatario con el id de SU conexión, y a las demás sesiones de quien envía
  if (thread.peerId) publish(thread.peerId, "message.new", { connectionId: thread.mirror.id, message: toMessage(msg, thread.peerId) });
  publish(req.user.id, "message.new", { connectionId: connId, message: toMessage(msg, req.user.id) });
  res.status(201).json({ message: toMessage(msg, req.user.id) });
});

export default router;
