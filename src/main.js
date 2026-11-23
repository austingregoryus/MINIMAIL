'use strict';
// Minimail — one window for all your web mail.
//
// A shell window (title bar + account sidebar) hosts a WebContentsView per
// account, each in its own `persist:` session partition, showing that
// account's mail service as-is. No preload is injected into mail pages.
// What differs between services lives in src/providers.js: where to start,
// which hosts stay in the app, how to read the unread count from the page
// title, and — for Gmail only — a feed that works with the page closed.

const { app, BrowserWindow, WebContentsView, session, shell, ipcMain, Menu, net, Notification, nativeImage, clipboard, dialog, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const { badgeImage, dotImage } = require('./badge');
const { parseEmail, parseFeed, mergeFeed, unwrapGoogleRedirect, sanitizeFilename, formatCount, createRiseTracker, riseStep, MUTE_UNTIL_TURNED_OFF, isMuted, notificationPlan, withNotifyDefaults } = require('./parsers');
const { PROVIDERS, PROVIDER_ORDER, classifyUrl, accountColor } = require('./providers');

const DIAGNOSTIC = ['--autotest', '--shot', '--experiment', '--online', '--probe'].find((flag) => process.argv.includes(flag));

// The profile holds sign-ins, cookies and settings. Releases up to 0.3 were
// called "Gmail Lite" and kept it in `gmail-lite`: move it along on the first
// start, so nobody has to sign in again.
let dataDir = path.join(app.getPath('appData'), 'minimail');
const legacyDataDir = path.join(app.getPath('appData'), 'gmail-lite');
if (!DIAGNOSTIC) {
  try {
    if (!fs.existsSync(dataDir) && fs.existsSync(legacyDataDir)) fs.renameSync(legacyDataDir, dataDir);
  } catch (err) {
    console.log('[settings] could not move the old profile folder:', String(err));
  }
  if (!fs.existsSync(dataDir) && fs.existsSync(legacyDataDir)) dataDir = legacyDataDir; // the move failed: keep using the old one
}
app.setPath('userData', dataDir);

if (DIAGNOSTIC && DIAGNOSTIC !== '--probe') {
  // Diagnostics run in their own profile so they never touch the real one.
  const dir = path.join(os.tmpdir(), 'minimail' + DIAGNOSTIC.replace('--', '-'));
  fs.rmSync(dir, { recursive: true, force: true }); // start every run from the same clean state
  if (DIAGNOSTIC === '--shot' && process.env.SHOT !== 'welcome') { // SHOT=welcome renders the first-run screen instead
    fs.mkdirSync(dir, { recursive: true });
    try {
      // SHOT_SETTINGS points at a different settings file to render from.
      fs.copyFileSync(process.env.SHOT_SETTINGS || path.join(dataDir, 'settings.json'), path.join(dir, 'settings.json'));
    } catch {
      /* no real settings yet — renders the welcome state */
    }
  }
  app.setPath('userData', dir);
}

const APP_NAME = 'Minimail';
// An unpackaged run (npm start, the test harness) is Electron itself, logo and
// all. It gets its own identity so the taskbar never files that logo away under
// the installed app's name — which is what leaves the installed app showing it.
const APP_ID = app.isPackaged ? 'io.github.minimail' : 'io.github.minimail.dev';
const DEBUG = !app.isPackaged || !!process.env.MINIMAIL_DEBUG;
const SIDEBAR_W = 56;
const COLLAPSED_W = 16; // thin strip that stays clickable when the sidebar is hidden
const TITLEBAR_H = 40;
const PREFETCH_DELAY_MS = 3000;
// Background Gmail accounts unload their renderer after this long.
const SLEEP_AFTER_MS = Number(process.env.MINIMAIL_SLEEP_MS) || 10 * 60 * 1000;
// Gmail's feed is polled this often, page open or not: it is what keeps counts
// current when no Inbox is showing and what new-mail notifications come from.
const pollInterval = () => Number(process.env.MINIMAIL_POLL_MS) || 60 * 1000;
const FEED_RETRY_MS = 10000; // when the title saw new mail that the feed has not listed yet

const log = (...args) => console.log(...args);
const debug = (...args) => {
  if (DEBUG) console.log(...args);
};

let win = null;
let settingsWin = null;
let lastDownload = null; // consumed by the shell on startup, so early downloads never lose their toast
// accountId -> { view|null, count, titleCount, titleAt, pollAt, email, seenKeys, rise, host, signedIn, loading,
//                sleepTimer, pollTimer, polling, repoll, lastCrash }
const views = new Map();
const downloadShells = new Set(); // hidden popup windows whose only job is to start a download
const reservedPaths = new Set(); // save paths handed out for downloads still in flight

// Notifications, sounds, "open in the browser" and menus go through seams, so
// the offline test harness can record them instead of putting anything on the
// user's screen or making a sound.
let notifier = (id, title, body, icon, { silent }) => {
  if (!Notification.isSupported()) return;
  // Unless silent, the banner carries Windows' own notification sound.
  const toast = new Notification({ title, body, icon, silent });
  toast.on('click', () => focusApp(id));
  toast.on('failed', (_e, error) => debug('[toast] failed:', error));
  toast.show();
};
let playSound = () => {
  // Sound without a pop-up: the shell plays a short chime of its own.
  if (win && !win.isDestroyed()) win.webContents.send('shell:sound');
};
let openInBrowser = (url, options) =>
  shell.openExternal(url, options).catch((err) => debug('[link] not opened:', String(url).slice(0, 80), String(err)));

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const backupPath = settingsPath.replace(/\.json$/, '.bak.json');
let settings = {
  accounts: [],
  activeId: null,
  sidebarCollapsed: false,
  prefetchAccounts: true,
  showBadge: true,
  sleepAccounts: true,
  launchOnStartup: false,
  mutedUntil: 0, // when the global mute ends (ms); MUTE_UNTIL_TURNED_OFF for "until I turn it back on"; 0 = not muted
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadSettings() {
  // The backup exists for exactly this: fall back to it if the main file is unreadable.
  const main = readJson(settingsPath);
  const stored = main || readJson(backupPath);
  if (!stored) return;
  if (!main) log('[settings] settings.json is unreadable — using the backup copy');
  settings.accounts = Array.isArray(stored.accounts) ? stored.accounts.filter((a) => a && typeof a.id === 'string') : [];
  for (const key of Object.keys(stored)) if (key !== 'accounts') settings[key] = stored[key];
  for (const acct of settings.accounts) {
    if (acct.avatar && acct.avatarSize !== 128) acct.avatarRefreshPending = true; // cached at the old, blurrier size: fetch a better one, keeping this until it arrives
    // Each account's own notification switches. Accounts saved before these
    // existed take their defaults from the global switches that used to cover them.
    acct.notify = withNotifyDefaults(acct.notify, settings);
  }
  delete settings.showCounts; // now each account's "count" switch
  delete settings.notificationsEnabled; // now each account's "banner" switch
  if (typeof settings.mutedUntil !== 'number' || !Number.isFinite(settings.mutedUntil)) settings.mutedUntil = 0;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // Write-then-rename so an interrupted save can never leave a half-written file.
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    try {
      fs.copyFileSync(settingsPath, backupPath);
    } catch {
      /* first save has nothing to back up */
    }
    fs.renameSync(tmp, settingsPath);
  } catch (err) {
    log('[settings] could not save:', String(err));
  }
}

function publicPrefs() {
  const { showBadge, prefetchAccounts, sleepAccounts, sidebarCollapsed, launchOnStartup } = settings;
  return {
    showBadge,
    prefetchAccounts,
    sleepAccounts,
    sidebarCollapsed,
    launchOnStartup,
    mutedUntil: isMuted(settings.mutedUntil) ? Number(settings.mutedUntil) : 0, // 0 = not muted
  };
}

function accountRecord(id) {
  return settings.accounts.find((a) => a.id === id);
}

function providerOf(id) {
  const acct = accountRecord(id);
  return PROVIDERS[acct && acct.provider] || PROVIDERS.gmail;
}

function acctLabel(id) {
  const acct = accountRecord(id);
  return acct ? acct.label : id;
}

function accountsPayload() {
  const siblings = new Map(); // provider -> colourless accounts seen so far, so they can be told apart
  return settings.accounts.map((a) => {
    const rec = views.get(a.id);
    const provider = providerOf(a.id);
    const named = /@/.test(a.label || '');
    const index = named ? 0 : siblings.get(provider.id) || 0;
    if (!named) siblings.set(provider.id, index + 1);
    return {
      id: a.id,
      label: a.label,
      avatar: a.avatar || null,
      color: accountColor(a.label, provider.id, index),
      provider: provider.id,
      providerName: provider.short || provider.name,
      providerColor: provider.color,
      mark: provider.mark || null, // outline drawn on the badge; null = show the service's initial
      count: rec ? rec.count : 0,
      showCount: !a.notify || a.notify.count !== false, // this account's "unread count" switch
      notify: a.notify || null, // { count, sound, banner } for the Settings window
      active: a.id === settings.activeId,
      // No renderer right now: unloaded by auto-sleep, or never loaded (prefetch off).
      asleep: !!rec && !rec.view,
      loading: !!rec && rec.loading,
    };
  });
}

function pushAccounts() {
  const payload = { accounts: accountsPayload(), prefs: publicPrefs() };
  for (const w of [win, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('state:changed', payload);
}

function updateBadge() {
  if (!win || win.isDestroyed()) return;
  const total = [...views.values()].reduce((sum, r) => sum + r.count, 0);
  win.setTitle(total ? `${APP_NAME} (${formatCount(total)})` : APP_NAME);
  const shown = settings.showBadge === false ? 0 : total;
  if (process.platform === 'win32') win.setOverlayIcon(badgeImage(shown), `${formatCount(total)} unread`);
  else if (process.platform === 'darwin') app.setBadgeCount(shown);
}

// ---------------------------------------------------------------------------
// Sessions and downloads
// ---------------------------------------------------------------------------

const configuredSessions = new Set();

function sessionFor(id) {
  const ses = session.fromPartition('persist:' + id);
  if (configuredSessions.has(ses)) return ses; // configure each session exactly once
  configuredSessions.add(ses);
  // Present as plain Chrome: mail services balk at the Electron UA token.
  ses.setUserAgent(app.userAgentFallback.replace(/ Electron\/[\d.]+/i, ''));
  // Web mail's own notifications can't focus the app or switch account on
  // click, so new-mail toasts come from us instead. Deny the permission so
  // pages never fire duplicates.
  const allowed = ['fullscreen', 'media', 'display-capture', 'clipboard-sanitized-write'];
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.includes(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission));
  ses.on('will-download', (_e, item, wc) => startDownload(item, wc));
  return ses;
}

function downloadDir() {
  return process.env.MINIMAIL_DOWNLOADS_DIR || app.getPath('downloads');
}

// Two downloads started at once with the same name would both be told to save
// to the same path before either file exists, so paths are reserved until the
// download finishes.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext) || 'download';
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) || reservedPaths.has(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  reservedPaths.add(p);
  return p;
}

const isBlankUrl = (url) => !url || /^about:blank$|^blob:/i.test(url);

function startDownload(item, wc) {
  const savePath = uniquePath(downloadDir(), sanitizeFilename(item.getFilename()));
  item.setSavePath(savePath);
  item.once('done', (_e, state) => {
    reservedPaths.delete(savePath);
    if (state !== 'completed') return log('[download]', item.getFilename(), 'did not finish:', state);
    log('[download]', path.basename(savePath));
    lastDownload = { file: path.basename(savePath), path: savePath };
    if (win && !win.isDestroyed()) win.webContents.send('download:done', lastDownload);
  });
  // The window that started the download has done its job: close the hidden
  // shell we opened for it, or a popup that never got past its blank page.
  const w = wc && BrowserWindow.fromWebContents(wc);
  if (w && w !== win && w !== settingsWin && (downloadShells.has(w) || isBlankUrl(wc.getURL()))) {
    setTimeout(() => {
      if (!w.isDestroyed()) w.close();
    }, 2000);
  }
}

// ---------------------------------------------------------------------------
// Unread counts and new-mail notifications
// ---------------------------------------------------------------------------

// Fetch Gmail's atom feed with the account's own session cookies attached
// explicitly — the net stack does not send them by default, which is a 401.
function feedFetch(id) {
  const feed = providerOf(id).feed;
  return new Promise((resolve, reject) => {
    if (!feed) return reject(new Error('this service has no feed'));
    const ses = sessionFor(id);
    ses.cookies
      .get({ url: feed.cookiesFor })
      .then((cookies) => {
        const req = net.request({ method: 'GET', url: feed.url, session: ses });
        const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        if (header) req.setHeader('Cookie', header);
        const timer = setTimeout(() => req.abort(), 20000); // without this a hung request would stall polling for good
        const settle = (fn) => (arg) => {
          clearTimeout(timer);
          fn(arg);
        };
        req.on('response', (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', settle(() => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })));
          res.on('error', settle(reject));
        });
        req.on('error', settle(reject));
        req.on('abort', () => settle(reject)(new Error('timed out')));
        req.end();
      })
      .catch(reject);
  });
}

function setFeedState(id, rec, state) {
  if (rec.feedState === state) return;
  rec.feedState = state;
  if (state === 'ok') debug('[feed]', acctLabel(id), 'ok');
  else log('[feed]', acctLabel(id), state);
}

function pollFeed(id, opts = {}) {
  const rec = views.get(id);
  if (!rec) return;
  if (rec.polling) {
    rec.repoll = opts; // a poll is already in flight: run this one too once it settles
    return;
  }
  rec.polling = true;
  rec.pollAt = Date.now(); // for mergeFeed: has the page title changed since this poll began?
  feedFetch(id)
    .then((res) => {
      if (views.get(id) !== rec) return; // the account was removed meanwhile
      if (res.status === 401 || res.status === 403) return setFeedState(id, rec, 'signed out');
      if (res.status !== 200) return setFeedState(id, rec, 'http ' + res.status);
      const feed = parseFeed(res.text);
      if (!feed) return setFeedState(id, rec, 'no feed (is the account signed in?)');
      setFeedState(id, rec, 'ok');
      const { fresh, retry } = mergeFeed(rec, feed, { ...opts, hasView: !!rec.view });
      if (fresh.length) {
        const first = fresh[0];
        const text = [first.sender, first.subject].filter(Boolean).join(': ').replace(/\s+/g, ' ');
        showToast(id, text + (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''));
      }
      if (retry) setTimeout(() => pollFeed(id, { countedByTitle: opts.countedByTitle, retries: opts.retries - 1 }), FEED_RETRY_MS);
      updateBadge();
      pushAccounts();
    })
    .catch((err) => {
      if (views.get(id) === rec) setFeedState(id, rec, 'error: ' + ((err && err.message) || err));
    })
    .finally(() => {
      rec.polling = false;
      if (rec.repoll) {
        const again = rec.repoll;
        rec.repoll = null;
        pollFeed(id, again);
      }
    });
}

function showToast(id, body) {
  const acct = accountRecord(id);
  if (!acct) return;
  const plan = notificationPlan(acct.notify, settings.mutedUntil);
  if (!plan.sound && !plan.banner) return; // switched off for this account, or muted
  log('[mail]', acct.label, body, `sound:${plan.sound} banner:${plan.banner}`);
  if (plan.banner) {
    notifier(id, acct.label, body || 'New mail', acct.avatar ? nativeImage.createFromDataURL(acct.avatar) : undefined, { silent: !plan.sound });
  } else {
    playSound();
  }
}

// The global mute: silences sounds and pop-ups for every account until a
// moment in time, or until it is turned off. Unread counts are unaffected.
let muteTimer = null;
function setMute(until) {
  const t = Number(until);
  settings.mutedUntil = t === MUTE_UNTIL_TURNED_OFF || t > Date.now() ? t : 0;
  saveSettings();
  armMuteExpiry();
  pushAccounts();
  log('[mute]', settings.mutedUntil ? (settings.mutedUntil === MUTE_UNTIL_TURNED_OFF ? 'until turned off' : `until ${new Date(settings.mutedUntil).toLocaleTimeString()}`) : 'off');
  return publicPrefs();
}
function armMuteExpiry() {
  clearTimeout(muteTimer);
  muteTimer = null;
  if (!isMuted(settings.mutedUntil) || settings.mutedUntil >= MUTE_UNTIL_TURNED_OFF) return;
  muteTimer = setTimeout(() => {
    muteTimer = null;
    if (!isMuted(settings.mutedUntil)) pushAccounts(); // let the sidebar show notifications as back on
  }, settings.mutedUntil - Date.now() + 250);
}
function remainingLabel(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
const MUTE_CHOICES = [[15, '15 minutes'], [60, '1 hour'], [240, '4 hours']];
let muteMenu = (x, y) => {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  const items = [];
  if (isMuted(settings.mutedUntil)) {
    const left = settings.mutedUntil >= MUTE_UNTIL_TURNED_OFF ? 'until you turn them back on' : `for ${remainingLabel(settings.mutedUntil - now)} more`;
    items.push({ label: 'Turn notifications back on', click: () => setMute(0) }, { label: `Muted ${left}`, enabled: false }, { type: 'separator' });
  }
  for (const [minutes, text] of MUTE_CHOICES) items.push({ label: `Mute for ${text}`, click: () => setMute(now + minutes * 60000) });
  items.push({ label: 'Mute until I turn it back on', click: () => setMute(MUTE_UNTIL_TURNED_OFF) });
  Menu.buildFromTemplate(items).popup({ window: win, x, y });
};

function focusApp(id) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (id) switchTo(id);
}

// ---------------------------------------------------------------------------
// Account views
// ---------------------------------------------------------------------------

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const x = settings.sidebarCollapsed ? COLLAPSED_W : SIDEBAR_W;
  for (const rec of views.values()) {
    if (rec.view) rec.view.setBounds({ x, y: TITLEBAR_H, width: w - x, height: h - TITLEBAR_H });
  }
}

function newRecord() {
  return {
    view: null,
    count: 0,
    titleCount: undefined,
    titleAt: 0,
    pollAt: 0,
    email: null,
    seenKeys: undefined,
    rise: createRiseTracker(),
    host: null,
    signedIn: false,
    loading: false,
    sleepTimer: null,
    pollTimer: null,
    polling: false,
    repoll: null,
    lastCrash: 0,
  };
}

// Every account gets a record, loaded or not. A service with a feed is polled
// from here even while unloaded; the others can only be watched while their
// page is open.
function ensureRecord(id) {
  if (views.has(id)) return views.get(id);
  const rec = newRecord();
  views.set(id, rec);
  if (providerOf(id).feed) {
    rec.pollTimer = setInterval(() => pollFeed(id), pollInterval());
    setTimeout(() => pollFeed(id), 2000).unref?.();
  }
  return rec;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

function attachView(id) {
  sessionFor(id);
  const view = new WebContentsView({
    webPreferences: { partition: 'persist:' + id, backgroundThrottling: true },
  });
  view.setBackgroundColor('#141519'); // the app's own background, so loading into a dark-themed inbox doesn't flash white
  const wc = view.webContents;
  wc.on('page-title-updated', (_e, title) => onTitle(id, title));
  wc.on('did-finish-load', () => {
    const rec = views.get(id);
    if (rec) {
      rec.loading = false;
      rec.host = hostOf(wc.getURL());
      pushAccounts();
    }
    if (providerOf(id).avatar) scheduleAvatarProbe(id);
    refreshEditableFocus(wc);
  });
  wc.on('render-process-gone', () => {
    const rec = views.get(id);
    if (!rec || Date.now() - rec.lastCrash < 15000) return; // don't loop on a crash loop
    rec.lastCrash = Date.now();
    setTimeout(() => {
      const r = views.get(id);
      if (r && r.view && !r.view.webContents.isDestroyed()) r.view.webContents.reload();
    }, 2000);
  });
  return view;
}

function wakeView(id) {
  const rec = views.get(id);
  if (!rec || rec.view || !win || win.isDestroyed()) return;
  rec.view = attachView(id);
  rec.loading = true;
  rec.signedIn = false;
  rec.rise = createRiseTracker(); // the first count this page reports is a baseline, not new mail
  win.contentView.addChildView(rec.view);
  rec.view.setVisible(id === settings.activeId);
  layout();
  rec.view.webContents.loadURL(providerOf(id).start).catch(() => {});
  debug('[sleep]', acctLabel(id), 'loaded');
}

// Auto-sleep: a background Gmail account unloads its renderer after
// SLEEP_AFTER_MS; its feed keeps counts and notifications going, and its
// session stays on disk, so waking is instant and still signed in. Services
// without a feed would go silent, so they are never unloaded.
function armSleep(id) {
  const rec = views.get(id);
  if (!rec || !settings.sleepAccounts || !providerOf(id).feed || !rec.view || id === settings.activeId) return;
  clearTimeout(rec.sleepTimer);
  rec.sleepTimer = setTimeout(() => sleepView(id), SLEEP_AFTER_MS);
}

function sleepView(id) {
  const rec = views.get(id);
  if (!rec || !providerOf(id).feed || !rec.view || id === settings.activeId || !win || win.isDestroyed()) return;
  clearTimeout(rec.sleepTimer);
  rec.sleepTimer = null;
  win.contentView.removeChildView(rec.view);
  rec.view.webContents.close();
  rec.view = null;
  log('[sleep]', acctLabel(id), 'unloaded');
  pushAccounts();
}

function switchTo(id) {
  if (!accountRecord(id)) return;
  ensureRecord(id); // never loaded this session (prefetch off)
  wakeView(id);
  for (const [k, rec] of views) {
    clearTimeout(rec.sleepTimer);
    rec.sleepTimer = null;
    if (rec.view) rec.view.setVisible(k === id);
    if (k !== id) armSleep(k);
  }
  settings.activeId = id;
  saveSettings();
  pushAccounts();
}

function startAccounts() {
  if (DIAGNOSTIC === '--shot') {
    // A render-only run loads nothing. A preview settings file may say what
    // unread count to show for an account (previewCount); real settings never have it.
    for (const acct of settings.accounts) views.set(acct.id, { ...newRecord(), count: Number(acct.previewCount) || 0 });
    return pushAccounts();
  }
  for (const acct of settings.accounts) ensureRecord(acct.id);
  const first = settings.accounts.find((a) => a.id === settings.activeId) || settings.accounts[0];
  if (first) {
    settings.activeId = first.id;
    wakeView(first.id);
  }
  if (settings.prefetchAccounts) {
    setTimeout(() => {
      if (!win) return;
      for (const acct of settings.accounts) {
        wakeView(acct.id);
        if (acct.id !== settings.activeId) armSleep(acct.id);
      }
      layout();
    }, PREFETCH_DELAY_MS);
  }
  pushAccounts();
}

// ---------------------------------------------------------------------------
// Avatars (Gmail only: it is the one service whose account chip is known)
// ---------------------------------------------------------------------------

// The profile photo sits in the Gmail header's account chip. The chip's
// aria-label must contain the account's own email: the page shows other
// lh3.googleusercontent.com images (contacts, loading rings) that would
// otherwise be mistaken for it.
const AVATAR_SNIPPET = `(() => {
  const EMAIL = __EMAIL__;
  const scopes = [document.querySelector('#gb'), document.querySelector('header'), document.querySelector('[role="banner"]')].filter(Boolean);
  for (const scope of scopes) {
    for (const img of scope.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!/^https:\\/\\/lh3\\.googleusercontent\\.com\\//.test(src)) continue;
      const a = img.closest('a');
      if (a && (a.getAttribute('aria-label') || '').toLowerCase().includes(EMAIL)) return src;
    }
  }
  return null;
})()`;
const AVATAR_PROBE_DELAYS = [2500, 6000, 12000, 30000, 60000];

function scheduleAvatarProbe(id) {
  const rec = views.get(id);
  const acct = accountRecord(id);
  if (!rec || !acct || (acct.avatar && !acct.avatarRefreshPending)) return; // cached, and nobody asked for a refresh
  if (!rec.email) return debug('[avatar]', id, 'no email identified yet');
  for (const delay of AVATAR_PROBE_DELAYS) setTimeout(() => probeAvatar(id), delay);
}

// Returns whether a photo was found and cached.
async function probeAvatar(id) {
  const rec = views.get(id);
  const acct = accountRecord(id);
  if (!rec || !rec.view || !acct || !rec.email || (acct.avatar && !acct.avatarRefreshPending)) return false;
  const wc = rec.view.webContents;
  if (wc.isDestroyed() || !wc.getURL().startsWith('https://mail.google.com')) return false;
  try {
    const src = await wc.executeJavaScript(AVATAR_SNIPPET.replace('__EMAIL__', JSON.stringify(rec.email)), true);
    if (!src) return false;
    // The chip serves a 32px image; ask for a larger cut so the avatar stays sharp on HiDPI screens.
    let res = await net.fetch(src.replace(/=s\d+(-[a-z-]+)?$/i, '=s128'));
    if (!res.ok) res = await net.fetch(src);
    const type = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok || !type.startsWith('image/') || !buf.length || buf.length > 512 * 1024) return false;
    acct.avatar = `data:${type};base64,${buf.toString('base64')}`;
    acct.avatarSize = 128;
    delete acct.avatarRefreshPending;
    saveSettings();
    pushAccounts();
    return true;
  } catch (err) {
    debug('[avatar]', rec.email, String(err));
    return false;
  }
}

// "Refresh avatar": the old photo stays on screen until a new one has been
// fetched; if none can be found right now, later page loads try again.
async function refreshAvatar(id) {
  const acct = accountRecord(id);
  if (!acct) return;
  acct.avatarRefreshPending = true;
  if (!(await probeAvatar(id))) scheduleAvatarProbe(id);
}

// ---------------------------------------------------------------------------
// Page titles
// ---------------------------------------------------------------------------

function onTitle(id, title) {
  const rec = views.get(id);
  if (!rec) return;
  const provider = providerOf(id);
  rec.host = rec.view ? hostOf(rec.view.webContents.getURL()) : rec.host;

  const email = parseEmail(title);
  if (email && email !== rec.email) {
    rec.email = email;
    const acct = accountRecord(id);
    if (acct && acct.label !== email) {
      acct.label = email;
      saveSettings();
    }
    if (provider.avatar) scheduleAvatarProbe(id);
    pushAccounts();
  }

  // Only a title that shows the Inbox carries the unread count. With a
  // conversation open the count is unknown — not zero — and is left alone.
  const inbox = provider.inbox(title);
  if (!inbox) return;
  debug('[title]', id, JSON.stringify(title));
  rec.titleAt = Date.now();
  rec.signedIn = true;
  rec.count = inbox.count;

  if (provider.feed) {
    if (rec.titleCount !== undefined && inbox.count > rec.titleCount) pollFeed(id, { countedByTitle: true, retries: 2 }); // new mail just arrived: toast now, not at the next poll
    rec.titleCount = inbox.count;
  } else {
    // No feed to ask: new mail is a rise in this count (see riseStep).
    const fresh = riseStep(rec.rise, inbox.count, Date.now());
    if (fresh) showToast(id, `${fresh} new message${fresh > 1 ? 's' : ''}`);
  }
  updateBadge();
  pushAccounts();
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function addAccount(providerId) {
  const provider = PROVIDERS[providerId] || PROVIDERS.gmail;
  const id = 'a' + crypto.randomBytes(6).toString('hex');
  settings.accounts.push({ id, provider: provider.id, label: provider.short || provider.name, notify: { count: true, sound: true, banner: true } });
  ensureRecord(id);
  switchTo(id);
  return id;
}

// One of an account's notification switches. Returns the account's switches.
const NOTIFY_KEYS = ['count', 'sound', 'banner'];
function setAccountPref(id, key, value) {
  const acct = accountRecord(id);
  if (!acct || !NOTIFY_KEYS.includes(key) || typeof value !== 'boolean') return null;
  acct.notify = { ...acct.notify, [key]: value };
  saveSettings();
  pushAccounts();
  return acct.notify;
}

async function removeAccount(id) {
  const acct = accountRecord(id);
  const rec = views.get(id);
  if (!acct || !rec) return;
  // Removing wipes the saved sign-in, so a mis-click must not be enough.
  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Remove account',
    message: `Remove ${acct.label} from ${APP_NAME}?`,
    detail: 'Its saved sign-in is cleared. Your mailbox is not affected; you can add the account again at any time.',
  });
  if (response !== 0) return;
  clearInterval(rec.pollTimer);
  clearTimeout(rec.sleepTimer);
  if (rec.view && win && !win.isDestroyed()) {
    win.contentView.removeChildView(rec.view);
    rec.view.webContents.close();
  }
  views.delete(id);
  session.fromPartition('persist:' + id).clearStorageData().catch(() => {});
  settings.accounts = settings.accounts.filter((a) => a.id !== id);
  if (settings.activeId === id) {
    settings.activeId = settings.accounts.length ? settings.accounts[0].id : null;
    if (settings.activeId) switchTo(settings.activeId);
  }
  saveSettings();
  pushAccounts();
  updateBadge();
}

function toggleSidebar() {
  settings.sidebarCollapsed = !settings.sidebarCollapsed;
  saveSettings();
  layout();
  pushAccounts();
}

function showAccountMenu(id, x, y) {
  const rec = views.get(id);
  if (!rec) return;
  const items = [{ label: rec.view ? 'Reload' : 'Load', click: () => (rec.view ? rec.view.webContents.reload() : switchTo(id)) }];
  if (providerOf(id).avatar) items.push({ label: 'Refresh avatar', click: () => refreshAvatar(id) });
  items.push({ type: 'separator' }, { label: 'Remove account…', click: () => removeAccount(id) });
  Menu.buildFromTemplate(items).popup({ window: win, x, y });
}

// "Add an account": which mail service. A native menu, so it costs nothing
// until it is opened. (Behind a seam like the toasts, so tests can record the
// request instead of putting a menu on the user's screen.)
let providerMenu = (x, y) => {
  if (!win || win.isDestroyed()) return;
  Menu.buildFromTemplate(
    PROVIDER_ORDER.filter((id) => PROVIDERS[id]).map((id) => ({
      label: PROVIDERS[id].name,
      icon: dotImage(PROVIDERS[id].color),
      click: () => addAccount(id),
    })),
  ).popup({ window: win, x, y });
};

// ---------------------------------------------------------------------------
// Where URLs may go
// ---------------------------------------------------------------------------

function openExternally(url, inBackground) {
  openInBrowser(url, { activate: !inBackground }); // Ctrl+click stays in the background, like in a browser
}

function accountIdFor(wc) {
  for (const [id, rec] of views) {
    if (rec.view && rec.view.webContents === wc) return id;
  }
  for (const [id] of views) {
    if (session.fromPartition('persist:' + id) === wc.session) return id; // a popup of that account
  }
  return settings.activeId;
}

const providerForWebContents = (wc) => providerOf(accountIdFor(wc));

// mailto: links open a compose window in the account they were clicked in.
function openMailTo(mailtoUrl, wc) {
  const id = wc ? accountIdFor(wc) : settings.activeId;
  const acct = accountRecord(id);
  if (!acct) return;
  const provider = providerOf(id);
  const rec = views.get(id);
  const compose = provider.compose ? provider.compose(mailtoUrl, rec && rec.host) : null;
  if (!compose) return focusApp(id); // the service has no compose link: take the user to the account

  const popup = new BrowserWindow({
    width: 640,
    height: 560,
    parent: win && !win.isDestroyed() ? win : undefined,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#141519',
    webPreferences: { session: sessionFor(id) },
  });
  popup.setMenu(null);
  popup.once('ready-to-show', () => popup.show());
  const signedIn = provider.feed ? !!rec && rec.feedState === 'ok' : !!rec && rec.signedIn;
  debug('[mailto]', acctLabel(id), signedIn ? 'signed in — opening compose' : 'not signed in — signing in first');
  if (signedIn) return popup.loadURL(compose).catch(() => {});

  // Not signed in (or unknown). Loading the compose link cold gets thrown out
  // to a marketing page, so open the service, let the user sign in, and load
  // the compose once the mail app itself is up — once, not on every load.
  let opened = false;
  popup.webContents.on('did-finish-load', () => {
    const host = hostOf(popup.webContents.getURL());
    if (!opened && !popup.isDestroyed() && provider.mailHosts.includes(host)) {
      opened = true;
      popup.loadURL(compose).catch(() => {});
    }
  });
  popup.loadURL(provider.start).catch(() => {});
}

function wireNavigation(wc) {
  const isAppChrome = () => wc === (win && win.webContents) || wc === (settingsWin && settingsWin.webContents);

  wc.setWindowOpenHandler(({ url, disposition }) => {
    const target = unwrapGoogleRedirect(url);
    const kind = classifyUrl(target, providerForWebContents(wc));
    if (kind === 'mailto') {
      openMailTo(target, wc);
      return { action: 'deny' };
    }
    if (kind === 'external') {
      openExternally(target, disposition === 'background-tab');
      return { action: 'deny' };
    }
    // 'download' opens hidden: the window's only job is to start the download,
    // after which startDownload() closes it. 'app' and 'blank' open normally.
    const options = { autoHideMenuBar: true, backgroundColor: '#141519' };
    if (kind === 'download') options.show = false;
    return { action: 'allow', overrideBrowserWindowOptions: options };
  });

  wc.on('will-navigate', (e, url) => {
    if (isAppChrome()) {
      e.preventDefault(); // the shell and settings never leave their local page
      return;
    }
    const target = unwrapGoogleRedirect(url);
    const kind = classifyUrl(target, providerForWebContents(wc));
    if (kind === 'app' || kind === 'blank') return;
    e.preventDefault();
    if (kind === 'download') wc.downloadURL(target); // save the file instead of replacing the page
    else if (kind === 'mailto') openMailTo(target, wc);
    else openExternally(target);
  });

  wc.on('did-create-window', (popup, details) => {
    popup.setMenu(null); // popups would otherwise carry Electron's default menu behind Alt
    if (classifyUrl(details.url, providerForWebContents(wc)) !== 'download') return;
    downloadShells.add(popup);
    popup.once('closed', () => downloadShells.delete(popup));
    setTimeout(() => {
      if (!popup.isDestroyed()) popup.close(); // nothing was downloaded: don't leak a hidden window
    }, 30000).unref?.();
  });
}

function showContextMenu(wc, params) {
  const provider = providerForWebContents(wc);
  const items = [];
  const add = (...entries) => items.push(...entries);
  const sep = () => {
    const last = items[items.length - 1];
    if (last && last.type !== 'separator') items.push({ type: 'separator' });
  };

  if (params.linkURL) {
    const target = unwrapGoogleRedirect(params.linkURL);
    if (classifyUrl(target, provider) === 'mailto') add({ label: 'Send email', click: () => openMailTo(target, wc) });
    else add({ label: 'Open link in browser', click: () => openExternally(target) });
    add({ label: 'Copy link address', click: () => clipboard.writeText(target) });
  }
  if (params.srcURL && params.mediaType === 'image') {
    const kind = classifyUrl(params.srcURL, provider);
    sep();
    if (kind === 'external') add({ label: 'Open image in browser', click: () => openExternally(params.srcURL) });
    add({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    if (/^https?:/i.test(params.srcURL)) add({ label: 'Save image', click: () => wc.downloadURL(params.srcURL) }); // lands in Downloads, with a toast
  }
  if (params.isEditable) {
    const flags = params.editFlags;
    sep();
    add(
      { label: 'Cut', role: 'cut', enabled: flags.canCut },
      { label: 'Copy', role: 'copy', enabled: flags.canCopy },
      { label: 'Paste', role: 'paste', enabled: flags.canPaste },
      { label: 'Select all', role: 'selectAll', enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    sep();
    add({ label: 'Copy', role: 'copy' }, { label: 'Select all', role: 'selectAll' });
  }
  if (!items.length) {
    // Nothing under the cursor to act on. (Gmail's own menus, e.g. on mail rows,
    // cancel this event and are unaffected.)
    const nav = wc.navigationHistory;
    if (!nav.canGoBack() && !nav.canGoForward()) return;
    if (nav.canGoBack()) add({ label: 'Back', click: () => nav.goBack() });
    if (nav.canGoForward()) add({ label: 'Forward', click: () => nav.goForward() });
    add({ label: 'Reload', click: () => wc.reload() });
  }
  const owner = BrowserWindow.fromWebContents(wc) || win; // account views belong to no window of their own
  Menu.buildFromTemplate(items).popup(owner ? { window: owner } : {});
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

// Whether the focused page element is somewhere you type. Probing is async and
// keyboard events can't wait, so the answer is cached and refreshed whenever
// focus could have moved: after a click, after typing, and on page load.
const editableFocus = new WeakMap();
let focusProbeTimer = null;
const EDITABLE_PROBE = `!!document.activeElement && (document.activeElement.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))`;

function refreshEditableFocus(wc) {
  if (wc.isDestroyed()) return;
  wc.executeJavaScript(EDITABLE_PROBE, true).then(
    (v) => editableFocus.set(wc, v === true),
    () => {},
  );
}

function handleKey(event, input, wc) {
  if (input.type !== 'keyDown' || input.isAutoRepeat || wc.isDestroyed()) return;
  if (wc.getURL().startsWith('devtools:')) return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const appChrome = wc === (win && win.webContents) || wc === (settingsWin && settingsWin.webContents);

  if (ctrl && !input.alt && !input.shift && input.key >= '1' && input.key <= '9') {
    const acct = settings.accounts[Number(input.key) - 1];
    if (acct) {
      switchTo(acct.id);
      event.preventDefault();
    }
  } else if (ctrl && input.shift && !input.alt && key === 'b') {
    // Gmail owns Ctrl+Shift+B wherever you can type (bold, add Bcc). It only
    // toggles the sidebar when the page has no editable element focused.
    refreshEditableFocus(wc);
    if (editableFocus.get(wc) !== true) {
      toggleSidebar();
      event.preventDefault();
    }
  } else if (wc === (settingsWin && settingsWin.webContents)) {
    return; // Ctrl+R and the like do nothing in Settings: the account behind it is not what is being looked at
  } else if (input.key === 'F5' || (ctrl && !input.shift && key === 'r')) {
    // Reload what the user is actually looking at: the focused mail window if
    // so, otherwise the active account (the shortcut was pressed in our chrome).
    if (!appChrome) wc.reload();
    else {
      const rec = views.get(settings.activeId);
      if (rec && rec.view) rec.view.webContents.reload();
    }
    event.preventDefault();
  } else if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) {
    wc.toggleDevTools();
    event.preventDefault();
  } else if (!ctrl && !input.alt && !input.meta && input.key.length === 1) {
    // Plain typing can move focus on its own (Gmail's "c" opens a compose box).
    clearTimeout(focusProbeTimer);
    focusProbeTimer = setTimeout(() => refreshEditableFocus(wc), 250);
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const TITLE_BAR = { color: '#17181c', symbolColor: '#c4c7cc', height: TITLEBAR_H };

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#141519',
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', 'build', 'icon.ico'), // packaged apps take the icon from the exe
    titleBarStyle: 'hidden', // native min/max/close stay (resize, snap and rounded corners intact)...
    titleBarOverlay: TITLE_BAR, // ...tinted to match our own bar
    webPreferences: { preload: path.join(__dirname, 'preloads', 'shell.js'), sandbox: true },
  });
  win.setMenu(null);
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, layout);
  win.on('closed', () => {
    win = null;
    app.quit(); // closing the main window closes the app, whatever popups are still open
  });
  win.loadFile(path.join(__dirname, 'shell', 'index.html'));
  // A test run shows its window without taking focus: it must not interrupt what the user is doing.
  win.once('ready-to-show', () => (DIAGNOSTIC ? win.showInactive() : win.show()));
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 540, // wide enough for an address beside its three switches
    height: 760, // taller than needed; shrunk to fit the content just before it is shown
    useContentSize: true,
    parent: win && !win.isDestroyed() ? win : undefined,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#141519',
    title: `${APP_NAME} Settings`,
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR,
    webPreferences: { preload: path.join(__dirname, 'preloads', 'shell.js'), sandbox: true },
  });
  settingsWin.setMenu(null);
  settingsWin.once('ready-to-show', async () => {
    await fitSettings();
    if (settingsWin && !settingsWin.isDestroyed()) (DIAGNOSTIC ? settingsWin.showInactive() : settingsWin.show());
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'));
}

// Size the Settings window to its content (it grows with the number of accounts).
async function fitSettings() {
  const target = settingsWin;
  if (!target || target.isDestroyed()) return;
  // documentElement.scrollHeight is never less than the viewport; the body's bottom edge is the real content height.
  const height = await target.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().bottom)').catch(() => 0);
  if (!settingsWin || settingsWin !== target || settingsWin.isDestroyed() || !height) return;
  settingsWin.setContentSize(540, Math.min(height, screen.getPrimaryDisplay().workAreaSize.height - 40));
}

// ---------------------------------------------------------------------------
// IPC — only our own shell/settings pages carry the preload, and nothing else
// is allowed through.
// ---------------------------------------------------------------------------

const trusted = (e) => e.sender === (win && win.webContents) || e.sender === (settingsWin && settingsWin.webContents);
// A throwing handler must not take anything down with it: log it and move on.
const ipcHandle = (channel, fn) =>
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) return undefined;
    try {
      return await fn(...args);
    } catch (err) {
      log('[ipc]', channel, String(err));
      return undefined;
    }
  });
const ipcOn = (channel, fn) =>
  ipcMain.on(channel, (e, ...args) => {
    if (trusted(e)) fn(...args);
  });

const PREF_KEYS = ['showBadge', 'prefetchAccounts', 'sleepAccounts', 'launchOnStartup'];

function setPref(key, value) {
  if (PREF_KEYS.includes(key) && typeof value === 'boolean') {
    settings[key] = value;
    if (key === 'launchOnStartup' && app.isPackaged) app.setLoginItemSettings({ openAtLogin: value });
    if (key === 'showBadge') updateBadge();
    if (key === 'sleepAccounts') {
      for (const [id, rec] of views) {
        clearTimeout(rec.sleepTimer);
        if (value && id !== settings.activeId) armSleep(id);
      }
    }
    saveSettings();
    pushAccounts();
  }
  return publicPrefs();
}

ipcHandle('accounts:list', () => ({ accounts: accountsPayload(), prefs: publicPrefs() }));
ipcHandle('accounts:add', (provider) => addAccount(String(provider || 'gmail')));
ipcHandle('accounts:remove', (id) => removeAccount(String(id)));
ipcOn('accounts:switch', (id) => switchTo(String(id)));
ipcOn('shell:toggle-sidebar', toggleSidebar);
ipcOn('shell:menu', (p) => showAccountMenu(String(p.id), Math.round(p.x), Math.round(p.y)));
ipcOn('shell:add-account', (p) => providerMenu(Math.round(p.x), Math.round(p.y)));
ipcOn('shell:mute-menu', (p) => muteMenu(Math.round(p.x), Math.round(p.y)));
ipcOn('window:open-settings', openSettings);
ipcOn('window:fit-settings', fitSettings);
ipcHandle('prefs:get', publicPrefs);
ipcHandle('prefs:set', (p) => setPref(String(p.key), p.value));
ipcHandle('mute:set', (until) => setMute(until));
ipcHandle('account:set-pref', (p) => setAccountPref(String(p.id), String(p.key), p.value));
ipcHandle('app:version', () => app.getVersion());
ipcHandle('shell:open-file', (p) => shell.openPath(String(p)));
ipcHandle('shell:show-item', (p) => {
  shell.showItemInFolder(String(p));
  return true;
});
// Consume-once: the shell pulls this at startup to toast downloads that
// finished before its listener existed.
ipcHandle('downloads:last', () => {
  const d = lastDownload;
  lastDownload = null;
  return d;
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Applies to the shell, every account view, and every popup a page opens.
app.on('web-contents-created', (_e, wc) => {
  wireNavigation(wc);
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  wc.on('before-input-event', (event, input) => handleKey(event, input, wc));
  wc.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type === 'mouseUp') setTimeout(() => refreshEditableFocus(wc), 150); // focus follows the click
  });
  if (DEBUG) {
    wc.on('console-message', (details) => {
      if (details.level === 'warning' || details.level === 'error') debug('[renderer]', details.message);
    });
  }
});

function argWithMailTo(argv) {
  return (argv || []).find((a) => typeof a === 'string' && a.startsWith('mailto:'));
}

if (!app.requestSingleInstanceLock() && !DIAGNOSTIC) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    focusApp();
    const mailto = argWithMailTo(argv);
    if (mailto) openMailTo(mailto);
  });
  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    loadSettings(); // before anything below: they decide what the login item should be
    armMuteExpiry(); // a mute set before this launch may run out while the app is open
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient('mailto');
      app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
    }
    createWindow();
    startAccounts();
    const mailto = argWithMailTo(process.argv);
    if (mailto && !DIAGNOSTIC) setTimeout(() => openMailTo(mailto), 4000);
    if (DIAGNOSTIC) {
      const target = {
        get win() {
          return win;
        },
        get settingsWin() {
          return settingsWin;
        },
        views,
        settings,
        PROVIDERS,
        addAccount,
        switchTo,
        sleepView,
        openSettings,
        openMailTo,
        updateBadge,
        setNotifier(fn) {
          notifier = fn;
        },
        setOpener(fn) {
          openInBrowser = fn;
        },
        setProviderMenu(fn) {
          providerMenu = fn;
        },
        setMuteMenu(fn) {
          muteMenu = fn;
        },
        setSound(fn) {
          playSound = fn;
        },
        setAccountPref,
        setMute,
      };
      require('./diagnostics').run(DIAGNOSTIC, target);
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', saveSettings);
}
