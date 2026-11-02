import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://127.0.0.1:3211/', pretendToBeVisual: true } },
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
})
