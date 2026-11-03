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
});
