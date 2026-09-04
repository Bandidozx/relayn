-- Crypto payment columns on `payments`. Purely additive: every new column is nullable or
-- carries a default, so existing QRIS rows are untouched and no backfill is needed.
--
-- The UNIQUE index on `txHash` is the double-spend defence. It is a plain UNIQUE (not a
-- partial index) because SQLite and PostgreSQL both treat NULLs as distinct, so the existing
-- fiat rows — all NULL here — do not collide with each other.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'IDR';
ALTER TABLE "payments" ADD COLUMN "network" TEXT;
ALTER TABLE "payments" ADD COLUMN "asset" TEXT;
ALTER TABLE "payments" ADD COLUMN "txHash" TEXT;
ALTER TABLE "payments" ADD COLUMN "recipient" TEXT;
ALTER TABLE "payments" ADD COLUMN "sender" TEXT;
ALTER TABLE "payments" ADD COLUMN "amountRaw" TEXT;
ALTER TABLE "payments" ADD COLUMN "amountRequired" TEXT;
ALTER TABLE "payments" ADD COLUMN "confirmations" INTEGER;
ALTER TABLE "payments" ADD COLUMN "blockNumber" TEXT;
ALTER TABLE "payments" ADD COLUMN "verifiedAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "payments_txHash_key" ON "payments"("txHash");
