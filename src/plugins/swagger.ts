import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

/**
 * Registra Swagger (OpenAPI) + Swagger UI + compilers do fastify-type-provider-zod.
 *
 * Depois de registrado, cada rota que declarar schemas Zod vai aparecer
 * automaticamente em /docs/json (OpenAPI spec) e /docs (Swagger UI).
 *
 * O frontend consome /docs/json via `openapi-typescript` pra gerar tipos.
 */
export default fp(async (app) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Performance Pulse API",
        description:
          "API do dashboard de performance de vendas. Fonte de verdade dos tipos do frontend via OpenAPI + openapi-typescript.",
        version: "0.1.0",
      },
      servers: [
        { url: "http://localhost:3001", description: "Dev local" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
  });
});
