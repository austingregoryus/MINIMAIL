'use strict';
const api = window.minimail;

const root = document.getElementById('accounts');
const addBtn = document.getElementById('add');
const collapseBtn = document.getElementById('collapse');
const accountText = document.getElementById('account');
const unreadChip = document.getElementById('unread');
const accountButtons = new Map();

function tooltip(a, index) {
  const who = /@/.test(a.label) ? `${a.label} (${a.providerName})` : `${a.providerName} account`;
  const shortcut = `(Ctrl+${index + 1})`;
  if (a.loadFailed) return `${who} — could not load, select to retry ${shortcut}`;
  if (a.loading) return `${who} — loading… ${shortcut}`;
  const unread = a.showCount !== false && (a.count || a.countStale)
    ? ` — ${a.count.toLocaleString('en-US')} unread${a.countStale ? ' (last known count)' : ''}` : '';
  if (a.asleep) return `${who}${unread} — select to load ${shortcut}`;
  return `${who}${unread} ${shortcut}`;
}

const OUTLINE = /^[MmZzLlHhVvCcSsQqTtAaEe][MmZzLlHhVvCcSsQqTtAaEe0-9.,\s+-]*$/;

// The service's outline as an inline <svg>, or null if it has none (or what
// arrived is not an outline made of drawing commands alone).
function providerSvg(a, className) {
  if (typeof a.mark !== 'string' || !OUTLINE.test(a.mark)) return null;
  const span = document.createElement('span');
  span.innerHTML = `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="${a.mark}"/></svg>`;
  return span.firstChild;
}

// Which service the account is on: a small badge on the avatar's lower-left
// corner, in the service's colour. Services without an outline show their initial.
function providerBadge(a) {
  const badge = document.createElement('span');
  badge.className = 'provider';
  badge.style.background = a.providerColor;
  const svg = providerSvg(a, '');
  if (svg) badge.appendChild(svg);
  else badge.textContent = (a.providerName || '?')[0].toUpperCase();
  return badge;
}

const collapsedChevron =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

const muteBtn = document.getElementById('mute');
const speakerBody = '<path fill="currentColor" d="M11 4.9 6.6 8.6H4a1 1 0 0 0-1 1v4.8a1 1 0 0 0 1 1h2.6L11 19.1a1 1 0 0 0 1.6-.8V5.7A1 1 0 0 0 11 4.9Z"/>';
const speakerOn = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">${speakerBody}<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M15.4 9a4.4 4.4 0 0 1 0 6M18 6.6a8 8 0 0 1 0 10.8"/></svg>`;
const speakerOff = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">${speakerBody}<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m15.2 9.6 4.8 4.8m0-4.8-4.8 4.8"/></svg>`;

let mutedUntil = 0; // when the global mute ends (ms); 0 = not muted
let muteTick = null;
const OPEN_ENDED = 1e12; // further away than any timed mute gets (about 31 years)

function remainingLabel(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function showMute() {
  const left = mutedUntil - Date.now();
  const muted = left > 0;
  muteBtn.classList.toggle('muted', muted);
  muteBtn.innerHTML = muted ? speakerOff : speakerOn;
  muteBtn.title = !muted
    ? 'Mute all notifications for a while'
    : left > OPEN_ENDED
      ? 'Notifications muted until you turn them back on'
      : `Notifications muted — ${remainingLabel(left)} left`;
  // With the sidebar collapsed the speaker is out of sight: say so on the strip instead.
  if (document.body.classList.contains('collapsed')) collapseBtn.title += muted ? ' — notifications muted' : '';
  // The remaining time in the tooltip has to keep counting down.
  clearTimeout(muteTick);
  muteTick = null;
  if (muted && left <= OPEN_ENDED) muteTick = setTimeout(showMute, Math.min(60000, Math.max(1000, left - Math.floor(left / 60000) * 60000 || 60000)));
}

// Clicking the speaker opens the mute menu beside it (it may also be reached by keyboard).
muteBtn.addEventListener('click', () => {
  const r = muteBtn.getBoundingClientRect();
  api.muteMenu(Math.round(r.right - 4), Math.round(r.top));
});

let rendered = '';

function render(state) {
  // Counts change all the time; an identical state must not rebuild the avatars.
  const json = JSON.stringify(state);
  if (json === rendered) return;
  rendered = json;

  const accounts = state.accounts || [];
  const prefs = state.prefs || {};
  const ids = new Set(accounts.map((account) => account.id));
  let restoreFocus = false;
  for (const [id, button] of accountButtons) {
    if (ids.has(id)) continue;
    restoreFocus ||= button === document.activeElement;
    button.remove();
    accountButtons.delete(id);
  }
  accounts.forEach((a, i) => {
    let b = accountButtons.get(a.id);
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.addEventListener('click', () => api.switchTo(a.id));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        api.menu(a.id, e.clientX, e.clientY);
      });
      accountButtons.set(a.id, b);
    }
    if (root.children[i] !== b) root.insertBefore(b, root.children[i] || null);
    b.replaceChildren();
    b.className = 'acct' + (a.active ? ' active' : '') + (a.asleep ? ' asleep' : '') + (a.loading ? ' loading' : '');
    b.style.background = a.color;
    if (a.avatar) {
      const img = document.createElement('img');
      img.src = a.avatar;
      img.alt = '';
      img.draggable = false;
      b.appendChild(img);
    } else if (/@/.test(a.label || '')) {
      b.textContent = a.label[0].toUpperCase(); // address known, no photo: its initial
    } else {
      // Neither photo nor address yet (the label is the service's name): the avatar
      // itself is the service's mark, or its initial where it has none.
      const mark = providerSvg(a, 'mark');
      if (mark) b.appendChild(mark);
      else b.textContent = (a.label || '?')[0].toUpperCase();
    }
    b.title = tooltip(a, i);
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(a.active));
    // The badge says which service this is. It would only repeat the avatar
    // when that already shows the service's mark or initial.
    if (a.avatar || /@/.test(a.label || '')) b.appendChild(providerBadge(a));
    if (a.showCount !== false && (a.count || a.countStale)) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = `${a.countStale ? '~' : ''}${a.count > 99 ? '99+' : a.count}`;
      b.appendChild(dot);
    }
  });
  if (restoreFocus) (accountButtons.get(accounts.find((a) => a.active)?.id) || addBtn).focus();

  const empty = accounts.length === 0;
  addBtn.classList.toggle('pulse', empty);
  document.body.classList.toggle('empty', empty);

  const collapsed = prefs.sidebarCollapsed === true;
  document.body.classList.toggle('collapsed', collapsed);
  collapseBtn.innerHTML = collapsed ? collapsedChevron : '\u2039';
  collapseBtn.title = `${collapsed ? 'Show' : 'Hide'} sidebar (Ctrl+Shift+B in Minimail controls)`;

  mutedUntil = Number(prefs.mutedUntil) || 0;
  showMute();

  const active = accounts.find((a) => a.active);
  const total = accounts.reduce((sum, a) => sum + a.count, 0);
  const stale = accounts.some((a) => a.countStale);
  // Logo and wordmark are always there; the account and the unread total follow.
  const named = active && /@/.test(active.label) ? active.label : '';
  accountText.textContent = named;
  accountText.title = named;
  accountText.hidden = !named;
  unreadChip.textContent = total || stale ? `${stale ? '~' : ''}${total.toLocaleString('en-US')}` : '';
  unreadChip.title = total || stale ? `${total.toLocaleString('en-US')} unread${stale ? ' (includes last known counts)' : ''}` : '';
  unreadChip.hidden = !total && !stale;
}

// The "which mail service?" menu opens where the button was clicked. A click
// from the keyboard has no coordinates, so the button's centre is used.
function addAccount(e, button) {
  const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : (() => {
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom };
  })();
  api.add(Math.round(at.x), Math.round(at.y));
}
addBtn.addEventListener('click', (e) => addAccount(e, addBtn));
document.getElementById('settings').addEventListener('click', () => api.openSettings());
collapseBtn.addEventListener('click', () => api.toggleSidebar());
const welcomeAdd = document.getElementById('welcome-add');
welcomeAdd.addEventListener('click', (e) => addAccount(e, welcomeAdd));

// Download toast: slides into the title bar when a file finishes downloading.
const dlToast = document.getElementById('dl-toast');
const dlFile = document.getElementById('dl-file');
const dlOpen = document.getElementById('dl-open');
const dlFolder = document.getElementById('dl-folder');
let dlQueue = [];
let dlHideTimer = null;
let dlReturnFocus = null;

const hideToast = () => {
  clearTimeout(dlHideTimer);
  if (dlToast.contains(document.activeElement)) (dlReturnFocus?.isConnected ? dlReturnFocus : addBtn).focus();
  dlToast.inert = true;
  dlToast.classList.remove('show');
  dlQueue = [];
};

const hideToastSoon = () => {
  clearTimeout(dlHideTimer);
  if (!dlToast.contains(document.activeElement)) dlHideTimer = setTimeout(hideToast, 10000);
};

function handleDownload(dl) {
  // The same download can arrive twice (push event and the startup catch-up).
  if (!dl || (!dl.path && !dl.failed) || (dl.id && dlQueue.at(-1)?.id === dl.id)) return;
  dlQueue.push(dl);
  if (dlQueue.length > 5) dlQueue = dlQueue.slice(-5);
  const last = dlQueue[dlQueue.length - 1];
  dlFile.textContent = last.failed ? `Download failed: ${last.file}` : dlQueue.length > 1 ? `${last.file} (+${dlQueue.length - 1} more)` : last.file;
  dlFile.title = last.path || '';
  if (last.failed && [dlOpen, dlFolder].includes(document.activeElement)) document.getElementById('dl-close').focus();
  dlOpen.hidden = dlFolder.hidden = last.failed === true;
  if (dlToast.inert) dlReturnFocus = document.activeElement === document.body ? null : document.activeElement;
  dlToast.inert = false;
  dlToast.classList.add('show');
  hideToastSoon();
}

dlToast.addEventListener('mouseenter', () => clearTimeout(dlHideTimer)); // don't vanish under the cursor
dlToast.addEventListener('mouseleave', hideToastSoon);
dlToast.addEventListener('focusin', (e) => {
  if (!dlToast.contains(e.relatedTarget)) dlReturnFocus = e.relatedTarget;
  clearTimeout(dlHideTimer);
});
dlToast.addEventListener('focusout', () => setTimeout(hideToastSoon));
document.getElementById('dl-close').addEventListener('click', hideToast);
dlOpen.addEventListener('click', async () => {
  const last = dlQueue.at(-1);
  if (!last?.path) return;
  const error = await api.openFile(last.path).catch(() => true);
  if (dlQueue.at(-1) !== last) return;
  if (!error && error !== undefined) return hideToast();
  dlFile.textContent = `Could not open ${last.file}`;
});
dlFolder.addEventListener('click', () => {
  const last = dlQueue[dlQueue.length - 1];
  if (last) api.showFolder(last.path);
  hideToast();
});

api.onDownload(handleDownload);
api.lastDownload().then(handleDownload); // a download that finished before this listener existed

// "Sound but no pop-up" needs a sound of our own: a short two-note chime,
// synthesised here so that no sound file is needed.
let audio = null;
function playChime() {
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audio = audio || new Context();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime;
    for (const [frequency, at] of [[1318.5, 0], [1975.5, 0.09]]) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.12, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0005, t0 + at + 0.35);
      tone.connect(gain).connect(audio.destination);
      tone.start(t0 + at);
      tone.stop(t0 + at + 0.4);
    }
  } catch {
    /* no audio output available: nothing to play */
  }
}
api.onSound(playChime);

api.onState(render);
api.list().then(render);

// Chromium reports when the window goes out of sight — minimized, or fully
// covered — through the page's visibility. The app uses it to unload the
// account on screen once nobody is looking (a switch; off by default).
document.addEventListener('visibilitychange', () => api.setVisible(document.visibilityState === 'visible'));
