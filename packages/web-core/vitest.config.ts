import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Same aliases as tsconfig.json, so tests can import runtime values
// (enums, helpers) through `@/` and `shared/`, not only types.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      shared: fileURLToPath(new URL('../../shared', import.meta.url)),
    },
  },
});
