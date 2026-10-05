// Checks that SECURITY.md's threat model points at real tests: every linked
// test file exists and holds a test with exactly the quoted title, every
// threat section links at least one test, and every eval id it names exists.
//
//   node tools/security-links.mjs [path/to/SECURITY.md]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Test titles declared in a test file: test('…'), t('…'), with \' unescaped. */
export function testTitles(source) {
  const titles = new Set();
  for (const m of source.matchAll(/\b(?:test|t)\(\s*'((?:[^'\\]|\\.)*)'/g)) titles.add(m[1].replace(/\\(.)/g, '$1'));
  for (const m of source.matchAll(/\b(?:test|t)\(\s*"((?:[^"\\]|\\.)*)"/g)) titles.add(m[1].replace(/\\(.)/g, '$1'));
  return titles;
}

export function checkSecurityDoc(markdown, root = ROOT) {
  const problems = [];
  const links = [];
  const sections = markdown.split(/^### /m).slice(1);
  if (sections.length === 0) problems.push('no threat sections (### headings) found');
  const evalIds = new Set();
  const evalsPath = join(root, 'evals/agent_cases.jsonl');
  if (existsSync(evalsPath)) {
    for (const line of readFileSync(evalsPath, 'utf8').split('\n').filter(Boolean)) evalIds.add(JSON.parse(line).id);
  }
  const cache = new Map();
  for (const section of sections) {
    const heading = section.split('\n')[0]?.trim() ?? '';
    const found = [...section.matchAll(/\[`([^`]+)`\]\(([^)]+)\)\s+—\s+`([^`]+)`/g)];
    if (found.length === 0) problems.push(`"${heading}" links no tests`);
    for (const [, label, path, title] of found) {
      links.push({ heading, path, title });
      if (label !== path) problems.push(`"${heading}": link text ${label} does not match its target ${path}`);
      if (!/^tests\/(unit|db|sandbox|e2e)\/[\w.-]+\.mjs$/.test(path)) {
        problems.push(`"${heading}": ${path} is not a test file`);
        continue;
      }
      const file = join(root, path);
      if (!existsSync(file)) {
        problems.push(`"${heading}": ${path} does not exist`);
        continue;
      }
      if (!cache.has(path)) cache.set(path, testTitles(readFileSync(file, 'utf8')));
      if (!cache.get(path).has(title)) problems.push(`"${heading}": ${path} has no test titled "${title}"`);
    }
    for (const m of section.matchAll(/\bEvals?\s+((?:S|Q)\d+(?:(?:,\s*|\s+and\s+|–)(?:S|Q)\d+)*)/g)) {
      const parts = m[1].split(/,\s*|\s+and\s+/);
      for (const part of parts) {
        const [from, to] = part.split('–');
        const ids = to ? range(from, to) : [from];
        for (const id of ids) if (!evalIds.has(id)) problems.push(`"${heading}": eval ${id} does not exist`);
      }
    }
  }
  return { problems, links };
}

function range(from, to) {
  const prefix = from[0];
  const width = from.length - 1;
  const out = [];
  for (let n = Number(from.slice(1)); n <= Number(to.slice(1)); n += 1) out.push(`${prefix}${String(n).padStart(width, '0')}`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const docPath = resolve(process.argv[2] ?? join(ROOT, 'SECURITY.md'));
  const { problems, links } = checkSecurityDoc(readFileSync(docPath, 'utf8'));
  if (problems.length > 0) {
    for (const p of problems) console.error(`SECURITY.md: ${p}`);
    process.exit(1);
  }
  console.log(`SECURITY.md links ${links.length} tests across ${new Set(links.map((l) => l.heading)).size} threats; all exist.`);
}
