/* Review Cockpit — settings page: token setup + preferences. */
(() => {
  'use strict';
  const { send } = ReviewCockpit;
  const $ = (id) => document.getElementById(id);
  const tokenInput = $('token');
  const status = $('status');

  function setStatus(message, tone = '') {
    status.textContent = message;
    status.className = `status ${tone}`;
  }

  async function showConnected() {
    const { token, login } = await chrome.storage.local.get(['token', 'login']);
    $('remove').hidden = !token;
    tokenInput.placeholder = token ? '•••••••• (saved, paste a new one to replace it)' : 'ghp_… or github_pat_…';
    if (token) setStatus(`Connected as @${login}.`, 'ok');
  }

  $('token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) return setStatus('Paste a token first.', 'err');
    $('save').disabled = true;
    setStatus('Verifying with GitHub…');
    try {
      const { login, scopes } = await send('validateToken', { token });
      await chrome.storage.local.set({ token, login });
      tokenInput.value = '';
      await showConnected();
      // Classic tokens report their scopes; fine-grained tokens don't (scopes === null).
      if (scopes !== null && !scopes.split(/,\s*/).includes('repo')) {
        setStatus(`Connected as @${login}, but this token lacks the "repo" scope, so private repos and Viewed sync won't work.`, 'warn');
      }
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      $('save').disabled = false;
    }
  });

  $('remove').addEventListener('click', async () => {
    await chrome.storage.local.remove(['token', 'login', 'queueCache']);
    setStatus('Token removed.');
    showConnected();
  });

  $('autoAdvance').addEventListener('change', async (e) => {
    const { prefs = {} } = await chrome.storage.local.get('prefs');
    await chrome.storage.local.set({ prefs: { ...prefs, autoAdvance: e.target.checked } });
  });

  chrome.storage.local.get('prefs').then(({ prefs = {} }) => {
    $('autoAdvance').checked = prefs.autoAdvance !== false;
  });
  showConnected();
})();
