'use strict';
// --bench: what the real mail pages cost in memory.
//
//   MINIMAIL_ALLOW_ACCOUNT_PAGES=1 MINIMAIL_BENCH_PROFILE=<a copy of the profile> npx electron . --bench
//   MINIMAIL_BENCH_PLAN=plain     skip the purge steps: just settle, and measure
//   MINIMAIL_BENCH_PLAN=frames    settle, then list which process holds what, over a few minutes
//   MINIMAIL_BENCH_PLAN=doze      watch the real accounts unload on short timers, and one
//                                 without a feed reload out of sight, be read and close again
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
const { app, session } = require('electron');
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
