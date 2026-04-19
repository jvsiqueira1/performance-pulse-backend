import cron from "node-cron";
import type { FastifyInstance } from "fastify";
import { finishTournament } from "../services/tournamentEngine.js";
import { eventBus } from "../services/eventBus.js";
import { todayInAppTz } from "../lib/dates.js";

/**
 * Cron job: auto-finaliza torneios cujo endDate já passou.
 *
 * Roda diariamente às 00:05 (5 min depois da meia-noite pra dar margem de
 * timezone). Busca todos os Bets com kind=TOURNAMENT, status=ACTIVE e
 * endDate < hoje → chama finishTournament() pra cada um.
 *
 * Motivação: Felipe não precisa lembrar de clicar "Finalizar" no domingo
 * à noite — segunda de manhã o torneio já tá encerrado, payouts no cofre,
 * TV mostra o CAMPEÃO. Sem auto-finish, torneios ficavam pendurados em
 * ACTIVE forever e matavam a credibilidade do sistema.
 */
export function startTournamentAutoFinishJob(app: FastifyInstance) {
  // "min hour day-of-month month day-of-week"
  // 00:05 BRT todo dia
  const schedule = "5 0 * * *";

  cron.schedule(
    schedule,
    async () => {
      try {
        const today = todayInAppTz();
        const pending = await app.prisma.bet.findMany({
          where: {
            kind: "TOURNAMENT",
            status: "ACTIVE",
            endDate: { lt: today },
          },
          select: { id: true, roundLabel: true },
        });

        if (pending.length === 0) {
          app.log.debug("auto-finish: nenhum torneio expirado");
          return;
        }

        app.log.info({ count: pending.length }, "auto-finish: processando torneios expirados");

        for (const t of pending) {
          try {
            const result = await finishTournament(app.prisma, t.id, null);
            app.log.info(
              { tournamentId: t.id, label: t.roundLabel, winners: result.winners.length, payouts: result.payoutsCreated },
              "auto-finish: torneio finalizado",
            );
          } catch (err) {
            app.log.error({ err, tournamentId: t.id }, "auto-finish: falha em torneio individual");
          }
        }

        // Broadcast consolidado — 1 SSE event invalida rankings/tournaments no front
        eventBus.emitRankingUpdate();
      } catch (err) {
        app.log.error({ err }, "auto-finish: erro geral no job");
      }
    },
    { timezone: "America/Sao_Paulo" },
  );

  app.log.info({ schedule }, "Tournament auto-finish cron scheduled");
}
