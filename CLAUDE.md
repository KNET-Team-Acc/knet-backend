# KNET backend

API REST de KNET. Express 5 + PostgreSQL 16 (Docker, host **5433** → contenedor 5432). API en **:4000**. Frontend en `../knet-frontend/knet-frontend` (CORS `http://localhost:5173`). Detalle de endpoints y esquema: `README.md`.

## Carpetas
- `db/migrations/` — SQL numerado (`001_init.sql`, `002_user_erasure.sql`). Nunca edites una migración aplicada: agrega la siguiente (`003_...`).
- `db/data/` — copia de `src/data/` del frontend para el seed (si el frontend cambia, recopiar y `db:seed`).
- `src/` — `app.js`, `config.js`, `db.js` (`query`, `tx`), `middleware/` (`user.js`: `X-User-Id` o usuario demo), `lib/` (`consents.js`, `xp.js`, `levels.js`, `serialize.js`, `http.js`), `routes/` (`me/*` = rutas del usuario).

## Comandos
- `npm run dev` (con `--watch`) / `npm start` (sin watch: reiniciar tras cambios)
- `npm run db:migrate` — aplica migraciones pendientes
- `npm run db:seed` — catálogo + usuarios demo
- `npm run db:reset` — borra el esquema y reseedea (solo desarrollo)
- `npm run smoke` — prueba la API en marcha (`API_URL` para otro puerto). Deja usuarios borrados con consentimientos desvinculados: es a propósito.

## Reglas
- Nivel = `floor(xp / 500) + 1`, máximo 5 (`src/lib/levels.js`), igual que el frontend.
- XP: solo con `awardXp()` dentro de `tx()`. `xp_ledger` es un libro de solo inserción (`UNIQUE (user_id, reason, ref)` evita doble suma); no hagas UPDATE/DELETE sobre él (no hay trigger: es convención). `users.xp` es la caché del total.
- `consents`: trigger append-only. Única excepción: `user_id → NULL` por `ON DELETE SET NULL`. El hash usa `subject_id` (UUID del titular sin FK), no `user_id`; `verifyChain()` recalcula con `subject_id`. Agregar eventos solo con `appendConsent()`. `supresion` solo la registra el servidor.
- `DELETE /api/me`: exige `X-User-Id` explícito (400), rechaza `is_demo` con 403 `demo_account`, registra `supresion` y borra el usuario en una transacción (CASCADE en progreso; consents se conservan desvinculados, no anonimizados). El borrado diferido (offline) lo maneja el frontend reintentando.
- Sin `X-User-Id` las peticiones usan el usuario demo compartido (`DEMO_USER_EMAIL`): nunca lo borres ni lo ensucies en pruebas (el smoke usa `demo.energia@knet.local`).
- Comentarios y mensajes de error en español.
