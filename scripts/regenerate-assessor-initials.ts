/**
 * Regenera as iniciais de todos os assessores usando a regra padrão
 * `deriveInitials(name)` — primeira letra do primeiro nome + primeira letra
 * do último nome (ex: "Bruno Coimbra" → "BC", "João Pedro Alves" → "JA").
 *
 * Como rodar:
 *   - Local:  npx tsx scripts/regenerate-assessor-initials.ts
 *   - No VPS: Terminal do container Coolify → mesmo comando
 *
 * Flags:
 *   --dry    apenas mostra o que mudaria, sem gravar
 *   --force  sobrescreve TODAS as iniciais (incluindo as que foram definidas
 *            manualmente — cuidado). Sem essa flag, só corrige iniciais que
 *            estão visivelmente erradas (não batem com o nome).
 *
 * Idempotente. Pode rodar várias vezes.
 *
 * Motivo: alguns assessores aparecem no dashboard com iniciais que não
 * batem com o nome (ex: "Bruno Coimbra" mostrando "JR", "Diego Laier" como
 * "MS"). Provavelmente foram editadas manualmente ou seed legado.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/env.js";

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * Considera uma inicial "obviamente errada" quando nenhuma das letras dela
 * aparece no nome. Ex: nome "Bruno Coimbra" com iniciais "JR" — nem J nem R
 * estão no nome → errada. Mas "BC" tem B e C no nome → ok.
 *
 * Evita sobrescrever variações aceitáveis (ex: "JP" pra "João Pedro Alves"
 * em vez de "JA" — ambas as iniciais batem com partes do nome).
 */
function isObviouslyWrong(name: string, current: string): boolean {
  if (!current || current.length === 0) return true;
  const upper = name.toUpperCase();
  for (const ch of current.toUpperCase()) {
    if (!upper.includes(ch)) return true;
  }
  return false;
}

async function main() {
  const dryRun = process.argv.includes("--dry");
  const force = process.argv.includes("--force");

  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  console.log(`🔎 Buscando assessores... (${dryRun ? "DRY RUN" : force ? "FORCE" : "SAFE"})`);

  const assessors = await prisma.assessor.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, initials: true },
  });

  console.log(`📋 Total: ${assessors.length} assessores\n`);

  const planned: Array<{ id: string; name: string; from: string; to: string; reason: string }> = [];
  const unchanged: Array<{ name: string; initials: string }> = [];

  for (const a of assessors) {
    const target = deriveInitials(a.name);
    const current = a.initials ?? "";

    if (current === target) {
      unchanged.push({ name: a.name, initials: current });
      continue;
    }

    const wrong = isObviouslyWrong(a.name, current);
    if (!wrong && !force) {
      // Iniciais diferentes mas plausíveis (ex: JP pra João Pedro) — skip no modo safe
      unchanged.push({ name: a.name, initials: `${current} (plausível, skip)` });
      continue;
    }

    planned.push({
      id: a.id,
      name: a.name,
      from: current || "(vazio)",
      to: target,
      reason: wrong ? "obviamente errada" : "force mode",
    });
  }

  // Relatório
  if (planned.length === 0) {
    console.log("✅ Nada a mudar. Iniciais batem com o nome em todos.");
  } else {
    console.log(`🔧 Vai ${dryRun ? "mudar (simulação)" : "mudar"}:`);
    for (const p of planned) {
      console.log(`   ${p.name.padEnd(30)} ${p.from.padStart(6)} → ${p.to}  [${p.reason}]`);
    }
    console.log();
  }

  if (unchanged.length > 0 && unchanged.length <= 20) {
    console.log(`👌 Sem mudança (${unchanged.length}):`);
    for (const u of unchanged) {
      console.log(`   ${u.name.padEnd(30)} ${u.initials}`);
    }
    console.log();
  } else if (unchanged.length > 20) {
    console.log(`👌 Sem mudança: ${unchanged.length} assessores\n`);
  }

  // Aplica
  if (dryRun) {
    console.log("🔕 DRY RUN — nada foi gravado. Rode sem --dry pra aplicar.");
    await prisma.$disconnect();
    return;
  }

  if (planned.length === 0) {
    await prisma.$disconnect();
    return;
  }

  console.log(`💾 Aplicando ${planned.length} updates...`);
  let updated = 0;
  for (const p of planned) {
    await prisma.assessor.update({
      where: { id: p.id },
      data: { initials: p.to },
    });
    updated++;
  }
  console.log(`✅ ${updated} assessores atualizados.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("❌ Erro:", err);
  process.exit(1);
});
