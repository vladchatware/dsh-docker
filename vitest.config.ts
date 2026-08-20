import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (name: string): string => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@vladchatware/dsh-docker': src('docker'),
      '@vladchatware/dsh-fs-docker': src('fs-docker'),
      '@vladchatware/dsh-subprocess-docker': src('subprocess-docker'),
      '@vladchatware/dsh-tool-docker': src('tool-docker'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
  },
})
