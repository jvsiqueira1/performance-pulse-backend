import Fastify from "fastify";
import { env } from "./env.js";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import multipartPlugin from "./plugins/multipart.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import corsPlugin from "./plugins/cors.js";
import swaggerPlugin from "./plugins/swagger.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import assessorRoutes from "./routes/assessors.js";
import kpiRoutes from "./routes/kpis.js";
import goalRoutes from "./routes/goals.js";
import metricRoutes from "./routes/metrics.js";
import rankingRoutes from "./routes/rankings.js";
import activityRoutes from "./routes/activities.js";
import squadRoutes from "./routes/squads.js";
import betRoutes from "./routes/bets.js";
import cofreRoutes from "./routes/cofre.js";
import badgeRoutes from "./routes/badges.js";
import reportRoutes from "./routes/reports.js";
import meetingRoutes from "./routes/meetings.js";
import userRoutes from "./routes/users.js";
import insightRoutes from "./routes/insights.js";
import streamRoutes from "./routes/stream.js";
import prizeRoutes from "./routes/prizes.js";
import directionRoutes from "./routes/directions.js";
import openrouterPlugin from "./plugins/openrouter.js";

async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "HH:MM:ss",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
  });

  // Infra plugins (ordem importa)
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  await app.register(multipartPlugin);
  await app.register(rateLimitPlugin);

  // Service plugins
  await app.register(openrouterPlugin);

  // HTTP plugins
  await app.register(corsPlugin);
  await app.register(swaggerPlugin);

  // Rotas
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(assessorRoutes);
  await app.register(kpiRoutes);
  await app.register(goalRoutes);
  await app.register(metricRoutes);
  await app.register(rankingRoutes);
  await app.register(activityRoutes);
  await app.register(squadRoutes);
  await app.register(betRoutes);
  await app.register(cofreRoutes);
  await app.register(badgeRoutes);
  await app.register(reportRoutes);
  await app.register(meetingRoutes);
  await app.register(userRoutes);
  await app.register(insightRoutes);
  await app.register(streamRoutes);
  await app.register(prizeRoutes);
  await app.register(directionRoutes);

  return app;
}

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`🚀 Performance Pulse API rodando em http://${env.HOST}:${env.PORT}`);
    app.log.info(`📚 Swagger UI: http://localhost:${env.PORT}/docs`);
    app.log.info(`📄 OpenAPI JSON: http://localhost:${env.PORT}/docs/json`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
