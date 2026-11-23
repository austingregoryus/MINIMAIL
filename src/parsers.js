'use strict';
// Pure helpers with no Electron dependency, so they can be unit-tested with
// plain node (`npm test`). Everything here parses text that comes from Gmail
// or from web pages, i.e. untrusted input — none of it is ever executed.

// Gmail's title is "<location> (<unread>) - <account> - <product>" while a
// folder that has unread mail is open, "<location> - <account> - <product>"
// while that folder has none, and "<subject> - <account> - <product>" while a
// conversation is. Only an Inbox title carries the inbox count, and the number
// is grouped by locale ("216,447", "1 234", "1.234"). Returns null for every
// other title: "unknown", not "zero" — and 0 for an Inbox with nothing unread.
// The separator is required so a subject such as "Inbox (2) is full" is not
// mistaken for a count.
function parseInboxCount(title) {
  const counted = /^Inbox\s*\(([\d.,\s\u00a0\u202f]+)\)\s+[-\u2013\u2014]\s/.exec(title);
  if (counted) {
    const n = Number(counted[1].replace(/\D/g, ''));
    return Number.isSafeInteger(n) ? n : null;
  }
  return /^Inbox\s+[-\u2013\u2014]\s/.test(title) ? 0 : null;
}

// The account is the last "-"- or "|"-separated part that is exactly an email
// address, so subjects that happen to contain one are never mistaken for it.
// (Proton separates the parts of its title with " | ", the others with " - ".)
function parseEmail(title) {
  const parts = String(title).split(/\s+(?:[-\u2013\u2014]|\|)\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parts[i])) return parts[i].toLowerCase();
  }
  return null;
}

// Every other web mail app puts the unread count next to the word "Inbox" at
// the start of the title, in either order: "Inbox (3) - you@x.com - Outlook"
// or "(3) Inbox - Yahoo Mail". Returns null for any other title, and 0 for an
// Inbox with nothing unread. The exact wording of each provider has not been
// confirmed against a signed-in page — Proton has its own parser below.
function parseWebmailTitle(title) {
  const m = /^Inbox\s*\(([\d.,\s\u00a0\u202f]+)\)/.exec(title) || /^\(([\d.,\s\u00a0\u202f]+)\)\s*Inbox\b/.exec(title);
  const count = m ? Number(m[1].replace(/\D/g, '')) : /^Inbox\s+[-\u2013\u2014|]\s/.test(title) ? 0 : NaN;
  return Number.isSafeInteger(count) ? { count, email: parseEmail(title) } : null;
}

// Proton Mail, taken from its own source (useMailboxPageTitle.ts):
//   "(3) Inbox | you@proton.me | Proton Mail"
// The count is left out when nothing is unread — and also when Proton's "Show
// unread count in favicon" setting is on, which therefore has to stay off.
// Proton's title follows the folder being viewed, not whether a conversation
// is open, so the count keeps updating while you read.
function parseProtonTitle(title) {
  const m = /^(?:\(([\d.,]+)\)\s+)?Inbox\s+\|\s+.+?\|\s+Proton Mail$/.exec(title);
  if (!m) return null;
  const count = m[1] === undefined ? 0 : Number(m[1].replace(/\D/g, ''));
  return Number.isSafeInteger(count) ? { count, email: parseEmail(title) } : null;
}

function decodeXml(s) {
  if (!s) return '';
  const codePoint = (match, n) => {
    const cp = Number(n);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(m, parseInt(h, 16)))
    .replace(/&#(\d+);/g, codePoint)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Gmail's atom feed (https://mail.google.com/mail/feed/atom): newest unread
// inbox threads first, at most 20 of them, plus the total unread count.
// Returns null for anything that is not a Gmail feed (sign-in pages, errors).
function parseFeed(xml) {
  const count = Number((/<fullcount>(\d+)<\/fullcount>/.exec(xml) || [])[1]);
  if (!Number.isSafeInteger(count)) return null;
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const field = (tag) => {
      const f = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(m[1]);
      return f ? decodeXml(f[1]).trim() : '';
    };
    entries.push({ id: field('id'), sender: field('name'), email: field('email'), subject: field('title') });
  }
  return { count, entries };
}

// Folds a freshly polled feed into an account's state and reports what is new.
//
//   state               the account's record; reads and writes seenKeys, count,
//                       feedCount, and reads titleCount, hasView, titleAt, pollAt
//   opts.countedByTitle the page title has already added this arrival to the count
//   opts.retries        polls still allowed when the title saw new mail that the
//                       feed has not listed yet (the feed can lag by a few seconds)
//
// Returns { fresh, retry }: the entries never seen before, and whether to poll
// again shortly. New mail is "entries never seen before" rather than a rising
// count, so reading or archiving mail never looks like an arrival.
//
// The count shown is the Inbox title's number, because that is the one Gmail
// itself displays. The feed's own total is not comparable — it counts
// differently (for one real mailbox: 894,721 against an Inbox title of
// 218,388) — so it is only used until an Inbox title has been seen, and new
// threads are added to the title's number from then on.
function mergeFeed(state, feed, opts = {}) {
  const seen = state.seenKeys;
  const fresh = seen ? feed.entries.filter((e) => e.id && !seen.has(e.id)) : [];
  const retry = !!seen && !fresh.length && opts.retries > 0;

  const titleCountedIt = opts.countedByTitle || (state.hasView && state.titleAt > state.pollAt); // the title changed during this poll
  state.seenKeys = new Set(feed.entries.map((e) => e.id));
  state.feedCount = feed.count;
  if (state.titleCount === undefined) state.count = feed.count; // no Inbox title yet: the feed is all there is
  else if (fresh.length && !titleCountedIt) state.count += fresh.length; // Inbox not on screen: count the new threads ourselves
  return { fresh, retry };
}

// Gmail rewrites outbound links as www.google.com/url?q=<real-url>. Returns
// the real destination, or the input unchanged if it is not such a redirect.
function unwrapGoogleRedirect(url) {
  try {
    const u = new URL(url);
    if ((u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname === '/url') {
      const target = u.searchParams.get('q') || u.searchParams.get('url');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch {
    /* not a parseable URL — callers treat it as external, which is a no-op */
  }
  return url;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_FILENAME = 150; // leaves room for the Downloads path and " (2)" suffixes

// Attachment names arrive from web pages: make them safe for the file system.
function sanitizeFilename(name) {
  let s = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // Windows silently drops these, which collides names like "a.txt." with "a.txt"
  if (!s) return 'download';
  if (s.length > MAX_FILENAME) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? s.slice(dot).slice(0, 20) : '';
    s = s.slice(0, MAX_FILENAME - ext.length).trimEnd() + ext;
  }
  if (WINDOWS_RESERVED.test(s.replace(/\.[^.]*$/, ''))) s = '_' + s; // "nul.txt" cannot be written on Windows
  return s;
}

// The parts of a mailto: link, decoded. Null if it is not a mailto: URL.
function parseMailTo(mailtoUrl) {
  try {
    const u = new URL(String(mailtoUrl));
    if (u.protocol !== 'mailto:') return null;
    const out = { to: '', subject: '', body: '', cc: '', bcc: '' };
    try {
      out.to = decodeURIComponent(u.pathname); // malformed percent-encoding: an empty recipient beats a bogus one
    } catch {
      /* leave empty */
    }
    for (const key of ['subject', 'body', 'cc', 'bcc']) out[key] = u.searchParams.get(key) || '';
    return out;
  } catch {
    return null;
  }
}

// mailto:a@b.com?subject=..&body=.. -> Gmail's compose URL. Gmail spells the
// subject parameter `su`.
function mailToComposeUrl(mailtoUrl) {
  const m = parseMailTo(mailtoUrl);
  if (!m) return null;
  const params = new URLSearchParams();
  const gmail = { to: m.to, su: m.subject, body: m.body, cc: m.cc, bcc: m.bcc };
  for (const key of Object.keys(gmail)) if (gmail[key]) params.set(key, gmail[key]);
  return `https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1&${params}`;
}

// Page titles are the only signal a web mail app gives for free, so outside
// Gmail new mail means "the Inbox count went up". Two things make a rise that
// is not new mail: a page still filling in after it loaded, and a count that
// dips and bounces back (a reconnect). This decides, from each count a title
// reports, whether mail has actually arrived.
const RISE_SETTLE_MS = 15000; // after a (re)load, rises are the page catching up
const RISE_HOLD_MS = 10000; // a drop only counts once it has lasted this long

function createRiseTracker(settleMs = RISE_SETTLE_MS, holdMs = RISE_HOLD_MS) {
  return { base: undefined, settleUntil: 0, dip: undefined, dipAt: 0, settleMs, holdMs };
}

// Feeds one Inbox count to a tracker. Returns how many new messages arrived
// with it, or 0 if the change was not an arrival.
function riseStep(state, count, now) {
  if (state.base === undefined) {
    state.base = count; // the first count after a load is a baseline, never "new mail"
    state.settleUntil = now + state.settleMs;
    return 0;
  }
  if (state.dip !== undefined && now - state.dipAt >= state.holdMs) {
    state.base = state.dip; // the drop was real: mail was read or archived
    state.dip = undefined;
  }
  if (state.dip !== undefined) {
    if (count === state.dip) return 0; // still down; too early to say whether it is real
    // Back up while the drop is still unconfirmed. Measured against the level
    // before the drop, so 5 → 0 → 7 is two new messages and 5 → 0 → 5 is none.
    const fresh = count > state.base ? count - state.base : 0;
    state.base = count;
    state.dip = undefined;
    return now < state.settleUntil ? 0 : fresh;
  }
  if (count === state.base) return 0;
  if (count < state.base) {
    state.dip = count;
    state.dipAt = now;
    return 0;
  }
  const fresh = count - state.base;
  state.base = count;
  return now < state.settleUntil ? 0 : fresh;
}

// A check-in (main.js, "dozing") loads a page out of sight, reads its title
// and closes it again, every few minutes. What the title last showed cannot
// simply be taken as the count, because a page reports no count — or zero —
// while it is still starting up (Proton Mail shows "Inbox | …" before
// "(3957) Inbox | …"). So, between the count before and the last one seen:
// - a rise is real: no page reports more than it has while loading;
// - a drop to a number above zero is real, for the same reason;
// - a drop to zero is real only once the page has finished loading and has
//   stayed at zero for CHECKIN_ZERO_HOLD_MS. Until then the old count stands,
//   so a slow page can never turn its own start-up into "3957 new messages"
//   at the next check.
// Returns the count to show and how many new messages arrived. `known` false
// means the account's count has never been read this session: the first
// reading is a baseline, never new mail. `heldMs` is how long the page has
// shown zero since it finished loading; `holdMs` is how long it has to, and
// exists so that tests can shorten it (main.js waits the same amount).
const CHECKIN_ZERO_HOLD_MS = 8000;

function settleCheckIn(previous, seen, { known = true, heldMs = 0, holdMs = CHECKIN_ZERO_HOLD_MS } = {}) {
  if (!known || seen === previous) return { count: seen, fresh: 0 };
  if (seen > previous) return { count: seen, fresh: seen - previous };
  if (seen > 0 || previous === 0) return { count: seen, fresh: 0 };
  return heldMs >= holdMs ? { count: 0, fresh: 0 } : { count: previous, fresh: 0 };
}

function formatCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// What a new-mail event should do for an account. Each account has its own
// switches — `notify = { count, sound, banner }`, a missing one meaning "on" —
// and a global mute silences sound and pop-up for every account at once. The
// mute lasts until a moment in time, or until it is turned off.
const MUTE_UNTIL_TURNED_OFF = 8640000000000000; // the largest moment Date knows

function isMuted(mutedUntil, now = Date.now()) {
  return Number(mutedUntil) > now;
}

function notificationPlan(notify, mutedUntil, now = Date.now()) {
  if (isMuted(mutedUntil, now)) return { sound: false, banner: false, muted: true };
  const on = (key) => !notify || notify[key] !== false;
  return { sound: on('sound'), banner: on('banner'), muted: false };
}

// An account's three switches, each "on" unless it was saved as off. Accounts
// saved before the switches existed take their defaults from the two global
// switches that used to cover everything (absent in `legacy` means "on").
function withNotifyDefaults(notify, legacy = {}) {
  const saved = notify && typeof notify === 'object' ? notify : {};
  return {
    count: typeof saved.count === 'boolean' ? saved.count : legacy.showCounts !== false,
    sound: typeof saved.sound === 'boolean' ? saved.sound : true,
    banner: typeof saved.banner === 'boolean' ? saved.banner : legacy.notificationsEnabled !== false,
  };
}

module.exports = {
  parseInboxCount,
  parseEmail,
  parseWebmailTitle,
  parseProtonTitle,
  parseFeed,
  mergeFeed,
  unwrapGoogleRedirect,
  sanitizeFilename,
  parseMailTo,
  mailToComposeUrl,
  createRiseTracker,
  riseStep,
  RISE_SETTLE_MS,
  RISE_HOLD_MS,
  settleCheckIn,
  CHECKIN_ZERO_HOLD_MS,
  formatCount,
  MUTE_UNTIL_TURNED_OFF,
  isMuted,
  notificationPlan,
  withNotifyDefaults,
};
