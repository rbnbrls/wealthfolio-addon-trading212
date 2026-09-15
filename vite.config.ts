import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], build: { target: ['chrome107', 'edge107', 'firefox104', 'safari16'], lib: { entry: 'src/addon.tsx', formats: ['es'], fileName: () => 'addon.js' }, rollupOptions: { external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@wealthfolio/addon-sdk', '@tanstack/react-query'] } } });
