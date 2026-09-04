-- Custom provider support on `provider_configs`.
--
-- Before this migration the table only annotated providers compiled into the registry from
-- env: it held a label, a base URL and the *name* of the env var holding the credential. These
-- columns let a row carry the credential itself, sealed, so an operator can add a reseller
-- upstream from the dashboard without a redeploy.
--
-- Purely additive. Every column has a default, so existing builtin rows keep working unchanged:
-- `custom` = 0 and `apiKeyCipher` NULL means "credential still comes from env", which is
-- exactly what they were before.
--
-- `apiKeyCipher` holds AES-256-GCM output (`lib/security/secret-box`), never plaintext, and
-- `envVar` becomes optional in practice — custom rows store "" there.

-- AlterTable
ALTER TABLE "provider_configs" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE "provider_configs" ADD COLUMN "apiKeyCipher" TEXT;
ALTER TABLE "provider_configs" ADD COLUMN "apiKeyHint" TEXT NOT NULL DEFAULT '';
ALTER TABLE "provider_configs" ADD COLUMN "extraHeaders" TEXT NOT NULL DEFAULT '';
ALTER TABLE "provider_configs" ADD COLUMN "custom" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "provider_configs_custom_enabled_idx" ON "provider_configs"("custom", "enabled");
