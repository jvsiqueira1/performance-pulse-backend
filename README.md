# Performance Pulse — Backend

API Fastify + Prisma + Postgres do dashboard Performance Pulse.

Este é um **repositório separado** do frontend (que fica em
`../performance-pulse`, feito no Lovable e hospedado na Vercel).
Este backend é hospedado na VPS via Coolify.

## Stack

- Node 20 LTS
- Fastify 4 + `fastify-type-provider-zod` (validação via Zod)
- Prisma + Postgres 16
- `@fastify/swagger` → OpenAPI em `/docs/json` (consumido pelo frontend pra gerar tipos)
- `@fastify/jwt`, `bcryptjs` pra auth
- `@fastify/multipart` + `sharp` pra upload de fotos

## Dev local

```bash
# 1. Instalar deps
npm install

# 2. Copiar env
cp .env.example .env
# edite o .env e ajuste DATABASE_URL / JWT_SECRET

# 3. Subir Postgres via docker-compose (já embutido neste repo)
docker compose up -d postgres

# 4. Migrations + seed (Fase 2 em diante)
npm run prisma:migrate
npm run prisma:seed

# 5. Rodar em watch mode
npm run dev
```

Endpoints úteis:
- `GET /api/health` — status
- `GET /docs` — Swagger UI
- `GET /docs/json` — OpenAPI spec (o frontend consome daqui pra gerar tipos)

## Integração com o frontend

Os contratos (tipos) são definidos aqui via Zod em `src/schemas/*.ts`.
Cada rota declara seus schemas com `fastify-type-provider-zod`, e o
`@fastify/swagger` expõe o OpenAPI em `/docs/json`.

No frontend (`../performance-pulse`), rode `npm run sync-types` pra gerar
`src/api/types.generated.ts` automaticamente a partir do OpenAPI.

## Deploy — Coolify (VPS)

1. Criar nova Application no Coolify apontando pra este repo
2. Build via `Dockerfile` (multi-stage Node 20)
3. Criar Resource Postgres no Coolify (injeta `DATABASE_URL`)
4. Definir env vars:
   - `JWT_SECRET` (longo, aleatório)
   - `CORS_ORIGIN` — lista separada por vírgula dos domínios do frontend
     (ex: `https://pulse.vercel.app,https://pulse.meudominio.com`); regex
     `*.vercel.app` já é aceita automaticamente pra previews
   - `OPENROUTER_API_KEY` (Fase 10)
   - `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME`
   - `UPLOAD_DIR=/var/app/uploads`
5. Criar volume persistente montado em `/var/app/uploads`
6. Domínio: ex. `api.pulse.dominio.com` (TLS automático via Traefik)
