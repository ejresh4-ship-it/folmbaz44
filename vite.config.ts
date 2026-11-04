import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// GitHub Pages project URL: https://ejresh4-ship-it.github.io/folmbaz44/
export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/folmbaz44/' : './',
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
