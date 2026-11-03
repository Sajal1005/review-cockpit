/* Review Cockpit — toolbar popup: everything waiting on you, across all repos. */
(() => {
  'use strict';
  const { h, send, timeAgo } = ReviewCockpit;
  const app = document.getElementById('app');

  const DECISION = {
    APPROVED: ['Approved', 'success'],
    CHANGES_REQUESTED: ['Changes requested', 'danger'],
    REVIEW_REQUIRED: ['Awaiting review', 'attention'],
  };

  function sizeLabel(lines) {
    if (lines < 10) return 'XS';
    if (lines < 100) return 'S';
    if (lines < 500) return 'M';
    if (lines < 1000) return 'L';
    return 'XL';
  }

  function row(p, { href = p.url, note, chip } = {}) {
    return h(
      'a',
      { class: 'pr', href, target: '_blank', rel: 'noopener', title: p.title },
      p.avatar ? h('img', { class: 'avatar', src: p.avatar, alt: '' }) : h('span', { class: 'avatar' }),
      h(
        'div',
        { class: 'pr-main' },
        h('div', { class: 'pr-title' }, p.isDraft ? h('span', { class: 'chip' }, 'Draft') : null, p.title),
        h('div', { class: 'pr-meta' }, note || `${p.repo}#${p.number} · @${p.author} · updated ${timeAgo(p.updatedAt)}`),
      ),
      h(
        'div',
        { class: 'pr-side' },
        chip || h('span', { class: 'chip', title: `${p.additions + p.deletions} lines changed` }, sizeLabel(p.additions + p.deletions)),
        h('span', null, h('span', { class: 'add' }, `+${p.additions}`), ' ', h('span', { class: 'del' }, `−${p.deletions}`)),
      ),
    );
  }

  function section(title, items, empty) {
    return [
      h('div', { class: 'section-hd' }, title, h('span', { class: 'count' }, items.length)),
      ...(items.length ? items : [h('div', { class: 'empty' }, empty)]),
    ];
  }

  function render(queue, stale = false) {
    document.getElementById('who').textContent = `@${queue.login}`;
    app.classList.toggle('stale', stale);
    app.replaceChildren(
      ...section('Needs your review', queue.requested.map((p) => row(p)), 'Nothing waiting on you. 🎉'),
      ...section(
        'Updated since you reviewed',
        queue.updated.map((p) =>
          row(p, {
            href: p.sinceUrl,
            note: `${p.repo}#${p.number} · you reviewed ${timeAgo(p.reviewedAt)} · opens only the new changes`,
          }),
        ),
        'No new pushes on PRs you reviewed.',
      ),
      ...section(
        'Your open PRs',
        queue.mine.map((p) => {
          const [label, tone] = DECISION[p.reviewDecision] || [];
          return row(p, { chip: label ? h('span', { class: `chip ${tone}` }, label) : null });
        }),
        'You have no open pull requests.',
      ),
    );
  }

  function renderSetup() {
    app.replaceChildren(
      h(
        'div',
        { class: 'setup' },
        h('h2', null, 'Connect GitHub to see your review queue'),
        h('p', null, 'Add a personal access token. It stays in this browser and is only ever sent to api.github.com.'),
        h('div', null, h('button', { class: 'btn primary', onclick: () => chrome.runtime.openOptionsPage() }, 'Set up token')),
      ),
    );
  }

  async function refresh() {
    const { token, queueCache } = await chrome.storage.local.get(['token', 'queueCache']);
    if (!token) return renderSetup();
    if (queueCache) render(queueCache, true);
    else app.replaceChildren(h('div', { class: 'empty' }, 'Loading your review queue…'));
    try {
      render(await send('getQueue'));
    } catch (err) {
      app.classList.remove('stale');
      app.prepend(h('div', { class: 'error' }, err.message));
    }
  }

  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  refresh();
})();
