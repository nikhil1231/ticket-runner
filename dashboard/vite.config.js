import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4600',
    },
  },
  build: {
    outDir: '../public/dashboard',
    emptyOutDir: true,
  },
});
