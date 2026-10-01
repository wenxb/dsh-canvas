import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    pool: 'threads',
  },
  resolve: {
    alias: [

      // ONE react instance for jsdom component tests.
      { find: /^react$/, replacement: require.resolve('react') },
      { find: 'react/jsx-runtime', replacement: require.resolve('react/jsx-runtime') },
      { find: 'react/jsx-dev-runtime', replacement: require.resolve('react/jsx-dev-runtime') },
      { find: 'react-dom/client', replacement: require.resolve('react-dom/client') },
      { find: /^react-dom$/, replacement: require.resolve('react-dom') },
    ],
  },
})
