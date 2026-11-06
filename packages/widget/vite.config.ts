/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: { index: "src/index.ts", react: "src/react.tsx" },
      formats: ["es"],
    },
    rollupOptions: { external: ["react", "react/jsx-runtime"] },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
