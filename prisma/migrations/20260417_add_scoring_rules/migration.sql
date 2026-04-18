-- CreateEnum
CREATE TYPE "ScoringRuleType" AS ENUM ('LINEAR', 'THRESHOLD_PERCENT');

-- CreateTable
CREATE TABLE "scoring_rules" (
    "id" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "ruleType" "ScoringRuleType" NOT NULL,
    "divisor" DOUBLE PRECISION,
    "pointsPerBucket" DOUBLE PRECISION,
    "thresholdPct" DOUBLE PRECISION,
    "thresholdPoints" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scoring_rules_kpiId_key" ON "scoring_rules"("kpiId");

-- AddForeignKey
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "kpis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
