import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const cofreEntryKindSchema = z.enum(["DEPOSIT", "PAYOUT", "ADJUSTMENT"]);

const cofreEntryResponseSchema = z.object({
  id: z.string(),
  betId: z.string().nullable(),
  kind: cofreEntryKindSchema,
  amount: z.number(),
  description: z.string(),
  createdById: z.string(),
  createdAt: z.string(),
});

const balanceBySquadSchema = z.object({
  squadId: z.string(),
  squadName: z.string(),
  squadEmoji: z.string(),
  totalWon: z.number(),
  winCount: z.number(),
});

const balanceResponseSchema = z.object({
  totalDeposits: z.number(),
  totalPayouts: z.number(),
  totalAdjustments: z.number(),
  currentBalance: z.number(),
  bySquad: z.array(balanceBySquadSchema),
});

const adjustBodySchema = z.object({
  amount: z.number(),
  description: z.string().min(1).max(240),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function cofreRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/cofre/balance — saldo agregado + breakdown por squad
  typed.get(
    "/api/cofre/balance",
    {
      schema: {
        description:
          "Saldo do cofre: soma DEPOSIT − PAYOUT + ADJUSTMENT (pode ser negativo). " +
          "Também retorna quanto cada squad ganhou (PAYOUTs vinculados a bets vencidas). PUBLIC — consumido pela rota /tv.",
        tags: ["cofre"],
        response: { 200: balanceResponseSchema },
      },
      // Sem auth: usado pela TV pública (`/tv`).
    },
    async () => {
      const [entries, finishedBets] = await Promise.all([
        app.prisma.cofreEntry.findMany(),
        app.prisma.bet.findMany({
          where: { status: "FINISHED", winnerSquadId: { not: null } },
          include: { winnerSquad: { select: { id: true, name: true, emoji: true } } },
        }),
      ]);

      let totalDeposits = 0;
      let totalPayouts = 0;
      let totalAdjustments = 0;
      for (const e of entries) {
        if (e.kind === "DEPOSIT") totalDeposits += e.amount;
        else if (e.kind === "PAYOUT") totalPayouts += e.amount;
        else if (e.kind === "ADJUSTMENT") totalAdjustments += e.amount;
      }

      // Por squad: soma dos valores das bets finalizadas que ela venceu
      const bySquadMap = new Map<
        string,
        { squadId: string; squadName: string; squadEmoji: string; totalWon: number; winCount: number }
      >();
      for (const bet of finishedBets) {
        if (!bet.winnerSquad) continue;
        const key = bet.winnerSquad.id;
        const cur = bySquadMap.get(key) ?? {
          squadId: key,
          squadName: bet.winnerSquad.name,
          squadEmoji: bet.winnerSquad.emoji,
          totalWon: 0,
          winCount: 0,
        };
        cur.totalWon += bet.value;
        cur.winCount += 1;
        bySquadMap.set(key, cur);
      }

      return {
        totalDeposits,
        totalPayouts,
        totalAdjustments,
        currentBalance: totalDeposits - totalPayouts + totalAdjustments,
        bySquad: Array.from(bySquadMap.values()).sort((a, b) => b.totalWon - a.totalWon),
      };
    },
  );

  typed.get(
    "/api/cofre/ledger",
    {
      schema: {
        description: "Histórico completo do ledger do cofre, mais recentes primeiro",
        tags: ["cofre"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(cofreEntryResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async () => {
      const rows = await app.prisma.cofreEntry.findMany({
        orderBy: { createdAt: "desc" },
      });
      return rows.map((r) => ({
        id: r.id,
        betId: r.betId,
        kind: r.kind as "DEPOSIT" | "PAYOUT" | "ADJUSTMENT",
        amount: r.amount,
        description: r.description,
        createdById: r.createdById,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );

  typed.post(
    "/api/cofre/adjust",
    {
      schema: {
        description:
          "Cria uma entry ADJUSTMENT no cofre (somente ADMIN). Amount positivo = crédito, negativo = débito.",
        tags: ["cofre"],
        security: [{ bearerAuth: [] }],
        body: adjustBodySchema,
        response: { 201: cofreEntryResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (req.user.role !== "ADMIN") {
        return reply.status(403).send({ error: "Apenas ADMIN pode ajustar o cofre" } as never);
      }
      const created = await app.prisma.cofreEntry.create({
        data: {
          betId: null,
          kind: "ADJUSTMENT",
          amount: req.body.amount,
          description: req.body.description,
          createdById: req.user.sub,
        },
      });
      reply.status(201);
      return {
        id: created.id,
        betId: created.betId,
        kind: created.kind as "DEPOSIT" | "PAYOUT" | "ADJUSTMENT",
        amount: created.amount,
        description: created.description,
        createdById: created.createdById,
        createdAt: created.createdAt.toISOString(),
      };
    },
  );
}
