import { defineConfig } from "tsup";

/**
 * Builds the publishable SDK. The workspace package @quietpay/shared is private, so it is bundled into the output
 * (schemas, typed-data builders, webhook signing, and their TypeScript types); viem and zod stay external and are
 * real dependencies.
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  platform: "node",
  target: "node20",
  dts: {
    // Inline only the private workspace package (and its relative files); Node, viem and zod types stay external.
    resolve: [/(^@quietpay\/shared)|(shared\/src)/],
    compilerOptions: {
      baseUrl: ".",
      // Resolve the private workspace package to its source so the declaration bundler can inline its types.
      paths: {
        "@quietpay/shared": ["../shared/src/index.ts"],
        "@quietpay/shared/webhook": ["../shared/src/webhook.ts"],
      },
    },
  },
  clean: true,
  sourcemap: true,
  noExternal: ["@quietpay/shared"],
  external: ["viem", "zod"],
});
