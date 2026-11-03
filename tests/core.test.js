const test = require('node:test');
const assert = require('node:assert/strict');
const RC = require('../src/shared/core.js');

test('classify groups files by what a reviewer cares about', () => {
  const cases = {
    'src/server/auth.ts': 'source',
    'lib/latest.java': 'source',
    'cmd/contest.go': 'source',
    'src/auth.test.ts': 'test',
    'pkg/auth/auth_test.go': 'test',
    'tests/test_login.py': 'test',
    'app/src/test/java/com/acme/LoginServiceTest.java': 'test',
    '__tests__/button.jsx': 'test',
    'package-lock.json': 'lockfile',
    'services/api/go.sum': 'lockfile',
    'pnpm-lock.yaml': 'lockfile',
    'dist/bundle.min.js': 'generated',
    'api/v1/service.pb.go': 'generated',
    'src/__snapshots__/button.test.tsx.snap': 'generated',
    '.github/workflows/ci.yml': 'config',
    'Dockerfile': 'config',
    'requirements-dev.txt': 'config',
    'vite.config.ts': 'config',
    '.eslintrc.json': 'config',
    'README.md': 'docs',
    'docs/architecture/overview.png': 'docs',
    'CHANGELOG.md': 'docs',
  };
  for (const [path, expected] of Object.entries(cases)) {
    assert.equal(RC.classify(path), expected, path);
  }
});

test('only generated files and lockfiles count as noise', () => {
  assert.equal(RC.isNoise('lockfile'), true);
  assert.equal(RC.isNoise('generated'), true);
  for (const c of ['source', 'test', 'config', 'docs']) assert.equal(RC.isNoise(c), false);
});

test('sortFiles orders by category, then path', () => {
  const files = ['README.md', 'src/b.ts', 'yarn.lock', 'src/a.test.ts', 'src/a.ts'].map((path) => ({
    path,
    category: RC.classify(path),
  }));
  assert.deepEqual(
    RC.sortFiles(files).map((f) => f.path),
    ['src/a.ts', 'src/b.ts', 'src/a.test.ts', 'README.md', 'yarn.lock'],
  );
});

function withCategory(files) {
  return files.map((f) => ({ changeType: 'MODIFIED', additions: 10, deletions: 0, ...f, category: RC.classify(f.path) }));
}

test('assessRisk puts security-sensitive source above everything else', () => {
  const files = withCategory([
    { path: 'src/auth/session.ts', additions: 40 },
    { path: 'src/ui/button.tsx', additions: 5 },
    { path: 'docs/auth.md', additions: 200 },
    { path: 'package-lock.json', additions: 5000 },
  ]);
  const risk = RC.assessRisk(files);
  assert.equal(risk.get('src/auth/session.ts').level, 'high');
  assert.ok(risk.get('src/auth/session.ts').reasons.includes('security'));
  assert.equal(risk.get('src/ui/button.tsx').level, 'low');
  assert.equal(risk.get('docs/auth.md').level, 'low'); // docs never get path-based risk
  assert.equal(risk.get('package-lock.json').score, 0); // noise is never "large"
});

test('assessRisk flags new logic that ships without tests, unless a matching test is in the PR', () => {
  const untested = RC.assessRisk(withCategory([{ path: 'src/pricing_rules.py', additions: 80 }]));
  assert.ok(untested.get('src/pricing_rules.py').reasons.includes('no tests in PR'));

  const tested = RC.assessRisk(withCategory([
    { path: 'src/pricing_rules.py', additions: 80 },
    { path: 'tests/test_pricing_rules.py', additions: 30 },
  ]));
  assert.ok(!tested.get('src/pricing_rules.py').reasons.includes('no tests in PR'));
});

test('sortByRisk orders by score, then path', () => {
  const files = withCategory([{ path: 'b.ts' }, { path: 'src/payments/charge.ts' }, { path: 'a.ts' }]);
  const risk = RC.assessRisk(files);
  const sorted = RC.sortByRisk(files.map((f) => ({ ...f, risk: risk.get(f.path) })));
  assert.deepEqual(sorted.map((f) => f.path), ['src/payments/charge.ts', 'a.ts', 'b.ts']);
});

test('estimateMinutes assumes ~300 lines per hour', () => {
  assert.equal(RC.estimateMinutes(0), 0);
  assert.equal(RC.estimateMinutes(2), 1);
  assert.equal(RC.estimateMinutes(300), 60);
});

test('annotateDiff numbers new-file lines and leaves removed lines unnumbered', () => {
  const diff = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -10,3 +20,3 @@ function f() {',
    ' keep',
    '-old',
    '--- a removed line that looks like a header',
    '+new',
  ].join('\n');
  const lines = RC.annotateDiff(diff).split('\n');
  assert.equal(lines[1], '--- a/x.js'); // headers before the hunk are untouched
  assert.equal(lines[4], '   20  keep');
  assert.equal(lines[5], '      -old');
  assert.equal(lines[6], '      --- a removed line that looks like a header');
  assert.equal(lines[7], '   21 +new');
});

test('parseHunks returns new-file ranges and the first changed line', () => {
  const hunks = RC.parseHunks(
    ['diff --git a/x.go b/x.go', '@@ -342,6 +342,26 @@', ' a', ' b', ' c', '+d', '+e', ' f', '@@ -400 +420 @@ func g() {', '-gone'].join('\n'),
  );
  assert.equal(hunks.length, 2);
  assert.deepEqual(
    { start: hunks[0].start, end: hunks[0].end, firstChange: hunks[0].firstChange, additions: hunks[0].additions },
    { start: 342, end: 367, firstChange: 345, additions: 2 },
  );
  assert.equal(hunks[1].context, 'func g() {');
  assert.equal(hunks[1].firstChange, 420);
  assert.equal(hunks[1].deletions, 1);
});

test('enclosingFunction answers "what method am I looking at?" (Prometheus relabel.go)', () => {
  const file = [
    'package relabel',
    '',
    'func relabel(cfg *Config, lb *labels.Builder) (keep bool) {',
    '\tswitch cfg.Action {',
    '\tcase LabelMap:',
    '\t\tre := cfg.Regex.Regexp',
    '\t\tif prefix, emptySuffix := labelMapWildcardPrefix(re); prefix != "" {',
    '\t\t\tlb.Range(func(l labels.Label) {',
    '\t\t\t\tif !strings.HasPrefix(l.Name, prefix) {',
  ];
  assert.deepEqual(RC.enclosingFunction(file, 9), {
    line: 3,
    text: 'func relabel(cfg *Config, lb *labels.Builder) (keep bool)',
  });
  assert.equal(RC.enclosingFunction(['package x', 'import "fmt"'], 2), null);

  const ts = ['export class Cart {', '  total(items: Item[]): number {', '    if (!items.length) {', '      return 0;'];
  assert.equal(RC.enclosingFunction(ts, 4).text, 'total(items: Item[]): number');

  const py = ['class Repo:', '    async def fetch(self, id):', '        if id is None:', '            raise ValueError()'];
  assert.equal(RC.enclosingFunction(py, 4).text, 'async def fetch(self, id):');
});

test('definitionRegex finds definitions, not calls', () => {
  const re = RC.definitionRegex('labelMapWildcardPrefix');
  assert.ok(re.test('func labelMapWildcardPrefix(re *regexp.Regexp) (string, bool) {'));
  assert.ok(!re.test('\tif prefix, emptySuffix := labelMapWildcardPrefix(re); prefix != "" {'));
  assert.ok(RC.definitionRegex('Process').test('func (r *Relabeler) Process(lset labels.Labels) bool {'));
  assert.ok(RC.definitionRegex('Cart').test('export class Cart {'));
  assert.ok(RC.definitionRegex('total').test('  total(items: Item[]) {'));
  assert.ok(RC.definitionRegex('loadUser').test('export const loadUser = async (id) => {'));
  assert.ok(RC.definitionRegex('fetch').test('    async def fetch(self, id):'));
  assert.ok(!RC.definitionRegex('total').test('    return total(items);'));
});

test('extractIdentifier picks the name you meant from a selection', () => {
  assert.equal(RC.extractIdentifier('labelMapWildcardPrefix(re)'), 'labelMapWildcardPrefix');
  assert.equal(RC.extractIdentifier(' cfg.Regex.Regexp '), 'Regexp');
  assert.equal(RC.extractIdentifier('  '), null);
});

test('parseFindings imports findings from any agent output', () => {
  const answer = [
    'Looks mostly fine. Two issues:',
    '```json',
    '{"findings": [',
    '  {"path": "b/model/relabel/relabel.go", "line": 353, "severity": "high", "title": "Re-runs regex", "explanation": "x", "suggestion": "y"},',
    '  {"path": "a.go", "line": 0, "title": "bad line is skipped"},',
    '  {"path": "c.go", "line": "12", "severity": "urgent", "title": "t", "body": "from body"}',
    ']}',
    '```',
  ].join('\n');
  const findings = RC.parseFindings(answer);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].path, 'model/relabel/relabel.go');
  assert.equal(findings[1].line, 12);
  assert.equal(findings[1].severity, 'medium');
  assert.equal(findings[1].explanation, 'from body');
  assert.deepEqual(RC.parseFindings('[]'), []);
  assert.throws(() => RC.parseFindings('no json here'), /Couldn't find findings JSON/);
});

test('parsePullUrl recognizes every PR tab and nothing else', () => {
  assert.deepEqual(RC.parsePullUrl('/octo-org/my.repo/pull/42'), { owner: 'octo-org', repo: 'my.repo', number: 42 });
  assert.deepEqual(RC.parsePullUrl('/a/b/pull/7/files'), { owner: 'a', repo: 'b', number: 7 });
  assert.deepEqual(RC.parsePullUrl('/a/b/pull/7/files/abc123..def456'), { owner: 'a', repo: 'b', number: 7 });
  assert.equal(RC.parsePullUrl('/a/b/pulls'), null);
  assert.equal(RC.parsePullUrl('/a/b/issues/7'), null);
  assert.equal(RC.parsePullUrl('/a/b/pull/new/main'), null);
});

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 111..222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/package-lock.json b/package-lock.json',
  'index 333..444 100644',
  '@@ -1 +1 @@',
  '-"a"',
  '+"b"',
  'diff --git a/docs/a b.md b/docs/a b.md',
  '@@ -0,0 +1 @@',
  '+```js',
  '',
].join('\n');

test('splitDiff yields one chunk per file, including paths with spaces', () => {
  const chunks = RC.splitDiff(DIFF);
  assert.deepEqual(chunks.map((c) => c.path), ['src/app.js', 'package-lock.json', 'docs/a b.md']);
  assert.ok(chunks[0].text.endsWith('+new'));
});

test('stripNoise removes lockfiles but keeps everything else intact', () => {
  const { diff, removed } = RC.stripNoise(DIFF);
  assert.deepEqual(removed, ['package-lock.json']);
  assert.ok(diff.includes('+new'));
  assert.ok(!diff.includes('package-lock.json'));
  assert.ok(diff.includes('docs/a b.md'));
});

test('buildAiPrompt includes PR context and a fence the diff cannot escape', () => {
  const { diff, removed } = RC.stripNoise(DIFF);
  const prompt = RC.buildAiPrompt({
    title: 'Fix login',
    url: 'https://github.com/a/b/pull/1',
    author: 'octocat',
    headRefName: 'fix-login',
    baseRefName: 'main',
    body: '',
    diff,
    removed,
  });
  assert.match(prompt, /# Fix login/);
  assert.match(prompt, /\(no description\)/);
  assert.match(prompt, /Left out 1 generated\/lock file\(s\): package-lock\.json/);
  assert.match(prompt, /````diff\n/); // diff contains ``` so the fence must be longer
  assert.match(prompt, /\n {4}1 \+new/); // diff lines carry new-file line numbers
  assert.match(prompt, /"findings"/); // asks for importable JSON
});
