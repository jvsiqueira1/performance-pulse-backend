-- CreateTable
CREATE TABLE "kpi_sounds" (
    "id" TEXT NOT NULL,
    "kpiId" TEXT NOT NULL,
    "soundUrl" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "broadcast" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kpi_sounds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kpi_sounds_kpiId_key" ON "kpi_sounds"("kpiId");

-- AddForeignKey
ALTER TABLE "kpi_sounds" ADD CONSTRAINT "kpi_sounds_kpiId_fkey" FOREIGN KEY ("kpiId") REFERENCES "kpis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
