#!/bin/sh
# Aplica las migraciones pendientes y arranca la API. node recibe las señales (exec) para cerrar ordenado.
set -e
if [ "$RUN_MIGRATIONS" = "true" ]; then
  node db/migrate.js
fi
exec node src/server.js
