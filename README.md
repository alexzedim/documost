# Установка

npm config set strict-ssl false

pnpm install --unsafe-perm

# База данных

docker-compose -f docker-compose.db.yml up -d
_тестовый композ, который запускает только постгрю и редис_

# Миграции

cd apps/server

pnpm run migration:up

pnpm run migration:latest

# in .env

APP_SECRET: "minimum of 32 characters. Generate one with: openssl rand -hex 32"

# Cобираем editor-ext:

pnpm nx run @docmost/editor-ext:build

# Сборка и запуск

pnpm run dev

либо отдельно:

pnpm run client:dev

pnpm run server:dev
