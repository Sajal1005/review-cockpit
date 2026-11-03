/*
 * Review Cockpit — background service worker.
 * The only place that talks to api.github.com; the token never leaves this worker except in
 * requests to GitHub.
 */
const API = 'https://api.github.com';
const QUEUE_ALARM = 'refresh-queue';
const SHA = /^[0-9a-f]{7,40}$/i;

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function getToken() {
  const { token } = await chrome.storage.local.get('token');
  return token || null;
}

async function request(path, { method = 'GET', body, accept = 'application/vnd.github+json', token } = {}) {
  token = token || (await getToken());
  if (!token) throw new ApiError('No GitHub token configured.', 'NO_TOKEN');

  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError('GitHub rejected your token. It may have expired or been revoked.', 'BAD_TOKEN', 401);
    }
    let message = `GitHub API error ${res.status}`;
    try {
      message = (await res.json()).message || message;
    } catch {}
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      message = 'GitHub API rate limit reached. Try again in a few minutes.';
    }
    throw new ApiError(message, 'HTTP', res.status);
  }
  return res;
}

async function graphql(query, variables = {}, token) {
  const res = await request('/graphql', { method: 'POST', body: { query, variables }, token });
  const json = await res.json();
  if (json.errors?.length) throw new ApiError(json.errors.map((e) => e.message).join('\n'), 'GRAPHQL');
  return json.data;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Pull request data for the in-page panel
// ---------------------------------------------------------------------------

const FILES = `
  pageInfo { hasNextPage endCursor }
  nodes { path additions deletions changeType viewerViewedState }`;

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title body url state isDraft additions deletions
      headRefName baseRefName headRefOid
      author { login }
      reviews(last: 100) { nodes { author { login } state submittedAt commit { oid } } }
      files(first: 100) { ${FILES} }
    }
  }
}`;

const FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { files(first: 100, after: $cursor) { ${FILES} } }
  }
}`;

async function getPullRequest({ owner, repo, number }) {
  const vars = { owner, name: repo, number: Number(number) };
  const data = await graphql(PR_QUERY, vars);
  const pr = data.repository?.pullRequest;
  if (!pr) {
    throw new ApiError(`${owner}/${repo}#${number} was not found or your token can't access it.`, 'NOT_FOUND');
  }

  const files = [...pr.files.nodes];
  let page = pr.files.pageInfo;
  // GitHub caps PRs at 3,000 files; 40 pages of 100 is a safe upper bound.
  for (let i = 0; page.hasNextPage && i < 40; i++) {
    const next = (await graphql(FILES_QUERY, { ...vars, cursor: page.endCursor })).repository.pullRequest.files;
    files.push(...next.nodes);
    page = next.pageInfo;
  }

  const login = data.viewer.login;
  const lastReview = pr.reviews.nodes
    .filter((r) => r.author?.login === login && r.state !== 'PENDING' && r.commit)
    .at(-1);

  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    author: pr.author?.login ?? 'ghost',
    viewer: login,
    lastReview: lastReview
      ? { oid: lastReview.commit.oid, submittedAt: lastReview.submittedAt, state: lastReview.state }
      : null,
    files,
  };
}

const MARK_VIEWED = `mutation($id: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}`;
const UNMARK_VIEWED = `mutation($id: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId }
}`;

async function setViewed({ pullRequestId, path, viewed }) {
  await graphql(viewed ? MARK_VIEWED : UNMARK_VIEWED, { id: pullRequestId, path });
}

// Paths touched between two commits, used to flag files that changed since your last review.
async function changedFiles({ owner, repo, base, head }) {
  if (!SHA.test(base) || !SHA.test(head)) throw new ApiError('Invalid commit SHA.', 'BAD_INPUT');
  const res = await request(`/repos/${enc(owner)}/${enc(repo)}/compare/${base}...${head}`);
  const json = await res.json();
  const paths = new Set();
  for (const f of json.files || []) {
    paths.add(f.filename);
    if (f.previous_filename) paths.add(f.previous_filename);
  }
  return [...paths];
}

async function getDiff({ owner, repo, number }) {
  const res = await request(`/repos/${enc(owner)}/${enc(repo)}/pulls/${Number(number)}`, {
    accept: 'application/vnd.github.diff',
  });
  return res.text();
}

// ---------------------------------------------------------------------------
// Review queue for the toolbar popup + badge
// ---------------------------------------------------------------------------

const QUEUE_QUERY = `query($requested: String!, $reviewed: String!, $mine: String!, $login: String!) {
  requested: search(query: $requested, type: ISSUE, first: 30) { nodes { ...card } }
  reviewed: search(query: $reviewed, type: ISSUE, first: 30) {
    nodes {
      ...card
      ... on PullRequest { reviews(author: $login, last: 1) { nodes { submittedAt commit { oid } } } }
    }
  }
  mine: search(query: $mine, type: ISSUE, first: 30) { nodes { ...card } }
}
fragment card on PullRequest {
  id number title url isDraft updatedAt additions deletions headRefOid reviewDecision
  repository { nameWithOwner }
  author { login avatarUrl(size: 40) }
}`;

function toCard(n) {
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    isDraft: n.isDraft,
    updatedAt: n.updatedAt,
    additions: n.additions,
    deletions: n.deletions,
    reviewDecision: n.reviewDecision,
    repo: n.repository.nameWithOwner,
    author: n.author?.login ?? 'ghost',
    avatar: n.author?.avatarUrl ?? null,
  };
}

async function getQueue() {
  const { viewer } = await graphql('query { viewer { login } }');
  const login = viewer.login;
  const base = 'is:open is:pr archived:false sort:updated-desc';
  const d = await graphql(QUEUE_QUERY, {
    login,
    requested: `${base} review-requested:${login}`,
    reviewed: `${base} reviewed-by:${login} -author:${login}`,
    mine: `${base} author:${login}`,
  });

  const requested = d.requested.nodes.filter((n) => n.id).map(toCard);
  const requestedUrls = new Set(requested.map((p) => p.url));

  // PRs you already reviewed that got new commits since, and aren't re-requested yet.
  const updated = d.reviewed.nodes
    .filter((n) => n.id && !requestedUrls.has(n.url))
    .flatMap((n) => {
      const last = n.reviews?.nodes?.[0];
      if (!last?.commit || last.commit.oid === n.headRefOid) return [];
      return [{ ...toCard(n), reviewedAt: last.submittedAt, sinceUrl: `${n.url}/files/${last.commit.oid}..${n.headRefOid}` }];
    });

  const mine = d.mine.nodes.filter((n) => n.id).map(toCard);

  const queue = { login, requested, updated, mine, fetchedAt: Date.now() };
  await chrome.storage.local.set({ queueCache: queue });
  setBadge(requested.length + updated.length);
  return queue;
}

function setBadge(count) {
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#8250df' });
}

function refreshBadge() {
  getQueue().catch(() => setBadge(0));
}

async function validateToken({ token }) {
  const res = await request('/user', { token });
  const user = await res.json();
  return { login: user.login, scopes: res.headers.get('x-oauth-scopes') };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const handlers = {
  getPullRequest,
  setViewed,
  changedFiles,
  getDiff,
  getQueue,
  validateToken,
  openOptions: () => chrome.runtime.openOptionsPage(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message, code: err.code || 'ERROR' }),
    );
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 5 });
  if (reason === 'install') chrome.runtime.openOptionsPage();
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 5 });
  refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) refreshBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'token' in changes) refreshBadge();
});
