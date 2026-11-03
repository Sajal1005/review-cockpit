<p align="center">
  <img src="icons/icon128.png" width="72" height="72" alt="" />
</p>

<h1 align="center">Review Cockpit for GitHub</h1>

<p align="center">
  <strong>A faster, keyboard-first pull request review experience, layered on top of GitHub.</strong><br />
  Less context switching. Know exactly what changed since you last looked. Hand the diff to your AI agent in one click.
</p>

---

## Why

Code review changed. More of the code is written by AI agents, we juggle many PRs at once, and we
review in the browser instead of checking branches out locally. GitHub's review UI hasn't kept up:

- In a 60-file PR it's hard to see which files matter, which are lockfile or generated noise, and which you've already looked at.
- When the author pushes again, you have to work out what changed since *your* review.
- Getting a PR into an AI agent for a first pass means copying, cleaning, and pasting by hand.
- Everything waiting on you is spread across notifications, emails, and tabs.

Review Cockpit is a Chrome extension that adds a review panel to every pull request page and a
review queue to your toolbar.

## Features

### On every pull request

| | |
|---|---|
| **Smart file list** | Files grouped into *Source → Tests → Config → Docs → Generated → Lockfiles*, with additions and deletions for each file. Noise (lockfiles, `dist/`, `*.pb.go`, snapshots, …) is hidden by default. |
| **Real "Viewed" sync** | Checking a file uses GitHub's own *Viewed* state through the API, so it carries across devices and the GitHub UI. |
| **"Changed since you looked"** | Files that changed after you marked them viewed, or after your last review, get a dot. A banner links straight to **only the new commits since your review**. |
| **Keyboard-first** | `Alt+J/K` next/prev file · `Alt+N` next unviewed · `Alt+V` toggle viewed and advance · `Alt+/` filter · `Alt+R` toggle panel. |
| **Copy for AI review** | Copies a ready-to-paste prompt (PR title, description, and diff) with lockfiles and generated files removed to save tokens. Paste it into Claude, ChatGPT, Cursor, or your own agent. |
| **Private notes** | A scratchpad for each PR, kept in your browser, for drafting your review while you read. |
| **Native look** | Uses GitHub's own color variables, so light, dark, and high-contrast themes match automatically. |

### In the toolbar popup

- **Needs your review**: open PRs where your review is requested, with size labels (XS–XL).
- **Updated since you reviewed**: PRs that got new commits after your review. One click opens *only those new changes*.
- **Your open PRs**: with approval or changes-requested status.
- A badge count on the icon, refreshed every 5 minutes.

## Install (from source)

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, and click **Load unpacked**. Select the repo folder.
3. The settings page opens. Add a GitHub token:
   - **Quickest:** a [classic token with the `repo` scope](https://github.com/settings/tokens/new?scopes=repo&description=Review%20Cockpit).
   - **Least privilege:** a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with *Pull requests: Read and write* and *Contents: Read*.
   - If your org uses SAML SSO, authorize the token for that org.
4. Open any pull request on github.com.

It works in any Chromium browser (Chrome, Edge, Brave, Arc).

## Privacy and security

- The token is stored in `chrome.storage.local` and is **only ever sent to `api.github.com`**, by the background worker.
- There's no server and no analytics. The extension requests access to `github.com` pages and `api.github.com` only.
- All user content (titles, paths, descriptions) is rendered as text, never as HTML.
- "Copy for AI review" only copies to *your* clipboard. Nothing is sent to an AI provider by the extension.

## How it works

```
manifest.json
src/
  background.js        Service worker: all GitHub API calls (GraphQL + REST), review queue, badge
  content/panel.js     The in-page panel (shadow DOM), keyboard shortcuts, SPA navigation handling
  content/panel.css    Panel styles, built on GitHub's Primer CSS variables
  content/page.css     Makes room for the panel on wide screens
  popup/               Toolbar review queue
  options/             Token setup and preferences
  shared/core.js       Pure logic: file classification, URL parsing, diff splitting, AI prompt (unit-tested)
  shared/ext.js        Browser helpers: tiny DOM builder, messaging, relative time
tests/                 node:test unit tests for shared/core.js
scripts/make_icons.py  Regenerates the icons (Python standard library only)
```

Design choices:

- **API over DOM scraping.** GitHub's markup changes often. File lists, viewed state, and review history come from the GraphQL API. The extension touches the page DOM only to scroll to a file (`#diff-<sha256(path)>`, which GitHub itself uses).
- **No build step, no dependencies.** Plain JavaScript loaded by Chrome. Clone, load, and edit. This keeps contributing easy.
- **Shadow DOM, mounted on `<html>`.** GitHub's CSS can't leak in, and Turbo navigations, which replace `<body>`, don't remove the panel.

## Development

```bash
npm test          # unit tests (Node 20+, no install needed)
npm run icons     # regenerate icons/
```

After editing, click **Reload** on the extension in `chrome://extensions` and refresh the GitHub tab.

## Roadmap

Ideas, roughly in priority order. PRs welcome.

- [ ] Sync the on-page *Viewed* checkboxes live (they currently update when you reload the page)
- [ ] Review the files that changed since your last review as one combined view
- [ ] AI review inside the panel (bring your own API key), with findings posted as *pending* review comments
- [ ] "Explain this hunk" on any diff selection
- [ ] Risk hints: touches auth, migrations, or public APIs; large functions; missing tests for changed source
- [ ] Custom noise rules for each repo
- [ ] Firefox port
- [ ] Chrome Web Store release

## Contributing

1. Fork the repo and create a branch.
2. Keep it dependency-free, and add tests for anything in `src/shared/core.js`.
3. Run `npm test`, then try the change on a real PR. Large PRs (100+ files) and dark mode are good stress tests.
4. Open a PR with a screenshot or GIF of the UI change.

## License

[MIT](LICENSE)
