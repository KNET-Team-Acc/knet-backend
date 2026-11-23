# KNET API · imagen de producción
#   docker build -t knet-api .
#   docker run -p 4000:4000 --env-file .env.production knet-api
# Al arrancar aplica las migraciones pendientes (RUN_MIGRATIONS=false para hacerlo en un job aparte).

# 1) Dependencias de producción (sin devDependencies ni caché de npm)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 2) Imagen final: solo node_modules + código, con usuario sin privilegios
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=4000 \
    RUN_MIGRATIONS=true
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node db ./db
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod 0555 docker-entrypoint.sh
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
