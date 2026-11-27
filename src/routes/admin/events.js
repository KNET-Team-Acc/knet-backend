/**
 * /api/admin/events · panel de creador de eventos (knet-backend#18, knet-frontend#21).
 * Solo organizer y admin (requireRole en src/routes/admin/index.js). Un organizer solo ve y edita sus
 * eventos (events.owner_id); un admin, todos (incluidos los del catálogo sembrado, owner_id NULL).
 * Los eventos nacen como borrador (status draft) y solo salen en GET /api/events al publicarlos.
 */
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { query, tx } from "../../db.js";
import { HttpError } from "../../lib/http.js";
import { toAdminEvent, toAdminSession, toAdminSpeaker, toMission } from "../../lib/serialize.js";
import { accountRoleOf } from "../../middleware/roles.js";
import {
  createEventSchema, daysSchema, infoSchema, missionPatchSchema, missionSchema, MISSION_TYPES, patchEventSchema,
  sessionPatchSchema, sessionSchema, speakerPatchSchema, speakerSchema, venueSchema,
} from "./schemas.js";

const router = Router();

const isAdmin = (u) => accountRoleOf(u) === "admin";
const intParam = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, `No existe ${what} ${v}`);
  return n;
};

const ADMIN_SELECT = `
  SELECT e.*, COALESCE(d.days, '{}') AS days,
         (SELECT count(*) FROM sessions s WHERE s.event_id = e.id)::int AS sessions_count,
         (SELECT count(*) FROM speakers p WHERE p.event_id = e.id)::int AS speakers_count,
         (SELECT count(*) FROM missions m WHERE m.event_id = e.id)::int AS missions_count,
         (SELECT count(*) FROM registrations r WHERE r.event_id = e.id)::int AS registrations_count,
         o.name AS owner_name, o.email AS owner_email
    FROM events e
    LEFT JOIN users o ON o.id = e.owner_id
    LEFT JOIN LATERAL (SELECT array_agg(date::text ORDER BY day_index) AS days
                         FROM event_days WHERE event_id = e.id) d ON true`;

/**
 * Evento que el usuario puede ver (lectura) o editar (lock: FOR UPDATE dentro de una transacción).
 * 404 si no existe, 403 not_owner si es de otro organizador (un admin ve y edita los de todos).
 * Los del catálogo sembrado (owner_id NULL) son de solo lectura: db:seed los reescribe en cada despliegue → 409 catalog_event.
 */
async function editable(db, id, user, { lock = false } = {}) {
  const { rows: [ev] } = await db.query(`SELECT id, owner_id, status FROM events WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!ev) throw new HttpError(404, `No existe el evento ${id}`);
  if (!isAdmin(user) && ev.owner_id !== user.id) throw new HttpError(403, "Solo puedes editar los eventos que creaste", "not_owner");
  if (lock && !ev.owner_id) throw new HttpError(409, "Los eventos del catálogo se gestionan con el seed (db/data/) y no se editan desde el panel", "catalog_event");
  return ev;
}

async function checkIndustries(db, list) {
  if (!list?.length) return;
  const { rows } = await db.query("SELECT id FROM industries WHERE id = ANY ($1)", [list]);
  const known = new Set(rows.map((r) => r.id));
  const bad = list.filter((i) => !known.has(i));
  if (bad.length) throw new HttpError(400, `Industria desconocida: ${bad.join(", ")}`);
}

/** Detalle completo para el asistente de creación: evento, ficha, recinto, días, speakers, charlas y misiones */
async function detail(db, id) {
  const { rows: [ev] } = await db.query(`${ADMIN_SELECT} WHERE e.id = $1`, [id]);
  const [{ rows: speakers }, { rows: sessions }, { rows: missions }] = await Promise.all([
    db.query("SELECT * FROM speakers WHERE event_id = $1 ORDER BY id", [id]),
    db.query("SELECT * FROM sessions WHERE event_id = $1 AND industry IS NULL ORDER BY day_index, start_time, slot", [id]),
    db.query("SELECT * FROM missions WHERE event_id = $1 ORDER BY sort_order, code", [id]),
  ]);
  return {
    ...toAdminEvent(ev), info: ev.info, venue: ev.venue,
    speakers: speakers.map(toAdminSpeaker), sessions: sessions.map(toAdminSession), missions: missions.map(toMission),
  };
}

/** Id corto y estable para el frontend (/^[a-z0-9]{1,24}$/); la «o» lo separa de los ids del catálogo */
async function newEventId(db) {
  for (let i = 0; i < 5; i++) {
    const id = "o" + BigInt("0x" + randomBytes(6).toString("hex")).toString(36).padStart(9, "0").slice(0, 9);
    const { rowCount } = await db.query("SELECT 1 FROM events WHERE id = $1", [id]);
    if (!rowCount) return id;
  }
  throw new HttpError(409, "No se pudo generar un id para el evento; inténtalo de nuevo");
}

// campo de la API → columna de events
const COLUMNS = {
  name: "name", city: "city", venueName: "venue_name", dateLabel: "date_label", lat: "lat", lon: "lon",
  tags: "tags", industries: "industries", description: "description", sourceUrl: "source_url", organizer: "organizer",
};

/* ───────────── Eventos ───────────── */

// GET /api/admin/events → los míos (admin: ?all=1 para ver los de todos los organizadores y, al final, los del catálogo)
router.get("/", async (req, res) => {
  const all = isAdmin(req.user) && ["1", "true"].includes(String(req.query.all));
  const { rows } = await query(
    `${ADMIN_SELECT} WHERE ($1::boolean OR e.owner_id = $2) ORDER BY (e.owner_id IS NULL), e.updated_at DESC, e.id`, [all, req.user.id]);
  res.json({ events: rows.map(toAdminEvent), role: accountRoleOf(req.user) });
});

// POST /api/admin/events → crea un borrador
router.post("/", async (req, res) => {
  const body = createEventSchema.parse(req.body ?? {});
  if (body.curated && !isAdmin(req.user)) throw new HttpError(403, "Solo un admin puede añadir eventos al catálogo", "forbidden_role");
  await checkIndustries({ query }, body.industries);
  const ev = await tx(async (c) => {
    const id = await newEventId(c);
    await c.query(
      `INSERT INTO events (id, name, kind, city, venue_name, date_label, lat, lon, tags, industries, organizer,
                           source_url, description, owner_id, status, published_at, curated)
       VALUES ($1, $2, 'real', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', NULL, $14)`,
      [id, body.name, body.city, body.venueName ?? "", body.dateLabel ?? "", body.lat ?? null, body.lon ?? null,
        body.tags ?? [], body.industries ?? [], body.organizer || req.user.company || req.user.name, body.sourceUrl ?? null,
        body.description ?? "", req.user.id, !!body.curated]);
    return detail(c, id);
  });
  res.status(201).json({ event: ev });
});

// GET /api/admin/events/:id
router.get("/:id", async (req, res) => {
  await editable({ query }, req.params.id, req.user);
  res.json({ event: await detail({ query }, req.params.id) });
});

// PATCH /api/admin/events/:id → datos básicos
router.patch("/:id", async (req, res) => {
  const body = patchEventSchema.parse(req.body ?? {});
  await checkIndustries({ query }, body.industries);
  const ev = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const sets = [], vals = [req.params.id];
    for (const [k, col] of Object.entries(COLUMNS)) {
      if (body[k] === undefined) continue;
      vals.push(body[k]);
      sets.push(`${col} = $${vals.length}`);
    }
    await c.query(`UPDATE events SET ${sets.join(", ")} WHERE id = $1`, vals);
    return detail(c, req.params.id);
  });
  res.json({ event: ev });
});

// DELETE /api/admin/events/:id → borra el evento (CASCADE: días, charlas, speakers, misiones, inscripciones)
router.delete("/:id", async (req, res) => {
  await tx(async (c) => {
    const ev = await editable(c, req.params.id, req.user, { lock: true });
    await c.query("DELETE FROM events WHERE id = $1", [ev.id]);
  });
  res.status(204).end();
});

// PUT /api/admin/events/:id/days → reemplaza los días (quitar un día borra sus charlas)
router.put("/:id/days", async (req, res) => {
  const { days } = daysSchema.parse(req.body ?? {});
  const ev = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    for (const [i, date] of days.entries()) {
      await c.query(
        `INSERT INTO event_days (event_id, day_index, date) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, day_index) DO UPDATE SET date = EXCLUDED.date`, [req.params.id, i, date]);
    }
    await c.query("DELETE FROM event_days WHERE event_id = $1 AND day_index >= $2", [req.params.id, days.length]);
    await c.query("UPDATE events SET updated_at = now() WHERE id = $1", [req.params.id]);
    return detail(c, req.params.id);
  });
  res.json({ event: ev });
});

// PUT /api/admin/events/:id/info → ficha (lema, para quién, formato, agenda general, qué te llevas, colores)
router.put("/:id/info", async (req, res) => {
  const { info } = infoSchema.parse(req.body ?? {});
  const ev = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    await c.query("UPDATE events SET info = $2 WHERE id = $1", [req.params.id, info]);
    return detail(c, req.params.id);
  });
  res.json({ event: ev });
});

// PUT /api/admin/events/:id/venue → recinto 3D (forma de VENUES del frontend; null lo quita)
router.put("/:id/venue", async (req, res) => {
  const { venue } = venueSchema.parse(req.body ?? {});
  const ev = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    await c.query("UPDATE events SET venue = $2 WHERE id = $1", [req.params.id, venue]);
    return detail(c, req.params.id);
  });
  res.json({ event: ev });
});

// POST /api/admin/events/:id/publish → lo hace visible en GET /api/events. 400 con lo que falta.
router.post("/:id/publish", async (req, res) => {
  const ev = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const d = await detail(c, req.params.id);
    const missing = [];
    if (!d.days.length) missing.push("al menos un día");
    // Un evento del catálogo (curated) no necesita charlas (el frontend arma su agenda) pero sí su web oficial
    if (d.curated) { if (!d.sourceUrl) missing.push("la web oficial del evento (fuente)"); }
    else if (!d.sessions.length) missing.push("al menos una charla");
    if (!d.info) missing.push("la ficha del evento (colores y formato)");
    if (!d.description) missing.push("una descripción");
    if (missing.length) throw new HttpError(400, `Para publicar falta: ${missing.join(", ")}`, "incomplete_event", { missing });
    await c.query("UPDATE events SET status = 'published', published_at = COALESCE(published_at, now()) WHERE id = $1", [req.params.id]);
    return detail(c, req.params.id);
  });
  res.json({ event: ev });
});

// POST /api/admin/events/:id/unpublish → vuelve a borrador (deja de salir en el catálogo)
router.post("/:id/unpublish", async (req, res) => {
  const ev = await tx(async (c) => {
    const e = await editable(c, req.params.id, req.user, { lock: true });
    await c.query("UPDATE events SET status = 'draft' WHERE id = $1", [e.id]);
    return detail(c, e.id);
  });
  res.json({ event: ev });
});

/* ───────────── Speakers ───────────── */

const SPEAKER_COLS = { name: "name", role: "role", org: "org", session: "session_label", talk: "talk", bio: "bio", tags: "tags", avatar: "avatar" };

router.get("/:id/speakers", async (req, res) => {
  await editable({ query }, req.params.id, req.user);
  const { rows } = await query("SELECT * FROM speakers WHERE event_id = $1 ORDER BY id", [req.params.id]);
  res.json({ speakers: rows.map(toAdminSpeaker) });
});

router.post("/:id/speakers", async (req, res) => {
  const b = speakerSchema.parse(req.body ?? {});
  const sp = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const { rows: [n] } = await c.query("SELECT count(*)::int AS n FROM speakers WHERE event_id = $1", [req.params.id]);
    if (n.n >= 60) throw new HttpError(400, "Un evento admite hasta 60 speakers");
    const { rows: [row] } = await c.query(
      `INSERT INTO speakers (event_id, name, role, org, session_label, talk, bio, tags, avatar)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.params.id, b.name, b.role ?? "", b.org ?? "", b.session ?? "", b.talk ?? "", b.bio ?? "", b.tags ?? [], b.avatar ?? null])
      .catch((e) => { throw e.code === "23505" ? new HttpError(409, `Ya hay un speaker llamado ${b.name} en este evento`) : e; });
    return row;
  });
  res.status(201).json({ speaker: toAdminSpeaker(sp) });
});

router.patch("/:id/speakers/:sid", async (req, res) => {
  const b = speakerPatchSchema.parse(req.body ?? {});
  const sid = intParam(req.params.sid, "el speaker");
  const sp = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const sets = [], vals = [req.params.id, sid];
    for (const [k, col] of Object.entries(SPEAKER_COLS)) {
      if (b[k] === undefined) continue;
      vals.push(b[k]);
      sets.push(`${col} = $${vals.length}`);
    }
    const { rows: [row] } = await c.query(`UPDATE speakers SET ${sets.join(", ")} WHERE event_id = $1 AND id = $2 RETURNING *`, vals)
      .catch((e) => { throw e.code === "23505" ? new HttpError(409, `Ya hay un speaker llamado ${b.name} en este evento`) : e; });
    if (!row) throw new HttpError(404, `No existe el speaker ${sid} en este evento`);
    return row;
  });
  res.json({ speaker: toAdminSpeaker(sp) });
});

router.delete("/:id/speakers/:sid", async (req, res) => {
  const sid = intParam(req.params.sid, "el speaker");
  await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const { rowCount } = await c.query("DELETE FROM speakers WHERE event_id = $1 AND id = $2", [req.params.id, sid]);
    if (!rowCount) throw new HttpError(404, `No existe el speaker ${sid} en este evento`);
  });
  res.status(204).end();
});

/* ───────────── Charlas (sessions genéricas: industry NULL) ───────────── */

const SESSION_COLS = { time: "start_time", kind: "kind", title: "title", room: "room", speaker: "speaker", tag: "tag", why: "why" };

router.get("/:id/sessions", async (req, res) => {
  await editable({ query }, req.params.id, req.user);
  const { rows } = await query(
    "SELECT * FROM sessions WHERE event_id = $1 AND industry IS NULL ORDER BY day_index, start_time, slot", [req.params.id]);
  res.json({ sessions: rows.map(toAdminSession) });
});

router.post("/:id/sessions", async (req, res) => {
  const b = sessionSchema.parse(req.body ?? {});
  const s = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const { rowCount: dayOk } = await c.query("SELECT 1 FROM event_days WHERE event_id = $1 AND day_index = $2", [req.params.id, b.day]);
    if (!dayOk) throw new HttpError(400, `El evento no tiene el día ${b.day + 1}: agrégalo primero en «Días y agenda»`);
    const { rows: [m] } = await c.query(
      "SELECT count(*)::int AS n, COALESCE(max(slot) + 1, 0)::int AS next FROM sessions WHERE event_id = $1 AND day_index = $2",
      [req.params.id, b.day]);
    if (m.n >= 24) throw new HttpError(400, "Un día admite hasta 24 charlas");
    const { rows: [row] } = await c.query(
      `INSERT INTO sessions (code, event_id, day_index, slot, start_time, kind, title, room, speaker, tag, why, industry)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL) RETURNING *`,
      [`${req.params.id}:${b.day}:${m.next}`, req.params.id, b.day, m.next, b.time, b.kind, b.title, b.room ?? "",
        b.speaker ?? "", b.tag ?? null, b.why ?? null]);
    return row;
  });
  res.status(201).json({ session: toAdminSession(s) });
});

router.patch("/:id/sessions/:sid", async (req, res) => {
  const b = sessionPatchSchema.parse(req.body ?? {});
  const sid = intParam(req.params.sid, "la charla");
  const s = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const sets = [], vals = [req.params.id, sid];
    for (const [k, col] of Object.entries(SESSION_COLS)) {
      if (b[k] === undefined) continue;
      vals.push(b[k]);
      sets.push(`${col} = $${vals.length}`);
    }
    const { rows: [row] } = await c.query(
      `UPDATE sessions SET ${sets.join(", ")} WHERE event_id = $1 AND id = $2 AND industry IS NULL RETURNING *`, vals);
    if (!row) throw new HttpError(404, `No existe la charla ${sid} en este evento`);
    return row;
  });
  res.json({ session: toAdminSession(s) });
});

router.delete("/:id/sessions/:sid", async (req, res) => {
  const sid = intParam(req.params.sid, "la charla");
  await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const { rowCount } = await c.query("DELETE FROM sessions WHERE event_id = $1 AND id = $2 AND industry IS NULL", [req.params.id, sid]);
    if (!rowCount) throw new HttpError(404, `No existe la charla ${sid} en este evento`);
  });
  res.status(204).end();
});

/* ───────────── Misiones del evento (kind 'event') ───────────── */

router.get("/:id/missions", async (req, res) => {
  await editable({ query }, req.params.id, req.user);
  const { rows } = await query("SELECT * FROM missions WHERE event_id = $1 ORDER BY sort_order, code", [req.params.id]);
  res.json({ missions: rows.map(toMission) });
});

router.post("/:id/missions", async (req, res) => {
  const b = missionSchema.parse(req.body ?? {});
  const m = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const { rows: [n] } = await c.query("SELECT count(*)::int AS n, COALESCE(max(sort_order) + 1, 0)::int AS next FROM missions WHERE event_id = $1", [req.params.id]);
    if (n.n >= 30) throw new HttpError(400, "Un evento admite hasta 30 misiones");
    // Código nuevo en cada alta: una misión borrada no reaparece como completada para quien ya la hizo
    const code = `${req.params.id}-${randomBytes(4).toString("hex")}`;
    const { rows: [row] } = await c.query(
      `INSERT INTO missions (code, kind, industry, event_id, icon, title, subtitle, xp, tags, sort_order)
       VALUES ($1, 'event', NULL, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [code, req.params.id, MISSION_TYPES[b.type], b.title, b.condition ?? "", b.xp, [b.type], n.next]);
    return row;
  });
  res.status(201).json({ mission: toMission(m) });
});

router.patch("/:id/missions/:code", async (req, res) => {
  const b = missionPatchSchema.parse(req.body ?? {});
  const m = await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const sets = [], vals = [req.params.id, req.params.code];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.type !== undefined) { add("icon", MISSION_TYPES[b.type]); add("tags", [b.type]); }
    if (b.title !== undefined) add("title", b.title);
    if (b.condition !== undefined) add("subtitle", b.condition);
    if (b.xp !== undefined) add("xp", b.xp);
    const { rows: [row] } = await c.query(
      `UPDATE missions SET ${sets.join(", ")} WHERE event_id = $1 AND code = $2 RETURNING *`, vals);
    if (!row) throw new HttpError(404, `No existe la misión ${req.params.code} en este evento`);
    return row;
  });
  res.json({ mission: toMission(m) });
});

router.delete("/:id/missions/:code", async (req, res) => {
  await tx(async (c) => {
    await editable(c, req.params.id, req.user, { lock: true });
    const { rowCount } = await c.query("DELETE FROM missions WHERE event_id = $1 AND code = $2", [req.params.id, req.params.code]);
    if (!rowCount) throw new HttpError(404, `No existe la misión ${req.params.code} en este evento`);
  });
  res.status(204).end();
});

export { detail, editable };
export default router;
