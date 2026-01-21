# Установка

npm config set strict-ssl false

pnpm install --unsafe-perm

# База данных - _тестовый композ, который запускает только постгрю и редис_

docker-compose -f docker-compose.db.yml up -d

# Миграции

cd apps/server

pnpm run migration:up

pnpm run migration:latest

# in .env

APP_SECRET: "openssl rand -hex 32"

# Cобираем editor-ext:

pnpm nx run @wiki/editor-ext:build

# Сборка и запуск

pnpm run dev

_либо отдельно:_

pnpm run client:dev

pnpm run server:dev
