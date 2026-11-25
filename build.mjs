// esbuild driver: `node build.mjs` bundles the library + examples;
// `--serve` hosts the live examples at http://localhost:8123 (spans.html too).
import * as esbuild from 'esbuild';

const serve = process.argv.includes('--serve');

/** Library bundle. uPlot + its CSS are bundled in, so the package is
 *  self-contained: `import 'mip-chart'` + `import 'mip-chart/style.css'`. */
const libOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  sourcemap: true,
  outfile: 'dist/mip-chart.js',
  logLevel: 'info',
};

/** Live example: a non-framework host that wires the navigator's plain-JS
 *  hooks to a synthetic data provider — the same shape any host integrates. */
const exampleOptions = {
  entryPoints: ['examples/main.ts', 'examples/spans.ts'],
  bundle: true,
  format: 'esm',
  sourcemap: true,
  outdir: 'examples/dist',
  logLevel: 'info',
};

if (serve) {
  const ctx = await esbuild.context(exampleOptions);
  await ctx.watch();
  const { hosts, port } = await ctx.serve({ servedir: 'examples', port: 8123 });
  console.log(`live example at http://${hosts[0] ?? 'localhost'}:${port}/`);
} else {
  await Promise.all([esbuild.build(libOptions), esbuild.build(exampleOptions)]);
}
