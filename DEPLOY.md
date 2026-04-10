# Deploy Completo — Performance Pulse

Guia passo a passo pra subir o sistema em produção:
- **PostgreSQL** na VPS (Docker)
- **Backend** na VPS via Coolify (imagem GHCR)
- **Frontend** na Vercel (deploy automático via git)

---

## Pré-requisitos

- VPS com Docker instalado (Ubuntu 22+ recomendado)
- Coolify instalado na VPS ([coolify.io/docs](https://coolify.io/docs))
- Conta no GitHub com os dois repos:
  - `jvsiqueira1/performance-pulse-backend`
  - `Gandalfmax777/performance-pulse`
- Conta na Vercel ([vercel.com](https://vercel.com))
- Domínio apontando pra VPS (ex: `pulse.seudominio.com`)
- (Opcional) Conta no OpenRouter pra IA insights ([openrouter.ai](https://openrouter.ai))

---

## Parte 1 — PostgreSQL na VPS

### 1.1 Criar a rede Docker compartilhada

O banco e o backend precisam se comunicar dentro do Docker. Crie uma rede:

```bash
ssh usuario@sua-vps

docker network create pulse-network
```

### 1.2 Subir o Postgres via Docker

```bash
docker run -d \
  --name pulse-postgres \
  --network pulse-network \
  --restart unless-stopped \
  -e POSTGRES_USER=pulse_admin \
  -e POSTGRES_PASSWORD=GERE_UMA_SENHA_FORTE_AQUI \
  -e POSTGRES_DB=performance_pulse \
  -v /opt/pulse-postgres-data:/var/lib/postgresql/data \
  -p 127.0.0.1:5432:5432 \
  postgres:16-alpine
```

**Pontos importantes:**
- `-v /opt/pulse-postgres-data:/var/lib/postgresql/data` — volume persistente no host. Seus dados sobrevivem a restarts.
- `-p 127.0.0.1:5432:5432` — expõe APENAS pro localhost da VPS (não acessível de fora). Segurança.
- `--network pulse-network` — o backend vai se conectar por essa rede interna.
- **Troque** `GERE_UMA_SENHA_FORTE_AQUI` por uma senha real. Gere com:

```bash
openssl rand -base64 24
# Exemplo: k8Fj2mN7pQ3xR9vB1cL6wY4z
```

### 1.3 Verificar que o Postgres está rodando

```bash
docker exec pulse-postgres pg_isready -U pulse_admin -d performance_pulse
# Deve retornar: accepting connections
```

### 1.4 Anotar a DATABASE_URL

O backend vai se conectar ao Postgres pela rede Docker interna (nome do container como hostname):

```
DATABASE_URL=postgresql://pulse_admin:SUA_SENHA@pulse-postgres:5432/performance_pulse?schema=public
```

> **Atenção**: o host é `pulse-postgres` (nome do container), NÃO `localhost`. Isso porque backend e banco estão na mesma rede Docker (`pulse-network`).

---

## Parte 2 — Backend no Coolify

### 2.1 Configurar o repositório no Coolify

1. Abra o painel do Coolify (geralmente `http://sua-vps:8000`)
2. Vá em **Projects** → **New Project** → dê um nome (ex: "Performance Pulse")
3. Dentro do projeto, clique **+ New** → **Resource** → **Application**
4. Escolha **GitHub** como fonte
5. Selecione o repo `jvsiqueira1/performance-pulse-backend`
6. Branch: `main`

### 2.2 Configurar o build

No painel da aplicação:

- **Build Pack**: Docker
- **Dockerfile Location**: `Dockerfile` (raiz)
- **Docker Compose**: NÃO usar (o compose é só pra dev local)

**Ou se estiver usando a imagem pré-built do GHCR:**

- **Build Pack**: Docker Image
- **Image**: `ghcr.io/jvsiqueira1/performance-pulse-backend:latest`
- Isso usa a imagem que o GitHub Actions já buildou.

### 2.3 Configurar a rede

O backend precisa acessar o Postgres que está na rede `pulse-network`:

1. Na configuração da aplicação, seção **Network**
2. Adicione a rede externa: `pulse-network`
3. Isso permite que o container do backend resolva `pulse-postgres` como hostname

> Se o Coolify não permitir redes externas via UI, adicione manualmente via **Docker Compose** override ou **Custom Docker Options**: `--network pulse-network`

### 2.4 Variáveis de ambiente

Na seção **Environment Variables** da aplicação no Coolify, configure:

```env
# ─── OBRIGATÓRIAS ──────────────────────────────────────────────────────────

NODE_ENV=production
PORT=3001
HOST=0.0.0.0

# Database (host = nome do container Postgres na rede Docker)
DATABASE_URL=postgresql://pulse_admin:SUA_SENHA@pulse-postgres:5432/performance_pulse?schema=public

# Auth (gere com: openssl rand -base64 32)
JWT_SECRET=COLE_AQUI_STRING_ALEATORIA_LONGA

# CORS (domínio do frontend — onde a Vercel vai servir)
CORS_ORIGIN=https://performance-pulse.vercel.app,https://pulse.seudominio.com

# Uploads
UPLOAD_DIR=/var/app/uploads

# Admin inicial (usado no primeiro seed)
SEED_ADMIN_EMAIL=joaovitorsc@gmail.com
SEED_ADMIN_PASSWORD=sua-senha-admin
SEED_ADMIN_NAME=João Vitor

# ─── OPCIONAIS ─────────────────────────────────────────────────────────────

# IA Insights (obtenha em https://openrouter.ai/keys)
OPENROUTER_API_KEY=sk-or-v1-xxx
OPENROUTER_MODEL=google/gemini-2.5-flash

# Defaults (não precisa mudar)
JWT_EXPIRES_IN=7d
LOG_LEVEL=info
MAX_UPLOAD_SIZE_MB=2
```

### 2.5 Volume persistente

Configure um volume pra uploads não se perderem entre deploys:

1. Na seção **Persistent Storage** / **Volumes**
2. Adicione: **Source**: `/opt/pulse-uploads` → **Destination**: `/var/app/uploads`

### 2.6 Domínio e SSL

1. Na seção **Domain**, adicione: `api.pulse.seudominio.com`
2. Coolify gera certificado TLS automaticamente via Let's Encrypt (Traefik)
3. Porta exposta: `3001`

### 2.7 Health Check

Configure o health check do Coolify:

- **URL**: `/api/health/ready`
- **Port**: `3001`
- **Interval**: `30s`
- **Timeout**: `10s`

### 2.8 Deploy e primeiro seed

1. Clique **Deploy** no Coolify
2. Aguarde o build + start (a migration roda automaticamente no startup: `npx prisma migrate deploy`)
3. Após o container estar healthy, rode o seed manualmente (uma vez):

```bash
# Opção A: via Coolify terminal (se disponível)
docker exec <container-id> npx tsx prisma/seed.ts

# Opção B: via SSH na VPS
docker exec $(docker ps -q --filter "name=performance-pulse") npx tsx prisma/seed.ts
```

4. Verifique:

```bash
curl https://api.pulse.seudominio.com/api/health/ready
# Deve retornar: {"status":"ok","db":"ok",...}
```

### 2.9 Configurar GitHub Actions (opcional — CI/CD automático)

Pra que cada push na `main` faça build + deploy automático:

1. No GitHub, vá em `jvsiqueira1/performance-pulse-backend` → **Settings** → **Secrets and variables** → **Actions**
2. Adicione os secrets:

| Secret | Valor |
|---|---|
| `COOLIFY_WEBHOOK_API` | URL do webhook de deploy da aplicação no Coolify (copie de Settings → Webhooks) |
| `COOLIFY_TOKEN` | Token da API do Coolify (Settings → API Tokens) |

3. Pronto — a cada push na `main`, o GitHub Actions faz build da imagem Docker, pusha pro GHCR, e trigga o Coolify pra fazer redeploy.

---

## Parte 3 — Frontend na Vercel

### 3.1 Importar o repositório

1. Acesse [vercel.com/new](https://vercel.com/new)
2. Conecte sua conta GitHub
3. Selecione o repo `Gandalfmax777/performance-pulse`
4. Framework preset: **Vite**

### 3.2 Variável de ambiente

Na tela de configuração (antes do primeiro deploy), adicione:

| Variável | Valor |
|---|---|
| `VITE_API_URL` | `https://api.pulse.seudominio.com/api` |

> **Importante**: a URL termina com `/api` (o backend usa esse prefixo em todas as rotas).

### 3.3 Deploy

Clique **Deploy**. A Vercel vai:
1. Instalar deps (`npm install`)
2. Buildar (`vite build`)
3. Servir os arquivos estáticos

Deploy automático a cada push na `main`.

### 3.4 Domínio customizado (opcional)

1. Na Vercel, vá em **Settings** → **Domains**
2. Adicione `pulse.seudominio.com`
3. Configure o DNS (CNAME pra `cname.vercel-dns.com`)
4. TLS automático

### 3.5 Verificar

Acesse `https://performance-pulse.vercel.app` (ou seu domínio):
1. Deve redirecionar pra `/login`
2. Logue com as credenciais do seed (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`)
3. Dashboard carrega com dados do backend

---

## Parte 4 — DNS (se tiver domínio próprio)

### Configuração típica

No seu provedor de DNS (Cloudflare, Route53, etc.):

| Tipo | Nome | Valor | Proxy |
|---|---|---|---|
| A | `api.pulse` | `IP_DA_VPS` | Off (DNS only) |
| CNAME | `pulse` | `cname.vercel-dns.com` | Off |

> Se usar Cloudflare com proxy ligado no `api.pulse`, desabilite pra SSE funcionar (Cloudflare bufferiza por default e mata o stream).

---

## Parte 5 — Checklist pós-deploy

### Backend

- [ ] `curl https://api.pulse.seudominio.com/api/health/ready` retorna `{"status":"ok","db":"ok"}`
- [ ] `curl -X POST https://api.pulse.seudominio.com/api/auth/login -H "Content-Type: application/json" -d '{"email":"seu@email","password":"sua-senha"}'` retorna token
- [ ] Swagger UI acessível em `https://api.pulse.seudominio.com/docs`
- [ ] Volume de uploads montado (`/var/app/uploads`)
- [ ] CORS aceita o domínio do frontend

### Frontend

- [ ] Login funciona
- [ ] Overview carrega KPIs + ranking
- [ ] Tab "Por Dia" mostra atividades do cronograma
- [ ] Admin (botão no header) acessível
- [ ] Modo TV funciona (fullscreen + SSE stream)

### Banco

- [ ] `docker exec pulse-postgres pg_isready` retorna healthy
- [ ] Volume persistente em `/opt/pulse-postgres-data`
- [ ] Backup automático configurado (ver seção abaixo)

---

## Parte 6 — Backup do banco

### Script de backup diário

Crie `/opt/scripts/backup-pulse-db.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/opt/backups/pulse"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

docker exec pulse-postgres pg_dump -U pulse_admin -d performance_pulse \
  | gzip > "$BACKUP_DIR/pulse_${TIMESTAMP}.sql.gz"

# Manter só os últimos 30 dias
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +30 -delete

echo "Backup concluído: pulse_${TIMESTAMP}.sql.gz"
```

```bash
chmod +x /opt/scripts/backup-pulse-db.sh
```

### Cron (todo dia às 3h da manhã)

```bash
crontab -e
# Adicionar:
0 3 * * * /opt/scripts/backup-pulse-db.sh >> /var/log/pulse-backup.log 2>&1
```

### Restaurar backup

```bash
gunzip -c /opt/backups/pulse/pulse_20260410_030000.sql.gz \
  | docker exec -i pulse-postgres psql -U pulse_admin -d performance_pulse
```

---

## Parte 7 — Troubleshooting

### "CORS: origem bloqueada"

O frontend está chamando de um domínio que não está na lista `CORS_ORIGIN` do backend. Adicione o domínio (separado por vírgula) e redeploy.

### "Token inválido ou ausente" no SSE

O EventSource do Modo TV passa o token via query param (`?token=xxx`). Se der 401, o token pode ter expirado. Relogue no frontend.

### "OPENROUTER_API_KEY não configurada"

Insights IA requerem uma API key do OpenRouter. Se não quiser usar IA, essa mensagem é esperada e não afeta o resto do sistema.

### Backend não conecta no Postgres

Verifique:
1. `docker network inspect pulse-network` — backend e postgres estão na mesma rede?
2. O host na `DATABASE_URL` é o nome do container (`pulse-postgres`), não `localhost`
3. Porta é `5432` (interna do container, não a mapeada no host)

### Migration falha no deploy

O Dockerfile executa `npx prisma migrate deploy` no startup. Se falhar:
1. Verifique se o Postgres está healthy antes do backend subir
2. Verifique se a `DATABASE_URL` está correta
3. Olhe os logs do container: `docker logs <container-id>`

### Frontend mostra tela branca

1. Abra DevTools → Console. Se der erro de fetch pra `localhost:3001`, o `VITE_API_URL` não está configurado na Vercel.
2. Configure `VITE_API_URL=https://api.pulse.seudominio.com/api` nas env vars da Vercel e **redeploy** (Vite lê env vars em build time, não runtime).

---

## Resumo final

| Componente | Onde roda | URL pública | Porta |
|---|---|---|---|
| PostgreSQL | VPS (Docker) | — (só rede interna) | 5432 |
| Backend API | VPS (Coolify) | `https://api.pulse.seudominio.com` | 3001 |
| Frontend | Vercel | `https://pulse.seudominio.com` | 443 |
| Swagger UI | VPS (via backend) | `https://api.pulse.seudominio.com/docs` | 3001 |
