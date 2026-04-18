-- CreateTable
CREATE TABLE "daily_directions" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_directions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_directions_date_key" ON "daily_directions"("date");

-- CreateIndex
CREATE INDEX "daily_directions_date_idx" ON "daily_directions"("date");

-- AddForeignKey
ALTER TABLE "daily_directions" ADD CONSTRAINT "daily_directions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
