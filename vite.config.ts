import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages पर ऐप का प्रकाशित पथ
  base: '/anujadha/',

  // React और JSX को प्रोसेस करने के लिए
  plugins: [react()],

  // उत्पादन के लिए तैयार फाइलें dist में बनेंगी
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
