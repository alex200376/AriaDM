import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import autoprefixer from 'autoprefixer'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from 'tailwindcss'

const projectRoot = __dirname
const shared = { '@shared': resolve(projectRoot, 'src/shared') }

// Baked into the preload bundle: `process.env.npm_package_version` is only set
// when the app is launched through npm, so a packaged build would otherwise
// report whatever the fallback string happened to be.
const appVersion = (
  JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as { version: string }
).version

const postcss = {
  plugins: [tailwindcss({ config: resolve(projectRoot, 'tailwind.config.ts') }), autoprefixer()]
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: {
      rollupOptions: { input: { index: resolve(projectRoot, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    build: {
      rollupOptions: {
        input: { index: resolve(projectRoot, 'src/preload/index.ts') },
        // Electron refuses an ESM preload under sandbox:true, so the preload is
        // emitted as CommonJS with an explicit .cjs extension. The package is ESM,
        // which is exactly why the extension has to be explicit.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { ...shared, '@renderer': resolve(projectRoot, 'src/renderer/src') }
    },
    plugins: [react()],
    css: { postcss },
    build: {
      rollupOptions: {
        // Multi-page: `index.html` is the main window and `catcher.html` is the
        // catch popup, which runs in its own BrowserWindow and so needs its own
        // document rather than a route.
        input: {
          index: resolve(projectRoot, 'src/renderer/index.html'),
          catcher: resolve(projectRoot, 'src/renderer/catcher.html')
        }
      }
    }
  }
})
