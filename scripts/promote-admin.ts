/**
 * Promotes an existing account to admin.
 *
 * A production database seeded with SEED_DEMO_DATA=false has no admin account, and
 * registration only ever creates `role: "user"` — deliberately, so the admin panel cannot
 * be reached by signing up. This is the bootstrap: register through the UI first, then run
 *
 *   npm run admin:promote -- you@example.com
 *
 * against the same DATABASE_URL. Pass --revoke to demote instead. The change is written to
 * the audit log with actor "cli" so the promotion is not invisible.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const isPostgres = databaseUrl.startsWith("postgres");

/**
 * Prisma 7 bakes the datasource provider into the generated client, so a client generated
 * for SQLite cannot talk to PostgreSQL no matter which adapter it is handed — it fails deep
 * inside the query compiler with an opaque error. A local checkout is generated for SQLite
 * by default, which is exactly the state you are in when you first point this script at a
 * production database, so check up front and say what to run.
 */
function assertClientMatchesUrl(): void {
  let generatedProvider: string;
  try {
    const source = readFileSync(
      new URL("../src/generated/prisma/internal/class.ts", import.meta.url),
      "utf8",
    );
    generatedProvider = /"activeProvider":\s*"([a-z]+)"/.exec(source)?.[1] ?? "";
  } catch {
    return; // Internals moved; let the query fail on its own rather than blocking on a guess.
  }
  if (!generatedProvider) return;

  const wanted = isPostgres ? "postgresql" : "sqlite";
  if (generatedProvider === wanted) return;

  console.error(
    `The generated Prisma client targets ${generatedProvider}, but DATABASE_URL is ${wanted}.\n` +
      `Regenerate it first:\n\n` +
      (isPostgres
        ? `  PRISMA_SCHEMA="prisma/schema.postgres.prisma" npx prisma generate\n\n` +
          `Then re-run this command. Afterwards restore the local client with a plain \`npx prisma generate\`.`
        : `  npx prisma generate\n`),
  );
  process.exit(1);
}

async function client(): Promise<PrismaClient> {
  if (isPostgres) {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  return new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: databaseUrl.replace(/^file:/, "") }),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const email = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();

  if (!email) {
    console.error("Usage: npm run admin:promote -- <email> [--revoke]");
    process.exit(1);
  }

  assertClientMatchesUrl();

  const prisma = await client();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No account found for ${email}. Register through the UI first.`);
    process.exit(1);
  }

  const role = revoke ? "user" : "admin";
  if (user.role === role) {
    console.log(`${email} is already ${role}. Nothing to do.`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { role } });
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      actorEmail: "cli",
      action: "admin.user_role_changed",
      targetType: "user",
      targetId: user.id,
      metadata: JSON.stringify({ from: user.role, to: role, via: "scripts/promote-admin.ts" }),
    },
  });

  console.log(`${email}: ${user.role} → ${role}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => process.exit(0));
