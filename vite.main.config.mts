import { defineConfig } from 'vite';

export default defineConfig({
  define: { __NTO_PACKAGE_VARIANT__: JSON.stringify(process.env.NTO_PACKAGE_VARIANT ?? 'development') },
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    lib: {
      entry: 'src/main/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: { external: ['electron', /^node:/] },
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
