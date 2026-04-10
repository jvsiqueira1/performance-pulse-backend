/**
 * Helper de resolução biweekly pra atividades do cronograma.
 *
 * Fase 5: Felipe pediu que algumas quartas tenham "Indique Day" e outras
 * "Prospecção Agendamento", alternando a cada 15 dias. A solução é marcar
 * a Activity com `cadenceType=BIWEEKLY` + `biweeklyAnchorDate`, e usar este
 * helper pra decidir se ela está ativa em uma data específica.
 *
 * Regras:
 * - WEEKLY → sempre ativa (todas as semanas).
 * - BIWEEKLY sem anchor → inativa (estado inválido, defensivo).
 * - BIWEEKLY com anchor → ativa só nos dias `anchor + N*14` (N >= 0).
 *   Antes do anchor, NÃO fica ativa.
 *
 * O helper assume que `date` e `biweeklyAnchorDate` representam dias civis
 * (componente UTC, sem hora). Se vierem com hora, fazemos round pra dia
 * mais próximo pra evitar problemas de DST/timezone na conta de diff.
 */

const MS_PER_DAY = 86_400_000;

export interface ActivityCadenceFields {
  cadenceType: "WEEKLY" | "BIWEEKLY";
  biweeklyAnchorDate: Date | null;
}

export function isActivityActiveOn(
  activity: ActivityCadenceFields,
  date: Date,
): boolean {
  if (activity.cadenceType === "WEEKLY") return true;
  if (!activity.biweeklyAnchorDate) return false;

  const diffDays = Math.round(
    (date.getTime() - activity.biweeklyAnchorDate.getTime()) / MS_PER_DAY,
  );

  return diffDays >= 0 && diffDays % 14 === 0;
}
