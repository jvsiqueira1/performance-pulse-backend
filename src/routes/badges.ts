import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const badgeScopeSchema = z.enum(["INDIVIDUAL", "SQUAD"]);

const badgeResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  scope: badgeScopeSchema,
  active: z.boolean(),
});

const badgeUnlockResponseSchema = z.object({
  id: z.string(),
  badgeId: z.string(),
  badgeSlug: z.string(),
  badgeName: z.string(),
  badgeIcon: z.string(),
  badgeScope: badgeScopeSchema,
  assessorId: z.string().nullable(),
  squadId: z.string().nullable(),
  periodKey: z.string(),
  unlockedAt: z.string(),
});

const unlocksQuerySchema = z.object({
  assessorId: z.string().optional(),
  squadId: z.string().optional(),
  periodKey: z.string().optional(),
});

export default async function badgeRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/badges",
    {
      schema: {
        description: "Lista definições de badges ativos",
        tags: ["badges"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(badgeResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async () => {
      const rows = await app.prisma.badge.findMany({
        where: { active: true },
        orderBy: [{ scope: "asc" }, { slug: "asc" }],
      });
      return rows.map((b) => ({
        id: b.id,
        slug: b.slug,
        name: b.name,
        description: b.description,
        icon: b.icon,
        scope: b.scope as "INDIVIDUAL" | "SQUAD",
        active: b.active,
      }));
    },
  );

  typed.get(
    "/api/badges/unlocks",
    {
      schema: {
        description: "Lista unlocks de badges (filtros: assessorId, squadId, periodKey)",
        tags: ["badges"],
        security: [{ bearerAuth: [] }],
        querystring: unlocksQuerySchema,
        response: { 200: z.array(badgeUnlockResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { assessorId, squadId, periodKey } = req.query;
      const rows = await app.prisma.badgeUnlock.findMany({
        where: {
          ...(assessorId ? { assessorId } : {}),
          ...(squadId ? { squadId } : {}),
          ...(periodKey ? { periodKey } : {}),
        },
        orderBy: { unlockedAt: "desc" },
        include: {
          badge: {
            select: { slug: true, name: true, icon: true, scope: true },
          },
        },
      });
      return rows.map((u) => ({
        id: u.id,
        badgeId: u.badgeId,
        badgeSlug: u.badge.slug,
        badgeName: u.badge.name,
        badgeIcon: u.badge.icon,
        badgeScope: u.badge.scope as "INDIVIDUAL" | "SQUAD",
        assessorId: u.assessorId,
        squadId: u.squadId,
        periodKey: u.periodKey,
        unlockedAt: u.unlockedAt.toISOString(),
      }));
    },
  );
}
