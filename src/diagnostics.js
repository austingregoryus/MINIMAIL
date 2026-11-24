'use strict';
// Developer diagnostics, opt-in via a CLI flag. None of this runs in normal use.
//
//   --autotest    Offline smoke test in a throwaway profile: the shell bridge, the
//                 IPC guards, view geometry, the account payload, the download toast.
//   --experiment  Offline end-to-end flows against a lab on 127.0.0.1: downloads,
//                 popups, link handling, compose windows, shortcuts, unread
//                 counts and new-mail detection (title-based and feed-based),
//                 auto-sleep, and leaving by closing the window.
//   --shot        Renders the shell (or, with SHOT=settings, the settings window)
//                 from an isolated copy of the real settings; prints layout metrics
//                 and writes a PNG (SHOT_OUT).
//   --probe       Reports on the real, signed-in profile: counts, avatars, and —
//                 in a hidden window — where the start URL and a compose link lead.
//   --online      ASK THE USER FIRST. The only mode that loads a mail service's
//                 real sign-in page, which puts sign-in prompts (passkeys, Hello,
//                 authenticator pushes) on their screen. Refuses to run unless
//                 MINIMAIL_ALLOW_SIGNIN_PAGES=1 is set.
//
// "Offline" is meant literally: the offline modes register their own services,
// whose start URL, compose link and feed are all served from 127.0.0.1, and
// they record toasts and "open in the browser" calls instead of showing them.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session, nativeImage } = require('electron');
const { createRiseTracker, parseWebmailTitle, parseProtonTitle } = require('./parsers');
const { composeQuery } = require('./providers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RUN_LIMIT_MINUTES = 6;

function checklist(tag) {
  const results = [];
  const list = {
    check(name, ok, detail) {
      results.push(!!ok);
      console.log(`[${tag}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`);
    },
    // Print the tally without exiting; the caller decides how to leave.
    done() {
      clearTimeout(watchdog);
      const failed = results.filter((r) => !r).length;
      console.log(`[${tag}] ${results.length - failed}/${results.length} checks passed`);
      return failed;
    },
    finish() {
      const failed = list.done();
      app.exit(failed ? 1 : 0);
      setTimeout(() => process.exit(failed ? 1 : 0), 5000); // a hard stop if app.exit() were ever to hang
    },
  };
  // A run that stops without reporting — a thrown error nobody caught, a wait
  // that never ends — must still end, and say why.
  const watchdog = setTimeout(() => {
    console.log(`[${tag}] FAIL  the run did not finish within ${RUN_LIMIT_MINUTES} minutes`);
    process.exit(4);
  }, RUN_LIMIT_MINUTES * 60000);
  return list;
}

// Leaves through the same door a user does — closing the window — and fails
// loudly if the process is still alive afterwards: a leftover process holding
// the single-instance lock would make the next launch appear to do nothing.
async function quitLikeAUser(target, suite) {
  suite.check('every window but the main one is closed', BrowserWindow.getAllWindows().length === 1, windowList().join(' | '));
  const failed = suite.done() ? 1 : 0;
  const watchdog = setTimeout(() => {
    console.log('[exp] FAIL  the process is still running 8s after the window was closed');
    process.exit(3);
  }, 8000);
  const quitting = new Promise((resolve) => app.once('will-quit', resolve));
  target.win.close();
  await quitting;
  clearTimeout(watchdog);
  app.exit(failed);
}

const windowList = () =>
  BrowserWindow.getAllWindows().map((w) => `${w.id}:${w.isVisible() ? 'visible' : 'hidden'}:${w.webContents.getURL().slice(0, 48) || '""'}`);

const METRICS = `(() => {
  const rect = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 };
  };
  return {
    dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight,
    titlebar: rect('#titlebar'), sidebar: rect('#sidebar'), accounts: rect('#accounts'),
    acct: rect('.acct'), add: rect('#add'), gear: rect('#settings'), collapse: rect('#collapse'),
    contentHeight: Math.ceil(document.body.getBoundingClientRect().bottom),
    scrollbar: window.innerWidth - document.documentElement.clientWidth,
    account: (document.getElementById('account') || {}).textContent,
    unreadChip: (document.getElementById('unread') || {}).textContent,
    logoLoaded: !!(document.getElementById('logo') && document.getElementById('logo').naturalWidth),
    toast: (() => {
      const t = document.getElementById('dl-toast');
      return t ? { shown: t.classList.contains('show'), file: document.getElementById('dl-file').textContent, right: rect('#dl-toast').right } : null;
    })(),
  };
})()`;

// ---------------------------------------------------------------------------
// The lab: mail services that exist only on 127.0.0.1
// ---------------------------------------------------------------------------

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Three stand-ins for real services. `localfeed` behaves like Gmail (a feed
// that works with the page closed), `local` like Outlook/Yahoo/Proton (page
// title only), and `localbare` additionally has no compose link, like Proton.
async function setupLab(target) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'test', 'download-page.html'));
  const lab = { hits: [], feed: { count: 0, entries: [] } };
  const server = http.createServer((req, res) => {
    lab.hits.push({ path: req.url, at: Date.now() });
    if (req.url === '/feed') {
      res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(
        `<feed><title>Inbox</title><fullcount>${lab.feed.count}</fullcount>` +
          lab.feed.entries.map((e) => `<entry><title>${escapeXml(e.subject)}</title><id>tag:lab,2004:${escapeXml(e.id)}</id><name>${escapeXml(e.sender)}</name><email>x@y.z</email></entry>`).join('') +
          '</feed>',
      );
    }
    if (req.url === '/redirect-to-inbox' || req.url === '/redirect-away') {
      res.writeHead(302, { location: req.url === '/redirect-to-inbox' ? '/inbox' : 'https://outside.example.test/redirect' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  lab.base = `http://127.0.0.1:${server.address().port}`;
  lab.url = (route, query) => `${lab.base}/${route}${query || ''}`;
  lab.close = () => new Promise((resolve) => server.close(resolve));

  const shared = { mailHosts: ['127.0.0.1'], hosts: ['127.0.0.1'], testOrigin: lab.base, inbox: parseWebmailTitle, color: '#2bb673' };
  Object.assign(target.PROVIDERS, {
    local: {
      ...shared,
      id: 'local',
      name: 'Local test service',
      short: 'Local',
      start: lab.url('start'),
      compose: (mailto) => {
        const query = composeQuery(mailto);
        return query === null ? null : lab.url('compose', '?' + query);
      },
    },
    localbare: { ...shared, id: 'localbare', name: 'Local test service, no compose link', short: 'Local', start: lab.url('start') },
    // The lab page, read with Proton Mail's title parser.
    localproton: { ...shared, id: 'localproton', name: 'Local test service, Proton Mail titles', short: 'Local', start: lab.url('start'), inbox: parseProtonTitle },
    localfeed: { ...shared, id: 'localfeed', name: 'Local test service with a feed', short: 'Local', start: lab.url('start'), feed: { url: lab.url('feed'), cookiesFor: lab.base } },
  });
  return lab;
}

// "Offline" is enforced, not merely intended: every request the app tries to
// make beyond 127.0.0.1 is cancelled and recorded, so a mistake in this file
// cannot reach a real sign-in page.
const offMachine = [];
const guarded = new WeakSet();
function enforceOffline() {
  app.on('web-contents-created', (_e, wc) => {
    const ses = wc.session;
    if (guarded.has(ses)) return;
    guarded.add(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (/^(https?:\/\/127\.0\.0\.1(?::\d+)?\/|file:|data:|blob:|about:|devtools:)/i.test(details.url)) return callback({});
      offMachine.push(details.url.slice(0, 120));
      callback({ cancel: true });
    });
  });
}

async function runOffline(target, body) {
  enforceOffline();
  const toasts = [];
  const sounds = [];
  const muteMenus = { mute: [] };
  const opened = [];
  target.setNotifier((id, title, text, icon, opts) => toasts.push({ id, title, text, silent: !!opts.silent }));
  target.setSound(() => sounds.push(Date.now()));
  target.setMuteMenu((x, y) => muteMenus.mute.push({ x, y }));
  target.setOpener((url) => {
    opened.push(String(url));
    return Promise.resolve();
  });
  process.env.MINIMAIL_POLL_MS = '1500'; // the lab's feed is polled briskly
  const lab = await setupLab(target);
  try {
    return await body({ lab, toasts, sounds, muteMenus, opened, offMachine });
  } finally {
    await lab.close();
  }
}

// ---------------------------------------------------------------------------
// --autotest
// ---------------------------------------------------------------------------

async function autotest(target) {
  const suite = checklist('autotest');
  const { check } = suite;
  await runOffline(target, async ({ lab, offMachine, muteMenus, toasts, sounds }) => {
    await sleep(1500);
    const wc = target.win.webContents;
    const run = (code) => wc.executeJavaScript(code);
    check('the shell bridge is exposed', (await run('typeof window.minimail')) === 'object');
    const listed = await run('window.minimail.list()');
    check('accounts:list returns { accounts, prefs }', Array.isArray(listed.accounts) && typeof listed.prefs.prefetchAccounts === 'boolean', JSON.stringify(listed).slice(0, 110));
    const unknown = await run('window.minimail.setPref("notARealKey", true)');
    check('prefs:set ignores unknown keys', !('notARealKey' in unknown));
    const badType = await run('window.minimail.setPref("showBadge", "yes")');
    check('prefs:set ignores non-boolean values', typeof badType.showBadge === 'boolean');
    const version = await run('window.minimail.getVersion()');
    check('app:version resolves', typeof version === 'string' && version.length > 0, version);

    // The "+" button must ask which mail service, where it was clicked. The
    // menu itself is recorded rather than opened.
    const menus = [];
    target.setProviderMenu((x, y) => menus.push({ x, y }));
    const plus = await run(`(() => {
      const r = document.getElementById('add').getBoundingClientRect();
      const x = Math.round(r.left + 5), y = Math.round(r.top + 5);
      document.getElementById('add').dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
      return { x, y };
    })()`);
    await sleep(300);
    check('the + button asks which mail service, at the click position', menus.length === 1 && menus[0].x === plus.x && menus[0].y === plus.y, JSON.stringify(menus));

    const { PROVIDER_ORDER } = require('./providers');
    const { dotImage } = require('./badge');
    const sizes = PROVIDER_ORDER.map((id) => {
      const image = dotImage(target.PROVIDERS[id].color);
      const size = image.getSize();
      return `${id} ${size.width}x${size.height}${image.isEmpty() ? ' EMPTY' : ''}`;
    });
    check('every mail service has a usable menu icon', sizes.every((s) => s.endsWith('16x16')), sizes.join(', '));
    check('the menu lists the services, Gmail first', PROVIDER_ORDER.join(',') === 'gmail,outlook,outlook-work,yahoo,aol,proton' && PROVIDER_ORDER.every((id) => target.PROVIDERS[id]?.name), PROVIDER_ORDER.map((id) => target.PROVIDERS[id]?.name || id).join(' | '));

    const id = target.addAccount('local');
    const view = target.views.get(id).view.webContents;
    for (let i = 0; i < 100 && !(view.getURL().startsWith(lab.base) && !view.isLoading()); i++) await sleep(100);
    check('an account view loads its service\u2019s start page', view.getURL().endsWith('/start'), view.getURL());
    const b = target.views.get(id).view.getBounds();
    check('the view sits beside the sidebar, below the title bar', b.x === 56 && b.y === 40 && b.width > 500 && b.height > 400, JSON.stringify(b));
    const me = (await run('window.minimail.list()')).accounts.find((a) => a.id === id);
    check('the sidebar is told which service the account is on', me && me.provider === 'local' && /^hsl\(/.test(me.color) && me.active, JSON.stringify(me));

    // --- the service badge on an avatar --------------------------------------------------
    // What an avatar shows: its letter (text directly in the button), whether the
    // service's mark fills it, and what its badge carries.
    const avatarOf = (label) =>
      run(`(() => {
        const b = [...document.querySelectorAll('.acct')].find((el) => el.title.startsWith(${JSON.stringify(label)}));
        if (!b) return null;
        const badge = b.querySelector('.provider');
        const path = badge && badge.querySelector('svg path');
        return {
          letter: [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''),
          photo: !!b.querySelector('img'),
          filledByMark: !!b.querySelector('svg.mark'),
          badge: badge ? (path ? path.getAttribute('d') : badge.textContent) : null,
          badgeColour: badge ? badge.style.background : null,
        };
      })()`);
    check('a freshly added account with no outline shows the service\u2019s initial, and no badge', JSON.stringify(await avatarOf('Local')) === JSON.stringify({ letter: 'L', photo: false, filledByMark: false, badge: null, badgeColour: null }), JSON.stringify(await avatarOf('Local')));

    // The real services' marks, sent to the shell the way the main process does.
    const { PROVIDERS: P } = require('./providers');
    const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const fake = (over) => ({ id: 'fake-' + over.label, label: over.label, avatar: over.avatar || null, color: 'hsl(0 0% 40%)', provider: over.provider, providerName: P[over.provider].short || P[over.provider].name, providerColor: P[over.provider].color, mark: over.mark !== undefined ? over.mark : P[over.provider].mark, count: 0, active: false, asleep: false, loading: false });
    const show = async (...accounts) => {
      wc.send('state:changed', { accounts, prefs: listed.prefs });
      await sleep(350);
    };

    await show(fake({ label: 'Proton Mail', provider: 'proton' }));
    let a = await avatarOf('Proton Mail');
    check('a freshly added Proton account shows the Proton mark as its avatar', a && a.filledByMark && a.badge === null, JSON.stringify(a));
    await run("document.querySelector('.acct').focus()");
    await show({ ...fake({ label: 'Proton Mail', provider: 'proton' }), count: 3 });
    check('an unread update keeps focus on the same account button', await run("document.activeElement === document.querySelector('.acct')"));
    check('the hidden download toast cannot take focus', await run("document.getElementById('dl-open').focus(); document.activeElement.id !== 'dl-open'"));

    await show(fake({ label: 'example@proton.me', provider: 'proton' })); // the usual Proton case: address known, never a photo
    a = await avatarOf('example@proton.me');
    check('a Proton account known by its address shows its initial, with a Proton badge', a && a.letter === 'E' && a.badge === P.proton.mark && a.badgeColour === 'rgb(109, 74, 255)', JSON.stringify(a));

    await show(fake({ label: 'someone@gmail.com', provider: 'gmail', avatar: PIXEL }));
    a = await avatarOf('someone@gmail.com');
    check('a Gmail account with a photo shows the photo, with a Gmail badge', a && a.photo && a.badge === P.gmail.mark && a.badgeColour === 'rgb(234, 67, 53)', JSON.stringify(a));

    await show(fake({ label: 'someone@outlook.com', provider: 'outlook' }));
    a = await avatarOf('someone@outlook.com');
    check('a service without an outline shows its initial on the badge', a && a.badge === 'O', JSON.stringify(a));

    // Nothing but an outline of drawing commands may be drawn into the page.
    await show(fake({ label: 'evil@example.com', provider: 'proton', mark: '"><img src=x onerror=window.__pwned=1>' }));
    a = await avatarOf('evil@example.com');
    const injected = await run(`!!document.querySelector('.acct img[src="x"]') || !!window.__pwned`);
    check('a "mark" that is not an outline is not put into the page', a && a.badge === 'P' && injected === false, JSON.stringify(a));

    await show([]); // leave the shell empty again for the checks below
    await run('window.minimail.list()').then((real) => wc.send('state:changed', real));

    // --- each account's switches --------------------------------------------------------
    const saved = await run(`window.minimail.setAccountPref(${JSON.stringify(id)}, 'count', false)`);
    check('an account\u2019s "unread count" switch can be turned off', JSON.stringify(saved) === JSON.stringify({ count: false, sound: true, banner: true }), JSON.stringify(saved));
    let listed2 = await run('window.minimail.list()');
    check('…and the sidebar is told not to show its number', listed2.accounts[0].showCount === false && listed2.accounts[0].notify.count === false, JSON.stringify(listed2.accounts[0].notify));
    // A count of 5 with the switch off must not draw the red number.
    const pillShown = async (showCount) => {
      const state = await run('window.minimail.list()');
      state.accounts = [{ ...state.accounts[0], count: 5, showCount }];
      wc.send('state:changed', state);
      await sleep(300);
      return run(`!!document.querySelector('.acct .dot')`);
    };
    check('…so no number is drawn on its avatar', (await pillShown(false)) === false);
    check('…while it is drawn when the switch is on', (await pillShown(true)) === true);
    const refused = [await run(`window.minimail.setAccountPref(${JSON.stringify(id)}, 'nope', false)`), await run(`window.minimail.setAccountPref('no-such-account', 'sound', false)`), await run(`window.minimail.setAccountPref(${JSON.stringify(id)}, 'sound', 'yes')`)];
    check('a switch that does not exist, an unknown account, or a value that is not on/off is refused', refused.every((r) => r === null || r === undefined) && (await run('window.minimail.list()')).accounts[0].notify.sound === true, JSON.stringify(refused));

    // --- the global mute -------------------------------------------------------------------
    await run(`(() => { const r = document.getElementById('mute').getBoundingClientRect(); document.getElementById('mute').dispatchEvent(new MouseEvent('click', { clientX: r.left + 4, clientY: r.top + 4, bubbles: true })); return true; })()`);
    await sleep(300);
    check('the speaker button asks for how long to mute, beside itself', muteMenus.mute.length === 1 && muteMenus.mute[0].x > 0 && muteMenus.mute[0].y > 0, JSON.stringify(muteMenus.mute));
    const until = await run(`window.minimail.setMute(Date.now() + 30 * 60000)`);
    check('muting for a while is remembered and reported to the sidebar', until.mutedUntil > Date.now() + 29 * 60000, JSON.stringify(until));
    const mutedLook = await run(`({ muted: document.getElementById('mute').classList.contains('muted'), title: document.getElementById('mute').title })`);
    check('…the speaker lights up as muted, with the time left in its tooltip', mutedLook.muted === true && /muted — \d+ minutes left/.test(mutedLook.title), JSON.stringify(mutedLook));
    const forever = await run(`window.minimail.setMute(8640000000000000)`);
    check('…"until I turn it back on" has no end time', forever.mutedUntil === 8640000000000000 && /until you turn them back on/.test(await run(`document.getElementById('mute').title`)), JSON.stringify(forever));
    const off = await run('window.minimail.setMute(0)');
    check('…and it turns back off', off.mutedUntil === 0 && (await run(`document.getElementById('mute').classList.contains('muted')`)) === false, JSON.stringify(off));
    const past = await run('window.minimail.setMute(Date.now() - 1000)');
    check('a mute that already ran out is not a mute', past.mutedUntil === 0, JSON.stringify(past));
    check('nothing made a sound or popped up during this', toasts.length === 0 && sounds.length === 0, `${toasts.length} banners, ${sounds.length} sounds`);

    if (process.env.MINIMAIL_FAKE_DL) {
      wc.send('download:done', { file: path.basename(process.env.MINIMAIL_FAKE_DL), path: process.env.MINIMAIL_FAKE_DL });
      await sleep(600);
      const toast = (await wc.executeJavaScript(METRICS)).toast;
      check('the download toast is shown with the file name', toast && toast.shown && toast.file === path.basename(process.env.MINIMAIL_FAKE_DL), JSON.stringify(toast));
    }
    await sleep(300);
    check('exactly one window is open', BrowserWindow.getAllWindows().length === 1, windowList().join(' | '));
    check('nothing was requested from outside this machine', offMachine.length === 0, offMachine.slice(0, 4).join(' | '));
  }).catch((err) => check('the run itself completed without throwing', false, String((err && err.stack) || err).slice(0, 400)));
  suite.finish();
}

// ---------------------------------------------------------------------------
// --experiment
// ---------------------------------------------------------------------------

async function experiment(target) {
  const suite = checklist('exp');
  const { check } = suite;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimail-downloads-'));
  process.env.MINIMAIL_DOWNLOADS_DIR = dir; // nothing an experiment downloads can touch the real Downloads folder

  await runOffline(target, async ({ lab, toasts, sounds, opened, offMachine }) => {
    const state = () => target.win.webContents.executeJavaScript('window.minimail.list()');
    const account = async (id) => (await state()).accounts.find((a) => a.id === id);
    const wcOf = (id) => target.views.get(id).view.webContents;
    const onPage = (wc) => wc.getURL().startsWith(lab.base) && !wc.isLoading();
    const add = async (providerId) => {
      const id = target.addAccount(providerId);
      for (let i = 0; i < 100 && !onPage(wcOf(id)); i++) await sleep(100);
      return id;
    };
    const until = async (condition, ms = 8000) => {
      for (let i = 0; i < ms / 100 && !condition(); i++) await sleep(100);
      return condition();
    };
    const setTitle = async (wc, title) => {
      await wc.executeJavaScript(`document.title = ${JSON.stringify(title)}`);
      await sleep(350);
    };
    const closeExtras = async () => {
      for (const w of BrowserWindow.getAllWindows()) if (w !== target.win) w.close();
      await sleep(600);
    };
    const composeHits = () => lab.hits.filter((h) => h.path.startsWith('/compose?')).map((h) => h.path);

    const id = await add('local');
    const wc = wcOf(id);
    check('mail pages get no bridge', (await wc.executeJavaScript('typeof window.minimail')) === 'undefined');
    const mine = await account(id);
    check('a new account reports its service and takes the service\u2019s colour', mine.provider === 'local' && mine.providerName === 'Local' && /^hsl\(1[0-9][0-9] /.test(mine.color), JSON.stringify(mine));

    // --- downloads -------------------------------------------------------------------------
    const files = () => fs.readdirSync(dir).sort();
    await wc.executeJavaScript('popupBlob()');
    await sleep(500);
    console.log('[exp]   popup opened: ' + windowList().join(' | '));
    await sleep(4000);
    check('window.open(blob:) downloads the file', files().length === 1, files().join(', '));
    check('…and its hidden window is closed afterwards', BrowserWindow.getAllWindows().length === 1, windowList().join(' | '));

    await wc.executeJavaScript('anchorBlob("minimail-test-b.txt")');
    await sleep(3000);
    check('<a download> keeps its file name', files().includes('minimail-test-b.txt'), files().join(', '));

    const before = files().length;
    await wc.executeJavaScript('navigateBlob()');
    await sleep(3500);
    check('a main-frame blob navigation becomes a download', files().length === before + 1, files().join(', '));
    check('…without navigating the page away', wc.getURL().endsWith('/start'), wc.getURL());

    await wc.executeJavaScript('anchorBlob("minimail-test-c.txt"); anchorBlob("minimail-test-c.txt")');
    await sleep(3500);
    check('two same-named downloads at once do not overwrite each other', files().includes('minimail-test-c.txt') && files().includes('minimail-test-c (1).txt'), files().join(', '));
    const contents = fs.readFileSync(path.join(dir, 'minimail-test-c (1).txt'), 'utf8');
    check('…and both files have real contents', contents.includes('minimail-test-c.txt'), JSON.stringify(contents));
    check('no download shell windows are left behind', BrowserWindow.getAllWindows().length === 1, windowList().join(' | '));
    if (process.platform === 'win32') {
      await wc.executeJavaScript('anchorBlob("minimail-case.txt"); anchorBlob("MINIMAIL-CASE.TXT")');
      check('case variants use separate download paths on Windows', await until(() => files().filter((file) => /^minimail-case.*\.txt$/i.test(file)).length === 2));
    }

    // --- popups and links -------------------------------------------------------------------
    const blank = await wc.executeJavaScript('blankPopup()');
    await sleep(2000);
    check('a page may open an about:blank window of its own', blank === true && BrowserWindow.getAllWindows().length === 2, windowList().join(' | '));
    await closeExtras();

    await wc.executeJavaScript("location.href = 'https://outside.example.test/article'");
    await sleep(900);
    check('a link outside the service goes to the browser, and the page stays put', wc.getURL().endsWith('/start') && opened.includes('https://outside.example.test/article'), `${wc.getURL()} | opened: ${opened.join(', ')}`);
    await wc.executeJavaScript(`location.href = ${JSON.stringify(lab.url('inbox'))}`);
    await until(() => onPage(wc) && wc.getURL().endsWith('/inbox'));
    await wc.loadURL(lab.url('redirect-to-inbox'));
    check('a server redirect within the service stays in the account', wc.getURL() === lab.url('inbox'));
    await wc.loadURL(lab.url('redirect-away')).catch(() => {});
    check('an off-provider server redirect is blocked without launching the browser', wc.getURL() === lab.url('inbox') && opened.length === 1);
    check('a link inside the service stays in the account view', wc.getURL().endsWith('/inbox'), wc.getURL());

    // --- unread count and new mail from the page title (Outlook, Yahoo, Proton) --------------
    const rec = target.views.get(id);
    rec.rise = createRiseTracker(300, 1000); // settle in 0.3 s; a drop must outlast each 0.35 s step below to count
    const toastsFor = (accountId) => toasts.filter((t) => t.id === accountId).map((t) => t.text);
    await setTitle(wc, 'Inbox (5) - Local Mail');
    check('the Inbox title sets the unread count', (await account(id)).count === 5);
    await sleep(450);
    await setTitle(wc, 'Inbox (8) - Local Mail');
    check('a rise in that count is new mail', JSON.stringify(toastsFor(id)) === JSON.stringify(['3 new messages']), JSON.stringify(toastsFor(id)));
    await setTitle(wc, 'Inbox (0) - Local Mail');
    await setTitle(wc, 'Inbox (8) - Local Mail');
    check('a count that dips and bounces back is not', toastsFor(id).length === 1 && (await account(id)).count === 8, JSON.stringify(toastsFor(id)));
    await setTitle(wc, 'Re: quarterly numbers - Local Mail');
    check('with a conversation open the count is unknown, not zero', (await account(id)).count === 8);
    await setTitle(wc, '(2) Inbox - Local Mail');
    check('…and it follows once an Inbox is showing again, in either order', (await account(id)).count === 2);
    await setTitle(wc, 'Inbox (2) - someone@example.com - Local Mail');
    const named = await account(id);
    check('the account is named after the address in its title', named.label === 'someone@example.com' && /^hsl\(\d+ 45% 42%\)$/.test(named.color), `${named.label} | ${named.color}`);

    // --- the same path in Proton Mail's title format -----------------------------------------
    const protonId = await add('localproton');
    const pwc = wcOf(protonId);
    target.views.get(protonId).rise = createRiseTracker(300, 1000);
    await setTitle(pwc, '(5) Inbox | someone@proton.me | Proton Mail');
    const proton = await account(protonId);
    check('Proton Mail\u2019s title gives the count and the address', proton.count === 5 && proton.label === 'someone@proton.me', `${proton.count} | ${proton.label}`);
    await sleep(450);
    await setTitle(pwc, '(8) Inbox | someone@proton.me | Proton Mail');
    check('…and a rise in it is new mail', JSON.stringify(toastsFor(protonId)) === JSON.stringify(['3 new messages']), JSON.stringify(toastsFor(protonId)));
    await setTitle(pwc, 'Archive | someone@proton.me | Proton Mail');
    check('…another folder leaves the inbox count alone', (await account(protonId)).count === 8);
    await setTitle(pwc, '(1) Inbox | someone@proton.me | Proton Mail');
    await setTitle(pwc, 'Inbox | someone@proton.me | Proton Mail');
    check('…and an Inbox with no number means nothing is unread', (await account(protonId)).count === 0);

    // --- each account's switches, and the global mute ---------------------------------------
    target.switchTo(id);
    const notifyOf = (accountId) => target.settings.accounts.find((a) => a.id === accountId).notify;
    const bannersFor = (accountId) => toasts.filter((t) => t.id === accountId);
    let level = 30;
    const moreMail = async () => {
      await setTitle(wc, `Inbox (${++level}) - someone@example.com - Local Mail`);
      await sleep(250);
    };
    await moreMail(); // a first rise settles the tracker at this level; what it reports is not under test
    await sleep(450);
    await moreMail();
    check('with every switch on, new mail is a pop-up that sounds', bannersFor(id).at(-1).silent === false && sounds.length === 0, JSON.stringify(bannersFor(id).at(-1)));

    Object.assign(notifyOf(id), { sound: false });
    const banners1 = bannersFor(id).length;
    await moreMail();
    check('…with sound off, the pop-up is silent', bannersFor(id).length === banners1 + 1 && bannersFor(id).at(-1).silent === true && sounds.length === 0, JSON.stringify(bannersFor(id).at(-1)));

    Object.assign(notifyOf(id), { sound: true, banner: false });
    const banners2 = bannersFor(id).length;
    await moreMail();
    check('…with the pop-up off but sound on, only a sound is played', bannersFor(id).length === banners2 && sounds.length === 1, `${bannersFor(id).length - banners2} banners, ${sounds.length} sounds`);

    Object.assign(notifyOf(id), { sound: false, banner: false });
    const banners3 = bannersFor(id).length;
    await moreMail();
    check('…with both off, nothing at all happens for that account', bannersFor(id).length === banners3 && sounds.length === 1, `${bannersFor(id).length - banners3} banners, ${sounds.length} sounds`);

    Object.assign(notifyOf(id), { sound: true, banner: true });
    target.setMute(Date.now() + 60 * 60000);
    const banners4 = bannersFor(id).length;
    await moreMail();
    await moreMail();
    check('the global mute silences sound and pop-up together', bannersFor(id).length === banners4 && sounds.length === 1, `${bannersFor(id).length - banners4} banners, ${sounds.length} sounds`);
    check('…while the unread count keeps counting', (await account(id)).count === level);
    check('…and other accounts are silenced too', notifyOf(protonId) && target.settings.mutedUntil > Date.now());

    target.setMute(0);
    await moreMail();
    check('turning the mute off brings notifications straight back', bannersFor(id).length === banners4 + 1, `${bannersFor(id).length - banners4} banners`);

    target.setMute(Date.now() + 1500);
    for (let i = 0; i < 40 && (await state()).prefs.mutedUntil !== 0; i++) await sleep(100);
    check('a timed mute runs out on its own', (await state()).prefs.mutedUntil === 0);
    const banners5 = bannersFor(id).length;
    await moreMail();
    check('…and notifications resume when it does', bannersFor(id).length === banners5 + 1, `${bannersFor(id).length - banners5} banners`);

    // --- the Settings window: one row per account, with its three switches -----------------
    target.openSettings();
    for (let i = 0; i < 60 && !target.settingsWin; i++) await sleep(100);
    const sw = target.settingsWin.webContents;
    const waitRows = async () => {
      for (let i = 0; i < 80 && !(await sw.executeJavaScript('document.querySelectorAll(".acc-row").length').catch(() => 0)); i++) await sleep(100);
      await sleep(400);
    };
    await waitRows();
    const rowIndex = target.settings.accounts.findIndex((a) => a.id === id);
    const switches = (row, column) => sw.executeJavaScript(`(() => { const b = document.querySelectorAll('.acc-row')[${row}].querySelectorAll('.toggle')[${column}]; return { on: b.classList.contains('on'), label: b.getAttribute('aria-label') }; })()`);
    const clickSwitch = async (row, column) => {
      await sw.executeJavaScript(`document.querySelectorAll('.acc-row')[${row}].querySelectorAll('.toggle')[${column}].click()`);
      await sleep(400);
    };
    check('Settings shows one row per account, with three switches each', (await sw.executeJavaScript('document.querySelectorAll(".acc-row").length')) === target.settings.accounts.length && (await sw.executeJavaScript('document.querySelectorAll(".acc-row")[0].querySelectorAll(".toggle").length')) === 3);
    check('…each switch saying which account and setting it is', JSON.stringify(await switches(rowIndex, 2)) === JSON.stringify({ on: true, label: 'someone@example.com: Pop-up' }), JSON.stringify(await switches(rowIndex, 2)));
    const beforeClick = target.settings.accounts.map((a) => ({ ...a.notify }));
    await clickSwitch(rowIndex, 1); // Sound
    check('clicking a switch in Settings saves it, for that account only', notifyOf(id).sound === false && target.settings.accounts.every((a, i) => a.id === id || JSON.stringify(a.notify) === JSON.stringify(beforeClick[i])));
    check('…and the switch shows the saved state', (await switches(rowIndex, 1)).on === false);
    await clickSwitch(rowIndex, 1);
    check('…and clicking again turns it back on', notifyOf(id).sound === true && (await switches(rowIndex, 1)).on === true);
    target.settingsWin.close();
    await sleep(600);

    // --- compose windows --------------------------------------------------------------------
    target.switchTo(id);
    target.openMailTo('mailto:a@b.com?subject=Hi&body=There');
    await sleep(2500);
    check('a compose window opens in the account\u2019s session', composeHits().length === 1 && composeHits()[0].includes('to=a%40b.com') && composeHits()[0].includes('subject=Hi'), composeHits().join(' | '));
    check('…leaving the account view where it was', wc.getURL().endsWith('/inbox'));
    await closeExtras();

    const fresh = await add('local'); // a second account of the same service, not signed in yet
    const earlier = composeHits().length;
    target.openMailTo('mailto:c@d.com?subject=Later');
    await sleep(3500);
    check('for an account that has not signed in yet: sign in first, then compose', composeHits().length === earlier + 1 && composeHits()[earlier].includes('to=c%40d.com'), composeHits().join(' | '));
    await sleep(3000);
    check('…exactly once (it must not reload the compose on every page load)', composeHits().length === earlier + 1, composeHits().join(' | '));
    await closeExtras();

    const bare = await add('localbare');
    const windows = BrowserWindow.getAllWindows().length;
    target.openMailTo('mailto:x@y.z');
    await sleep(900);
    check('a service without a compose link just switches to the account', BrowserWindow.getAllWindows().length === windows && target.settings.activeId === bare);

    // --- Ctrl+Shift+B: the page's own bold / add-Bcc shortcut wherever you can type ----------
    // Focus is moved explicitly: a synthetic mouse click does not move focus in
    // a view that has been hidden and shown again by account switching (a real
    // click activates the window first). The clicks are still sent, because the
    // app re-checks focus after every mouse-up and after plain typing.
    target.switchTo(id);
    wc.focus();
    const start = target.settings.sidebarCollapsed;
    const pressSidebarShortcut = async (source = wc) => {
      source.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control', 'shift'] });
      source.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['control', 'shift'] });
      await sleep(400);
    };
    const clickAt = async (selector) => {
      const r = await wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(600);
    };
    const typePlain = async () => {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'C' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'C' });
      await sleep(600);
    };
    const focused = () =>
      wc.executeJavaScript('({ tag: document.activeElement && document.activeElement.tagName, editable: !!(document.activeElement && document.activeElement.isContentEditable) })');

    // Clicked into a text field, then the shortcut.
    await wc.executeJavaScript("document.querySelector('#typing').focus()");
    await clickAt('#typing');
    await pressSidebarShortcut();
    check('Ctrl+Shift+B in a text field is left to the page', target.settings.sidebarCollapsed === start, 'focused: ' + JSON.stringify(await focused()));

    // The field was opened by typing (Gmail\u2019s "c"), with no click at all.
    await wc.executeJavaScript("document.activeElement.blur(); document.body.focus()");
    await typePlain();
    await wc.executeJavaScript("document.querySelector('#typing').focus()");
    await typePlain();
    await pressSidebarShortcut();
    check('…also when the field was reached by typing, not clicking', target.settings.sidebarCollapsed === start, 'focused: ' + JSON.stringify(await focused()));

    // Clicked away onto the page, then the shortcut.
    await wc.executeJavaScript("document.activeElement.blur()");
    await clickAt('#heading');
    await pressSidebarShortcut();
    check('Ctrl+Shift+B stays with the mail page outside a text field too', target.settings.sidebarCollapsed === start);
    const shellWc = target.win.webContents;
    shellWc.focus();
    await pressSidebarShortcut(shellWc);
    check('Ctrl+Shift+B in the Minimail shell toggles the sidebar', target.settings.sidebarCollapsed !== start);
    await pressSidebarShortcut(shellWc);
    check('…and toggles back', target.settings.sidebarCollapsed === start);

    // --- a service with a feed (the Gmail path) ---------------------------------------------
    lab.feed = { count: 12, entries: [{ id: '1', sender: 'Ann', subject: 'First' }] };
    const feedId = await add('localfeed'); // becomes the active account
    await until(() => target.views.get(feedId).feedState === 'ok');
    check('an account with a feed is polled while it is open', target.views.get(feedId).feedState === 'ok');
    check('…its count comes from the feed', (await account(feedId)).count === 12);
    check('…and the first poll is a silent baseline', toastsFor(feedId).length === 0, JSON.stringify(toastsFor(feedId)));
    lab.feed = { count: 14, entries: [{ id: '3', sender: 'Cy', subject: 'Third' }, { id: '2', sender: 'Bob', subject: 'Second' }, { id: '1', sender: 'Ann', subject: 'First' }] };
    await until(() => toastsFor(feedId).length > 0);
    check('new feed entries raise one toast with sender and subject', JSON.stringify(toastsFor(feedId)) === JSON.stringify(['Cy: Third (+1 more)']), JSON.stringify(toastsFor(feedId)));
    lab.feed = { count: 10, entries: [{ id: '3', sender: 'Cy', subject: 'Third' }] }; // two were read
    await sleep(2500);
    check('reading or archiving mail raises nothing', toastsFor(feedId).length === 1 && (await account(feedId)).count === 10, JSON.stringify(toastsFor(feedId)));

    // --- auto-sleep: only a service with a feed can be unloaded -----------------------------
    target.switchTo(id); // the others are in the background now
    target.sleepView(bare);
    await sleep(400);
    check('a service without a feed is never unloaded (it could not be checked)', !!target.views.get(bare).view);
    target.sleepView(feedId);
    await sleep(500);
    const slept = await account(feedId);
    check('a service with a feed unloads in the background', !target.views.get(feedId).view && slept.asleep === true, JSON.stringify(slept));
    lab.feed = { count: 13, entries: [{ id: '5', sender: 'Eve', subject: 'Fifth' }, { id: '4', sender: 'Dee', subject: 'Fourth' }, { id: '3', sender: 'Cy', subject: 'Third' }] };
    await until(() => toastsFor(feedId).length > 1);
    check('…and still notifies for new mail while unloaded', JSON.stringify(toastsFor(feedId)[1]) === JSON.stringify('Eve: Fifth (+1 more)'), JSON.stringify(toastsFor(feedId)));
    check('…with its count keeping up', (await account(feedId)).count === 13);
    target.switchTo(feedId);
    const woken = target.views.get(feedId);
    check('switching to it reloads it', !!woken.view && woken.loading === true);
    await sleep(4000);
    check('…and clears the loading state once the page is up', woken.loading === false);
    await setTitle(woken.view.webContents, 'Inbox (7) - Local Mail');
    target.switchTo(id);
    target.sleepView(feedId);
    const stale = await account(feedId);
    check('the last Inbox count is marked stale when its page unloads', stale.count === 7 && stale.countStale && stale.asleep);

    // --- dozing: a service with no feed, unloaded and checked out of sight (a switch) ---------
    const shell = (code) => target.win.webContents.executeJavaScript(code);
    const setPref = (key, value) => shell(`window.minimail.setPref(${JSON.stringify(key)}, ${value})`);
    const inWindow = (v) => target.win.contentView.children.includes(v);
    // Time is simulated with short intervals: idle before unloading, between
    // checks, how long a count has to hold, and how long a check may last.
    const timings = { MINIMAIL_SLEEP_MS: '1200', MINIMAIL_DOZE_MS: '1200', MINIMAIL_SETTLE_MS: '500', MINIMAIL_ZERO_MS: '1500', MINIMAIL_CHECKIN_MS: '6000' };
    Object.assign(process.env, timings);
    const protonRec = () => target.views.get(protonId);
    target.switchTo(id); // the Proton-titled account is in the background now
    await setPref('dozeOthers', true);
    check('once "doze" is on, a service with no feed unloads like the others', await until(() => !protonRec().view), `still loaded: ${!!protonRec().view}`);

    // A check: the page comes back, out of sight, is read, and is closed again.
    await until(() => protonRec().checking);
    const midCheck = protonRec().view;
    const listed = await account(protonId);
    check('…then comes back out of sight to look for new mail', protonRec().checking && !!midCheck && !inWindow(midCheck), JSON.stringify(listed));
    check('…counting as unloaded the while (there is nothing to click away from)', listed.asleep === true && listed.loading === false, JSON.stringify(listed));
    await midCheck.webContents.executeJavaScript('blankPopup()'); // nobody is looking at this page: it may not put a window on screen
    await midCheck.webContents.executeJavaScript("location.href = 'https://outside.example.test/check'");
    await sleep(900);
    check('…and it may not open windows of its own', BrowserWindow.getAllWindows().length === 1, windowList().join(' | '));
    check('…and it may not open the browser either', opened.length === 1);
    const beforeCheck = toastsFor(protonId).length;
    await setTitle(midCheck.webContents, '(5) Inbox | someone@proton.me | Proton Mail');
    const sawRise = () => toastsFor(protonId).length > beforeCheck && JSON.stringify(toastsFor(protonId).slice(beforeCheck)) === JSON.stringify(['5 new messages']);
    check('…reporting the new mail it saw', await until(sawRise), JSON.stringify(toastsFor(protonId).slice(beforeCheck)));
    check('…and closing its page again', await until(() => !protonRec().checking && !protonRec().view));
    check('…with its count brought up to date', (await account(protonId)).count === 5, JSON.stringify(await account(protonId)));

    // Proton Mail shows "Inbox | …" (no number) before "(1200) Inbox | …" on
    // every load, and shows nothing at all for an empty Inbox.
    await until(() => protonRec().checking);
    await setTitle(protonRec().view.webContents, 'Inbox | someone@proton.me | Proton Mail');
    await until(() => !protonRec().checking);
    check('an empty Inbox, once it has held, is taken as read', (await account(protonId)).count === 0, JSON.stringify(await account(protonId)));
    check('…and raised nothing', toastsFor(protonId).length === beforeCheck + 1, JSON.stringify(toastsFor(protonId)));

    await until(() => protonRec().checking);
    const readPage = protonRec().view.webContents;
    target.switchTo(protonId); // clicked while it was being read
    check('clicking it while it is being read keeps that very page', protonRec().view && !protonRec().checking && protonRec().view.webContents === readPage && inWindow(protonRec().view));
    // From here on it is watched like any open page: the next count is a
    // baseline, and a rise inside the 15 s settling time of a freshly opened
    // page is not new mail.
    await setTitle(readPage, '(4) Inbox | someone@proton.me | Proton Mail');
    await sleep(450);
    await setTitle(readPage, '(6) Inbox | someone@proton.me | Proton Mail');
    check('…and from there it is watched like any open page', (await account(protonId)).count === 6 && toastsFor(protonId).length === beforeCheck + 1, `${(await account(protonId)).count} | toasts: ${toastsFor(protonId).length}`);

    target.switchTo(id);
    await until(() => !protonRec().view); // in the background: unloaded again
    await setPref('dozeOthers', false);
    check('turning "doze" off brings back what it had unloaded without covering the active account', !!protonRec().view && !protonRec().checking && inWindow(protonRec().view) && !protonRec().view.getVisible(), JSON.stringify(await account(protonId)));

    // A zero seen only in passing: the page could not be read long enough to be
    // sure, so the old count stands — and the next rise is counted from it.
    process.env.MINIMAIL_ZERO_MS = '60000'; // longer than a check is allowed to last…
    process.env.MINIMAIL_CHECKIN_MS = '1500'; // …so zero can never be confirmed here
    await setPref('dozeOthers', true);
    await until(() => !protonRec().view);
    await until(() => protonRec().checking);
    await setTitle(protonRec().view.webContents, 'Inbox | someone@proton.me | Proton Mail');
    await until(() => !protonRec().checking);
    check('a zero seen only in passing is not taken for an empty Inbox', (await account(protonId)).count === 6, JSON.stringify(await account(protonId)));
    await until(() => protonRec().checking);
    await setTitle(protonRec().view.webContents, '(8) Inbox | someone@proton.me | Proton Mail');
    await until(() => !protonRec().checking);
    check('…so mail after it is counted from the last count, not from zero', JSON.stringify(toastsFor(protonId).slice(-1)) === JSON.stringify(['2 new messages']), JSON.stringify(toastsFor(protonId).slice(-2)));

    // A check that lands on a sign-in page must not be repeated — reloading a
    // sign-in page over and over is what puts passkey prompts on screen.
    // (about:blank stands in for the sign-in page: off the service's own site.)
    await until(() => protonRec().checking);
    protonRec().view.webContents.loadURL('about:blank').catch(() => {});
    check('a check that ends on a sign-in page stops the checks', await until(() => !protonRec().checking && protonRec().checkPaused), `paused: ${protonRec().checkPaused}`);
    await sleep(1500); // longer than one interval between checks
    check('…for good: nothing is loaded again', !protonRec().checkTimer && !protonRec().view && !protonRec().checking);
    target.switchTo(protonId);
    check('…until the account is opened, which starts over', !!protonRec().view && !protonRec().checkPaused);
    await setPref('dozeOthers', false);
    process.env.MINIMAIL_CHECKIN_MS = '6000';

    // --- "sleep when away": the account on screen, once the window is out of sight -----------
    // The shell reports its page's visibility; this is the call it makes.
    const seen = (visible) => shell(`window.minimail.setVisible(${visible})`);
    target.switchTo(feedId); // the Gmail-like account is showing
    await setPref('sleepWhenAway', true);
    await seen(false); // minimized, or fully covered
    check('the account on screen unloads once the window has been out of sight', await until(() => !target.views.get(feedId).view), JSON.stringify(await account(feedId)));
    await seen(true);
    check('…and comes back as soon as the window is seen again', !!target.views.get(feedId).view && (await account(feedId)).loading === true, JSON.stringify(await account(feedId)));

    target.switchTo(protonId); // a service with no feed: nothing would keep notifying
    await seen(false);
    await sleep(1800); // past the idle time
    check('never the account on screen of a service without a feed', !!protonRec().view);
    await seen(true);

    // Not while something is in progress. No compose marker is known for the
    // lab's services, so a focused text field counts.
    target.switchTo(feedId);
    const shownWc = target.views.get(feedId).view.webContents;
    await until(() => onPage(shownWc));
    await shownWc.executeJavaScript("document.querySelector('#typing').focus()");
    shownWc.sendInputEvent({ type: 'keyDown', keyCode: 'C' }); // the app re-checks focus after plain typing
    shownWc.sendInputEvent({ type: 'keyUp', keyCode: 'C' });
    await sleep(700);
    await seen(false);
    await sleep(1800);
    check('not while a text field of the page has focus', !!target.views.get(feedId).view);

    // …or a window of the account is open (here: a pop-up of its own).
    await shownWc.executeJavaScript("document.activeElement.blur(); blankPopup()");
    await sleep(1200);
    await seen(true);
    await seen(false);
    await sleep(1800);
    check('not while a window of that account is open', !!target.views.get(feedId).view && BrowserWindow.getAllWindows().length === 2, windowList().join(' | '));
    await closeExtras();
    await shownWc.sendInputEvent({ type: 'keyDown', keyCode: 'C' });
    await shownWc.sendInputEvent({ type: 'keyUp', keyCode: 'C' });
    await shownWc.executeJavaScript("document.activeElement.blur()");
    await seen(true);
    await seen(false);
    check('…but once they are gone', await until(() => !target.views.get(feedId).view));
    await seen(true);

    // Gmail's compose body carries g_editable, and nothing else on an Inbox
    // page does (checked on the real pages): a lab service under that name.
    target.PROVIDERS.gmail = { ...target.PROVIDERS.localfeed, id: 'gmail', name: 'Gmail (lab stand-in)' };
    const gmailId = target.addAccount('gmail'); // the showing account now
    const gmailWc = target.views.get(gmailId).view.webContents;
    await until(() => onPage(gmailWc));
    await gmailWc.executeJavaScript("const box = document.createElement('div'); box.id = 'compose-box'; box.setAttribute('g_editable', 'true'); document.body.appendChild(box)");
    target.switchTo(id);
    await sleep(1800);
    check('background auto-sleep also leaves an open draft alone', target.views.get(gmailId).view?.webContents === gmailWc);
    target.switchTo(gmailId);
    await seen(false);
    await sleep(1800);
    check('not while the page has a compose box open', !!target.views.get(gmailId).view);
    await gmailWc.executeJavaScript("document.getElementById('compose-box').remove()");
    await seen(true);
    await seen(false);
    check('…but once it is closed', await until(() => !target.views.get(gmailId).view));
    await seen(true);
    await setPref('sleepWhenAway', false);

    // --- the switches themselves -------------------------------------------------------------
    target.openSettings();
    for (let i = 0; i < 60 && !target.settingsWin; i++) await sleep(100);
    const sw2 = target.settingsWin.webContents; // an earlier Settings window has been and gone
    for (let i = 0; i < 80 && !(await sw2.executeJavaScript('!!document.getElementById("p-dozeOthers")').catch(() => false)); i++) await sleep(100);
    await sleep(400);
    const appSwitch = (key) => sw2.executeJavaScript(`(() => { const b = document.getElementById('p-${key}'); return b && { on: b.classList.contains('on'), label: b.getAttribute('aria-label') }; })()`);
    const dozeSwitch = await appSwitch('dozeOthers');
    check('Settings has a switch for unloading the other services', !!dozeSwitch && dozeSwitch.on === false && dozeSwitch.label.length > 10, JSON.stringify(dozeSwitch));
    check('…and one for unloading the account on screen when away', (await appSwitch('sleepWhenAway')).on === false, JSON.stringify(await appSwitch('sleepWhenAway')));
    await sw2.executeJavaScript("document.getElementById('p-dozeOthers').click()");
    await sleep(400);
    check('…and they save what they are clicked to', target.settings.dozeOthers === true && (await appSwitch('dozeOthers')).on === true);
    await setPref('dozeOthers', false);
    target.settingsWin.close();
    await sleep(600);
    for (const key of Object.keys(timings)) delete process.env[key];
    check('no hidden windows are left behind', BrowserWindow.getAllWindows().every((w) => w.isVisible()), windowList().join(' | '));
    check('nothing was sent to a browser but the one external link', opened.length === 1, opened.join(', '));
    check('nothing was requested from outside this machine', offMachine.length === 0, offMachine.slice(0, 4).join(' | '));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  await quitLikeAUser(target, suite).catch((err) => {
    check('the run itself completed without throwing', false, String((err && err.stack) || err).slice(0, 400));
    suite.finish();
  });
}

// ---------------------------------------------------------------------------
// --shot
// ---------------------------------------------------------------------------

async function shot(target) {
  await sleep(3000);
  if (process.env.MINIMAIL_FAKE_DL) {
    target.win.webContents.send('download:done', { file: path.basename(process.env.MINIMAIL_FAKE_DL), path: process.env.MINIMAIL_FAKE_DL });
  }
  const ofSettings = process.env.SHOT === 'settings';
  if (ofSettings) {
    target.openSettings();
    for (let i = 0; i < 40 && !(target.settingsWin && target.settingsWin.isVisible()); i++) await sleep(100); // it is sized to its content first
  }
  await sleep(2500); // let any resize settle so the capture is not a torn frame
  const w = ofSettings ? target.settingsWin : target.win;
  const metrics = await w.webContents.executeJavaScript(METRICS);
  console.log('[shot] metrics = ' + JSON.stringify(metrics));
  const out = process.env.SHOT_OUT || path.join(os.tmpdir(), ofSettings ? 'minimail-settings-shot.png' : 'minimail-shot.png');
  fs.writeFileSync(out, (await w.webContents.capturePage()).toPNG());
  console.log('[shot] saved ' + out);
  app.exit(0);
}

// ---------------------------------------------------------------------------
// --probe (an explicitly selected profile copy)
// ---------------------------------------------------------------------------

// Runs against the REAL profile, unlike the modes above: reports what the mail
// services actually return for the signed-in accounts and opens one empty
// Gmail compose in a hidden window (an empty compose is never saved as a
// draft). It loads the user's own account pages, so say so before running it.
async function probe(target) {
  await sleep(16000); // accounts loading, first feed poll, first avatar probe
  for (const [index, acct] of target.settings.accounts.entries()) {
    const rec = target.views.get(acct.id);
    if (!rec) continue;
    const size = acct.avatar ? nativeImage.createFromDataURL(acct.avatar).getSize() : null;
    console.log(
      `[probe] account ${index + 1} [${acct.provider || 'gmail'}]: feed=${rec.feedState} feedCount=${rec.feedCount} inboxTitleCount=${rec.titleCount} shown=${rec.count} ` +
        `view=${rec.view ? 'loaded' : 'unloaded'} host=${rec.host} avatar=${size ? size.width + 'x' + size.height : 'none'}`,
    );
  }

  // Any signed-in Gmail account will do; the active one may be signed out.
  const [id] = [...target.views].find(([, r]) => r.feedState === 'ok') || [];
  if (!id) {
    console.log('[probe] no signed-in Gmail account — start URL and compose checks skipped');
    return app.exit(0);
  }
  const ses = session.fromPartition('persist:' + id);
  const gmail = target.PROVIDERS.gmail;
  const slot = gmail.mailboxFromUrl(target.views.get(id).view?.webContents.getURL()) || target.settings.accounts.find((acct) => acct.id === id)?.mailboxSlot || '0';
  const start = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  start.loadURL(gmail.startForMailbox(slot)).catch(() => {});
  await sleep(9000);
  console.log('[probe] start matched the expected mailbox: ' + (gmail.mailboxFromUrl(start.webContents.getURL()) === slot));
  start.destroy();

  const hidden = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await hidden.loadURL(gmail.compose('mailto:', null, slot)).catch(() => {});
  await sleep(8000);
  const info = await hidden.webContents
    .executeJavaScript(`!!document.querySelector('[g_editable="true"]')`)
    .catch(() => false);
  console.log('[probe] signed-in compose -> ' + JSON.stringify(info));
  hidden.destroy();
  app.exit(0);
}

// ---------------------------------------------------------------------------
// --online (real sign-in pages; ask the user first)
// ---------------------------------------------------------------------------

async function online(target) {
  if (process.env.MINIMAIL_ALLOW_SIGNIN_PAGES !== '1') {
    console.log('[online] not run: this mode loads real sign-in pages, which put sign-in prompts on the screen.');
    console.log('[online] ask the user first, then re-run with MINIMAIL_ALLOW_SIGNIN_PAGES=1');
    return app.exit(0);
  }
  const suite = checklist('online');
  const { check } = suite;
  console.log('[online] loading Google\u2019s sign-in page in a throwaway profile — expect passkey prompts');
  const trace = (webContents, label, ms) =>
    new Promise((resolve) => {
      const hops = [];
      webContents.on('did-navigate', (_e, url) => hops.push('= ' + String(url)));
      webContents.on('did-start-navigation', (d) => {
        if (d.isMainFrame) hops.push(String(d.url));
      });
      setTimeout(() => {
        const line = hops
          .join('  >  ')
          .replace(/\?continue=[^&]*/g, '')
          .replace(/&(?:emr|followup|osid|passive|flowName|flowEntry|dsh|theme|ifkv)=[^&]*/g, '');
        console.log(`[online]     ${label}\n[online]         ${line.slice(0, 230)}\n[online]         title: "${webContents.getTitle().slice(0, 40)}"`);
        resolve();
      }, ms);
    });

  await sleep(1500);
  const id = target.addAccount('gmail');
  await sleep(9000);
  const wc = target.views.get(id).view.webContents;
  const url = wc.getURL();
  check("a fresh Gmail account reaches Google's sign-in page", /accounts\.google\.com.*service=mail/.test(url), url.slice(0, 90));
  await trace(wc, 'the app\u2019s start URL — signed out, a later visit', 7000);
  check('a signed-out account gets the sign-in page, however often it reloads', /^https:\/\/accounts\.google\.com\//.test(wc.getURL()), wc.getURL().slice(0, 90));

  target.openMailTo('mailto:test@example.com?subject=Hello');
  await sleep(6000);
  const compose = BrowserWindow.getAllWindows().find((w) => w !== target.win);
  check('mailto: for a signed-out account opens the sign-in page, not an ad', compose && /^https:\/\/accounts\.google\.com\//.test(compose.webContents.getURL()), compose ? compose.webContents.getURL().slice(0, 90) : 'no window');
  suite.finish();
}

function run(flag, target) {
  const task =
    flag === '--autotest' ? autotest(target)
    : flag === '--shot' ? shot(target)
    : flag === '--probe' ? probe(target)
    : flag === '--online' ? online(target)
    : experiment(target);
  // Last resort, for every mode: a run that throws or never reaches its end
  // reports why and exits, instead of sitting there until someone kills it.
  task.catch((err) => {
    console.log(`[harness] FAIL  ${flag} threw: ${String((err && err.stack) || err).slice(0, 600)}`);
    process.exit(5);
  });
  setTimeout(() => {
    console.log(`[harness] FAIL  ${flag} did not finish within ${RUN_LIMIT_MINUTES + 2} minutes`);
    process.exit(4);
  }, (RUN_LIMIT_MINUTES + 2) * 60000).unref();
}

module.exports = { run };
