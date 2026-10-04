// Detection logic for tools/sql-interpolation-guard.mjs (importable by tests).
const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|SET LOCAL)\b/;
const CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/** Line numbers of SQL template literals that interpolate anything but an UPPER_CASE constant. */
export function findViolations(text) {
  const out = [];
  for (const match of text.matchAll(/`([^`]*)`/g)) {
    const body = match[1] ?? '';
    const dynamic = [...body.matchAll(/\$\{([^}]*)\}/g)].filter((m) => !CONSTANT.test((m[1] ?? '').trim()));
    if (dynamic.length > 0 && SQL_KEYWORD.test(body)) out.push(text.slice(0, match.index).split('\n').length);
  }
  return out;
}
