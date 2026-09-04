/**
 * Vitest configuration.
 *
 * Two aliases matter:
 *   - `@/…` mirrors the `paths` entry in tsconfig.json so tests import modules exactly the
 *     way the app does.
 *   - `server-only` is stubbed. That package deliberately throws when imported outside a
 *     React Server Component, which is the behaviour we want in the app and unhelpful in a
 *     plain Node test process. Stubbing it here does not weaken the guarantee: the real
 *     module is still what Next resolves during a build, so a client component importing a
 *     server module still fails there.
 *
 * `NODE_ENV=test` also flips `isTest` in `src/lib/env.ts`.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "server-only": `${root}tests/stubs/server-only.ts`,
      "@": `${root}src`,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    restoreMocks: true,
  },
});
