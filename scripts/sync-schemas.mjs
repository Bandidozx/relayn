// Generates prisma/schema.postgres.prisma from the canonical SQLite schema so the
// two can never drift. The only difference is the datasource provider — the schema
// deliberately avoids provider-specific features.
//
//   node scripts/sync-schemas.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "prisma", "schema.prisma");
const target = join(root, "prisma", "schema.postgres.prisma");

const canonical = readFileSync(source, "utf8");
if (!/provider\s*=\s*"sqlite"/.test(canonical)) {
  console.error("prisma/schema.prisma is expected to be the SQLite canonical schema.");
  process.exit(1);
}

const banner = [
  "// AUTO-GENERATED from prisma/schema.prisma by scripts/sync-schemas.mjs.",
  "// Do not edit directly — edit the canonical schema and re-run `npm run db:sync`.",
  "",
].join("\n");

const postgres = banner + canonical.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
writeFileSync(target, postgres);
console.log("wrote prisma/schema.postgres.prisma");
