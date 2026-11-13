// builds public/vendor/tempo-wallet.js from wallet.ts. `npm run build`.
//
// the same as bundling wallet.ts with esbuild's command line, less one thing: zod's translations of
// its error messages (about 260 KB, 40-odd languages). the libraries here only re-export them, nothing
// reads them, and the page shows none of zod's messages. they are swapped for an empty module.
import { build } from 'esbuild';
import { fileURLToPath } from 'url';

const empty = fileURLToPath(new URL('./no-locales.js', import.meta.url));

await build({
  entryPoints: ['wallet.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'external',
  outfile: '../public/vendor/tempo-wallet.js',
  logLevel: 'info',
  plugins: [{
    name: 'no-zod-locales',
    setup(b) {
      b.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) => (/[\\/]zod[\\/]/.test(args.importer) ? { path: empty } : undefined));
    },
  }],
});
