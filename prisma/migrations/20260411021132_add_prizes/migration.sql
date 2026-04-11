-- CreateTable
CREATE TABLE "prizes" (
    "id" TEXT NOT NULL,
    "assessorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "period" TEXT NOT NULL,
    "awardedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prizes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prizes_assessorId_idx" ON "prizes"("assessorId");

-- CreateIndex
CREATE INDEX "prizes_period_idx" ON "prizes"("period");

-- AddForeignKey
ALTER TABLE "prizes" ADD CONSTRAINT "prizes_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "assessors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prizes" ADD CONSTRAINT "prizes_awardedById_fkey" FOREIGN KEY ("awardedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
