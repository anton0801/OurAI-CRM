/**
 * Builds docs/acceptance/report.md: every acceptance scenario T001–T172 (spec §29) with the
 * automated tests that cover it (test names carry the T-ids) and their latest result, plus
 * documented manual/operational evidence for scenarios that are not automatable in CI.
 *
 *   pnpm acceptance:report          (runs unit+integration+security with a JSON reporter, reads the
 *                                    last Playwright JSON report if present, writes the report)
 *   pnpm acceptance:report --no-run (only rebuild from existing JSON results)
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const specFile = resolve(root, 'docs/spec/08-operations-acceptance.md');
const vitestJson = resolve(root, 'test-results/vitest.json');
const e2eJson = resolve(root, 'test-results/e2e/results.json');
const manualFile = resolve(root, 'docs/acceptance/manual-evidence.json');
const outFile = resolve(root, 'docs/acceptance/report.md');

interface Scenario { id: string; scenario: string; expected: string }
interface Evidence { suite: 'unit' | 'integration' | 'security' | 'e2e'; file: string; name: string; status: 'passed' | 'failed' | 'skipped' }

const scenarios: Scenario[] = readFileSync(specFile, 'utf8')
  .split('\n')
  .map((l) => /^\| (T\d{3}) \| ([^|]+) \| ([^|]+) \|/.exec(l))
  .filter((m): m is RegExpExecArray => !!m)
  .map((m) => ({ id: m[1]!, scenario: m[2]!.trim(), expected: m[3]!.trim() }));

if (!process.argv.includes('--no-run')) {
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  try {
    execSync(`pnpm -s vitest run --reporter=json --outputFile=${vitestJson}`, { cwd: root, stdio: 'inherit' });
  } catch {
    // Failures are reported per test below.
  }
}

const ids = (text: string) => [...new Set(text.match(/T\d{3}/g) ?? [])];
const evidence = new Map<string, Evidence[]>();
const add = (id: string, e: Evidence) => evidence.set(id, [...(evidence.get(id) ?? []), e]);
const suiteOf = (file: string): Evidence['suite'] => (file.includes('/tests/security/') ? 'security' : file.includes('/tests/integration/') ? 'integration' : 'unit');

let totals = { passed: 0, failed: 0, skipped: 0 };
if (existsSync(vitestJson)) {
  const v = JSON.parse(readFileSync(vitestJson, 'utf8')) as {
    testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[];
  };
  for (const f of v.testResults) {
    const file = f.name.replace(`${root}/`, '');
    for (const a of f.assertionResults) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      totals[status]++;
      for (const id of ids(a.fullName)) add(id, { suite: suiteOf(f.name), file, name: a.fullName, status });
    }
  }
}
let e2eTotals = { passed: 0, failed: 0, skipped: 0 };
if (existsSync(e2eJson)) {
  type Suite = { title: string; file?: string; specs?: { title: string; file: string; tests: { results: { status: string }[] }[] }[]; suites?: Suite[] };
  const r = JSON.parse(readFileSync(e2eJson, 'utf8')) as { suites: Suite[] };
  const walk = (s: Suite, prefix: string) => {
    for (const spec of s.specs ?? []) {
      const last = spec.tests.flatMap((t) => t.results).at(-1)?.status ?? 'skipped';
      const status = last === 'passed' ? 'passed' : last === 'skipped' ? 'skipped' : 'failed';
      e2eTotals[status]++;
      const name = `${prefix}${spec.title}`;
      for (const id of ids(name)) add(id, { suite: 'e2e', file: `tests/e2e/specs/${spec.file}`, name, status });
    }
    for (const c of s.suites ?? []) walk(c, `${prefix}${c.title} › `);
  };
  for (const s of r.suites) walk(s, '');
}

const manual: Record<string, { evidence: string; status: 'verified' | 'operational' }> = existsSync(manualFile) ? JSON.parse(readFileSync(manualFile, 'utf8')) : {};

const esc = (s: string) => s.replace(/\|/g, '\\|');
let covered = 0;
let failing = 0;
let manualOnly = 0;
const rows = scenarios.map((s) => {
  const ev = evidence.get(s.id) ?? [];
  const m = manual[s.id];
  let status: string;
  if (ev.some((e) => e.status === 'failed')) {
    status = '❌ failing';
    failing++;
  } else if (ev.some((e) => e.status === 'passed')) {
    status = '✅ automated';
    covered++;
  } else if (m) {
    status = m.status === 'verified' ? '✅ verified manually' : '📋 operational procedure';
    manualOnly++;
  } else status = ev.length ? '⚠️ tests skipped' : '⚠️ no evidence';
  const refs = ev.length
    ? ev
        .slice(0, 4)
        .map((e) => `${e.suite}: \`${e.file}\` — ${esc(e.name)}${e.status === 'passed' ? '' : ` (**${e.status}**)`}`)
        .join('<br>') + (ev.length > 4 ? `<br>+${ev.length - 4} more` : '')
    : m
      ? esc(m.evidence)
      : '';
  return `| ${s.id} | ${esc(s.scenario)} | ${esc(s.expected)} | ${status} | ${refs} |`;
});

const now = new Date().toISOString();
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
  } catch {
    return 'unknown';
  }
})();
const md = `# Acceptance report

Generated ${now} from commit \`${commit}\` by \`pnpm acceptance:report\`.
Source of scenarios: spec §29 (\`docs/spec/08-operations-acceptance.md\`). Automated evidence is
matched by the T-id in the test name; manual/operational evidence is kept in
\`docs/acceptance/manual-evidence.json\`.

| | Count |
|---|---|
| Scenarios | ${scenarios.length} |
| Covered by passing automated tests | ${covered} |
| Failing automated tests | ${failing} |
| Manual / operational evidence only | ${manualOnly} |
| Without evidence | ${scenarios.length - covered - failing - manualOnly} |
| Vitest results (all tests) | ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped |
| Playwright results | ${existsSync(e2eJson) ? `${e2eTotals.passed} passed, ${e2eTotals.failed} failed, ${e2eTotals.skipped} skipped` : 'not run in this report'} |

| ID | Scenario | Expected | Status | Evidence |
|---|---|---|---|---|
${rows.join('\n')}
`;
mkdirSync(resolve(root, 'docs/acceptance'), { recursive: true });
writeFileSync(outFile, md);
console.log(`Wrote ${outFile}: ${covered} automated, ${failing} failing, ${manualOnly} manual, ${scenarios.length - covered - failing - manualOnly} without evidence.`);
