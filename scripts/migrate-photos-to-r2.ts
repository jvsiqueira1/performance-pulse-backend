/**
 * Migração + limpeza de fotos de assessor pra Cloudflare R2.
 *
 * Como rodar:
 *   - Local:  npx tsx scripts/migrate-photos-to-r2.ts
 *   - No VPS: abrir Terminal do container no Coolify e rodar o mesmo comando
 *
 * Requer R2_* env vars configuradas.
 *
 * Fluxo:
 * 1. Lista todos os assessors com photoUrl local (começam com "/uploads/")
 * 2. Pra cada um:
 *    a. Se o arquivo local existir: faz upload pro R2 e atualiza photoUrl
 *    b. Se NÃO existir (foto perdida em algum redeploy): seta photoUrl=null
 *       pra UI parar de tentar carregar URL quebrada e mostrar fallback de iniciais.
 * 3. Loga resultado.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/env.js";
import { getPhotoStorage } from "../src/services/photoStorage.js";

// Locais onde o volume de uploads podia estar antes da migração pro R2.
const POSSIBLE_UPLOAD_DIRS = ["/var/app/uploads", "./uploads"];

function findLocalPhoto(assessorId: string): string | null {
  for (const root of POSSIBLE_UPLOAD_DIRS) {
    const path = `${root}/assessors/${assessorId}.jpg`;
    if (existsSync(path)) return path;
  }
  return null;
}

async function main() {
  if (!env.R2_BUCKET || !env.R2_PUBLIC_URL) {
    console.error("❌ R2 não configurado no .env. Defina R2_BUCKET e R2_PUBLIC_URL.");
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  const storage = getPhotoStorage();

  console.log("🔎 Buscando assessors com photoUrl local (/uploads/...)...");
  const assessors = await prisma.assessor.findMany({
    where: {
      photoUrl: { startsWith: "/uploads/" },
    },
    select: { id: true, name: true, photoUrl: true },
  });

  if (assessors.length === 0) {
    console.log("✅ Nenhum assessor com photoUrl local — nada a migrar.");
    await prisma.$disconnect();
    return;
  }

  console.log(`📦 ${assessors.length} assessor(es) encontrado(s).\n`);

  let uploaded = 0;
  let cleared = 0;
  let failed = 0;

  for (const a of assessors) {
    const localPath = findLocalPhoto(a.id);

    if (localPath) {
      // Arquivo existe: migra pro R2
      try {
        const buffer = await readFile(localPath);
        const newUrl = await storage.uploadAssessorPhoto(a.id, buffer);
        await prisma.assessor.update({
          where: { id: a.id },
          data: { photoUrl: newUrl },
        });
        console.log(`✅ ${a.name}: migrado → ${newUrl}`);
        uploaded++;
      } catch (err) {
        console.error(`❌ ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    } else {
      // Arquivo não existe (foto perdida): limpa URL do banco
      try {
        await prisma.assessor.update({
          where: { id: a.id },
          data: { photoUrl: null },
        });
        console.log(`🧹 ${a.name}: arquivo local não existe — photoUrl limpa`);
        cleared++;
      } catch (err) {
        console.error(`❌ ${a.name} (clear): ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`✅ Migradas pro R2: ${uploaded}`);
  console.log(`🧹 URLs limpas:     ${cleared}`);
  console.log(`❌ Falhas:          ${failed}`);
  console.log(`──────────────────────────────────────`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
