/*
 * Review Cockpit — the in-page review panel shown on GitHub pull request pages.
 *
 * Renders into a shadow root attached to <html> (not <body>) so GitHub's Turbo navigations,
 * which swap out <body>, don't wipe it, and GitHub's CSS can't leak in.
 */
(() => {
  'use strict';
  if (globalThis.__reviewCockpitLoaded) return;
  globalThis.__reviewCockpitLoaded = true;

  const RC = globalThis.ReviewCockpit;
  const { h, send } = RC;

  const CHANGE_LETTER = { ADDED: 'A', DELETED: 'D', MODIFIED: 'M', RENAMED: 'R', COPIED: 'C', CHANGED: 'M' };
  const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
  const GROUPINGS = {
    risk: {
      key: (f) => f.risk.level,
      groups: [
        { id: 'high', label: 'High risk: start here' },
        { id: 'medium', label: 'Medium risk' },
        { id: 'low', label: 'Low risk' },
      ],
    },
    type: { key: (f) => f.category, groups: RC.CATEGORIES },
  };

  const prefs = { open: true, hideNoise: true, unviewedOnly: false, autoAdvance: true, sort: 'risk', tab: 'files' };

  let pr = null; // { owner, repo, number, key } for the PR on screen
  let data = null; // payload from the background worker
  let files = []; // sorted + enriched with category / anchor / risk
  let cursorPath = null; // file the keyboard cursor is on
  let since = null; // { from, to, at, paths: Set | null } when there are commits after your last review
  let ai = newAiState();
  let code = newCodeState();
  let diffCache = null; // { head, promise: Promise<Map<path, fileDiff>> }
  let error = null;
  let fetchedAt = 0;
  let query = '';

  let host = null;
  let buildPromise = null;
  const els = {};

  function newAiState() {
    return { status: null, running: false, result: null, error: null };
  }

  function newCodeState() {
    // outline: changed sections of the cursor file; results/viewer: symbol lookup
    return { outlineFor: null, outline: null, outlineError: null, query: '', searching: false, results: null, error: null, viewer: null };
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function load() {
    const target = pr;
    error = null;
    if (!data) render();
    try {
      const d = await send('getPullRequest', { owner: target.owner, repo: target.repo, number: target.number });
      if (pr !== target) return;
      const enriched = await Promise.all(
        d.files.map(async (f) => {
          const category = RC.classify(f.path);
          // GitHub anchors each file in the diff view as #diff-<sha256(path)>.
          return { ...f, category, noise: RC.isNoise(category), anchor: `diff-${await sha256(f.path)}` };
        }),
      );
      if (pr !== target) return;
      const risk = RC.assessRisk(enriched);
      for (const f of enriched) f.risk = risk.get(f.path);
      if (data && data.headRefOid !== d.headRefOid) code.outlineFor = null; // new push: re-read sections
      data = d;
      files = RC.sortFiles(enriched);
      fetchedAt = Date.now();
      if (cursorPath && !files.some((f) => f.path === cursorPath)) cursorPath = null;
      loadSince(target);
    } catch (err) {
      if (pr === target) error = err;
    }
    if (pr === target) render();
  }

  function loadSince(target) {
    const review = data.lastReview;
    if (!review || review.oid === data.headRefOid) {
      since = null;
      return;
    }
    if (since && since.from === review.oid && since.to === data.headRefOid) return;
    const current = (since = { from: review.oid, to: data.headRefOid, at: review.submittedAt, paths: null });
    send('changedFiles', { owner: target.owner, repo: target.repo, base: current.from, head: current.to })
      .then((paths) => {
        current.paths = new Set(paths);
        if (pr === target) render();
      })
      .catch(() => {}); // e.g. the reviewed commit was force-pushed away; the banner still works
  }

  async function loadAi(target) {
    const key = `ai:${target.key}`;
    const state = ai;
    const [stored, status] = await Promise.all([
      chrome.storage.local.get(key).then((r) => r[key] || null),
      send('aiStatus').catch(() => null),
    ]);
    if (ai !== state) return;
    state.result = stored;
    state.status = status;
    renderAi();
    renderTabs();
  }

  function saveAi(key, result) {
    chrome.storage.local.set({ [`ai:${key}`]: result }).catch(() => {});
  }

  // The PR diff split per file, fetched once per head commit.
  function fileDiffs() {
    if (!diffCache || diffCache.head !== data.headRefOid) {
      const promise = send('getDiff', { owner: pr.owner, repo: pr.repo, number: pr.number }).then(
        (text) => new Map(RC.splitDiff(text).map((c) => [c.path, c.text])),
      );
      diffCache = { head: data.headRefOid, promise };
      promise.catch(() => {
        if (diffCache?.promise === promise) diffCache = null;
      });
    }
    return diffCache.promise;
  }

  function readFile(path, ref) {
    return send('getFile', { owner: pr.owner, repo: pr.repo, ref, path }).then((text) => text.split('\n'));
  }

  // "What method am I looking at?": each changed section of a file with the function around it.
  async function loadOutline(f) {
    const state = code;
    state.outlineFor = f.path;
    state.outline = null;
    state.outlineError = null;
    try {
      const chunk = (await fileDiffs()).get(f.path);
      if (!chunk) throw new Error("GitHub didn't include this file in the diff. It may be binary or too large.");
      let lines = null;
      if (f.changeType !== 'DELETED') lines = await readFile(f.path, data.headRefOid).catch(() => null);
      state.outline = RC.parseHunks(chunk).map((hunk) => {
        const fn = lines ? RC.enclosingFunction(lines, hunk.firstChange) : null;
        return { ...hunk, fn: fn?.text || hunk.context || null, fnLine: fn?.line ?? null };
      });
    } catch (err) {
      state.outlineError = err;
    }
    if (code === state && state.outlineFor === f.path) renderCode();
  }

  // "Go to definition / references" without leaving the review.
  async function lookup(symbol) {
    if (!data) return;
    const state = code;
    Object.assign(state, { query: symbol, searching: true, results: null, error: null, viewer: null });
    els.symbol.value = symbol;
    renderCode();
    const paths = files
      .filter((f) => !f.noise && f.changeType !== 'DELETED' && (f.category === 'source' || f.category === 'test'))
      .map((f) => f.path);
    try {
      state.results = await send('findSymbol', { owner: pr.owner, repo: pr.repo, symbol, head: data.headRefOid, paths });
    } catch (err) {
      state.error = err;
    }
    state.searching = false;
    if (code === state) renderCode();
  }

  async function openViewer(item) {
    const state = code;
    state.viewer = { ...item, loading: true };
    renderCode();
    try {
      const lines = await readFile(item.path, item.ref);
      let line = item.line;
      if (!line && state.query) {
        const isDefinition = RC.definitionRegex(state.query);
        const i = lines.findIndex((l) => isDefinition.test(l));
        line = i >= 0 ? i + 1 : lines.findIndex((l) => l.includes(state.query)) + 1;
      }
      state.viewer = { ...item, line: line || 1, lines, loading: false };
    } catch (err) {
      state.viewer = { ...item, error: err, loading: false };
    }
    if (code === state) {
      renderCode();
      els.codeView.scrollTop = 0;
    }
  }

  function isChanged(f) {
    return f.viewedState === 'DISMISSED' || !!since?.paths?.has(f.path);
  }

  // Files in the order they're displayed, which is also the Alt+J/K order.
  function visibleFiles() {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = files.filter(
      (f) =>
        !(prefs.hideNoise && f.noise) &&
        !(prefs.unviewedOnly && f.viewedState === 'VIEWED') &&
        terms.every((t) => f.path.toLowerCase().includes(t)),
    );
    return prefs.sort === 'risk' ? RC.sortByRisk(list) : list;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function openFile(f, line) {
    // GitHub anchors a right-side diff line as #diff-<sha256(path)>R<line>.
    const anchor = line ? `${f.anchor}R${line}` : f.anchor;
    if (!/\/pull\/\d+\/(files|changes)\b/.test(location.pathname)) {
      location.assign(`/${pr.owner}/${pr.repo}/pull/${pr.number}/files#${anchor}`);
      return;
    }
    const el =
      document.getElementById(anchor) ||
      document.getElementById(f.anchor) ||
      document.querySelector(`[data-tagsearch-path="${CSS.escape(f.path)}"]`);
    if (el) {
      el.style.scrollMarginTop = '96px'; // clear GitHub's sticky header
      el.scrollIntoView({ block: line ? 'center' : 'start' });
      history.replaceState(history.state, '', `#${anchor}`);
    } else {
      location.hash = anchor; // let GitHub lazy-load and scroll to it
    }
  }

  function select(f, line) {
    cursorPath = f.path;
    renderList();
    if (prefs.tab === 'code') renderCode();
    openFile(f, line);
    if (!prefs.open) toast(f.path);
  }

  function move(delta) {
    const list = visibleFiles();
    if (!list.length) return;
    const i = list.findIndex((f) => f.path === cursorPath);
    const next = i === -1 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + delta));
    select(list[next]);
  }

  function nextUnviewed() {
    const list = visibleFiles();
    const start = list.findIndex((f) => f.path === cursorPath);
    for (let k = 1; k <= list.length; k++) {
      const f = list[(start + k) % list.length];
      if (f.viewedState !== 'VIEWED') return select(f);
    }
    toast('Every file is viewed 🎉');
  }

  async function toggleViewed(f, { advance = false } = {}) {
    const previous = f.viewedState;
    const viewed = previous !== 'VIEWED';
    f.viewedState = viewed ? 'VIEWED' : 'UNVIEWED';
    render();
    if (viewed && advance && prefs.autoAdvance) nextUnviewed();
    try {
      await send('setViewed', { pullRequestId: data.id, path: f.path, viewed });
    } catch (err) {
      f.viewedState = previous;
      render();
      toast(`Couldn't update "${f.path}": ${err.message}`);
    }
  }

  function cursorFile() {
    return files.find((f) => f.path === cursorPath);
  }

  async function copyForAi() {
    if (!data) return;
    const btn = els.aiBtn;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Fetching diff…';
    try {
      const raw = await send('getDiff', { owner: pr.owner, repo: pr.repo, number: pr.number });
      const { diff, removed } = prefs.hideNoise ? RC.stripNoise(raw) : { diff: raw, removed: [] };
      const text = RC.buildAiPrompt({ ...data, diff, removed });
      const tokens = `≈${Math.max(1, Math.round(text.length / 4000))}k tokens`;
      try {
        await navigator.clipboard.writeText(text);
        toast(
          `Copied (${tokens}). Paste it into your AI agent, then paste its answer into AI review → Import to turn findings into draft comments.${removed.length ? ` Left out ${removed.length} generated/lock files.` : ''}`,
        );
      } catch {
        showText(text); // clipboard can be blocked if the page lost focus
      }
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function runAi() {
    if (!data || ai.running) return;
    const state = ai;
    const target = pr;
    state.running = true;
    state.error = null;
    renderAi();
    renderTabs();
    try {
      const r = await send('aiReview', {
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        title: data.title,
        body: data.body,
        url: data.url,
        author: data.author,
      });
      state.result = {
        headRefOid: data.headRefOid,
        at: new Date().toISOString(),
        modelName: r.modelName,
        summary: r.summary,
        removed: r.removed,
        findings: r.findings
          .map((f) => ({ ...f, state: 'new' }))
          .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
      };
      saveAi(target.key, state.result);
    } catch (err) {
      state.error = err;
    } finally {
      state.running = false;
      if (ai === state) {
        renderAi();
        renderTabs();
      }
    }
  }

  function commentBody(finding) {
    return `**${finding.title}**\n\n${finding.explanation}${finding.suggestion ? `\n\n**Suggestion:** ${finding.suggestion}` : ''}`;
  }

  function addDraft(finding) {
    return send('addDraftComment', { pullRequestId: data.id, path: finding.path, line: finding.line, body: commentBody(finding) });
  }

  async function postAll(btn) {
    const state = ai;
    const key = pr.key;
    const pending = state.result.findings.filter((f) => f.state === 'new');
    btn.disabled = true;
    let added = 0;
    let failed = 0;
    for (const finding of pending) {
      btn.textContent = `Adding ${added + failed + 1}/${pending.length}…`;
      try {
        await addDraft(finding);
        finding.state = 'posted';
        added++;
      } catch {
        failed++;
      }
    }
    saveAi(key, state.result);
    toast(
      `Added ${added} draft comment${added === 1 ? '' : 's'}${failed ? `; ${failed} couldn't be placed (line outside the diff)` : ''}. Submit them with "Finish your review" on GitHub.`,
    );
    if (ai === state) {
      renderAi();
      renderTabs();
    }
  }

  // Findings from any agent (Claude Code, Cursor, a chat window…) become one-click draft comments.
  function importFindings() {
    let found;
    try {
      found = RC.parseFindings(els.importInput.value);
    } catch (err) {
      return toast(err.message);
    }
    const known = new Set(files.map((f) => f.path));
    const findings = found.map((f) => ({ ...f, state: 'new' }));
    const unknown = findings.filter((f) => !known.has(f.path)).length;
    if (ai.result && ai.result.headRefOid === data.headRefOid) {
      ai.result.findings.push(...findings);
      ai.result.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    } else {
      ai.result = {
        headRefOid: data.headRefOid,
        at: new Date().toISOString(),
        modelName: 'Your agent',
        summary: `Imported ${findings.length} finding${findings.length === 1 ? '' : 's'} from your own agent.`,
        removed: [],
        findings: findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
      };
    }
    saveAi(pr.key, ai.result);
    els.importInput.value = '';
    els.importBox.hidden = true;
    renderAi();
    renderTabs();
    toast(`Imported ${findings.length} finding${findings.length === 1 ? '' : 's'}.${unknown ? ` ${unknown} point at files that aren't in this PR.` : ''}`);
  }

  async function postFinding(finding, btn) {
    const state = ai;
    const key = pr.key;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      await addDraft(finding);
      finding.state = 'posted';
      saveAi(key, state.result);
      toast('Added to your pending review. Submit it with "Finish your review" on GitHub (reload to see it there).');
    } catch (err) {
      toast(err.message);
    }
    if (ai === state) {
      renderAi();
      renderTabs();
    }
  }

  function dismissFinding(finding) {
    finding.state = 'dismissed';
    saveAi(pr.key, ai.result);
    renderAi();
    renderTabs();
  }

  function jumpTo(path, line) {
    const f = files.find((x) => x.path === path);
    if (f) select(f, line);
    else toast(`${path} isn't in this PR's file list.`);
  }

  function setTab(tab) {
    prefs.tab = tab;
    savePrefs();
    renderTabs();
    if (tab === 'code') renderCode();
  }

  function setOpen(open) {
    prefs.open = open;
    savePrefs();
    applyOpen();
  }

  function applyOpen() {
    const visible = !!pr && prefs.open;
    document.documentElement.classList.toggle('rc-panel-open', visible);
    if (!host) return;
    els.panel.hidden = !prefs.open;
    els.launcher.hidden = prefs.open;
  }

  function savePrefs() {
    chrome.storage.local.set({ prefs }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    if (!host) return;
    renderSummary();
    renderTabs();
    renderList();
    renderThreads();
    renderCode();
    renderAi();
    renderLauncher();
  }

  function renderSummary() {
    const box = els.summary;
    if (error) return box.replaceChildren(errorCard(error));
    if (!data) return box.replaceChildren(h('div', { class: 'muted' }, 'Loading pull request…'));

    const viewed = files.filter((f) => f.viewedState === 'VIEWED').length;
    const pct = files.length ? (viewed / files.length) * 100 : 0;
    const left = RC.estimateMinutes(
      files.filter((f) => !f.noise && f.viewedState !== 'VIEWED').reduce((n, f) => n + f.additions + f.deletions, 0),
    );
    box.replaceChildren(
      h('div', { class: 'title', title: data.title }, h('span', { class: 'num' }, `#${data.number} `), data.title),
      h(
        'div',
        { class: 'meta' },
        `@${data.author} · ${data.headRefName} → ${data.baseRefName}`,
        left ? h('span', { title: 'Estimated at ~300 reviewed lines per hour, excluding generated files and lockfiles' }, ` · ≈${left} min left`) : null,
      ),
      h(
        'div',
        { class: 'progress' },
        h('div', { class: 'bar' }, h('span', { style: { width: `${pct}%` } })),
        h('span', null, `${viewed}/${files.length} viewed`),
        h('span', { class: 'add' }, `+${data.additions}`),
        h('span', { class: 'del' }, `−${data.deletions}`),
      ),
      sinceBanner(),
    );
  }

  function sinceBanner() {
    const unseen = files.filter((f) => isChanged(f) && f.viewedState !== 'VIEWED').length;
    if (!since && !unseen) return null;
    return h(
      'div',
      { class: 'since' },
      since
        ? h(
            'div',
            null,
            h('strong', null, 'New commits since your review'),
            ` (${RC.timeAgo(since.at)}). `,
            h('a', { href: `/${pr.owner}/${pr.repo}/pull/${pr.number}/files/${since.from}..${since.to}` }, 'Show only what changed →'),
          )
        : null,
      unseen ? h('div', null, h('span', { class: 'dot' }), ` ${unseen} file${unseen === 1 ? '' : 's'} with changes you haven't seen`) : null,
    );
  }

  function errorCard(err) {
    if (err.code === 'NO_TOKEN' || err.code === 'BAD_TOKEN') {
      return h(
        'div',
        { class: 'card' },
        h('strong', null, err.code === 'NO_TOKEN' ? 'Connect your GitHub account' : 'Your GitHub token stopped working'),
        h('p', null, 'Review Cockpit calls the GitHub API with a personal access token that never leaves your browser.'),
        h('button', { class: 'btn primary', onclick: () => send('openOptions') }, 'Set up token'),
      );
    }
    return h(
      'div',
      { class: 'card error' },
      h('strong', null, "Couldn't load this pull request"),
      h('p', null, err.message),
      h('button', { class: 'btn', onclick: () => load() }, 'Retry'),
    );
  }

  function renderTabs() {
    if (!host) return;
    const threads = data?.threads.length ?? 0;
    const open = ai.result?.findings.filter((f) => f.state === 'new').length ?? 0;
    const counts = {
      files: files.length ? `${files.filter((f) => f.viewedState !== 'VIEWED').length}` : '',
      threads: threads ? `${threads}` : '',
      code: '',
      ai: ai.running ? '…' : open ? `${open}` : '',
    };
    for (const [tab, button] of Object.entries(els.tabs)) {
      button.classList.toggle('active', prefs.tab === tab);
      button.setAttribute('aria-selected', String(prefs.tab === tab));
      button.querySelector('.count').textContent = counts[tab];
      els.views[tab].hidden = prefs.tab !== tab;
    }
  }

  function renderList() {
    if (!host) return;
    const list = visibleFiles();
    const noise = files.filter((f) => f.noise).length;
    els.noiseCount.textContent = noise ? ` (${noise})` : '';

    const rows = [];
    if (data && !list.length) {
      rows.push(h('div', { class: 'empty' }, files.length ? 'No files match your filters.' : 'No files changed.'));
    }
    const grouping = GROUPINGS[prefs.sort] || GROUPINGS.risk;
    for (const g of grouping.groups) {
      const group = list.filter((f) => grouping.key(f) === g.id);
      if (!group.length) continue;
      const viewed = group.filter((f) => f.viewedState === 'VIEWED').length;
      rows.push(h('div', { class: `group group-${g.id}` }, h('span', null, g.label), h('span', null, `${viewed}/${group.length}`)));
      rows.push(...group.map(fileRow));
    }
    els.list.replaceChildren(...rows);
    els.list.querySelector('.file.cursor')?.scrollIntoView({ block: 'nearest' });
  }

  function fileRow(f) {
    const viewed = f.viewedState === 'VIEWED';
    const slash = f.path.lastIndexOf('/');
    const checkbox = h('input', { type: 'checkbox', checked: viewed, title: 'Viewed (Alt+V)' });
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleViewed(f);
    });
    const showRisk = f.risk.level !== 'low' && f.risk.reasons.length && !viewed;
    return h(
      'div',
      {
        class: ['file', viewed && 'viewed', f.path === cursorPath && 'cursor'].filter(Boolean).join(' '),
        title: f.path,
        onclick: () => select(f),
      },
      checkbox,
      h(
        'div',
        { class: 'file-main' },
        h(
          'span',
          { class: 'path' },
          slash >= 0 ? h('span', { class: 'dir' }, f.path.slice(0, slash + 1)) : null,
          h('span', { class: 'name' }, f.path.slice(slash + 1)),
        ),
        showRisk ? h('span', { class: `reasons risk-${f.risk.level}` }, f.risk.reasons.join(' · ')) : null,
      ),
      isChanged(f) && !viewed ? h('span', { class: 'dot', title: 'Changed since you last viewed or reviewed it' }) : null,
      h('span', { class: `ct ct-${f.changeType.toLowerCase()}`, title: f.changeType.toLowerCase() }, CHANGE_LETTER[f.changeType] || 'M'),
      h('span', { class: 'stat' }, h('span', { class: 'add' }, `+${f.additions}`), ' ', h('span', { class: 'del' }, `−${f.deletions}`)),
    );
  }

  function threadStatus(t) {
    if (t.outdated) {
      return h('span', { class: 'chip attention', title: 'The code under this comment changed after it was written. Check whether it was addressed.' }, 'code changed');
    }
    if (t.lastAuthor === data.author && t.author !== data.author) return h('span', { class: 'chip accent' }, 'author replied');
    return h('span', { class: 'chip' }, 'open');
  }

  function renderThreads() {
    if (!host) return;
    const box = els.threadsList;
    if (!data) return box.replaceChildren();
    const threads = [...data.threads].sort(
      (a, b) => (b.author === data.viewer) - (a.author === data.viewer) || b.outdated - a.outdated,
    );
    if (!threads.length) return box.replaceChildren(h('div', { class: 'empty' }, 'No unresolved conversations. 🎉'));
    const changed = threads.filter((t) => t.outdated).length;
    box.replaceChildren(
      h('div', { class: 'view-note' }, `${threads.length} unresolved`, changed ? ` · ${changed} where the code has changed since` : ''),
      ...threads.map((t) =>
        h(
          'a',
          { class: 'thread', href: t.url || `/${pr.owner}/${pr.repo}/pull/${pr.number}/files` },
          h('div', { class: 'thread-hd' }, threadStatus(t), h('span', { class: 'thread-path' }, t.line ? `${t.path}:${t.line}` : t.path)),
          h('div', { class: 'thread-body' }, h('strong', null, `@${t.author}`), t.author === data.viewer ? ' (you)' : '', `: ${t.body}`),
          t.replies
            ? h('div', { class: 'muted small' }, `${t.replies} repl${t.replies === 1 ? 'y' : 'ies'} · last from @${t.lastAuthor}`)
            : null,
        ),
      ),
    );
  }

  function renderAi() {
    if (!host) return;
    const box = els.aiView;
    if (!data) return box.replaceChildren(h('div', { class: 'empty' }, 'Loading pull request…'));
    const { status, running, result, error: aiError } = ai;
    const configured = !!status?.configured;
    const modelName = status?.modelName ?? 'Claude';
    const parts = [];

    if (status && !configured) {
      parts.push(
        h(
          'div',
          { class: 'card' },
          h('strong', null, 'Get a first-pass review from Claude'),
          h(
            'p',
            null,
            'Claude reads the diff (minus generated files and lockfiles) and lists likely bugs with file and line. You choose which ones become draft comments. Add your Anthropic API key in settings to turn it on, or import findings from your own agent below.',
          ),
          h('button', { class: 'btn primary', onclick: () => send('openOptions') }, 'Add API key'),
        ),
      );
    } else {
      parts.push(
        h(
          'div',
          { class: 'ai-bar' },
          h('button', { class: 'btn primary', disabled: running || !status, onclick: runAi }, running ? 'Reviewing…' : result ? 'Run again' : 'Run AI review'),
          h(
            'span',
            { class: 'muted small' },
            running ? `${modelName} is reading the diff. Usually 1–3 minutes.` : `${modelName} · sends the diff to Anthropic with your key`,
          ),
        ),
      );
    }

    parts.push(
      h(
        'div',
        { class: 'import-bar' },
        h(
          'button',
          {
            class: 'btn small quiet',
            title: 'Paste the answer from Claude Code, Cursor or any chat. "Copy for AI" asks for the right format.',
            onclick: () => {
              els.importBox.hidden = !els.importBox.hidden;
              if (!els.importBox.hidden) els.importInput.focus();
            },
          },
          'Import findings from your own agent',
        ),
      ),
      els.importBox,
    );
    if (aiError) {
      parts.push(
        h(
          'div',
          { class: 'card error' },
          h('strong', null, 'AI review failed'),
          h('p', null, aiError.message),
          aiError.code === 'BAD_AI_KEY' || aiError.code === 'NO_AI_KEY'
            ? h('button', { class: 'btn', onclick: () => send('openOptions') }, 'Open settings')
            : null,
        ),
      );
    }
    if (result) {
      if (result.headRefOid !== data.headRefOid) {
        parts.push(h('div', { class: 'since' }, 'New commits were pushed after this AI review. Run it again to cover them.'));
      }
      parts.push(h('div', { class: 'ai-summary' }, h('div', { class: 'muted small' }, `${result.modelName} · ${RC.timeAgo(result.at)}`), result.summary));
      const shown = result.findings.filter((f) => f.state !== 'dismissed');
      const pending = shown.filter((f) => f.state === 'new').length;
      if (pending > 1) {
        parts.push(
          h(
            'div',
            { class: 'import-bar' },
            h('button', { class: 'btn small', onclick: (e) => postAll(e.currentTarget) }, `Add all ${pending} as draft comments`),
            h('span', { class: 'muted small' }, 'Nothing is visible until you submit your review.'),
          ),
        );
      }
      if (!shown.length) parts.push(h('div', { class: 'empty' }, result.findings.length ? 'All findings dismissed.' : 'No issues found. 🎉'));
      parts.push(...shown.map(findingCard));
    } else if (configured && !running && !aiError) {
      parts.push(
        h(
          'p',
          { class: 'muted ai-pad' },
          'Claude lists likely bugs, security problems and missing tests. Nothing is posted until you choose "Add as draft comment" on a finding and then submit your review on GitHub.',
        ),
      );
    }
    box.replaceChildren(...parts);
  }

  function renderCode() {
    if (!host) return;
    const box = els.codeResults;
    if (!data) return box.replaceChildren(h('div', { class: 'empty' }, 'Loading pull request…'));
    const { viewer } = code;

    if (viewer) {
      const back = h('button', { class: 'btn small quiet', onclick: () => { code.viewer = null; renderCode(); } }, '← Back');
      if (viewer.loading) return box.replaceChildren(h('div', { class: 'viewer-hd' }, back, h('span', { class: 'muted small' }, `Opening ${viewer.path}…`)));
      if (viewer.error) return box.replaceChildren(h('div', { class: 'viewer-hd' }, back), h('div', { class: 'card error' }, h('p', null, viewer.error.message)));
      const from = Math.max(1, viewer.line - 3);
      const to = Math.min(viewer.lines.length, viewer.line + 60);
      const inPr = files.find((f) => f.path === viewer.path && viewer.ref === data.headRefOid);
      const blobUrl = `https://github.com/${pr.owner}/${pr.repo}/blob/${viewer.ref}/${viewer.path.split('/').map(encodeURIComponent).join('/')}#L${viewer.line}`;
      return box.replaceChildren(
        h('div', { class: 'viewer-hd' }, back, h('span', { class: 'viewer-path', title: viewer.path }, `${viewer.path}:${viewer.line}`)),
        h(
          'div',
          { class: 'viewer-actions' },
          inPr ? h('button', { class: 'btn small', onclick: () => select(inPr, viewer.line) }, 'Show in diff') : null,
          h('a', { class: 'small', href: blobUrl, target: '_blank', rel: 'noopener' }, 'Open on GitHub ↗'),
          h('span', { class: 'muted small' }, viewer.ref === data.headRefOid ? 'at this PR' : 'on the default branch'),
        ),
        h(
          'pre',
          { class: 'code' },
          viewer.lines.slice(from - 1, to).map((text, i) =>
            h('div', { class: from + i === viewer.line ? 'hl' : null }, h('span', { class: 'ln' }, from + i), text || ' '),
          ),
        ),
      );
    }

    const parts = [];

    // Symbol lookup results
    if (code.searching) parts.push(h('div', { class: 'empty' }, `Looking for ${code.query}…`));
    if (code.error) parts.push(h('div', { class: 'card error' }, h('p', null, code.error.message)));
    if (code.results) {
      const { definitions, references, searchError } = code.results;
      const row = (item) =>
        h(
          'button',
          { class: 'sym', onclick: () => openViewer(item) },
          h('span', { class: 'sym-path' }, item.line ? `${item.path}:${item.line}` : item.path, item.inPr ? h('span', { class: 'chip accent' }, 'in this PR') : null),
          item.preview ? h('code', { class: 'sym-preview' }, item.preview) : null,
        );
      parts.push(h('div', { class: 'section-hd' }, `Definitions of ${code.query}`, h('span', null, definitions.length)));
      parts.push(...(definitions.length ? definitions.map(row) : [h('div', { class: 'empty-sm' }, 'No definition found.')]));
      if (references.length) {
        parts.push(h('div', { class: 'section-hd' }, 'Used in', h('span', null, references.length)));
        parts.push(...references.map(row));
      }
      if (searchError) parts.push(h('div', { class: 'empty-sm' }, `GitHub code search unavailable: ${searchError}`));
    }

    // Changed sections of the current file
    const f = cursorFile();
    parts.push(h('div', { class: 'section-hd' }, f ? `Changed sections · ${f.path.slice(f.path.lastIndexOf('/') + 1)}` : 'Changed sections'));
    if (!f) {
      parts.push(h('div', { class: 'empty-sm' }, 'Pick a file (Alt+J, or click one in Files) to see which functions it changes.'));
    } else if (code.outlineFor !== f.path) {
      if (prefs.tab === 'code') loadOutline(f);
      parts.push(h('div', { class: 'empty-sm' }, 'Reading the file…'));
    } else if (code.outlineError) {
      parts.push(h('div', { class: 'empty-sm' }, code.outlineError.message));
    } else if (!code.outline) {
      parts.push(h('div', { class: 'empty-sm' }, 'Reading the file…'));
    } else {
      parts.push(
        ...code.outline.map((hunk) =>
          h(
            'div',
            { class: 'hunk', title: 'Jump to this change', onclick: () => openFile(f, hunk.firstChange) },
            h('code', { class: 'hunk-fn' }, hunk.fn || '(top level)'),
            h(
              'div',
              { class: 'hunk-meta' },
              `lines ${hunk.start}–${hunk.end} · `,
              h('span', { class: 'add' }, `+${hunk.additions}`),
              ' ',
              h('span', { class: 'del' }, `−${hunk.deletions}`),
              hunk.fnLine
                ? h(
                    'button',
                    {
                      class: 'link',
                      title: 'Read the whole function here',
                      onclick: (e) => {
                        e.stopPropagation();
                        openViewer({ path: f.path, ref: data.headRefOid, line: hunk.fnLine });
                      },
                    },
                    'view function',
                  )
                : null,
            ),
          ),
        ),
      );
    }
    box.replaceChildren(...parts);
  }

  function findingCard(f) {
    return h(
      'div',
      { class: `finding sev-${f.severity}` },
      h('div', { class: 'finding-hd' }, h('span', { class: `chip sev ${f.severity}` }, f.severity), h('strong', null, f.title)),
      h('a', { class: 'loc', href: '#', onclick: (e) => { e.preventDefault(); jumpTo(f.path, f.line); } }, `${f.path}:${f.line}`),
      h('div', { class: 'md' }, f.explanation),
      f.suggestion ? h('div', { class: 'md suggestion' }, h('strong', null, 'Suggestion: '), f.suggestion) : null,
      h(
        'div',
        { class: 'finding-actions' },
        f.state === 'posted'
          ? h('span', { class: 'add small' }, '✓ Added to your pending review')
          : [
              h('button', { class: 'btn small', onclick: (e) => postFinding(f, e.currentTarget) }, 'Add as draft comment'),
              h('button', { class: 'btn small quiet', onclick: () => dismissFinding(f) }, 'Dismiss'),
            ],
      ),
    );
  }

  function renderLauncher() {
    const viewed = files.filter((f) => f.viewedState === 'VIEWED').length;
    els.launcher.textContent = data ? `✓ ${viewed}/${files.length} viewed` : 'Review Cockpit';
  }

  let toastTimer;
  function toast(message) {
    if (!host) return;
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3500);
  }

  function showText(text) {
    const area = h('textarea', { readonly: true, value: text });
    const modal = h(
      'div',
      { class: 'modal', onclick: (e) => e.target === modal && modal.remove() },
      h(
        'div',
        { class: 'modal-box' },
        h(
          'div',
          { class: 'modal-hd' },
          h('strong', null, 'Copy this into your AI agent'),
          h('button', { class: 'icon', title: 'Close', onclick: () => modal.remove() }, '×'),
        ),
        area,
      ),
    );
    els.root.append(modal);
    area.focus();
    area.select();
  }

  // -------------------------------------------------------------------------
  // Notes (private, stored locally per PR)
  // -------------------------------------------------------------------------

  let notesTimer;
  async function loadNotes() {
    if (!host) return;
    const key = `notes:${pr.key}`;
    const stored = (await chrome.storage.local.get(key))[key] || '';
    els.notes.value = stored;
    updateNotesButton();
  }

  function saveNotes() {
    clearTimeout(notesTimer);
    const key = `notes:${pr.key}`;
    const value = els.notes.value;
    notesTimer = setTimeout(() => {
      (value ? chrome.storage.local.set({ [key]: value }) : chrome.storage.local.remove(key)).catch(() => {});
    }, 400);
    updateNotesButton();
  }

  function updateNotesButton() {
    els.notesBtn.textContent = els.notes.value.trim() ? 'Notes •' : 'Notes';
  }

  // -------------------------------------------------------------------------
  // UI construction
  // -------------------------------------------------------------------------

  async function applyStyles(shadow) {
    const css = await fetch(chrome.runtime.getURL('src/content/panel.css')).then((r) => r.text());
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', null, css));
    }
  }

  async function buildUi() {
    const el = document.createElement('div');
    el.id = 'review-cockpit-root';
    const shadow = el.attachShadow({ mode: 'open' });
    await applyStyles(shadow);

    const kbd = (k) => h('kbd', null, k);
    const tab = (id, label) =>
      h('button', { class: 'tab', role: 'tab', onclick: () => setTab(id) }, label, h('span', { class: 'count' }));

    els.root = shadow;
    els.summary = h('div', { class: 'summary' });
    els.tabs = { files: tab('files', 'Files'), threads: tab('threads', 'Conversations'), code: tab('code', 'Code'), ai: tab('ai', 'AI review') };
    els.symbol = h('input', { type: 'search', class: 'search', placeholder: 'Find definition…  (select a name, Alt+G)', spellcheck: 'false' });
    els.codeResults = h('div');
    els.codeView = h(
      'div',
      { class: 'scroll' },
      h(
        'form',
        {
          class: 'tools-row code-search',
          onsubmit: (e) => {
            e.preventDefault();
            const symbol = RC.extractIdentifier(els.symbol.value);
            if (symbol) lookup(symbol);
          },
        },
        els.symbol,
        h('button', { class: 'btn small', type: 'submit' }, 'Find'),
      ),
      els.codeResults,
    );
    els.importInput = h('textarea', {
      class: 'notes-input',
      placeholder: 'Paste your agent\'s answer. It needs a JSON block like {"findings": [{"path", "line", "severity", "title", "explanation", "suggestion"}]}. "Copy for AI" asks for exactly this.',
    });
    els.importBox = h(
      'div',
      { class: 'import', hidden: true },
      els.importInput,
      h(
        'div',
        { class: 'finding-actions' },
        h('button', { class: 'btn small primary', onclick: importFindings }, 'Import'),
        h('button', { class: 'btn small quiet', onclick: () => { els.importBox.hidden = true; } }, 'Cancel'),
      ),
    );
    els.search = h('input', { type: 'search', class: 'search', placeholder: 'Filter files…  (Alt+/)', spellcheck: 'false' });
    els.sort = h(
      'select',
      { class: 'sort', title: 'How files are ordered' },
      h('option', { value: 'risk' }, 'Riskiest first'),
      h('option', { value: 'type' }, 'Group by type'),
    );
    els.sort.value = prefs.sort;
    els.hideNoise = h('input', { type: 'checkbox', checked: prefs.hideNoise });
    els.unviewedOnly = h('input', { type: 'checkbox', checked: prefs.unviewedOnly });
    els.noiseCount = h('span', { class: 'muted' });
    els.list = h('div', { class: 'list scroll', role: 'list' });
    els.threadsList = h('div', { class: 'scroll' });
    els.aiView = h('div', { class: 'scroll ai' });
    els.views = {
      files: h(
        'div',
        { class: 'view' },
        h(
          'div',
          { class: 'tools' },
          h('div', { class: 'tools-row' }, els.search, els.sort),
          h(
            'div',
            { class: 'toggles' },
            h('label', null, els.hideNoise, 'Hide generated & lockfiles', els.noiseCount),
            h('label', null, els.unviewedOnly, 'Unviewed only'),
          ),
        ),
        els.list,
      ),
      threads: h('div', { class: 'view' }, els.threadsList),
      code: h('div', { class: 'view' }, els.codeView),
      ai: h('div', { class: 'view' }, els.aiView),
    };
    els.notes = h('textarea', { class: 'notes-input', placeholder: 'Private notes for this PR. Saved in your browser only.' });
    els.notesWrap = h('div', { class: 'notes', hidden: true }, els.notes);
    els.notesBtn = h('button', { class: 'btn', onclick: () => { els.notesWrap.hidden = !els.notesWrap.hidden; if (!els.notesWrap.hidden) els.notes.focus(); } }, 'Notes');
    els.aiBtn = h('button', { class: 'btn', title: 'Copy the PR description and diff with a review prompt, to paste into any AI tool', onclick: copyForAi }, 'Copy for AI');

    els.panel = h(
      'aside',
      { class: 'panel', 'aria-label': 'Review Cockpit' },
      h(
        'header',
        { class: 'hd' },
        h(
          'div',
          { class: 'hd-top' },
          h('span', { class: 'brand' }, h('span', { class: 'brand-mark' }), 'Review Cockpit'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'icon', title: 'Refresh', onclick: () => load() }, '↻'),
          h('button', { class: 'icon', title: 'Hide panel (Alt+R)', onclick: () => setOpen(false) }, '×'),
        ),
        els.summary,
      ),
      h('nav', { class: 'tabs', role: 'tablist' }, Object.values(els.tabs)),
      ...Object.values(els.views),
      els.notesWrap,
      h(
        'footer',
        { class: 'ft' },
        els.aiBtn,
        els.notesBtn,
        h(
          'div',
          { class: 'keys' },
          kbd('Alt'), '+', kbd('J'), '/', kbd('K'), ' move · ',
          kbd('Alt'), '+', kbd('N'), ' next unviewed · ',
          kbd('Alt'), '+', kbd('V'), ' viewed · ',
          kbd('Alt'), '+', kbd('G'), ' definition · ',
          kbd('Alt'), '+', kbd('R'), ' panel',
        ),
      ),
    );
    els.launcher = h('button', { class: 'launcher', title: 'Open Review Cockpit (Alt+R)', onclick: () => setOpen(true) });
    els.toast = h('div', { class: 'toast', role: 'status' });
    shadow.append(els.panel, els.launcher, els.toast);

    els.search.addEventListener('input', () => {
      query = els.search.value;
      renderList();
    });
    els.search.addEventListener('keydown', (e) => {
      if (e.altKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        move(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        const first = visibleFiles()[0];
        if (first) select(first);
      } else if (e.key === 'Escape') {
        els.search.blur();
      }
    });
    els.sort.addEventListener('change', () => {
      prefs.sort = els.sort.value;
      savePrefs();
      renderList();
    });
    els.hideNoise.addEventListener('change', () => {
      prefs.hideNoise = els.hideNoise.checked;
      savePrefs();
      renderList();
    });
    els.unviewedOnly.addEventListener('change', () => {
      prefs.unviewedOnly = els.unviewedOnly.checked;
      savePrefs();
      renderList();
    });
    els.notes.addEventListener('input', saveNotes);
    // Keep GitHub's own single-key shortcuts from firing while typing in the panel.
    els.panel.addEventListener('keydown', (e) => e.stopPropagation());

    document.documentElement.append(el);
    host = el;
  }

  async function mount() {
    buildPromise ||= buildUi();
    await buildPromise;
    host.hidden = !pr;
    applyOpen();
    render();
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  function isEditable(el) {
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  document.addEventListener(
    'keydown',
    (e) => {
      // AltGr on Windows reports ctrl+alt; leave it alone so people can type accented characters.
      if (!pr || !host || !e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.composedPath()[0];
      if (isEditable(target) && target !== els.search) return;

      const actions = {
        KeyR: () => setOpen(!prefs.open),
        KeyJ: () => move(1),
        KeyK: () => move(-1),
        KeyN: nextUnviewed,
        KeyV: () => {
          const f = cursorFile();
          if (f && data) toggleViewed(f, { advance: true });
          else toast('Pick a file first (Alt+J)');
        },
        Slash: () => {
          setOpen(true);
          setTab('files');
          els.search.focus();
          els.search.select();
        },
        KeyG: () => {
          const symbol = RC.extractIdentifier(String(window.getSelection() || ''));
          setOpen(true);
          setTab('code');
          if (symbol) lookup(symbol);
          else {
            els.symbol.focus();
            toast('Select a function or type name in the diff, then press Alt+G.');
          }
        },
      };
      const action = actions[e.code];
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      action();
    },
    true,
  );

  // -------------------------------------------------------------------------
  // Navigation (GitHub is a Turbo/React SPA, so watch the URL ourselves)
  // -------------------------------------------------------------------------

  function onLocationChange() {
    const next = RC.parsePullUrl(location.pathname);
    if (!next) {
      pr = null;
      if (host) host.hidden = true;
      applyOpen();
      return;
    }
    const key = `${next.owner}/${next.repo}#${next.number}`;
    if (pr?.key !== key) {
      pr = { ...next, key };
      data = null;
      files = [];
      cursorPath = null;
      since = null;
      error = null;
      ai = newAiState();
      code = newCodeState();
      diffCache = null;
      if (host) els.symbol.value = '';
      const target = pr;
      mount().then(() => {
        loadNotes();
        loadAi(target);
      });
      load();
    } else if (Date.now() - fetchedAt > 30_000) {
      load(); // switching tabs within the same PR: pick up new pushes / viewed state
    }
  }

  let lastUrl = location.href.split('#')[0];
  setInterval(() => {
    const url = location.href.split('#')[0];
    if (url !== lastUrl) {
      lastUrl = url;
      onLocationChange();
    }
  }, 400);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.prefs?.newValue) Object.assign(prefs, changes.prefs.newValue);
    if (changes.token && pr) load();
    if ((changes.anthropicKey || changes.aiModel) && pr) {
      send('aiStatus')
        .then((status) => {
          ai.status = status;
          renderAi();
        })
        .catch(() => {});
    }
  });

  chrome.storage.local
    .get('prefs')
    .then(({ prefs: stored }) => Object.assign(prefs, stored))
    .catch(() => {})
    .finally(onLocationChange);
})();
