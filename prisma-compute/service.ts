/**
 * Prisma Composer service declaration for the ThailandGard dashboard (Next.js).
 *
 * Pure data: what the service is called and how it is built. The deploy
 * assembles what `npm run build` produced (output: 'standalone').
 *
 * - No database is declared here on purpose: Supabase Postgres stays the
 *   database and is reached through a connection string injected as an
 *   environment variable (see prisma.config.ts / Console → Environment).
 * - `appDir: '..'` = the Next.js app root (repo root), relative to this file.
 */
import nextjs from "@prisma/composer/nextjs";
import { compute } from "@prisma/composer-prisma-cloud";

export default compute({
  name: "web",
  deps: {},
  build: nextjs({ module: import.meta.url, appDir: ".." }),
});
