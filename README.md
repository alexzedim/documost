npm config set strict-ssl false

pnpm install --unsafe-perm

docker-compose -f docker-compose.db.yml up -d //тестовый композ, который запускает только постгрю и редис

cd apps/server

pnpm run migration:up
pnpm run migration:latest

in .env
APP_SECRET: "minimum of 32 characters. Generate one with: openssl rand -hex 32"

собираем editor-ext:
pnpm nx run @docmost/editor-ext:build


локально запускаем бэк фронт:
pnpm run dev

либо отдельно:
pnpm run client:dev
pnpm run server:dev