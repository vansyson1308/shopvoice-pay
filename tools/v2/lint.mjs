import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const GLOB_PATTERNS = ['apps/**/*.{ts,tsx,mts,cts}', 'packages/**/*.{ts,tsx,mts,cts}'];
const IGNORE_PARTS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

async function discoverFilesWithFastGlob() {
  const mod = await import('fast-glob');
  const fg = mod.default ?? mod;
  return fg(GLOB_PATTERNS, {
    dot: false,
    onlyFiles: true,
    unique: true,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.git/**',
      '**/*.d.ts'
    ]
  });
}

function hasIgnoredPart(filePath) {
  const parts = filePath.split(/[\\/]+/);
  return parts.some((part) => IGNORE_PARTS.has(part));
}

function discoverFilesFallback() {
  const roots = ['apps', 'packages'];
  const files = [];
  const allowedExt = new Set(['.ts', '.tsx', '.mts', '.cts']);

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = full.split(sep).join('/');
      if (hasIgnoredPart(rel)) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (rel.endsWith('.d.ts')) continue;
      const ext = rel.slice(rel.lastIndexOf('.'));
      if (allowedExt.has(ext)) files.push(rel);
    }
  };

  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // ignore missing directory
    }
  }

  return files;
}

let files;
try {
  files = await discoverFilesWithFastGlob();
} catch {
  files = discoverFilesFallback();
}

const issues = [];
const verificationMarker = ['TODO:', 'NEEDS VERIFICATION'].join(' ');

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  if (content.includes(' as any') || content.includes(': any') || content.includes('<any>')) {
    issues.push(`${file}: avoid explicit any in V2 scaffold code`);
  }
  if (content.includes(verificationMarker)) {
    issues.push(`${file}: forbidden marker ${verificationMarker}`);
  }
}

if (issues.length > 0) {
  console.error('Lint check failed:');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Lint check passed for ${files.length} files.`);
