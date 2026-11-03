/*
 * Review Cockpit — browser-only helpers shared by the panel, popup, and options page.
 */
(function (root) {
  'use strict';

  const RC = (root.ReviewCockpit = root.ReviewCockpit || {});

  // Tiny hyperscript helper. Children are appended as text nodes, never parsed as HTML,
  // so user-controlled strings (PR titles, paths, etc.) are always safe to pass in.
  RC.h = function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'value') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  };

  RC.timeAgo = function timeAgo(iso) {
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
    if (seconds < 60) return 'just now';
    let unit = 'm';
    let size = 60;
    for (const [u, s] of [['h', 3600], ['d', 86400], ['mo', 2592000], ['y', 31536000]]) {
      if (seconds >= s) [unit, size] = [u, s];
    }
    return `${Math.floor(seconds / size)}${unit} ago`;
  };

  // Sends a message to the background worker and unwraps { ok, data | error }.
  RC.send = function send(type, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ ...payload, type }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('No response from Review Cockpit.'));
          if (!res.ok) return reject(Object.assign(new Error(res.error), { code: res.code }));
          resolve(res.data);
        });
      } catch {
        reject(Object.assign(new Error('Review Cockpit was updated. Reload this page.'), { code: 'STALE' }));
      }
    });
  };
})(globalThis);
