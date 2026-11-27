#!/usr/bin/env node
/**
 * scripts/build-layer.mjs
 * Assembles the AWS Lambda Layer directory layout:
 *   layer/nodejs/node_modules/
 *     ├── pg/ (+ its runtime dependencies)
 *     ├── pg-helper/{package.json,index.js,index.d.ts}
 *     ├── logger/{package.json,index.js,index.d.ts}
 *     └── response-builder/{package.json,index.js,index.d.ts}
 *
 * Also mirrors pg-helper, logger, response-builder into local node_modules/
 * (gitignored) so CommonJS require('pg-helper') works in local tests on Windows/Linux.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const distLayerDir = resolve(projectRoot, 'dist', 'layer');
const nodeModulesDir = resolve(projectRoot, 'node_modules');
const layerRoot = resolve(projectRoot, 'layer', 'nodejs');
const layerModulesDir = resolve(layerRoot, 'node_modules');

if (!existsSync(distLayerDir)) {
  console.error('Missing dist/layer/. Run `npm run build` first.');
  process.exit(1);
}

rmSync(resolve(projectRoot, 'layer'), { recursive: true, force: true });
mkdirSync(layerModulesDir, { recursive: true });

writeFileSync(
  resolve(layerRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'lambda-file-api-common-layer',
      version: '1.0.0',
      private: true,
      dependencies: { pg: '^8.0.0' },
    },
    null,
    2,
  ) + '\n',
);

const layerPackages = ['pg-helper', 'logger', 'response-builder'];
for (const pkg of layerPackages) {
  const pkgJson = JSON.stringify(
    {
      name: pkg,
      version: '1.0.0',
      main: 'index.js',
      types: 'index.d.ts',
    },
    null,
    2,
  ) + '\n';

  const jsPath = resolve(distLayerDir, `${pkg}.js`);
  const dtsPath = resolve(distLayerDir, `${pkg}.d.ts`);

  for (const baseDir of [layerModulesDir, nodeModulesDir]) {
    const dest = resolve(baseDir, pkg);
    mkdirSync(dest, { recursive: true });
    writeFileSync(resolve(dest, 'package.json'), pkgJson);
    cpSync(jsPath, resolve(dest, 'index.js'));
    if (existsSync(dtsPath)) {
      cpSync(dtsPath, resolve(dest, 'index.d.ts'));
    }
  }
}

// Copy `pg` and its transitive dependencies into layer/nodejs/node_modules/
const visited = new Set();
function copyPkgTree(pkgName) {
  if (visited.has(pkgName)) return;
  visited.add(pkgName);
  const src = resolve(nodeModulesDir, pkgName);
  if (!existsSync(src)) return;
  const dest = resolve(layerModulesDir, pkgName);
  cpSync(src, dest, { recursive: true });

  const pkgJsonPath = resolve(src, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const meta = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    for (const dep of Object.keys(meta.dependencies ?? {})) {
      copyPkgTree(dep);
    }
  }
}
copyPkgTree('pg');

console.log(`Lambda Layer assembled at ${layerRoot} (${visited.size} pg-tree packages + ${layerPackages.length} shared modules).`);
