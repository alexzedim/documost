FROM registry.red-soft.ru/ubi8/nodejs-20:20-260106 AS base

USER root

RUN dnf update -y

FROM base AS builder

WORKDIR /opt/app-root/app

COPY . .

RUN npm install -g pnpm@10.27.0
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS installer

WORKDIR /opt/app-root/app

# Copy apps
COPY --from=builder /opt/app-root/app/apps/server/dist /opt/app-root/app/apps/server/dist
COPY --from=builder /opt/app-root/app/apps/client/dist /opt/app-root/app/apps/client/dist
COPY --from=builder /opt/app-root/app/apps/server/package.json /opt/app-root/app/apps/server/package.json

# Copy packages
COPY --from=builder /opt/app-root/app/packages/editor-ext/dist /opt/app-root/app/packages/editor-ext/dist
COPY --from=builder /opt/app-root/app/packages/editor-ext/package.json /opt/app-root/app/packages/editor-ext/package.json

# Copy root package files
COPY --from=builder /opt/app-root/app/package.json /opt/app-root/app/package.json
COPY --from=builder /opt/app-root/app/pnpm*.yaml /opt/app-root/app/

# Copy patches
COPY --from=builder /opt/app-root/app/patches /opt/app-root/app/patches

RUN npm install -g pnpm@10.27.0

RUN chown -R 1001:1001 /opt/app-root/app

USER 1001

RUN pnpm install --frozen-lockfile --prod

RUN mkdir -p /opt/app-root/app/data/storage

VOLUME ["/opt/app-root/app/data/storage"]

EXPOSE 3000

CMD ["pnpm", "start"]
