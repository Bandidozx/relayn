-- `removed_models`: catalogue ids an operator deleted, so sync does not put them back.
--
-- Deleting a synced row on its own does not stick. `syncProviderCatalogue` lists each upstream
-- again and creates anything it does not already have, so a deleted row reappears on the next run
-- looking exactly as it did — the deletion silently undoes itself. This table is the memory that
-- makes it permanent: sync skips every id listed here, neither creating it nor reporting it stale.
--
-- Purely additive. A new table with no foreign keys and no changes to `models`, so every existing
-- row and every query against it behaves exactly as before; with the table empty, sync's behaviour
-- is byte-for-byte what it was. Nothing reads it except catalogue sync and the admin dashboard.
--
-- It stores ids, not rows. Restoring deletes the suppression and lets the next sync fetch the
-- model fresh from its provider — prices and context windows belong to the upstream, and a
-- snapshot kept here would go stale and then be served as though it were current. `name` is
-- display-only, so the removed list can be read without re-querying anything.
--
-- Hand-added (`manual`) models are never listed: sync did not create them and never will, so
-- deleting one is already permanent.

-- CreateTable
CREATE TABLE "removed_models" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "removedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "removed_models_modelId_key" ON "removed_models"("modelId");

-- CreateIndex
CREATE INDEX "removed_models_provider_idx" ON "removed_models"("provider");
