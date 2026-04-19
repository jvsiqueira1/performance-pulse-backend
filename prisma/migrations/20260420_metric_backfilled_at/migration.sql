-- Sprint C: visibilidade de pontuação retroativa.
-- Felipe pediu: "tem aquela parada principal de e se o assessor pontuar uma
-- atividade em outro dia". Sistema já permite — agora marca a entry pra UI
-- mostrar badge "🕐 retroativo" e Felipe não estranhar quando ranking mudar.

ALTER TABLE "metric_entries"
  ADD COLUMN "backfilledAt" TIMESTAMP(3);
