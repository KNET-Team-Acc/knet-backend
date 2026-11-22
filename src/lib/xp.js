/**
 * Suma XP de forma idempotente: si (usuario, motivo, ref) ya existe en xp_ledger, no vuelve a sumar.
 * Debe llamarse dentro de una transacción (recibe el client de tx()).
 */
export async function awardXp(client, userId, amount, reason, ref) {
  const { rowCount } = await client.query(
    `INSERT INTO xp_ledger (user_id, amount, reason, ref) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, reason, ref) DO NOTHING`,
    [userId, amount, reason, ref],
  );
  const { rows } = rowCount
    ? await client.query("UPDATE users SET xp = xp + $2 WHERE id = $1 RETURNING xp", [userId, amount])
    : await client.query("SELECT xp FROM users WHERE id = $1", [userId]);
  return { xpAwarded: rowCount ? amount : 0, xp: rows[0].xp };
}
