/**
 * Port de sessionsFor() de knet-frontend/src/lib/engine/knetApp.js (agenda recomendada por la IA).
 *
 * Para cada (industria, evento, día) genera 4 sesiones deterministas: plantillas, semilla
 * hashStr(`${ind}|${ev}|${día}`), orden de tags según los intereses de la persona de la industria
 * y el motivo `why`. Los IDs `ev:día:i` son los mismos del frontend (check-ins y misiones dependen de ellos).
 *
 * Igual que el frontend, los intereses son los de PERSONAS[industria], no los del perfil: así la agenda
 * coincide en ambos lados. Si cambian las plantillas en el frontend, hay que cambiarlas aquí
 * (scripts/agenda-parity.js lo detecta).
 *
 * El día 0 del Summit demo (`bog:0`) no pasa por aquí: usa la agenda curada IND[industria].agenda.
 */

export const TIMES = ["08:30", "10:15", "14:00", "16:30"];
export const KINDS = ["Keynote", "Panel", "Taller", "Charla"];
export const ROOMS = ["Auditorio principal", "Sala Orbit", "Lab 3 · Zona de talleres", "Sala Quantum", "Sala Nova", "Terraza del pabellón"];
export const TPL = [
  (t) => `${t}: del piloto a producción`,
  (t) => `Casos reales de ${t} en Latinoamérica`,
  (t) => `Taller práctico: ${t} en 90 minutos`,
  (t) => `Panel: lo que nadie cuenta sobre ${t}`,
  (t) => `Demo en vivo: ${t} aplicado al negocio`,
  (t) => `${t} con métricas de impacto`,
];

/** FNV-1a de 32 bits, igual que hashStr() del frontend */
export const hashStr = (t) => {
  let h = 2166136261;
  for (const c of String(t)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/** Generador Park–Miller, igual que seeded() del frontend */
export function seeded(seed) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => (x = x * 16807 % 2147483647, (x - 1) / 2147483646);
}

/**
 * Sesiones recomendadas de un día.
 * @param {{ id: string, name: string, tags: string[] }} ev  evento
 * @param {number} di  índice del día
 * @param {string} ind  id de la industria (clave de IND)
 * @param {{ label: string, role: string }} industry  IND[ind]
 * @param {string[]} interests  PERSONAS[ind].interests
 * @returns {{ code, eventId, day, slot, time, kind, title, room, tag, why }[]}
 */
export function generateAgenda(ev, di, ind, industry, interests) {
  const mine = ev.tags.filter((t) => interests.includes(t));
  const order = mine.concat(ev.tags.filter((t) => !mine.includes(t)));
  const r = seeded(hashStr(`${ind}|${ev.id}|${di}`) % 2147483646 + 1);
  const base = Math.floor(r() * TPL.length);
  return [0, 1, 2, 3].map((i) => {
    const tag = order[(di * 2 + i) % order.length];
    const hit = interests.includes(tag);
    // El orden de las llamadas a r() importa: primero la sala, como en el frontend
    const room = ROOMS[Math.floor(r() * ROOMS.length)];
    const why = hit
      ? [`Coincide con tu interés en ${tag} y con tu rol de ${industry.role}`,
        `Tu perfil marca ${tag} como prioridad: aquí verás casos aplicables`][(i + di) % 2]
      : [`Tema central de ${ev.name}; la IA lo priorizó para ${industry.label}`,
        `Complementa tus intereses con una mirada práctica a ${tag}`,
        "Asisten 3 de tus matches; buena sesión para conectar",
        `Alta demanda en ${industry.label}: llega 10 min antes`][(i + di) % 4];
    return {
      code: `${ev.id}:${di}:${i}`, eventId: ev.id, day: di, slot: i,
      time: TIMES[i], kind: KINDS[(i + di) % 4], title: TPL[(base + i) % TPL.length](tag),
      room, tag, why,
    };
  });
}
