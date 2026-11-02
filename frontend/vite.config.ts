import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy: { '/api': 'http://127.0.0.1:3210' } },
  // Retain old hashed chunks so tabs opened before a rebuild can still lazy-load.
  build: { outDir: 'dist', emptyOutDir: false, sourcemap: false, chunkSizeWarningLimit: 650 },
})
