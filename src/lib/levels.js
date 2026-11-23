/**
 * Reglas de gamificación. Deben coincidir con db/data/gamification.js (LEVELS)
 * y con lvl() en knet-frontend/src/lib/engine/knetApp.js: nivel = floor(xp / 500) + 1.
 */
export const XP_PER_LEVEL = 500;
export const LEVELS = ["Explorador", "Desarrollador", "Integrador", "Arquitecto", "Innovador"];

export const XP_REWARDS = { checkin: 40, connection: 100, coffee: 50 };

export function levelInfo(xp) {
  const level = Math.min(Math.floor(xp / XP_PER_LEVEL) + 1, LEVELS.length);
  return {
    level,
    levelName: LEVELS[level - 1],
    xpIntoLevel: xp - (level - 1) * XP_PER_LEVEL,
    nextLevelAt: level >= LEVELS.length ? null : level * XP_PER_LEVEL,
  };
}
