import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Relative base so the build works under any sub-path (e.g. /<repo>/mosquito-alert/).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' }, // maplibre's worker is an ES module
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
