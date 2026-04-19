-- Sprint B: estende DailyDirection pra suportar período (DAILY/WEEKLY/MONTHLY)
-- + KPIs alvo + status de cumprimento (PENDING/ACHIEVED/PARTIAL/MISSED).
-- Não destrutivo: campos novos opcionais, defaults preservam comportamento
-- atual (todas directions existentes ficam DAILY + PENDING).

-- ───────── Enums ─────────
CREATE TYPE "DirectionPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE "DirectionStatus" AS ENUM ('PENDING', 'ACHIEVED', 'PARTIAL', 'MISSED');

-- ───────── DailyDirection ─────────
ALTER TABLE "daily_directions"
  ADD COLUMN "period"        "DirectionPeriod" NOT NULL DEFAULT 'DAILY',
  ADD COLUMN "periodStart"   DATE,
  ADD COLUMN "periodEnd"     DATE,
  ADD COLUMN "targetKpiKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "status"        "DirectionStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "reviewNote"    TEXT,
  ADD COLUMN "reviewedAt"    TIMESTAMP(3),
  ADD COLUMN "reviewedById"  TEXT;

-- FK pro reviewer
ALTER TABLE "daily_directions"
  ADD CONSTRAINT "daily_directions_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Index pra query de compliance por período
CREATE INDEX "daily_directions_period_date_idx" ON "daily_directions"("period", "date");
