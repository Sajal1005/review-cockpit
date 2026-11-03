/*
 * Review Cockpit — DOM-free helpers shared by the content script, popup, and tests.
 * Loaded as a classic script in the extension and via require() in Node tests.
 */
(function (root) {
  'use strict';

  // Display order of file groups in the panel. "noise" groups are hidden by default.
  const CATEGORIES = [
    { id: 'source', label: 'Source', noise: false },
    { id: 'test', label: 'Tests', noise: false },
    { id: 'config', label: 'Config & build', noise: false },
    { id: 'docs', label: 'Docs', noise: false },
    { id: 'generated', label: 'Generated', noise: true },
    { id: 'lockfile', label: 'Lockfiles', noise: true },
  ];
  const CATEGORY_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));

  // First match wins, so order matters (e.g. requirements.txt is config, not docs).
  const RULES = [
    ['lockfile', /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json|mix\.lock|pubspec\.lock|Podfile\.lock|Package\.resolved|gradle\.lockfile)$/i],
    ['generated', /(\.min\.(js|css)$|\.(js|css)\.map$|(^|\/)(dist|vendor|third_party|__generated__|generated)\/|\.pb\.go$|_pb2(_grpc)?\.pyi?$|\.pb\.(cc|h)$|\.g\.dart$|\.freezed\.dart$|[._]generated\.\w+$|\.snap$|(^|\/)__snapshots__\/)/i],
    ['test', /((^|\/)(tests?|__tests__|__mocks__|specs?|e2e|testdata|fixtures)\/|[._-](test|spec)s?\.\w+$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$)/i],
    ['test', /[a-z0-9](Test|Tests|Spec|IT)\.(java|kt|kts|scala|cs|swift|groovy)$/],
    ['config', /((^|\/)\.(github|circleci|husky|vscode|devcontainer)\/|(^|\/)(Dockerfile|Containerfile|Makefile|Justfile|Procfile|Jenkinsfile|Vagrantfile|CODEOWNERS)[^/]*$|(^|\/)docker-compose[^/]*$|(^|\/)\.[^/]*rc(\.\w+)?$|(^|\/)[^/]+\.config\.[cm]?[jt]s$|(^|\/)(tsconfig|jsconfig)[^/]*\.json$|(^|\/)(package\.json|pyproject\.toml|setup\.cfg|setup\.py|Cargo\.toml|go\.mod|Gemfile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|requirements[^/]*\.txt|\.gitignore|\.gitattributes|\.editorconfig|\.dockerignore|\.env[^/]*)$|\.(ya?ml|toml|ini|cfg|conf|properties|tf|tfvars|hcl|nix|bzl)$|(^|\/)(BUILD|WORKSPACE)(\.bazel)?$)/i],
    ['docs', /(\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)docs?\/|(^|\/)(README|LICENSE|CHANGELOG|AUTHORS|CONTRIBUTING|NOTICE|SECURITY|CODE_OF_CONDUCT)[^/]*$)/i],
  ];

  function classify(path) {
    for (const [category, re] of RULES) if (re.test(path)) return category;
    return 'source';
  }

  function isNoise(category) {
    return CATEGORIES.some((c) => c.id === category && c.noise);
  }

  function sortFiles(files) {
    return [...files].sort(
      (a, b) =>
        CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  }

  // Path patterns that make a change riskier to get wrong. Only applied to source and config files,
  // so docs/auth.md or tests/test_login.py don't count.
  const RISK_RULES = [
    ['security', 3, /(auth|login|logout|session|token|passw|secret|crypt|permission|rbac|acl|oauth|jwt|csrf|cors|sanitiz|security|credential)/i],
    ['migration', 3, /((^|\/)migrations?\/|\.sql$|(^|\/)schema\.(prisma|rb|graphql)$|alembic|flyway|liquibase)/i],
    ['payments', 3, /(payment|billing|invoice|checkout|stripe|paypal|refund|pricing)/i],
    ['public API', 2, /((^|\/)(api|routes?|controllers?|handlers?|endpoints?)\/|openapi|swagger|\.proto$|\.graphql$)/i],
    ['deploy', 2, /((^|\/)\.github\/workflows\/|(^|\/)(terraform|k8s|kubernetes|helm|charts|deploy|infra)\/|Dockerfile|\.tf$)/i],
  ];
  const BASE_RISK = { source: 2, config: 1, test: 0.5, docs: 0, generated: 0, lockfile: 0 };
  const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'lib', 'app', '__init__', 'utils', 'types']);

  function stem(path) {
    return path.slice(path.lastIndexOf('/') + 1).split('.')[0].toLowerCase();
  }

  // Scores every file so reviewers can start where mistakes are most expensive.
  // Returns Map<path, { score, level: 'high' | 'medium' | 'low', reasons: string[] }>.
  function assessRisk(files) {
    const testNames = files.filter((f) => f.category === 'test').map((f) => f.path.slice(f.path.lastIndexOf('/') + 1).toLowerCase());
    const result = new Map();
    for (const f of files) {
      let score = BASE_RISK[f.category] ?? 1;
      const reasons = [];
      if (f.category === 'source' || f.category === 'config') {
        for (const [reason, weight, re] of RISK_RULES) {
          if (re.test(f.path)) {
            score += weight;
            reasons.push(reason);
          }
        }
      }
      const churn = (f.additions || 0) + (f.deletions || 0);
      if (!isNoise(f.category) && churn >= 300) {
        score += 2;
        reasons.push('large change');
      } else if (!isNoise(f.category) && churn >= 100) {
        score += 1;
      }
      const s = stem(f.path);
      if (f.category === 'source' && f.changeType !== 'DELETED' && (f.additions || 0) >= 20 && !GENERIC_STEMS.has(s) && !testNames.some((t) => t.includes(s))) {
        score += 1;
        reasons.push('no tests in PR');
      }
      if (f.changeType === 'DELETED') score = Math.max(0, score - 1);
      result.set(f.path, { score, level: score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low', reasons });
    }
    return result;
  }

  // Highest risk first; files need a .risk from assessRisk().
  function sortByRisk(files) {
    return [...files].sort((a, b) => b.risk.score - a.risk.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  // Rough reading time at ~300 reviewed lines per hour, the commonly cited sustainable pace.
  function estimateMinutes(lines) {
    return lines ? Math.max(1, Math.round(lines / 5)) : 0;
  }

  // Prefixes every added/context line with its line number in the new file, so an AI reviewer
  // can cite lines GitHub will accept for review comments.
  function annotateDiff(diff) {
    let inHunk = false;
    let line = 0;
    return diff
      .split('\n')
      .map((text) => {
        if (text.startsWith('diff --git ')) {
          inHunk = false;
          return text;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (hunk) {
          inHunk = true;
          line = Number(hunk[1]);
          return text;
        }
        if (!inHunk) return text;
        if (text.startsWith('+') || text.startsWith(' ')) return `${String(line++).padStart(5)} ${text}`;
        if (text.startsWith('-')) return `      ${text}`;
        return text;
      })
      .join('\n');
  }

  // One file's diff -> its hunks, with new-file line ranges and the first changed line.
  function parseHunks(fileDiff) {
    const hunks = [];
    let hunk = null;
    let line = 0;
    for (const text of fileDiff.split('\n')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(text);
      if (m) {
        line = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        hunk = { start: line, end: Math.max(line, line + count - 1), context: m[3].trim(), additions: 0, deletions: 0, firstChange: null };
        hunks.push(hunk);
      } else if (!hunk) {
        continue;
      } else if (text.startsWith('+')) {
        hunk.additions++;
        hunk.firstChange ??= line;
        line++;
      } else if (text.startsWith('-')) {
        hunk.deletions++;
        hunk.firstChange ??= line;
      } else if (text.startsWith(' ')) {
        line++;
      }
    }
    for (const h of hunks) h.firstChange ??= h.start;
    return hunks;
  }

  // Lines that open a function, method or type in common languages. Heuristic by design:
  // good enough to answer "what am I looking at?" without a parser per language.
  const FUNCTION_LINE = new RegExp(
    [
      /^\s*func\s+(\([^)]*\)\s*)?\w+/, // Go
      /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/, // JS/TS/PHP
      /^\s*(export\s+)?((const|let|var)\s+)?\w+\s*=\s*(async\s+)?(\([^)]*\)|\w+)\s*=>/, // arrow functions
      /^\s*(async\s+)?def\s+\w+/, // Python/Ruby
      /^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+/, // Rust
      /^\s*((public|private|protected|internal|static|final|override|virtual|abstract|async|synchronized|suspend|open)\s+)+[\w<>[\],.?\s]*\w+\s*\(/, // Java/C#/Kotlin/Swift
      /^\s*(fun|func)\s+\w+/, // Kotlin/Swift
      /^\s*(export\s+)?(abstract\s+)?(class|interface|struct|trait|impl|enum|module|object)\b/, // types
      /^\s*(async\s+)?(static\s+)?(get\s+|set\s+)?(?!(if|for|while|switch|catch|return|else)\b)\w+\s*\([^)]*\)\s*(:\s*[^{=;]+)?\{\s*$/, // method shorthand
    ]
      .map((re) => re.source)
      .join('|'),
  );

  // Nearest function/type opening at or above `lineNo` (1-based). Returns { line, text } or null.
  function enclosingFunction(lines, lineNo) {
    for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
      if (FUNCTION_LINE.test(lines[i])) return { line: i + 1, text: lines[i].trim().replace(/\s*\{\s*$/, '').slice(0, 140) };
    }
    return null;
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Matches a line that *defines* `symbol` (as opposed to using it).
  function definitionRegex(symbol) {
    const s = escapeRegExp(symbol);
    return new RegExp(
      [
        `^\\s*func\\s+(\\([^)]*\\)\\s*)?${s}\\b`,
        `\\bfunction\\*?\\s+${s}\\b`,
        `^\\s*(export\\s+)?(const|let|var)\\s+${s}\\s*[:=]`,
        `^\\s*(export\\s+)?(default\\s+)?(abstract\\s+|sealed\\s+|data\\s+)?(class|interface|type|enum|struct|trait|object|record|protocol|module)\\s+${s}\\b`,
        `^\\s*(async\\s+)?def\\s+${s}\\b`,
        `^\\s*(pub(\\([^)]*\\))?\\s+)?(async\\s+)?(unsafe\\s+)?fn\\s+${s}\\b`,
        `^\\s*((public|private|protected|internal|static|final|override|virtual|abstract|async|synchronized|suspend|open)\\s+)+[\\w<>[\\],.?\\s]*\\b${s}\\s*\\(`,
        `^\\s*(fun|func)\\s+(<[^>]*>\\s*)?(\\w+\\.)?${s}\\b`,
        `^\\s*(async\\s+)?(static\\s+)?(get\\s+|set\\s+)?${s}\\s*\\([^)]*\\)\\s*(:\\s*[^{=;]+)?\\{\\s*$`,
      ].join('|'),
    );
  }

  // Picks the identifier someone most likely meant from a text selection like
  // "labelMapWildcardPrefix(re)" or "cfg.Regex.Regexp".
  function extractIdentifier(selection) {
    const text = String(selection || '').trim();
    const call = /([A-Za-z_$][\w$]*)\s*\(/.exec(text);
    if (call) return call[1];
    const ids = text.match(/[A-Za-z_$][\w$]*/g);
    return ids ? ids[ids.length - 1] : null;
  }

  const FINDINGS_FORMAT =
    '{"findings": [{"path": "src/file.ts", "line": 42, "severity": "high|medium|low", "title": "...", "explanation": "...", "suggestion": "..."}]}';

  // Pulls review findings out of any AI agent's answer: a ```json block or bare JSON,
  // either {"findings": [...]} or a plain array.
  function parseFindings(text) {
    const candidates = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
    candidates.push(String(text));
    for (const candidate of candidates) {
      let parsed;
      try {
        parsed = JSON.parse(candidate.trim());
      } catch {
        continue;
      }
      const list = Array.isArray(parsed) ? parsed : parsed?.findings;
      if (!Array.isArray(list)) continue;
      return list
        .filter((f) => f && typeof f.path === 'string' && Number.isInteger(Number(f.line)) && Number(f.line) > 0)
        .map((f) => ({
          path: f.path.replace(/^[ab]\//, ''),
          line: Number(f.line),
          severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
          title: String(f.title || 'Finding'),
          explanation: String(f.explanation ?? f.body ?? f.description ?? ''),
          suggestion: String(f.suggestion ?? ''),
        }));
    }
    throw new Error(`Couldn't find findings JSON. Expected: ${FINDINGS_FORMAT}`);
  }

  // "/owner/repo/pull/123/files" -> { owner, repo, number }
  function parsePullUrl(pathname) {
    const m = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/.exec(pathname);
    return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
  }

  function diffPath(header) {
    const m = /^diff --git "?a\/.*?"? "?b\/(.*?)"?$/.exec(header);
    return m ? m[1] : header.slice('diff --git '.length);
  }

  // Splits a unified git diff into one chunk per file.
  function splitDiff(diff) {
    const chunks = [];
    let current = null;
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        current = { path: diffPath(line), lines: [] };
        chunks.push(current);
      }
      if (current) current.lines.push(line);
    }
    return chunks.map((c) => ({ path: c.path, text: c.lines.join('\n') }));
  }

  // Drops lockfiles and generated files from a diff so AI context isn't wasted on them.
  function stripNoise(diff) {
    const kept = [];
    const removed = [];
    for (const chunk of splitDiff(diff)) {
      if (isNoise(classify(chunk.path))) removed.push(chunk.path);
      else kept.push(chunk.text);
    }
    return { diff: kept.join('\n'), removed };
  }

  // A code fence longer than any backtick run inside the text, so markdown diffs can't break out.
  function fenceFor(text) {
    const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
    return '`'.repeat(longest + 1);
  }

  function buildAiPrompt({ title, url, author, headRefName, baseRefName, body, diff, removed = [] }) {
    const annotated = annotateDiff(diff);
    const fence = fenceFor(annotated);
    return [
      'Please review this GitHub pull request like a senior engineer.',
      'Focus on correctness bugs, security problems, unhandled edge cases, performance or concurrency issues, and missing tests.',
      'Skip style nits and anything a linter would catch. For each finding, describe the concrete failure scenario and suggest a fix.',
      'Every added or unchanged diff line is prefixed with its line number in the new file; use those numbers.',
      `End your answer with one \`\`\`json code block in exactly this shape (an empty list if the change looks good): ${FINDINGS_FORMAT}`,
      '',
      `# ${title}`,
      url,
      `Author: @${author} · merging \`${headRefName}\` into \`${baseRefName}\``,
      '',
      '## Description',
      (body || '').trim() || '(no description)',
      '',
      '## Diff',
      removed.length ? `(Left out ${removed.length} generated/lock file(s): ${removed.join(', ')})` : null,
      `${fence}diff`,
      annotated.replace(/\n+$/, ''),
      fence,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n');
  }

  const api = {
    CATEGORIES,
    classify,
    isNoise,
    sortFiles,
    assessRisk,
    sortByRisk,
    estimateMinutes,
    annotateDiff,
    parseHunks,
    enclosingFunction,
    definitionRegex,
    extractIdentifier,
    parseFindings,
    parsePullUrl,
    splitDiff,
    stripNoise,
    buildAiPrompt,
  };

  root.ReviewCockpit = Object.assign(root.ReviewCockpit || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
