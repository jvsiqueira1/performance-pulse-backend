import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import { env } from "../env.js";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

export default fp(async (app) => {
  const uploadDir = resolve(env.UPLOAD_DIR);
  mkdirSync(uploadDir, { recursive: true });

  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: "/uploads/",
    decorateReply: false,
  });
});
