import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@common': resolve(__dirname, 'src/common'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 3080,
    strictPort: true,
  },
})
