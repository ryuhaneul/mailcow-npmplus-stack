# Docker Hub library/node:24-bookworm-slim, 2026-10-15 UTC 조회.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# web/ 입력은 F01 산출물이다.
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server ./server
COPY --from=web-build --chown=node:node /app/web/dist ./web/dist
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
