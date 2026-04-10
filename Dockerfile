# Multi-stage build pro Coolify
# Stage 1: dependências + build
FROM node:20-alpine AS builder

WORKDIR /app

# Instalar dependências primeiro (cache layer)
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copiar código
COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY src ./src
COPY prisma ./prisma

# Gerar cliente Prisma 7 + build TS
RUN npx prisma generate
RUN npm run build

# Stage 2: runtime
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Sharp precisa de libs nativas
RUN apk add --no-cache vips-dev

# Copiar só o necessário do builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/package.json ./package.json

# Criar diretório de uploads (montado como volume no Coolify)
RUN mkdir -p /var/app/uploads
ENV UPLOAD_DIR=/var/app/uploads

EXPOSE 3001

# Migrations automáticas no deploy + start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
