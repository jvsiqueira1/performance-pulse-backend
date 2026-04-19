-- Tournaments: extensão do Bet model com kind + campos opcionais.
-- Default CompetitionKind='SQUAD_BET' mantém compat com bets existentes.

-- ───────── Enums ─────────
CREATE TYPE "CompetitionKind" AS ENUM ('SQUAD_BET', 'TOURNAMENT');
CREATE TYPE "TournamentScope" AS ENUM ('INDIVIDUAL', 'SQUAD');

-- ───────── Bet ─────────
ALTER TABLE "bets"
  ADD COLUMN "kind" "CompetitionKind" NOT NULL DEFAULT 'SQUAD_BET',
  ADD COLUMN "tournamentScope" "TournamentScope",
  ADD COLUMN "maxWinners" INTEGER,
  ADD COLUMN "progressivePayoutJson" JSONB,
  ADD COLUMN "goalKpiKey" TEXT,
  ADD COLUMN "goalTargetValue" DOUBLE PRECISION;

CREATE INDEX "bets_kind_idx" ON "bets"("kind");

-- ───────── BetParticipant ─────────
-- squadId e snapshotMembersJson agora nullable (só preenchidos em SQUAD scope).
-- assessorId + rank são novos (assessorId preenchido em INDIVIDUAL scope).
ALTER TABLE "bet_participants"
  ALTER COLUMN "squadId" DROP NOT NULL,
  ALTER COLUMN "snapshotMembersJson" DROP NOT NULL,
  ADD COLUMN "assessorId" TEXT,
  ADD COLUMN "rank" INTEGER;

-- FK pro assessor
ALTER TABLE "bet_participants"
  ADD CONSTRAINT "bet_participants_assessorId_fkey"
  FOREIGN KEY ("assessorId") REFERENCES "assessors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Unique constraint pra (betId, assessorId) — multiple NULLs permitidos no Postgres
CREATE UNIQUE INDEX "bet_participants_betId_assessorId_key" ON "bet_participants"("betId", "assessorId");
