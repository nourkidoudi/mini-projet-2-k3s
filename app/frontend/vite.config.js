import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En développement (npm run dev), /api est relayé vers l'API locale.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
