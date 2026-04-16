-- AlterTable: add totalLeads and totalClients to assessors
ALTER TABLE "assessors" ADD COLUMN "totalLeads" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "assessors" ADD COLUMN "totalClients" INTEGER NOT NULL DEFAULT 0;
