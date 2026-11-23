'use strict';
// --bench: what the real mail pages cost in memory.
//
//   MINIMAIL_ALLOW_ACCOUNT_PAGES=1 MINIMAIL_BENCH_PROFILE=<a copy of the profile> npx electron . --bench
//   MINIMAIL_BENCH_PLAN=plain     skip the purge steps: just settle, and measure
//   MINIMAIL_BENCH_PLAN=frames    settle, then list which process holds what, over a few minutes
//   MINIMAIL_BENCH_PLAN=doze      watch the real accounts unload on short timers, and one
//                                 without a feed reload out of sight, be read and close again
//   MINIMAIL_BENCH_PLAN=linger    after an account unloads, how soon its memory is really back
//   MINIMAIL_BENCH_PLAN=shot      the main window as a picture for the README: needs
//                                 MINIMAIL_SHOT_OUT, and shows the window (inactive) for ~2s
//   MINIMAIL_BENCH_SHOW=1         also measure with the window shown (inactive) at the end
//   MINIMAIL_BENCH_SWITCHES=...   Chromium switches to try (see main.js)
//   MINIMAIL_BENCH_BLOCK=a,b      also refuse these hosts (to see what a page costs without them)
//   MINIMAIL_BENCH_SHOT=<dir>     write a screenshot of the lower left of each Gmail page there
//
// Unlike the offline modes this loads the user's real, signed-in mail pages, so
// say so before running it. It is built so that it cannot disturb anything:
//
// - it only runs on a COPY of the profile — it refuses the real one — so the
//   installed app keeps running untouched and nothing is written to it;
// - its window is never shown and never takes focus, and toasts and sounds are
//   switched off;
// - every sign-in host is blocked outright, so no sign-in page — and no passkey
//   or Hello prompt — can appear, however many times it runs.
//
// Memory is sampled per process over a fixed timeline, so two runs are
// comparable. Two numbers per process: the private working set (what Task
// Manager's "Memory" column shows, and what the machine can really get back)
// and the commit charge (everything the process holds, resident or pushed out).
const { app, session, nativeImage, screen, desktopCapturer } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SIGNIN_HOSTS = ['accounts.google.com', 'account.proton.me', 'login.proton.me', 'login.live.com', 'account.live.com', 'login.yahoo.com', 'login.aol.com'];
const MB = 1024 * 1024;
const providerOf = (acct) => acct.provider || 'gmail';

let blockedSignIns = [];
let blockedExtra = 0;
function blockHosts(ses, hosts, record) {
  ses.webRequest.onBeforeRequest({ urls: hosts.map((h) => `*://${h}/*`) }, (details, callback) => {
    record(details.url);
    callback({ cancel: true });
  });
}
// What was refused: host and path only, never the query, which can carry tokens.
const where = (url) => {
  try {
    return new URL(url).host + new URL(url).pathname.slice(0, 60);
  } catch {
    return '(unparsed url)';
  }
};

// Private working set per pid. Node cannot read it, so the perf counters are
// asked through PowerShell; one call per sample.
function privateWorkingSet(pids) {
  if (!pids.length) return {};
  const filter = pids.map((p) => `IDProcess=${p}`).join(' OR ');
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "${filter}" | Select-Object IDProcess,WorkingSetPrivate | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true },
  );
  const parsed = JSON.parse(out.trim() || '[]');
  const map = {};
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) map[row.IDProcess] = Number(row.WorkingSetPrivate); // bytes
  return map;
}

// "gmail1", "proton"…: an account's name here. Never the address.
function accountKey(target, index) {
  const acct = target.settings.accounts[index];
  const provider = providerOf(acct);
  return provider + (target.settings.accounts.slice(0, index).filter((a) => providerOf(a) === provider).length + 1);
}

// pid -> account name, for the renderer of each account view, and the shell's.
function roles(target) {
  const map = new Map();
  target.settings.accounts.forEach((acct, i) => {
    const rec = target.views.get(acct.id);
    if (rec && rec.view) map.set(rec.view.webContents.getOSProcessId(), accountKey(target, i));
  });
  if (target.win && !target.win.isDestroyed()) map.set(target.win.webContents.getOSProcessId(), 'shell');
  return map;
}

// Every process, and what it holds: the account a renderer belongs to, or —
// for a process that belongs to no account view — whose frames are in it and
// from which site. A page can pull in processes of its own: a frame from
// another site, a worker, a spare renderer.
function describe(target) {
  const held = new Map(); // pid -> { origins:Set, from:Map(account -> frames) }
  target.settings.accounts.forEach((acct, i) => {
    const rec = target.views.get(acct.id);
    if (!rec || !rec.view) return;
    const key = accountKey(target, i);
    for (const frame of rec.view.webContents.mainFrame.framesInSubtree) {
      const pid = frame.osProcessId;
      if (!held.has(pid)) held.set(pid, { origins: new Set(), from: new Map() });
      const h = held.get(pid);
      let origin = '(no page)';
      try {
        origin = new URL(frame.url).origin;
      } catch {
        /* about:blank and the like */
      }
      h.origins.add(origin);
      h.from.set(key, (h.from.get(key) || 0) + 1);
    }
  });
  const who = roles(target);
  const metrics = app.getAppMetrics();
  const ws = privateWorkingSet(metrics.map((m) => m.pid));
  const byPid = new Map(metrics.map((m) => [m.pid, m]));
  console.log(`[bench]   ${'pid'.padEnd(7)} ${'resident'.padStart(8)} ${'commit'.padStart(7)}  what`);
  for (const m of [...metrics].sort((a, b) => (ws[b.pid] || 0) - (ws[a.pid] || 0))) {
    const h = held.get(m.pid);
    const frames = h ? [...h.from].map(([account, n]) => `${n} frame(s) of ${account}`).join(', ') + ': ' : '';
    const sites = h ? [...h.origins].filter((o) => o !== 'null').slice(0, 4).join(' ') : '';
    console.log(
      `[bench]   ${String(m.pid).padEnd(7)} ${((ws[m.pid] || 0) / MB).toFixed(1).padStart(8)} ${(m.memory.privateBytes / 1024).toFixed(1).padStart(7)}  ${(who.get(m.pid) || m.name || m.serviceName || m.type).padEnd(15)} ${frames}${sites}`,
    );
  }
}

async function sample(target, seconds, phase) {
  const metrics = app.getAppMetrics();
  const ws = privateWorkingSet(metrics.map((m) => m.pid));
  const who = roles(target);
  const byRole = new Map();
  let total = 0;
  let commit = 0;
  let other = 0; // renderers that belong to no account view: another site's frame, a worker, a spare renderer
  for (const m of metrics) {
    const mb = (ws[m.pid] || 0) / MB;
    total += mb;
    commit += m.memory.privateBytes / 1024;
    let role = who.get(m.pid);
    if (!role) role = m.type === 'Browser' ? 'main' : m.type === 'GPU' ? 'gpu' : m.type === 'Utility' ? m.name || 'utility' : 'other-renderer';
    if (role === 'other-renderer') other++;
    byRole.set(role, (byRole.get(role) || 0) + mb);
  }
  const parts = [...byRole].sort((a, b) => b[1] - a[1]).map(([role, mb]) => `${role} ${mb.toFixed(1)}`);
  const cpu = metrics.reduce((sum, m) => sum + (m.cpu.percentCPUUsage || 0), 0);
  console.log(
    `[bench] t=${String(seconds).padStart(3)}s ${phase.padEnd(9)} resident ${total.toFixed(1).padStart(6)} MB  commit ${commit.toFixed(1).padStart(6)} MB  procs ${String(metrics.length).padStart(2)}  |  ${parts.join('  ')}  |  cpu ${cpu.toFixed(1)}%`,
  );
  return { t: seconds, phase, resident: +total.toFixed(1), commit: +commit.toFixed(1), byRole: Object.fromEntries(byRole), processes: metrics.length, otherRenderers: other };
}

// Through the DevTools protocol, which can ask a page to do what Chromium does
// on its own only under real memory pressure. Attached for the one call, and
// never for long: a command that does not come back must not hold the run.
async function protocol(wc, method, params) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} did not answer within 15s`)), 15000);
  });
  const call = (async () => {
    wc.debugger.attach('1.3');
    try {
      return await wc.debugger.sendCommand(method, params);
    } finally {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    }
  })();
  try {
    return await Promise.race([call, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function shot(wc, file) {
  // The lower left of a Gmail page: where its Meet box sits. CSS pixels.
  const res = await protocol(wc, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 500, width: 260, height: 300, scale: 1 } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
}

// The two unloading switches, on short timers, on the real pages: what they
// free, and — the point — what the service without a feed reports when it is
// loaded out of sight, read and closed. Proton Mail shows "Inbox | …" (no
// number) before "(3957) Inbox | …" on every load; none of that may come out
// as new mail.
async function dozeTimeline(target, accounts, at) {
  const toasts = [];
  target.setNotifier((_id, _title, text) => toasts.push(text));
  Object.assign(process.env, { MINIMAIL_SLEEP_MS: '20000', MINIMAIL_DOZE_MS: '9000' });
  target.settings.sleepAccounts = true;
  target.settings.dozeOthers = true;
  target.reconcile();
  const state = (acct) => {
    const r = target.views.get(acct.id);
    return (r.checking ? 'CHECKING' : r.view ? 'loaded' : 'unloaded').padEnd(9);
  };
  const when = (ms) => `${(ms / 1000).toFixed(1)}s`;
  for (const s of [12, 19, 24, 31, 34, 38, 44, 48, 53, 60]) {
    await at(s, 'doze');
    console.log(`[bench]   ${accounts.map((a, i) => `${accountKey(target, i)} ${state(a)} count=${target.views.get(a.id).count}`).join(' | ')}   notifications raised: ${JSON.stringify(toasts)}`);
  }
  const first = target.settings.accounts.find((a) => (a.provider || 'gmail') !== 'gmail');
  const rec = first && target.views.get(first.id);
  if (rec) console.log(`[bench]   ${accountKey(target, target.settings.accounts.indexOf(first))}: checks ended with seen=${rec.checkSeen}, paused=${rec.checkPaused}`);
  console.log('[bench] settle settings used: ' + JSON.stringify({ settleMs: Number(process.env.MINIMAIL_SETTLE_MS) || 2500, zeroHoldMs: Number(process.env.MINIMAIL_ZERO_MS) || 8000 }));
}

// Unloading an account is only worth what it gives back, when it gives it
// back: after a page with frames from other sites in it (Gmail with Google
// Chat and Meet) is closed, do their processes go with it — and how soon?
async function lingerTimeline(target, accounts, at) {
  await at(25, 'all-loaded');
  describe(target);
  // Unload the background Gmail account the way the app does, with one thing
  // varied: how its page is closed. "close" lets the page run its unload
  // handlers; "destroy" does not.
  const how = process.env.MINIMAIL_BENCH_UNLOAD || 'close';
  const index = accounts.findIndex((a, i) => i > 0 && (a.provider || 'gmail') === 'gmail');
  const acct = accounts[index];
  const rec = target.views.get(acct.id);
  const pid = rec.view.webContents.getOSProcessId();
  target.win.contentView.removeChildView(rec.view);
  rec.view.webContents[how]();
  rec.view = null;
  target.reconcile();
  console.log(`[bench]   ${accountKey(target, index)} (renderer pid ${pid}) unloaded with ${how}()`);
  for (const s of [28, 31, 34, 38, 43, 50, 60, 75, 95]) {
    await at(s, 'after-unload');
    const ws = privateWorkingSet([pid]);
    const alive = app.getAppMetrics().some((m) => m.pid === pid);
    const who = roles(target);
    const rest = app
      .getAppMetrics()
      .filter((m) => m.type === 'Tab' && !who.has(m.pid) && m.pid !== pid)
      .map((m) => `${((ws[m.pid] || 0) / MB).toFixed(0)}MB`);
    console.log(`[bench]   ${String(s - 25).padStart(3)}s after: its renderer ${alive ? `still alive, ${((ws[pid] || 0) / MB).toFixed(0)} MB` : 'gone'}   other renderers: ${rest.join(' ') || 'none'}`);
  }
}

// The main window as a picture for the README. Real pages, so everything above
// applies (a copy of the profile, sign-in hosts refused, toasts off), and what
// is private stays out of the picture two ways. Minimail's own chrome — title
// bar, sidebar — shows made-up account names, counts and no photos. The mail
// page is pixelated wherever mail is, and those places are read from the
// page's own layout rather than looked for by eye, so nobody has to see the
// mail to hide it. The window is shown, without focus, for about two seconds.
const DEMO_LABELS = ['alex@gmail.com', 'sam@northwind.co', 'riley@proton.me', 'casey@yahoo.com', 'jordan@outlook.com', 'taylor@aol.com'];
const DEMO_COUNTS = [3, 0, 12, 0, 0, 0];
const PIXEL = 9; // one pixelated block, in CSS pixels

// Where the private parts of a page are, in its own coordinates. For a service
// not listed here the whole page is pixelated. The rule for Gmail is built on
// two things its page certainly has — the header (logo, search, icons) and the
// folder column — rather than on guesses about the rest of its layout: below
// the toolbar row, everything is hidden. What stays visible is the header (its
// account chip aside), the Compose button and the toolbar's left-hand controls.
// A catch-all then hides any text that says how much mail there is, how much is
// stored, when the account was last used, or an address, wherever it is.
const WHOLE_VIEW = '({ zones: [{ x: 0, y: 0, w: innerWidth, h: innerHeight }], vw: innerWidth, vh: innerHeight })';
const PRIVATE_ZONES = {
  gmail: `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const shown = (sel) => [...document.querySelectorAll(sel)].filter(visible);
    const box = (el) => { const q = el.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; };
    const union = (els) => {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const el of els) { const q = el.getBoundingClientRect(); l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); }
      return r === -Infinity ? null : { x: l, y: t, w: r - l, h: b - t };
    };
    const zones = [];
    const folders = union(shown('div[role="navigation"] a, div[role="navigation"] [role="treeitem"]'));
    if (folders) zones.push({ x: 0, y: folders.y, w: folders.x + folders.w, h: innerHeight - folders.y }); // the whole folder column, from the first folder down
    const left = folders ? folders.x + folders.w : 0; // where the folder column ends
    const header = document.querySelector('header[role="banner"], header');
    const headerBottom = header ? header.getBoundingClientRect().bottom : 100;
    const toolbar = document.querySelector('[role="toolbar"], [gh="tm"]');
    const bar = toolbar && toolbar.getBoundingClientRect();
    const toolbarBottom = bar && bar.top >= headerBottom - 4 && bar.top <= headerBottom + 40 ? Math.min(bar.bottom, headerBottom + 80) : headerBottom + 58;
    zones.push({ x: left, y: toolbarBottom, w: innerWidth - left, h: innerHeight - toolbarBottom }); // everything under the toolbar row
    zones.push({ x: (left + innerWidth) / 2, y: headerBottom, w: (innerWidth - left) / 2, h: toolbarBottom - headerBottom }); // the toolbar row's right end, where counts are
    for (const el of shown('[role="tablist"], a[aria-label*="Google Account"], [email], [data-hovercard-id], img[src^="https://lh3.googleusercontent.com"]')) zones.push(box(el));
    const tell = /\\d+\\s*[–-]\\s*\\d+\\s*of\\s*[\\d,.]+|\\d+(?:\\.\\d+)?%\\s*of\\s*[\\d,.]+\\s*[GTM]B|[GTM]B\\s+used|account\\s+activity|[\\w.+-]+@[\\w-]+\\.[\\w.-]+/;
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || seen.has(el) || el.children.length > 12 || !tell.test(el.textContent)) continue;
      seen.add(el); // tested as a whole: "1–50 of 362,255" and "10% of 10,244 GB used" are split across elements
      if (visible(el)) zones.push(box(el));
    }
    return { zones, vw: innerWidth, vh: innerHeight };
  })()`,
};

// Replaces each block of a region with its average colour: unreadable, and
// it reads as "hidden on purpose" rather than as a smudge.
function pixelate(image, rects, block) {
  const { width, height } = image.getSize();
  const from = image.toBitmap();
  const into = Buffer.from(from);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x - block / 2));
    const y0 = Math.max(0, Math.floor(r.y - block / 2));
    const x1 = Math.min(width, Math.ceil(r.x + r.w + block / 2));
    const y1 = Math.min(height, Math.ceil(r.y + r.h + block / 2));
    for (let by = y0; by < y1; by += block) {
      for (let bx = x0; bx < x1; bx += block) {
        const bw = Math.min(block, x1 - bx);
        const bh = Math.min(block, y1 - by);
        let blue = 0;
        let green = 0;
        let red = 0;
        for (let y = by; y < by + bh; y++) for (let x = 0, i = (y * width + bx) * 4; x < bw; x++, i += 4) (blue += from[i]), (green += from[i + 1]), (red += from[i + 2]);
        const n = bw * bh;
        blue = Math.round(blue / n);
        green = Math.round(green / n);
        red = Math.round(red / n);
        for (let y = by; y < by + bh; y++) for (let x = 0, i = (y * width + bx) * 4; x < bw; x++, i += 4) (into[i] = blue), (into[i + 1] = green), (into[i + 2] = red);
      }
    }
  }
  return nativeImage.createFromBitmap(into, { width, height });
}

// Draws `over` onto `base` with its top-left corner at (x, y). Both opaque.
function composite(base, over, x, y) {
  const { width, height } = base.getSize();
  const size = over.getSize();
  const into = base.toBitmap();
  const from = over.toBitmap();
  for (let row = 0; row < size.height && y + row < height; row++) {
    const to = ((y + row) * width + x) * 4;
    from.copy(into, to, row * size.width * 4, row * size.width * 4 + Math.min(size.width, width - x) * 4);
  }
  return nativeImage.createFromBitmap(into, { width, height });
}

// A page that is not painting (just shown without focus, or covered by another
// window) may refuse to be captured the first few times it is asked.
async function retrying(what, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await what();
    } catch (err) {
      last = err;
      await sleep(500);
    }
  }
  throw last;
}

// The window's own content area, as Windows has it on screen — which works
// whether or not it is covered.
async function captureWindow(win) {
  const bounds = win.getBounds();
  const content = win.getContentBounds();
  const scale = screen.getDisplayMatching(bounds).scaleFactor;
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) } });
  const handle = win.getNativeWindowHandle().readBigUInt64LE().toString();
  const mine = sources.find((s) => s.id === `window:${handle}:0`);
  if (!mine) throw new Error('the window is not among those that can be captured');
  const per = mine.thumbnail.getSize().width / bounds.width; // pixels per point
  const crop = (v) => Math.round(v * per);
  return mine.thumbnail.crop({ x: crop(content.x - bounds.x), y: crop(content.y - bounds.y), width: crop(content.width), height: crop(content.height) });
}

async function shotTimeline(target, accounts) {
  const out = process.env.MINIMAIL_SHOT_OUT;
  if (!out) throw new Error('set MINIMAIL_SHOT_OUT to the PNG to write');
  const win = target.win;
  const work = screen.getPrimaryDisplay().workAreaSize;
  win.setContentSize(Math.min(1440, work.width - 80), Math.min(900, work.height - 80));
  win.center();
  await sleep(15000); // the pages up, and the first probes for profile photos over

  // Minimail's own chrome: made-up names, counts and switches, and no photos.
  // (Not saved: this is the copy's settings, and they are put back by nothing.)
  accounts.forEach((acct, i) => {
    acct.label = DEMO_LABELS[i] || `account${i + 1}@example.com`;
    acct.avatar = null;
    acct.notify = { count: true, sound: true, banner: true };
    const rec = target.views.get(acct.id);
    clearInterval(rec.pollTimer); // the count stays what it is set to here
    rec.count = DEMO_COUNTS[i] || 0;
  });
  target.updateBadge();
  target.pushAccounts();
  await sleep(700); // the sidebar has redrawn

  const id = target.settings.activeId;
  const view = target.views.get(id).view;
  const shown = target.settings.accounts.findIndex((a) => a.id === id);
  const zones = await view.webContents.executeJavaScript(PRIVATE_ZONES[providerOf(accounts[shown])] || WHOLE_VIEW);
  const at = view.getBounds();
  // For when a region is not where it was meant to be: where each one is (never what is in it).
  if (process.env.MINIMAIL_BENCH_DEBUG) console.log(`[bench] page ${zones.vw}x${zones.vh}; hidden regions: ${JSON.stringify(zones.zones.map((z) => [z.x, z.y, z.w, z.h].map(Math.round)))}`);

  win.showInactive(); // on screen, but focus stays where the user left it
  await sleep(2000); // painted
  let picture;
  let how = 'page by page';
  try {
    const chrome = await retrying(() => win.webContents.capturePage());
    const mail = await retrying(() => view.webContents.capturePage());
    const per = mail.getSize().width / zones.vw;
    picture = composite(chrome, mail, Math.round(at.x * per), Math.round(at.y * per));
  } catch (err) {
    // A page that is covered is not painting, and will not be captured: take
    // the window as a whole instead.
    how = `the window as a whole (a page would not be captured: ${String(err).slice(0, 60)})`;
    picture = await captureWindow(win);
  }
  win.hide();

  const per = picture.getSize().width / win.getContentSize()[0]; // pixels per point
  const rects = zones.zones.map((z) => ({ x: (z.x + at.x) * per, y: (z.y + at.y) * per, w: z.w * per, h: z.h * per }));
  picture = pixelate(picture, rects, Math.max(4, Math.round(PIXEL * per)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, picture.toPNG());
  console.log(`[bench] saved ${out} (${picture.getSize().width}x${picture.getSize().height}); ${rects.length} region(s) of the mail page pixelated; captured ${how}`);
}

async function measure(target) {
  // Nothing may reach the screen or the speakers.
  target.setNotifier(() => {});
  target.setSound(() => {});
  target.setOpener(async () => {});
  target.setProviderMenu(() => {});
  target.setMuteMenu(() => {});
  target.settings.sleepAccounts = false; // measure pages that are loaded and left alone

  const accounts = target.settings.accounts;
  const extra = (process.env.MINIMAIL_BENCH_BLOCK || '').split(',').map((h) => h.trim()).filter(Boolean);
  for (const acct of accounts) {
    const ses = session.fromPartition('persist:' + acct.id);
    blockHosts(ses, SIGNIN_HOSTS, (url) => blockedSignIns.push(where(url)));
    if (extra.length) blockHosts(ses, extra, () => blockedExtra++);
  }
  blockHosts(session.defaultSession, SIGNIN_HOSTS, (url) => blockedSignIns.push(where(url)));
  // Start at the mail app itself. Signed in, it loads; signed out, it redirects
  // to a sign-in host — which is blocked, so that is where the page stops.
  target.PROVIDERS.gmail.start = 'https://mail.google.com/mail/u/0/';
  target.PROVIDERS.proton.start = 'https://mail.proton.me/';

  const plan = process.env.MINIMAIL_BENCH_PLAN || 'purge';
  console.log(`[bench] electron ${process.versions.electron}, chromium ${process.versions.chrome}, ${accounts.length} account(s), plan ${plan}`);
  console.log(`[bench] switches: ${process.env.MINIMAIL_BENCH_SWITCHES || '(none)'}   extra hosts refused: ${extra.join(', ') || '(none)'}`);

  const t0 = Date.now();
  for (const [i, acct] of accounts.entries()) {
    target.ensureRecord(acct.id);
    target.wakeView(acct.id);
    target.views.get(acct.id).view.setVisible(i === 0); // as in the app: one showing, the rest behind it
  }
  // How long until each page first shows its Inbox: what reloading it costs.
  // (What an "unload and check every few minutes" account would pay each time.)
  const seen = new Set();
  const firstInbox = setInterval(() => {
    for (const [i, acct] of accounts.entries()) {
      const rec = target.views.get(acct.id);
      if (rec && rec.signedIn && !seen.has(acct.id)) {
        seen.add(acct.id);
        console.log(`[bench] inbox title first seen: ${accountKey(target, i)} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
    if (Date.now() - t0 > 60000) clearInterval(firstInbox);
  }, 500);
  const at = async (s, phase) => {
    const wait = t0 + s * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    return sample(target, s, phase);
  };
  const samples = [];
  if (plan === 'linger') return lingerTimeline(target, accounts, at);
  if (plan === 'shot') return shotTimeline(target, accounts);
  if (plan === 'doze') {
    for (const s of [5, 10]) samples.push(await at(s, 'loaded'));
    await dozeTimeline(target, accounts, at);
    describe(target);
    return;
  }
  for (const s of [15, 30, 45, 60]) samples.push(await at(s, 'hidden'));

  if (plan === 'frames') {
    // Do the extra processes stay while the pages are left alone and hidden?
    for (const s of [60, 180, 300]) {
      await at(s, 'hidden');
      describe(target);
    }
  } else {
    for (const s of [90, 120]) samples.push(await at(s, 'hidden'));
  }

  if (process.env.MINIMAIL_BENCH_SHOT) {
    for (const [i, acct] of accounts.entries()) {
      const rec = target.views.get(acct.id);
      if (providerOf(acct) !== 'gmail' || !rec || !rec.view) continue;
      const file = path.join(process.env.MINIMAIL_BENCH_SHOT, `gmail${(accounts.slice(0, i).filter((a) => providerOf(a) === 'gmail').length) + 1}.png`);
      await shot(rec.view.webContents, file).then(
        () => console.log(`[bench] screenshot: ${file}`),
        (err) => console.log(`[bench] screenshot not taken: ${String(err).slice(0, 160)}`),
      );
    }
  }

  const pages = accounts.map((a) => target.views.get(a.id).view).filter(Boolean).map((v) => v.webContents);
  if (plan === 'purge' && pages.length) {
    // 1. A full garbage collection of one page only.
    await protocol(pages[0], 'HeapProfiler.collectGarbage', {});
    for (const s of [135, 150]) samples.push(await at(s, 'gc-one'));
    if (pages[1]) {
      // 2. What Chromium tells every process when memory is getting short.
      await protocol(pages[1], 'Memory.simulatePressureNotification', { level: 'moderate' });
      for (const s of [165, 180, 195]) samples.push(await at(s, 'pressure'));
      await protocol(pages[1], 'Memory.simulatePressureNotification', { level: 'critical' });
      for (const s of [210, 225]) samples.push(await at(s, 'critical'));
    }
  }

  if (process.env.MINIMAIL_BENCH_SHOW === '1' && target.win && !target.win.isDestroyed()) {
    target.win.showInactive(); // on screen, but focus stays where the user left it
    await sleep(1000);
    for (const [s, phase] of [[125, 'shown-5s'], [145, 'shown-25s'], [175, 'shown-55s']]) samples.push(await at(s + (plan === 'plain' ? 0 : 110), phase));
    target.win.hide();
  }

  describe(target);
  // Is the marker that says "a compose box is open in this page" (Gmail's
  // g_editable) absent from a page that just shows the Inbox? If it were not,
  // Minimail could never safely unload a Gmail page it is showing.
  for (const [i, acct] of accounts.entries()) {
    const rec = target.views.get(acct.id);
    const wc = rec && rec.view ? rec.view.webContents : null;
    if (providerOf(acct) !== 'gmail' || !wc) continue;
    const open = await wc.executeJavaScript('!!document.querySelector(\'[g_editable="true"]\')', false).catch((err) => 'error: ' + String(err).slice(0, 80));
    console.log(`[bench] compose marker on ${accountKey(target, i)} (Inbox showing): ${open}`);
  }
  // Where each page ended up. A sign-in host cannot appear here: it is blocked.
  for (const [i, acct] of accounts.entries()) {    const rec = target.views.get(acct.id);
    const wc = rec && rec.view ? rec.view.webContents : null;
    let host = 'unloaded';
    if (wc) {
      try {
        host = new URL(wc.getURL()).host || '(no page)';
      } catch {
        host = '(no page)';
      }
    }
    const title = wc ? wc.getTitle().replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<address>').slice(0, 60) : '';
    console.log(`[bench] ${accountKey(target, i)}: ${host}  inboxSeen=${!!(rec && rec.signedIn)}  "${title}"`);
  }
  for (const [what, list] of [['sign-in', [...new Set(blockedSignIns)]], ['extra', [`${blockedExtra} request(s)`]]]) {
    if (list.length) console.log(`[bench] refused ${what} host requests: ${list.slice(0, 8).join(' | ')}`);
  }
  console.log(`[bench] ${samples.length} samples`);
  console.log('[bench] ' + JSON.stringify(samples));
}

function run(_flag, target) {
  if (process.env.MINIMAIL_ALLOW_ACCOUNT_PAGES !== '1') {
    console.log('[bench] not run: this mode loads your real mail pages (in a hidden window, on a copy of the profile).');
    console.log('[bench] say so, then re-run with MINIMAIL_ALLOW_ACCOUNT_PAGES=1 and MINIMAIL_BENCH_PROFILE=<copy>.');
    return app.exit(0);
  }
  // A run that throws must report why and exit, not sit there until the watchdog.
  measure(target)
    .then(() => app.exit(0))
    .catch((err) => {
      console.log(`[bench] FAIL  the run threw: ${String((err && err.stack) || err).slice(0, 600)}`);
      process.exit(5);
    });
}

// Last resort, like the other modes: never sit there until someone kills it.
setTimeout(() => {
  console.log('[bench] FAIL  the run did not finish within 9 minutes');
  process.exit(4);
}, 9 * 60000).unref();

module.exports = { run };
