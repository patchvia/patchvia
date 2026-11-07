FROM node:22-alpine AS build
WORKDIR /app
# Toolchain only matters if better-sqlite3 has no prebuilt binary for the platform
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/patchvia/patchvia" \
      org.opencontainers.image.title="Patchvia DNS server" \
      org.opencontainers.image.description="Patchvia DNS: DNS infrastructure, simplified."
WORKDIR /app
ENV NODE_ENV=production DNS_PORT=53 API_PORT=8081 DB_PATH=/data/dns.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME /data
EXPOSE 53/udp 53/tcp 8081/tcp
# Port 53 is privileged; node is granted the capability instead of running as root
RUN apk add --no-cache libcap && setcap cap_net_bind_service=+ep /usr/local/bin/node && mkdir -p /data && chown node:node /data
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8081)+'/v1/server/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
