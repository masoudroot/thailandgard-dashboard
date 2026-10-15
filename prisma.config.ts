/**
 * Prisma CLI config. Read only by the CLI (`prisma deploy`, `prisma dev`).
 *
 * - `prismaCloud({ region: 'ap-southeast-1' })`: deploy target, Singapore.
 *   The region is set once at project creation and cannot be changed later;
 *   Singapore matches the Supabase project region and the audience
 *   (same region as the main ThailandGard site).
 * - `nextjsBuild()`: assembles the `nextjs` build adapter output
 *   (the standalone server from `next build`).
 * - `prismaState()`: keeps deploy state for the workspace.
 *
 * App code never imports this file.
 */
import { defineConfig as composer } from "@prisma/composer/config";
import { nextjsBuild } from "@prisma/composer/nextjs/control";
import { nodeBuild } from "@prisma/composer/node/control";
import {
  prismaCloud,
  prismaState,
} from "@prisma/composer-prisma-cloud/control";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  composer: composer({
    extensions: [prismaCloud({ region: "ap-southeast-1" }), nodeBuild(), nextjsBuild()],
    state: prismaState(),
  }),
});
