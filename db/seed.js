/**
 * Carga en PostgreSQL los datos reales y de demo de db/data/ (copia de src/data/ del frontend).
 * Es idempotente: se puede correr varias veces; actualiza el catálogo y no duplica nada.
 * No toca el progreso de los usuarios (XP, check-ins, misiones, conexiones).
 *
 * Si cambian los datos en el frontend (knet-frontend/src/data/), copia aquí los archivos y vuelve a correr el seed.
 */
import { tx, pool } from "../src/db.js";
import { appendConsent } from "../src/lib/consents.js";
import { EVENTS, EV_DAYS, EV_INFO, EV_SPEAKERS } from "./data/events.js";
import { COMMON_M, GROUP_M } from "./data/gamification.js";
import { IND, MATCH_INFO, OTHERS, PERSONAS } from "./data/industries.js";
import { P_FIELDS } from "./data/privacy.js";
import { VENUES } from "./data/venues.js";

/* Plantillas de sessionsFor() en knetApp.js, sin la personalización por perfil */
const TIMES = ["08:30", "10:15", "14:00", "16:30"];
const KINDS = ["Keynote", "Panel", "Taller", "Charla"];
const ROOMS = ["Auditorio principal", "Sala Orbit", "Lab 3 · Zona de talleres", "Sala Quantum", "Sala Nova", "Terraza del pabellón"];
const TPL = [
  (t) => `${t}: del piloto a producción`,
  (t) => `Casos reales de ${t} en Latinoamérica`,
  (t) => `Taller práctico: ${t} en 90 minutos`,
  (t) => `Panel: lo que nadie cuenta sobre ${t}`,
  (t) => `Demo en vivo: ${t} aplicado al negocio`,
  (t) => `${t} con métricas de impacto`,
];

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

    for (const s of EV_SPEAKERS[ev.id] || []) {
      await c.query(
        `INSERT INTO speakers (event_id, name, role, org, session_label, talk, bio, tags, avatar)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_id, name) DO UPDATE SET role = EXCLUDED.role, org = EXCLUDED.org,
           session_label = EXCLUDED.session_label, talk = EXCLUDED.talk, bio = EXCLUDED.bio,
           tags = EXCLUDED.tags, avatar = EXCLUDED.avatar`,
        [ev.id, s.n, s.role, s.org, s.ses, s.talk, s.bio, s.tags, s.av]);
      bump("speakers");
    }
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
      // Día 1 del Summit demo: agenda curada por industria (IND[*].agenda)
      if (ev.id === "bog" && di === 0) {
        for (const [ind, d] of Object.entries(IND)) {
          const interests = PERSONAS[ind].interests;
          for (const [i, [time, kind, title, room, why]] of d.agenda.entries()) {
            await upsertSession(c, { ev: ev.id, day: 0, slot: i, time, kind, title, room, why,
              tag: interests[i % interests.length], industry: ind });
          }
        }
        continue;
      }
      // Resto de días/eventos: 4 sesiones genéricas a partir de los tags del evento
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

async function seedContacts(c) {
  const baseXp = Object.fromEntries(OTHERS);
  for (const [ind, d] of Object.entries(IND)) {
    for (const [initials, name, headline, affinity, reason] of d.matches) {
      const info = MATCH_INFO[name] || {};
      await c.query(
        `INSERT INTO contacts (name, initials, headline, industry, affinity, match_reason, interests, likes, goal, base_xp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (name) DO UPDATE SET initials = EXCLUDED.initials, headline = EXCLUDED.headline,
           industry = EXCLUDED.industry, affinity = EXCLUDED.affinity, match_reason = EXCLUDED.match_reason,
           interests = EXCLUDED.interests, likes = EXCLUDED.likes, goal = EXCLUDED.goal, base_xp = EXCLUDED.base_xp`,
        [name, initials, headline, ind, affinity, reason, info.int || [], info.likes || [], info.goal || "", baseXp[name] || 0]);
      bump("contacts");
    }
  }
}

/* Un usuario demo por persona de db/data/industries.js (demo.<industria>@knet.local) */
async function seedDemoUsers(c) {
  for (const [ind, p] of Object.entries(PERSONAS)) {
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
    // Igual que fresh() en knetApp.js: todos arrancan inscritos en el Summit demo
    await c.query("INSERT INTO registrations (user_id, event_id) VALUES ($1, 'bog') ON CONFLICT DO NOTHING", [u.id]);

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
    await seedSessions(c);
    await seedMissions(c);
    await seedContacts(c);
    await seedDemoUsers(c);
  });
  console.log("Seed completo:");
  for (const [k, n] of Object.entries(count)) console.log(`  ${k.padEnd(12)} ${n}`);
  const { rows } = await pool.query("SELECT email, id FROM users WHERE is_demo ORDER BY email");
  console.log("\nUsuarios demo (usa el id en el header X-User-Id):");
  for (const r of rows) console.log(`  ${r.email.padEnd(26)} ${r.id}`);
}

main()
  .catch((e) => { console.error("Falló el seed:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
