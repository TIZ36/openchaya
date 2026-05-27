import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// react-shiki statically imports its own dist/style.css (uses `@layer base`,
// which Tailwind v3's PostCSS rejects without an in-file `@tailwind base`). We
// render with addDefaultStyles={false} and style code blocks ourselves, so
// blank out that stylesheet to keep it out of the Tailwind pipeline.
const stripReactShikiCss = {
  name: 'strip-react-shiki-css',
  enforce: 'pre' as const,
  load(id: string) {
    if (id.includes('react-shiki') && id.endsWith('style.css')) return '';
    return null;
  },
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [stripReactShikiCss, react()],
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
    rollupOptions: {
      output: {
        // Pin React into a long-cached vendor chunk so it survives feature deploys.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

