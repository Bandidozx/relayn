-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "unlimited" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT,
    "method" TEXT NOT NULL DEFAULT 'QRIS',
    "plan" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidAmount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "qrString" TEXT,
    "checkoutUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_orderId_key" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_reference_key" ON "payments"("provider", "reference");

-- CreateIndex
CREATE INDEX "subscriptions_unlimited_idx" ON "subscriptions"("unlimited");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
