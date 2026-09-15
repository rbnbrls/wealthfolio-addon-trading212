import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], build: { lib: { entry: 'src/addon.tsx', formats: ['es'], fileName: () => 'addon.js' }, rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime', '@wealthfolio/addon-sdk'] } } });
