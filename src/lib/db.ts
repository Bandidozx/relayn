/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter; the adapter is chosen from DATABASE_URL so the
 * same code runs on SQLite (local development / tests) and PostgreSQL (production)
 * against the identical schema.
 */
import "server-only";
import { createRequire } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Loaded through `createRequire` rather than a static import so a PostgreSQL deployment
 * never evaluates the better-sqlite3 native binding it will not use. On a serverless
 * target that binding is dead weight in the bundle and on every cold start.
 */
function sqliteAdapter(url: string) {
  const requireCjs = createRequire(import.meta.url);
  const { PrismaBetterSqlite3 } = requireCjs("@prisma/adapter-better-sqlite3");
  return new PrismaBetterSqlite3({ url: url.replace(/^file:/, "") || ":memory:" });
}

function createClient(): PrismaClient {
  const url = env.databaseUrl;
  const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");

  if (isPostgres) {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }

  return new PrismaClient({ adapter: sqliteAdapter(url) });
}

const globalForPrisma = globalThis as unknown as { relaynPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.relaynPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.relaynPrisma = prisma;
}
