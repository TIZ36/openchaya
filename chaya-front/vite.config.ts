import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5177,
    strictPort: true,
    // 使用 0.0.0.0 时 HMR WebSocket 会拿到错误地址，需显式指定
    hmr: {
      host: 'localhost',
      port: 5177,
    },
    watch: {
      // 忽略不需要监视的目录，减少文件监视器数量
      ignored: [
        '**/../../backend/venv/**',
        '**/node_modules/**',
        '**/.git/**',
      ],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

