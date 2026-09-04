-- Model fallback chains, hand-added catalogue rows, and per-provider outbound proxies.
--
-- Three independent additions, shipped together because they are all "operator can do it from
-- the dashboard now" columns and each is a single defaulted column:
--
--   models.fallbacks      Ordered comma-separated catalogue ids retried when this model's
--                         upstream fails transiently. '' preserves today's behaviour exactly —
--                         the upstream error is returned to the caller unchanged.
--   models.manual         Marks a row an operator typed in rather than one catalogue sync
--                         created. Sync must not resurrect or overwrite these, and only these
--                         may be deleted from the dashboard.
--   provider_configs.proxyCipher / proxyHint
--                         Sealed newline-separated proxy URLs for this upstream's outbound
--                         traffic, plus a redacted display form. Sealed rather than plain
--                         because a proxy URL normally embeds user:password; the hint keeps
--                         the password out of every read path, including the admin API.
--
-- Purely additive and every column has a default, so existing rows keep behaving as they do
-- today: no fallbacks, not manual, no proxy.

-- AlterTable
ALTER TABLE "models" ADD COLUMN "fallbacks" TEXT NOT NULL DEFAULT '';
ALTER TABLE "models" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "provider_configs" ADD COLUMN "proxyCipher" TEXT;
ALTER TABLE "provider_configs" ADD COLUMN "proxyHint" TEXT NOT NULL DEFAULT '';
