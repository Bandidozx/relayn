-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "expiresAt" DATETIME,
    "paidAt" DATETIME,
    "appliedAt" DATETIME,
    "failureReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "tokenAllocation" INTEGER NOT NULL DEFAULT 250000,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "unlimited" BOOLEAN NOT NULL DEFAULT false,
    "planExpiresAt" DATETIME,
    "externalRef" TEXT,
    "renewalDate" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_subscriptions" ("createdAt", "externalRef", "id", "plan", "renewalDate", "status", "tokenAllocation", "tokensUsed", "updatedAt", "userId") SELECT "createdAt", "externalRef", "id", "plan", "renewalDate", "status", "tokenAllocation", "tokensUsed", "updatedAt", "userId" FROM "subscriptions";
DROP TABLE "subscriptions";
ALTER TABLE "new_subscriptions" RENAME TO "subscriptions";
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");
CREATE INDEX "subscriptions_unlimited_idx" ON "subscriptions"("unlimited");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "payments_orderId_key" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_reference_key" ON "payments"("provider", "reference");
