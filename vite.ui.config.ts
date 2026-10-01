import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import autoprefixer from 'autoprefixer'
import tailwindcss from 'tailwindcss'
import { defineConfig } from 'vite'

const projectRoot = __dirname

export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(projectRoot, 'src/shared'),
      '@renderer': resolve(projectRoot, 'src/renderer/src')
    }
  },
  plugins: [react()],
  // PostCSS is configured inline on purpose: the Vite root is src/renderer, so a
  // root-level postcss.config.js would never be discovered.
  css: {
    postcss: {
      plugins: [
        tailwindcss({ config: resolve(projectRoot, 'tailwind.config.ts') }),
        autoprefixer()
      ]
    }
  },
  server: {
    port: 5178,
    strictPort: false
  },
  build: {
    outDir: resolve(projectRoot, 'out/ui'),
    emptyOutDir: true
  }
})
