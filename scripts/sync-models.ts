/**
 * Catalogue sync from the command line.
 *
 *   npm run models:sync                 # every configured provider
 *   npm run models:sync -- jerouter     # just these
 *
 * Same code path as the "Sync from providers" button in Admin → Models; this exists so a
 * fresh deployment can be populated without an admin session, and so the sync can run from
 * CI against a production DATABASE_URL.
 *
 * `--conditions=react-server` is not optional: the service layer imports `server-only`,
 * which throws on any other resolution condition. That guard is the point — it is what stops
 * provider credentials being pulled into a client bundle — so the script satisfies it rather
 * than duplicating the sync logic to avoid it.
 */
import "dotenv/config";
import { syncProviderCatalogue } from "../src/server/services/model-sync-service.ts";
import { listProviders } from "../src/lib/providers/registry.ts";

function money(value: number): string {
  return value === 0 ? "free" : `$${value}/M`;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

  const known = new Set((await listProviders()).map((provider) => provider.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(
      `Unknown provider(s): ${unknown.join(", ")}. Registered: ${[...known].sort().join(", ")}`,
    );
    process.exit(1);
  }

  const summary = await syncProviderCatalogue(only);

  if (summary.results.length === 0) {
    console.log("Nothing to sync: no configured provider can list its catalogue.");
  }

  for (const entry of summary.results) {
    if (entry.error) {
      console.error(`✗ ${entry.label} (${entry.provider}) — ${entry.error}`);
      continue;
    }
    console.log(
      `✓ ${entry.label} (${entry.provider}) — ${entry.discovered} offered, ` +
        `${entry.created} created, ${entry.updated} updated`,
    );
    if (entry.stale.length > 0) {
      console.log(
        `  no longer offered upstream (left enabled, disable by hand if you want them gone):\n` +
          entry.stale.map((id) => `    · ${id}`).join("\n"),
      );
    }
  }

  if (summary.skipped.length > 0) {
    console.log(`\nSkipped, no credential set: ${summary.skipped.join(", ")}`);
  }

  console.log(`\nTotal: ${summary.created} created, ${summary.updated} updated.`);

  // Printed so the operator can sanity-check the pricing that cost accounting will use
  // before any real traffic is metered against it.
  const { prisma } = await import("../src/lib/db.ts");
  const touched = summary.results.filter((entry) => !entry.error).map((entry) => entry.provider);
  if (touched.length > 0) {
    const rows = await prisma.aiModel.findMany({
      where: { provider: { in: touched } },
      orderBy: [{ provider: "asc" }, { sortOrder: "asc" }],
      select: { modelId: true, minPlan: true, category: true, inputPrice: true, outputPrice: true },
    });
    console.log("");
    for (const row of rows) {
      console.log(
        `  ${row.modelId.padEnd(46)} ${row.category.padEnd(10)} ${row.minPlan.padEnd(9)} ` +
          `in ${money(row.inputPrice).padEnd(9)} out ${money(row.outputPrice)}`,
      );
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => process.exit(0));
