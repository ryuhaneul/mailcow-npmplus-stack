# Docker Hub library/node:24-bookworm-slim, 2026-10-15 UTC 조회.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# web/ 입력은 F01 산출물이다.
# 관리 화면이 서버 문구를 같이 씀.
COPY server/admin/messages.js ./server/admin/messages.js
COPY web ./web
RUN npm run build && npm run build:admin

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server ./server
COPY --from=web-build --chown=node:node /app/web/dist ./web/dist
COPY --from=web-build --chown=node:node /app/web/dist-admin ./web/dist-admin
RUN mkdir -p /data/audit /brand && chown -R node:node /data /brand
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
