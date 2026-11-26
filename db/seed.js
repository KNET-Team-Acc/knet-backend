/**
 * Carga en PostgreSQL el catálogo real de db/data/ (copia de src/data/ del frontend).
 * Es idempotente: se puede correr varias veces; actualiza el catálogo y no duplica nada.
 *
 *   npm run db:seed        → solo el catálogo real. Retira los eventos que ya no están en EVENTS
 *                            (antes mueve a su sucesor de EV_ALIAS inscripciones, check-ins, dossiers,
 *                            conexiones y cafés) y quita los contactos ficticios de db/fixtures/demo.js.
 *   npm run db:seed:demo   → catálogo + fixtures de prueba (usuarios demo.*, matches y asistentes del QR).
 *
 * No toca la XP ni las misiones de los usuarios.
 * Si cambian los datos en el frontend (knet-frontend/src/data/), copia aquí los archivos y vuelve a correr el seed.
 */
import { tx, pool } from "../src/db.js";
import { generateAgenda, KINDS, ROOMS, TIMES, TPL } from "../src/lib/agenda.js";
import { appendConsent } from "../src/lib/consents.js";
import { EVENTS, EV_ALIAS, EV_DAYS, EV_INFO, MAIN_EV } from "./data/events.js";
import { COMMON_M, GROUP_M } from "./data/gamification.js";
import { IND, IND_INTERESTS } from "./data/industries.js";
import { P_FIELDS } from "./data/privacy.js";
import { VENUES } from "./data/venues.js";
import * as DEMO from "./fixtures/demo.js";

const withDemo = process.argv.includes("--demo");
const eventKind = (ev) => (ev.demo ? "demo" : ev.real ? "real" : "exclusive");
const count = {};
const bump = (k, n = 1) => { count[k] = (count[k] || 0) + n; };

async function seedIndustries(c) {
  for (const [id, d] of Object.entries(IND)) {
    await c.query(
      `INSERT INTO industries (id, label, description, base_role, topic) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description,
         base_role = EXCLUDED.base_role, topic = EXCLUDED.topic`,
      [id, d.label, d.desc, d.role, d.topic]);
    bump("industries");
  }
}

async function seedEvents(c) {
  for (const ev of EVENTS) {
    await c.query(
      `INSERT INTO events (id, name, kind, city, venue_name, date_label, lat, lon, tags, industries,
                           min_level, organizer, source_url, description, info, venue)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, city = EXCLUDED.city,
         venue_name = EXCLUDED.venue_name, date_label = EXCLUDED.date_label, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
         tags = EXCLUDED.tags, industries = EXCLUDED.industries, min_level = EXCLUDED.min_level,
         organizer = EXCLUDED.organizer, source_url = EXCLUDED.source_url, description = EXCLUDED.description,
         info = EXCLUDED.info, venue = EXCLUDED.venue`,
      [ev.id, ev.name, eventKind(ev), ev.city, ev.venue, ev.date, ev.lat, ev.lon, ev.tags, ev.ind,
        ev.lvl || 1, ev.org ?? null, ev.url ?? null, ev.desc, EV_INFO[ev.id] ?? null, VENUES[ev.id] ?? null]);
    bump("events");

    for (const [i, date] of (EV_DAYS[ev.id] || []).entries()) {
      await c.query(
        `INSERT INTO event_days (event_id, day_index, date) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, day_index) DO UPDATE SET date = EXCLUDED.date`, [ev.id, i, date]);
      bump("event_days");
    }
    // Días que el evento ya no tiene (CASCADE borra sus sesiones)
    await c.query("DELETE FROM event_days WHERE event_id = $1 AND day_index >= $2", [ev.id, (EV_DAYS[ev.id] || []).length]);
    // Ponentes: solo los que publique el organizador (hoy ninguno en el catálogo); se quitan los ficticios
    const { rowCount } = await c.query("DELETE FROM speakers WHERE event_id = $1", [ev.id]);
    bump("speakers_removed", rowCount);
  }
}

/**
 * Eventos que ya no están en el catálogo: lo del usuario pasa al evento de EV_ALIAS (mismos índices de día
 * y sesión, igual que la migración mv2 del frontend) y después se borra el evento (CASCADE: días, sesiones,
 * inscripciones, check-ins y dossiers que no se movieron; conexiones y cafés quedan con event_id NULL).
 * El libro de XP no se toca (solo inserción).
 */
async function retireEvents(c) {
  const ids = EVENTS.map((e) => e.id);
  const { rows: gone } = await c.query("SELECT id FROM events WHERE NOT (id = ANY ($1))", [ids]);
  for (const { id } of gone) {
    const to = EV_ALIAS[id];
    if (to && ids.includes(to)) {
      await c.query(
        `INSERT INTO registrations (user_id, event_id, created_at)
         SELECT user_id, $2, created_at FROM registrations WHERE event_id = $1 ON CONFLICT DO NOTHING`, [id, to]);
      await c.query(
        `INSERT INTO checkins (user_id, event_id, session_code, method, created_at)
         SELECT user_id, $2, $2 || substr(session_code, length($1) + 1), method, created_at
           FROM checkins
          WHERE event_id = $1 AND split_part(session_code, ':', 2)::int < (SELECT count(*) FROM event_days WHERE event_id = $2)
         ON CONFLICT (user_id, session_code) DO NOTHING`, [id, to]);
      await c.query(
        `INSERT INTO dossiers (user_id, event_id, content, generated_at)
         SELECT user_id, $2, content, generated_at FROM dossiers WHERE event_id = $1
         ON CONFLICT (user_id, event_id) DO NOTHING`, [id, to]);
      await c.query("UPDATE connections SET event_id = $2 WHERE event_id = $1", [id, to]);
      await c.query("UPDATE coffees SET event_id = $2 WHERE event_id = $1", [id, to]);
    }
    await c.query("DELETE FROM events WHERE id = $1", [id]);
    bump("events_retired");
  }
}

async function upsertSession(c, s) {
  await c.query(
    `INSERT INTO sessions (code, event_id, day_index, slot, start_time, kind, title, room, tag, why, industry)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT ON CONSTRAINT sessions_code_industry_key DO UPDATE SET start_time = EXCLUDED.start_time,
       kind = EXCLUDED.kind, title = EXCLUDED.title, room = EXCLUDED.room, tag = EXCLUDED.tag, why = EXCLUDED.why`,
    [`${s.ev}:${s.day}:${s.slot}`, s.ev, s.day, s.slot, s.time, s.kind, s.title, s.room, s.tag, s.why, s.industry]);
  bump("sessions");
}

async function seedSessions(c) {
  for (const ev of EVENTS) {
    for (const [di] of (EV_DAYS[ev.id] || []).entries()) {
      if (ev.id === MAIN_EV && di === 0) {
        // Día 1 del evento principal: agenda curada por industria (IND[*].agenda), igual que sessionsFor()
        for (const [ind, d] of Object.entries(IND)) {
          const interests = IND_INTERESTS[ind];
          for (const [i, [time, kind, title, room, why]] of d.agenda.entries()) {
            await upsertSession(c, { ev: ev.id, day: 0, slot: i, time, kind, title, room, why,
              tag: interests[i % interests.length], industry: ind });
          }
        }
      } else {
        // Resto de días/eventos: agenda personalizada por industria, igual que sessionsFor() del frontend
        for (const [ind, d] of Object.entries(IND)) {
          for (const ses of generateAgenda(ev, di, ind, d, IND_INTERESTS[ind])) {
            await upsertSession(c, { ...ses, ev: ses.eventId, industry: ind });
          }
        }
      }
      // Variante genérica (industry NULL) para usuarios sin industria
      for (let i = 0; i < 4; i++) {
        const tag = ev.tags[(di * 2 + i) % ev.tags.length];
        await upsertSession(c, { ev: ev.id, day: di, slot: i, time: TIMES[i], kind: KINDS[(i + di) % 4],
          title: TPL[(di + i) % TPL.length](tag), room: ROOMS[(di * 3 + i * 2) % ROOMS.length],
          tag, why: `Tema central de ${ev.name}`, industry: null });
      }
    }
  }
}

async function seedMissions(c) {
  const rows = [];
  for (const [ind, d] of Object.entries(IND)) {
    d.missions.forEach(([icon, title, subtitle, xp], i) =>
      rows.push({ code: `${ind}-m${i}`, kind: "industry", industry: ind, icon, title, subtitle, xp, tags: [], sort: i }));
  }
  COMMON_M.forEach(([icon, title, subtitle, xp], i) =>
    rows.push({ code: `c${i}`, kind: "common", industry: null, icon, title, subtitle, xp, tags: [], sort: i }));
  GROUP_M.forEach((g, i) =>
    rows.push({ code: g.id, kind: "group", industry: null, icon: g.ico, title: g.title, subtitle: g.sub, xp: g.xp, tags: g.tags, sort: i }));

  for (const m of rows) {
    await c.query(
      `INSERT INTO missions (code, kind, industry, icon, title, subtitle, xp, tags, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, industry = EXCLUDED.industry, icon = EXCLUDED.icon,
         title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, xp = EXCLUDED.xp, tags = EXCLUDED.tags,
         sort_order = EXCLUDED.sort_order`,
      [m.code, m.kind, m.industry, m.icon, m.title, m.subtitle, m.xp, m.tags, m.sort]);
    bump("missions");
  }
}

/* Fixtures: matches ficticios por industria y asistentes simulados del QR (db/fixtures/demo.js) */
const fixtureNames = () => [...new Set(Object.values(DEMO.MATCHES).flat().map((m) => m[1]).concat(DEMO.SUMMIT_POOL.map(([n]) => n)))];

async function seedDemoContacts(c) {
  const baseXp = Object.fromEntries(DEMO.OTHERS);
  for (const [ind, list] of Object.entries(DEMO.MATCHES)) {
    for (const [initials, name, headline, affinity, reason] of list) {
      const info = DEMO.MATCH_INFO[name] || {};
      await c.query(
        `INSERT INTO contacts (name, initials, headline, industry, affinity, match_reason, interests, likes, goal, base_xp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (name) DO UPDATE SET initials = EXCLUDED.initials, headline = EXCLUDED.headline,
           industry = EXCLUDED.industry, affinity = EXCLUDED.affinity, match_reason = EXCLUDED.match_reason,
           interests = EXCLUDED.interests, likes = EXCLUDED.likes, goal = EXCLUDED.goal, base_xp = EXCLUDED.base_xp`,
        [name, initials, headline, ind, affinity, reason, info.int || [], info.likes || [], info.goal || "", baseXp[name] || 0]);
      bump("demo_contacts");
    }
  }
  // Asistentes simulados del QR de conexión. Si alguno coincide con un match (industry no nula), se conservan sus datos.
  for (const [name, headline] of DEMO.SUMMIT_POOL) {
    const initials = name.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
    const { rowCount } = await c.query(
      `INSERT INTO contacts (name, initials, headline) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET headline = EXCLUDED.headline WHERE contacts.industry IS NULL`,
      [name, initials, headline]);
    bump("demo_contacts", rowCount);
  }
}

/* Sin --demo: el catálogo no tiene contactos ficticios (CASCADE quita las conexiones con ellos) */
async function pruneDemoContacts(c) {
  const { rowCount } = await c.query("DELETE FROM contacts WHERE is_demo AND name = ANY ($1)", [fixtureNames()]);
  bump("demo_contacts_removed", rowCount);
}

/* Un usuario demo por persona de db/fixtures/demo.js (demo.<industria>@knet.local) */
async function seedDemoUsers(c) {
  for (const [ind, p] of Object.entries(DEMO.PERSONAS)) {
    const { rows: [u] } = await c.query(
      `INSERT INTO users (email, name, role, company, industry, seniority, location, interests,
                          field_sources, linkedin_connected, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, true)
       ON CONFLICT (email) DO UPDATE SET is_demo = true
       RETURNING id, (xmax = 0) AS inserted`,
      [`demo.${ind}@knet.local`, p.name, IND[ind].role, p.company, ind, p.seniority, p.location, p.interests,
        Object.fromEntries(P_FIELDS.map((f) => [f, "mcp"]))]);
    bump("demo_users");

    for (const scope of ["profile", "industry", "interests", "network"]) {
      await c.query("INSERT INTO user_scopes (user_id, scope, granted) VALUES ($1, $2, true) ON CONFLICT DO NOTHING", [u.id, scope]);
    }
    // Igual que fresh() en knetApp.js: todos arrancan inscritos en el evento principal
    await c.query("INSERT INTO registrations (user_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [u.id, MAIN_EV]);

    if (u.inserted) {
      const seedClient = { userAgent: "knet-seed", language: "es-CO" };
      await appendConsent(c, u.id, "aceptacion",
        { documents: [{ id: "terminos", version: "1.1" }, { id: "privacidad", version: "1.1" }] }, seedClient);
      await appendConsent(c, u.id, "autorizacion_linkedin",
        { details: { fields: ["basic", "work", "industry", "skills"] } }, seedClient);
    }
  }
}

async function main() {
  await tx(async (c) => {
    await seedIndustries(c);
    await seedEvents(c);
    await retireEvents(c);
    await seedSessions(c);
    await seedMissions(c);
    if (withDemo) {
      await seedDemoContacts(c);
      await seedDemoUsers(c);
    } else {
      await pruneDemoContacts(c);
    }
  });
  console.log(`Seed completo${withDemo ? " (con fixtures de prueba)" : ""}:`);
  for (const [k, n] of Object.entries(count)) console.log(`  ${k.padEnd(22)} ${n}`);
  if (!withDemo) return;
  const { rows } = await pool.query("SELECT email, id FROM users WHERE is_demo ORDER BY email");
  console.log("\nUsuarios demo (usa el id en el header X-User-Id):");
  for (const r of rows) console.log(`  ${r.email.padEnd(26)} ${r.id}`);
}

main()
  .catch((e) => { console.error("Falló el seed:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
