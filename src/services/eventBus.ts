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

export interface TournamentFinishedPayload {
  tournamentId: string;
  roundLabel: string;
  winners: Array<{
    rank: number;
    displayName: string;
    photoUrl: string | null;
    initials: string | null;
    payout: number;
    score: number;
  }>;
}

export interface GoalHitPayload {
  assessorName: string;
  assessorInitials: string;
  photoUrl: string | null;
  kpiLabel: string;
  kpiKey: string;
  percent: number; // >= 100
}


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

  // ─── Tournament finished ──────────────────────────────────────────────────
  // Emitido quando um torneio encerra (manual ou cron). Payload inclui
  // winners detalhados pra que a TV possa mostrar celebração fullscreen
  // sem precisar re-fetch do endpoint.

  emitTournamentFinished(payload: TournamentFinishedPayload) {
    this.emit("tournament:finished", payload);
  }

  onTournamentFinished(handler: (p: TournamentFinishedPayload) => void): () => void {
    this.on("tournament:finished", handler);
    return () => this.off("tournament:finished", handler);
  }

  // ─── Goal hit ─────────────────────────────────────────────────────────────
  // Emitido quando um assessor cruza 100% da meta de um KPI (de <100 pra >=100).
  // UI mostra toast 🎯 "João bateu meta de Ativação!"

  emitGoalHit(payload: GoalHitPayload) {
    this.emit("goal:hit", payload);
  }

  onGoalHit(handler: (p: GoalHitPayload) => void): () => void {
    this.on("goal:hit", handler);
    return () => this.off("goal:hit", handler);
  }

  // ─── Sound play (broadcast) ───────────────────────────────────────────────
  // Emitido quando evento sonoro deve tocar em TODOS clientes conectados
  // (não só quem registrou). Usado pro som de ativação — assim Felipe vê/ouve
  // independente de espelhamento de tela ou onde registrou.

  emitSoundPlay(payload: { kpiKey: string }) {
    this.emit("sound:play", payload);
  }

  onSoundPlay(handler: (p: { kpiKey: string }) => void): () => void {
    this.on("sound:play", handler);
    return () => this.off("sound:play", handler);
  }
}

// Singleton — mesmo across todo o app
export const eventBus = new AppEventBus();
