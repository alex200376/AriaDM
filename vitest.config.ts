import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests spawn a real aria2c and bind loopback ports, so they run
    // one file at a time rather than racing each other.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
