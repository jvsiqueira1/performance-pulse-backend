-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER');

-- CreateEnum
CREATE TYPE "AssessorLevel" AS ENUM ('BRONZE', 'SILVER', 'GOLD');

-- CreateEnum
CREATE TYPE "KpiInputMode" AS ENUM ('ABSOLUTE', 'PERCENT', 'QUANTITY_OVER_BASE');

-- CreateEnum
CREATE TYPE "GoalPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "CadenceType" AS ENUM ('WEEKLY', 'BIWEEKLY');

-- CreateEnum
CREATE TYPE "MeetingOutcomeStatus" AS ENUM ('SCHEDULED', 'NO_SHOW', 'DONE', 'CLOSED_WON', 'CLOSED_LOST');

-- CreateEnum
CREATE TYPE "BetType" AS ENUM ('WEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('ACTIVE', 'FINISHED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CofreEntryKind" AS ENUM ('DEPOSIT', 'PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "BadgeScope" AS ENUM ('INDIVIDUAL', 'SQUAD');

-- CreateEnum
CREATE TYPE "InsightPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "photoUrl" TEXT,
    "level" "AssessorLevel" NOT NULL DEFAULT 'BRONZE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "hiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpis" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "inputMode" "KpiInputMode" NOT NULL DEFAULT 'ABSOLUTE',
    "baseSource" TEXT,
    "defaultTarget" DOUBLE PRECISION NOT NULL,
    "isDerived" BOOLEAN NOT NULL DEFAULT false,
    "derivedFormula" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kpis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "period" "GoalPeriod" NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "appliesRetroactively" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "cadenceType" "CadenceType" NOT NULL DEFAULT 'WEEKLY',
    "biweeklyAnchorDate" DATE,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_kpis" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "targetOverride" DOUBLE PRECISION,

    CONSTRAINT "activity_kpis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_entries" (
    "id" TEXT NOT NULL,
    "assessorId" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "activityId" TEXT,
    "date" DATE NOT NULL,
    "rawValue" DOUBLE PRECISION NOT NULL,
    "baseValue" DOUBLE PRECISION,
    "convertedPercent" DOUBLE PRECISION,
    "pointsAwarded" DOUBLE PRECISION,
    "enteredById" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_outcomes" (
    "id" TEXT NOT NULL,
    "assessorId" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "scheduledMetricEntryId" TEXT,
    "outcome" "MeetingOutcomeStatus" NOT NULL DEFAULT 'SCHEDULED',
    "closedAt" TIMESTAMP(3),
    "ticketValue" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "squads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "squads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "squad_members" (
    "id" TEXT NOT NULL,
    "squadId" TEXT NOT NULL,
    "assessorId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "squad_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" TEXT NOT NULL,
    "roundLabel" TEXT NOT NULL,
    "type" "BetType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'ACTIVE',
    "winnerSquadId" TEXT,
    "winnerCriteriaJson" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bet_participants" (
    "id" TEXT NOT NULL,
    "betId" TEXT NOT NULL,
    "squadId" TEXT NOT NULL,
    "snapshotMembersJson" JSONB NOT NULL,
    "finalScore" DOUBLE PRECISION,

    CONSTRAINT "bet_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cofre_entries" (
    "id" TEXT NOT NULL,
    "betId" TEXT,
    "kind" "CofreEntryKind" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cofre_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "scope" "BadgeScope" NOT NULL,
    "ruleJson" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_unlocks" (
    "id" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "assessorId" TEXT,
    "squadId" TEXT,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodKey" TEXT NOT NULL,

    CONSTRAINT "badge_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_insights" (
    "id" TEXT NOT NULL,
    "assessorId" TEXT,
    "squadId" TEXT,
    "periodKind" "InsightPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "textMarkdown" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "key" TEXT NOT NULL,
    "valueJson" JSONB NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "assessors_active_idx" ON "assessors"("active");

-- CreateIndex
CREATE UNIQUE INDEX "kpis_key_key" ON "kpis"("key");

-- CreateIndex
CREATE INDEX "kpis_active_sortOrder_idx" ON "kpis"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "goals_kpiId_validFrom_idx" ON "goals"("kpiId", "validFrom");

-- CreateIndex
CREATE INDEX "goals_kpiId_validTo_idx" ON "goals"("kpiId", "validTo");

-- CreateIndex
CREATE INDEX "activities_dayOfWeek_active_idx" ON "activities"("dayOfWeek", "active");

-- CreateIndex
CREATE INDEX "activities_cadenceType_idx" ON "activities"("cadenceType");

-- CreateIndex
CREATE UNIQUE INDEX "activity_kpis_activityId_kpiId_key" ON "activity_kpis"("activityId", "kpiId");

-- CreateIndex
CREATE INDEX "metric_entries_date_idx" ON "metric_entries"("date");

-- CreateIndex
CREATE INDEX "metric_entries_assessorId_date_idx" ON "metric_entries"("assessorId", "date");

-- CreateIndex
CREATE INDEX "metric_entries_kpiId_date_idx" ON "metric_entries"("kpiId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "metric_entries_assessorId_kpiId_activityId_date_key" ON "metric_entries"("assessorId", "kpiId", "activityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_outcomes_scheduledMetricEntryId_key" ON "meeting_outcomes"("scheduledMetricEntryId");

-- CreateIndex
CREATE INDEX "meeting_outcomes_assessorId_scheduledDate_idx" ON "meeting_outcomes"("assessorId", "scheduledDate");

-- CreateIndex
CREATE INDEX "meeting_outcomes_outcome_idx" ON "meeting_outcomes"("outcome");

-- CreateIndex
CREATE INDEX "squad_members_assessorId_idx" ON "squad_members"("assessorId");

-- CreateIndex
CREATE UNIQUE INDEX "squad_members_squadId_assessorId_leftAt_key" ON "squad_members"("squadId", "assessorId", "leftAt");

-- CreateIndex
CREATE INDEX "bets_status_idx" ON "bets"("status");

-- CreateIndex
CREATE INDEX "bets_endDate_idx" ON "bets"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "bet_participants_betId_squadId_key" ON "bet_participants"("betId", "squadId");

-- CreateIndex
CREATE INDEX "cofre_entries_createdAt_idx" ON "cofre_entries"("createdAt");

-- CreateIndex
CREATE INDEX "cofre_entries_betId_idx" ON "cofre_entries"("betId");

-- CreateIndex
CREATE UNIQUE INDEX "badges_slug_key" ON "badges"("slug");

-- CreateIndex
CREATE INDEX "badge_unlocks_unlockedAt_idx" ON "badge_unlocks"("unlockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "badge_unlocks_badgeId_assessorId_periodKey_key" ON "badge_unlocks"("badgeId", "assessorId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "badge_unlocks_badgeId_squadId_periodKey_key" ON "badge_unlocks"("badgeId", "squadId", "periodKey");

-- CreateIndex
CREATE INDEX "ai_insights_assessorId_periodKind_periodKey_idx" ON "ai_insights"("assessorId", "periodKind", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "ai_insights_assessorId_periodKind_periodKey_inputHash_key" ON "ai_insights"("assessorId", "periodKind", "periodKey", "inputHash");

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "kpis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_kpis" ADD CONSTRAINT "activity_kpis_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_kpis" ADD CONSTRAINT "activity_kpis_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "kpis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_entries" ADD CONSTRAINT "metric_entries_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "assessors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_entries" ADD CONSTRAINT "metric_entries_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "kpis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_entries" ADD CONSTRAINT "metric_entries_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_entries" ADD CONSTRAINT "metric_entries_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_outcomes" ADD CONSTRAINT "meeting_outcomes_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "assessors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_outcomes" ADD CONSTRAINT "meeting_outcomes_scheduledMetricEntryId_fkey" FOREIGN KEY ("scheduledMetricEntryId") REFERENCES "metric_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squads" ADD CONSTRAINT "squads_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "assessors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "squads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "assessors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_winnerSquadId_fkey" FOREIGN KEY ("winnerSquadId") REFERENCES "squads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_participants" ADD CONSTRAINT "bet_participants_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bet_participants" ADD CONSTRAINT "bet_participants_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "squads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cofre_entries" ADD CONSTRAINT "cofre_entries_betId_fkey" FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cofre_entries" ADD CONSTRAINT "cofre_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_unlocks" ADD CONSTRAINT "badge_unlocks_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_unlocks" ADD CONSTRAINT "badge_unlocks_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "assessors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_unlocks" ADD CONSTRAINT "badge_unlocks_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "squads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "assessors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_squadId_fkey" FOREIGN KEY ("squadId") REFERENCES "squads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
