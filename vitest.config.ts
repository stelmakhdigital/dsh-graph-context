import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const stub = (name: string): string => fileURLToPath(new URL(`./test/stubs/${name}`, import.meta.url))

export default defineConfig({
  resolve: {
    // The plugin's peer packages are provided by the host at runtime; in the
    // test environment they resolve to minimal runtime stubs (types come
    // from stubs/*.d.ts via tsconfig paths).
    alias: {
      '@deepseek-ai/cordis': stub('empty.mjs'),
      '@deepseek-ai/dsh-agent': stub('empty.mjs'),
      '@deepseek-ai/dsh-llm': stub('dsh-llm.mjs'),
      '@deepseek-ai/dsh-tools': stub('dsh-tools.mjs'),
      '@deepseek-ai/schemastery': stub('schemastery.mjs'),
    },
  },
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
