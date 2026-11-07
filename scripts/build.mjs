import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Optional native add-ons of the MongoDB driver. They are loaded lazily by the
// driver and only needed for specific auth/compression modes.
const driverOptional = [
  'kerberos', '@mongodb-js/zstd', 'mongodb-client-encryption', 'snappy', 'socks',
  'aws4', 'gcp-metadata', '@aws-sdk/credential-providers',
];

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info', legalComments: 'none' };

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: { extension: 'src/extension.ts', playgroundWorker: 'src/playground/worker.ts' },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', ...driverOptional],
  }),
  esbuild.context({
    ...common,
    entryPoints: { webview: 'src/webview/main.tsx' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'css' },
  }),
]);

mkdirSync('dist', { recursive: true });
cpSync('node_modules/@vscode/codicons/dist/codicon.css', 'dist/codicon.css');
cpSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/codicon.ttf');

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
