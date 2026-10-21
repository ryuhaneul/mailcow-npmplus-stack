# Build from the repository root: docker build -f log-archiver/Dockerfile .
# Match the existing webmail runtime image.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV NODE_ENV=production
WORKDIR /app
COPY log-archiver/package.json log-archiver/*.js ./log-archiver/
COPY webmail/server/admin/log-sanitize.js ./webmail/server/admin/log-sanitize.js
# Docker json-file logs/config can be root-only. Run as root with read-only
# rootfs, cap_drop ALL, no-new-privileges and read-only input mounts in Compose.
# Only /archive is writable; no Docker socket or privileged mode is required.
USER root
EXPOSE 8080
CMD ["node", "log-archiver/main.js"]
