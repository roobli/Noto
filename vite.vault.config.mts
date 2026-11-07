import { defineConfig } from 'vite';

// The folder's memory runs on a worker thread of the main process; see
// `src/vault-worker/vault-worker.ts`. Unpacked from the asar, as the file
// service is, so the worker is loaded from a real file.
export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    lib: {
      entry: 'src/vault-worker/vault-worker.ts',
      fileName: () => 'vault-worker.js',
    },
    rollupOptions: {
      external: ['electron', /^node:/],
      output: [{ format: 'cjs', codeSplitting: false }],
    },
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
