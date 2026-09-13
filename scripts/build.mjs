// Bundle the plugin entry to lib/index.js (ESM). Peer @deepseek-ai/* packages
// stay external: the host process resolves them from its own installation so
// the plugin shares the host's module instances.
//
// Fail-open for `prepare`: when esbuild is not installed (e.g. this package
// was linked into a profile without its devDependencies), exit 0 and rely on
// the committed lib/ build instead of breaking profile installation.
let build
try {
  ({ build } = await import('esbuild'))
} catch {
  process.stderr.write(
    'dsh-context-graph: esbuild not available; skipping build (using committed lib/)\n',
  )
  process.exit(0)
}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  outdir: 'lib',
  outbase: 'src',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/schemastery',
  ],
  logLevel: 'warning',
})
