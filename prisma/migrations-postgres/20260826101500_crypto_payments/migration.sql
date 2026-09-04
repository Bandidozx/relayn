-- Crypto payment columns on `payments`. Purely additive: every new column is nullable or
-- carries a default, so existing QRIS rows are untouched and no backfill is needed.
--
-- The UNIQUE index on "txHash" is the double-spend defence. PostgreSQL treats NULLs as
-- distinct in a unique index, so the existing fiat rows — all NULL here — do not collide.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'IDR',
ADD COLUMN     "network" TEXT,
ADD COLUMN     "asset" TEXT,
ADD COLUMN     "txHash" TEXT,
ADD COLUMN     "recipient" TEXT,
ADD COLUMN     "sender" TEXT,
ADD COLUMN     "amountRaw" TEXT,
ADD COLUMN     "amountRequired" TEXT,
ADD COLUMN     "confirmations" INTEGER,
ADD COLUMN     "blockNumber" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "payments_txHash_key" ON "payments"("txHash");
