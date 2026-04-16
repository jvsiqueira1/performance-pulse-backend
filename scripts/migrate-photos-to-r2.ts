/**
 * Migra fotos de assessor do storage local (UPLOAD_DIR/assessors/*.jpg) pro Cloudflare R2.
 *
 * Como rodar:
 *   - Local:  npx tsx scripts/migrate-photos-to-r2.ts
 *   - No VPS: docker exec <container> npx tsx scripts/migrate-photos-to-r2.ts
 *
 * Requer R2_* env vars configuradas no `.env`.
 * Idempotente: re-upload sobrescreve; update no DB usa `photoUrl` novo.
 *
 * Fluxo:
 * 1. Lista todos os assessors com photoUrl local (começam com "/uploads/")
 * 2. Pra cada um:
 *    a. Abre o arquivo local (UPLOAD_DIR/assessors/{assessorId}.jpg)
 *    b. Faz PutObject no R2
 *    c. Atualiza assessor.photoUrl com a URL do R2
 * 3. Loga resultado (sucesso/falha por assessor).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/env.js";
import { getPhotoStorage } from "../src/services/photoStorage.js";

async function main() {
  if (!env.R2_BUCKET || !env.R2_PUBLIC_URL) {
    console.error("❌ R2 não configurado no .env. Defina R2_BUCKET e R2_PUBLIC_URL.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const storage = getPhotoStorage();

  console.log("🔎 Buscando assessors com fotos locais...");
  const assessors = await prisma.assessor.findMany({
    where: {
      photoUrl: { startsWith: "/uploads/" },
    },
    select: { id: true, name: true, photoUrl: true },
  });

  if (assessors.length === 0) {
    console.log("✅ Nenhum assessor com foto local pra migrar.");
    await prisma.$disconnect();
    return;
  }

  console.log(`📦 ${assessors.length} foto(s) pra migrar.\n`);

  const uploadRoot = resolve(env.UPLOAD_DIR);
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const a of assessors) {
    const localPath = join(uploadRoot, "assessors", `${a.id}.jpg`);
    if (!existsSync(localPath)) {
      console.warn(`⚠️  ${a.name}: arquivo local não existe (${localPath}) — pulando`);
      skipped++;
      continue;
    }

    try {
      const buffer = await readFile(localPath);
      const newUrl = await storage.uploadAssessorPhoto(a.id, buffer);
      await prisma.assessor.update({
        where: { id: a.id },
        data: { photoUrl: newUrl },
      });
      console.log(`✅ ${a.name} → ${newUrl}`);
      ok++;
    } catch (err) {
      console.error(`❌ ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`✅ Sucesso:  ${ok}`);
  console.log(`⚠️  Pulados: ${skipped}`);
  console.log(`❌ Falhas:  ${failed}`);
  console.log(`──────────────────────────────────────`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
