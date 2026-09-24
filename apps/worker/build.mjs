// Bundles the worker and its CLI entry points. Workspace packages (@castlane/*, TypeScript
// sources) are compiled into the bundle; third-party packages stay external and are resolved from
// node_modules at runtime (native modules such as sharp and argon2 cannot be bundled).
import { build } from 'esbuild';

const workspaceOnly = {
  name: 'externalize-node-modules',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@castlane/') || args.path.startsWith('@/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: {
    index: 'src/index.ts',
    'cli/bootstrap-owner': 'src/cli/bootstrap-owner.ts',
    'cli/replay-tombstones': 'src/cli/replay-tombstones.ts',
    'cli/migrate': '../../packages/database/src/cli/migrate.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  plugins: [workspaceOnly],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
