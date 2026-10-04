import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'tsconfig.build.json',
  '.gitignore',
  'README.md'
];

const GLOB_PATTERNS = [
  'apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,md,yml,yaml}',
  'packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,md,yml,yaml}',
  'tests/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,md,yml,yaml}',
  'docs/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,md,yml,yaml}',
  '.github/workflows/**/*.{yml,yaml}'
];

const IGNORE_PARTS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', '.turbo', '.cache']);
const ALLOWED_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);

function hasIgnoredPart(filePath) {
  return filePath.split(/[\\/]+/).some((part) => IGNORE_PARTS.has(part));
}

async function collectWithFastGlob() {
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
      '**/.next/**',
      '**/.turbo/**',
      '**/.cache/**'
    ]
  });
}

function collectFallback() {
  const roots = ['apps', 'packages', 'tests', 'docs', '.github/workflows'];
  const files = [];

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
      const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')) : '';
      if (ALLOWED_EXT.has(ext)) files.push(rel);
    }
  };

  for (const root of roots) {
    try {
      if (statSync(root).isDirectory()) walk(root);
    } catch {
      // ignore missing root
    }
  }

  return files;
}

let discovered = [];
try {
  discovered = await collectWithFastGlob();
} catch {
  discovered = collectFallback();
}

const rootFiles = ROOT_FILES.filter((file) => existsSync(file));
const files = [...new Set([...discovered, ...rootFiles])].sort();

const violations = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  if (!content.endsWith('\n')) {
    violations.push(`${file}: file must end with newline`);
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (/\s+$/.test(lines[i])) {
      violations.push(`${file}:${i + 1}: trailing whitespace`);
    }
    if (/\t/.test(lines[i])) {
      violations.push(`${file}:${i + 1}: tab character found (use spaces)`);
    }
  }
}

if (violations.length > 0) {
  console.error('Format check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Format check passed for ${files.length} files.`);
