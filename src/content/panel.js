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

  const prefs = { open: true, hideNoise: true, unviewedOnly: false, autoAdvance: true };

  let pr = null; // { owner, repo, number, key } for the PR on screen
  let data = null; // payload from the background worker
  let files = []; // sorted + enriched with category / anchor
  let cursorPath = null; // file the keyboard cursor is on
  let since = null; // { from, to, at, paths: Set | null } when there are commits after your last review
  let error = null;
  let fetchedAt = 0;
  let query = '';

  let host = null;
  let buildPromise = null;
  const els = {};

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

  function isChanged(f) {
    return f.viewedState === 'DISMISSED' || !!since?.paths?.has(f.path);
  }

  function visibleFiles() {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return files.filter(
      (f) =>
        !(prefs.hideNoise && f.noise) &&
        !(prefs.unviewedOnly && f.viewedState === 'VIEWED') &&
        terms.every((t) => f.path.toLowerCase().includes(t)),
    );
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function openFile(f) {
    if (!/\/pull\/\d+\/(files|changes)\b/.test(location.pathname)) {
      location.assign(`/${pr.owner}/${pr.repo}/pull/${pr.number}/files#${f.anchor}`);
      return;
    }
    const el =
      document.getElementById(f.anchor) ||
      document.querySelector(`[data-tagsearch-path="${CSS.escape(f.path)}"]`);
    if (el) {
      el.style.scrollMarginTop = '96px'; // clear GitHub's sticky header
      el.scrollIntoView({ block: 'start' });
      history.replaceState(history.state, '', `#${f.anchor}`);
    } else {
      location.hash = f.anchor; // let GitHub lazy-load and scroll to it
    }
  }

  function select(f) {
    cursorPath = f.path;
    renderList();
    openFile(f);
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
        toast(`Copied (${tokens}). Paste it into your AI agent.${removed.length ? ` Left out ${removed.length} generated/lock files.` : ''}`);
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
    renderList();
    renderLauncher();
  }

  function renderSummary() {
    const box = els.summary;
    if (error) return box.replaceChildren(errorCard(error));
    if (!data) return box.replaceChildren(h('div', { class: 'muted' }, 'Loading pull request…'));

    const viewed = files.filter((f) => f.viewedState === 'VIEWED').length;
    const pct = files.length ? (viewed / files.length) * 100 : 0;
    box.replaceChildren(
      h('div', { class: 'title', title: data.title }, h('span', { class: 'num' }, `#${data.number} `), data.title),
      h('div', { class: 'meta' }, `@${data.author} · ${data.headRefName} → ${data.baseRefName}`),
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

  function renderList() {
    if (!host) return;
    const list = visibleFiles();
    const noise = files.filter((f) => f.noise).length;
    els.noiseCount.textContent = noise ? ` (${noise})` : '';

    const rows = [];
    if (data && !list.length) {
      rows.push(h('div', { class: 'empty' }, files.length ? 'No files match your filters.' : 'No files changed.'));
    }
    for (const cat of RC.CATEGORIES) {
      const group = list.filter((f) => f.category === cat.id);
      if (!group.length) continue;
      const viewed = group.filter((f) => f.viewedState === 'VIEWED').length;
      rows.push(h('div', { class: 'group' }, h('span', null, cat.label), h('span', null, `${viewed}/${group.length}`)));
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
    return h(
      'div',
      {
        class: ['file', viewed && 'viewed', f.path === cursorPath && 'cursor'].filter(Boolean).join(' '),
        title: f.path,
        onclick: () => select(f),
      },
      checkbox,
      h(
        'span',
        { class: 'path' },
        slash >= 0 ? h('span', { class: 'dir' }, f.path.slice(0, slash + 1)) : null,
        h('span', { class: 'name' }, f.path.slice(slash + 1)),
      ),
      isChanged(f) && !viewed ? h('span', { class: 'dot', title: 'Changed since you last viewed or reviewed it' }) : null,
      h('span', { class: `ct ct-${f.changeType.toLowerCase()}`, title: f.changeType.toLowerCase() }, CHANGE_LETTER[f.changeType] || 'M'),
      h('span', { class: 'stat' }, h('span', { class: 'add' }, `+${f.additions}`), ' ', h('span', { class: 'del' }, `−${f.deletions}`)),
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
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3000);
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
    els.root = shadow;
    els.summary = h('div', { class: 'summary' });
    els.search = h('input', { type: 'search', class: 'search', placeholder: 'Filter files…  (Alt+/)', spellcheck: 'false' });
    els.hideNoise = h('input', { type: 'checkbox', checked: prefs.hideNoise });
    els.unviewedOnly = h('input', { type: 'checkbox', checked: prefs.unviewedOnly });
    els.noiseCount = h('span', { class: 'muted' });
    els.list = h('div', { class: 'list', role: 'list' });
    els.notes = h('textarea', { class: 'notes-input', placeholder: 'Private notes for this PR. Saved in your browser only.' });
    els.notesWrap = h('div', { class: 'notes', hidden: true }, els.notes);
    els.notesBtn = h('button', { class: 'btn', onclick: () => { els.notesWrap.hidden = !els.notesWrap.hidden; if (!els.notesWrap.hidden) els.notes.focus(); } }, 'Notes');
    els.aiBtn = h('button', { class: 'btn', title: 'Copy the PR description and diff with a review prompt', onclick: copyForAi }, 'Copy for AI review');

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
      h(
        'div',
        { class: 'tools' },
        els.search,
        h(
          'div',
          { class: 'toggles' },
          h('label', null, els.hideNoise, 'Hide generated & lockfiles', els.noiseCount),
          h('label', null, els.unviewedOnly, 'Unviewed only'),
        ),
      ),
      els.list,
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
          els.search.focus();
          els.search.select();
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
      mount().then(loadNotes);
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
  });

  chrome.storage.local
    .get('prefs')
    .then(({ prefs: stored }) => Object.assign(prefs, stored))
    .catch(() => {})
    .finally(onLocationChange);
})();
