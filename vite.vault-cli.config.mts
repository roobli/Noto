import { defineConfig } from 'vite';

// The vault's command line, for an agent's MCP server started from the
// setup Noto copies; see `src/vault-worker/vault-cli.ts`. Unpacked from the
// asar, so Node outside Noto can read it.
export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    lib: {
      entry: 'src/vault-worker/vault-cli.ts',
      fileName: () => 'noto-vault.js',
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
