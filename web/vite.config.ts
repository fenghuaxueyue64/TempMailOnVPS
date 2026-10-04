import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // dev 模式：vite 起独立端口，API/WS/SSE 代理到后端 Bun :3000
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
      '/sse': 'http://127.0.0.1:3000',
    },
  },
  build: {
    // 产物输出到 build/，由 Bun 后端 serveStatic 托管
    outDir: 'build',
  },
});
