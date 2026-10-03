import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const distDir = join(process.cwd(), 'dist');
const runtimeExtensions = new Set(['.js', '.json', '.mjs', '.cjs']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (path.endsWith('.js') || path.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

function hasRuntimeExtension(specifier) {
  const last = specifier.split('/').pop() ?? '';
  return runtimeExtensions.has(last.slice(last.lastIndexOf('.')));
}

function normalizeSpecifier(file, specifier) {
  if (!specifier.startsWith('.') || hasRuntimeExtension(specifier)) return specifier;
  const target = join(dirname(file), specifier);
  if (existsSync(`${target}.js`) || existsSync(`${target}.d.ts`)) return `${specifier}.js`;
  if (existsSync(join(target, 'index.js')) || existsSync(join(target, 'index.d.ts'))) {
    return `${specifier}/index.js`;
  }
  return `${specifier}.js`;
}

function rewrite(file, content) {
  return content
    .replace(/(\bfrom\s+['"])(\.[^'"]+)(['"])/g, (_, prefix, specifier, suffix) =>
      `${prefix}${normalizeSpecifier(file, specifier)}${suffix}`)
    .replace(/(\bimport\s+['"])(\.[^'"]+)(['"])/g, (_, prefix, specifier, suffix) =>
      `${prefix}${normalizeSpecifier(file, specifier)}${suffix}`)
    // Inline type imports emitted by tsc (`import("..").X`) must be fully specified for node16/nodenext.
    .replace(/(\bimport\(\s*['"])(\.[^'"]*)(['"]\s*\))/g, (_, prefix, specifier, suffix) =>
      `${prefix}${normalizeSpecifier(file, specifier)}${suffix}`);
}

for (const file of walk(distDir)) {
  const before = readFileSync(file, 'utf8');
  const after = rewrite(file, before);
  if (after !== before) writeFileSync(file, after);
}
