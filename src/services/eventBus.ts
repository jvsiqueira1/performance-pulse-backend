/**
 * EventBus in-memory pra SSE (Server-Sent Events).
 *
 * Single-instance via módulo singleton. Quando POST /api/metrics grava uma
 * métrica, emite "ranking:update". O SSE endpoint /api/stream/rankings escuta
 * e pusha pro client.
 *
 * Limitação: funciona apenas single-instance (1 container). Se escalar pra
 * multi-instance no Coolify, trocar por Redis pub/sub.
 */

import { EventEmitter } from "node:events";

class AppEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // suporta até 100 conexões SSE simultâneas
  }

  emitRankingUpdate() {
    this.emit("ranking:update");
  }

  onRankingUpdate(handler: () => void): () => void {
    this.on("ranking:update", handler);
    return () => this.off("ranking:update", handler);
  }
}

// Singleton — mesmo across todo o app
export const eventBus = new AppEventBus();
