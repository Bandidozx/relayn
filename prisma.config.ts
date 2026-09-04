// Prisma CLI configuration.
//
// The canonical schema targets SQLite so `npm install && npm run dev` works with no
// external infrastructure. To run against PostgreSQL, set both:
//   DATABASE_URL="postgresql://..."
//   PRISMA_SCHEMA="prisma/schema.postgres.prisma"
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: process.env["PRISMA_SCHEMA"] ?? "prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"] ?? "file:./dev.db",
  },
  migrations: {
    path: process.env["PRISMA_SCHEMA"]?.includes("postgres")
      ? "prisma/migrations-postgres"
      : "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
