import fp from "fastify-plugin";
import { env } from "../env.js";

/**
 * Client HTTP fino pro OpenRouter. Usa a mesma interface da OpenAI Chat
 * Completions API (endpoint /api/v1/chat/completions).
 *
 * Não adiciona dep — usa fetch nativo do Node 20+.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

declare module "fastify" {
  interface FastifyInstance {
    openrouter: {
      chat: (params: {
        messages: OpenRouterMessage[];
        model?: string;
        maxTokens?: number;
        temperature?: number;
      }) => Promise<string>;
      isConfigured: boolean;
    };
  }
}

export default fp(async (app) => {
  const apiKey = env.OPENROUTER_API_KEY;
  const defaultModel = env.OPENROUTER_MODEL;
  const isConfigured = Boolean(apiKey);

  async function chat(params: {
    messages: OpenRouterMessage[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY não configurada");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://performance-pulse.app",
          "X-Title": "Performance Pulse",
        },
        body: JSON.stringify({
          model: params.model ?? defaultModel,
          messages: params.messages,
          max_tokens: params.maxTokens ?? 500,
          temperature: params.temperature ?? 0.7,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as OpenRouterResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter retornou resposta vazia");

      if (data.usage) {
        app.log.info(
          { tokens: data.usage.total_tokens, model: params.model ?? defaultModel },
          "OpenRouter usage",
        );
      }

      return content;
    } finally {
      clearTimeout(timeout);
    }
  }

  app.decorate("openrouter", { chat, isConfigured });
});
