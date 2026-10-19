/**
 * Ambient declarations for @prisma/composer-prisma-cloud@0.29.1.
 *
 * The published 0.29.1 tarball ships only .d.mts.map files (no .d.mts),
 * so TypeScript reports TS2307 for both entry points. These declarations
 * are a build unblocker and should be removed after upgrading to >=0.30.0.
 */
declare module "@prisma/composer-prisma-cloud" {
  export function compute(config: {
    name: string;
    deps?: Record<string, unknown>;
    build?: unknown;
  }): any;
}

declare module "@prisma/composer-prisma-cloud/control" {
  export function prismaCloud(config: { region: string }): any;
  export function prismaState(): any;
}