FROM registry.red-soft.ru/ubi8/ubi-minimal:8.0.2-260120 AS base

USER root

RUN dnf update -y && dnf install -y tar xz

WORKDIR /usr/local

COPY nodejs.tar.xz .

RUN tar -xJvf nodejs.tar.xz --strip-components 1 && rm -f nodejs.tar.xz
RUN npm install -g npm@latest

FROM base AS builder

WORKDIR /app

COPY . .

RUN npm install -g pnpm@10.27.0
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS installer

WORKDIR /app

# Copy apps
COPY --from=builder /app/apps/server/dist /app/apps/server/dist
COPY --from=builder /app/apps/client/dist /app/apps/client/dist
COPY --from=builder /app/apps/server/package.json /app/apps/server/package.json

# Copy packages
COPY --from=builder /app/packages/editor-ext/dist /app/packages/editor-ext/dist
COPY --from=builder /app/packages/editor-ext/package.json /app/packages/editor-ext/package.json

# Copy root package files
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm*.yaml /app/

# Copy patches
COPY --from=builder /app/patches /app/patches

RUN useradd --create-home --uid 1001 node

RUN npm install -g pnpm@10.27.0

RUN chown -R 1001:1001 /app

USER 1001

RUN pnpm install --frozen-lockfile --prod

RUN mkdir -p /app/data/storage

VOLUME ["/app/data/storage"]

EXPOSE 3000

CMD ["pnpm", "start"]
