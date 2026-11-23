'use strict';
// The web mail services the app can show. Pure data and functions — no
// Electron — so `npm test` covers everything here.
//
// Which hosts belong to each service is the part that decides whether signing
// in works: a sign-in redirect that is not listed would be thrown out of the
// app and into the browser, and the session would never come back. The lists
// for Outlook, Yahoo, AOL and Proton have not been confirmed against a real
// sign-in yet.
const { parseInboxCount, parseEmail, parseWebmailTitle, parseProtonTitle, parseMailTo, mailToComposeUrl } = require('./parsers');
const MARKS = require('./marks');

// ?to=..&subject=..&body=.. with whatever is present in the mailto: link.
function composeQuery(mailto) {
  const m = parseMailTo(mailto);
  if (!m) return null;
  const params = new URLSearchParams();
  for (const key of ['to', 'subject', 'body', 'cc', 'bcc']) if (m[key]) params.set(key, m[key]);
  return params.toString();
}

const OUTLOOK_MAIL = ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com'];
const MICROSOFT_LOGIN = ['login.live.com', 'login.microsoftonline.com', 'login.microsoft.com'];
// The consent hop every Yahoo and AOL sign-in goes through.
const YAHOO_LOGIN = (login) => [login, `api.${login}`, 'guce.yahoo.com', 'consent.yahoo.com'];

const PROVIDERS = {
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    color: '#ea4335',
    start: 'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/u/0/',
    mailHosts: ['mail.google.com'],
    hosts: ['mail.google.com', 'accounts.google.com'],
    downloadSuffixes: ['googleusercontent.com'],
    // The one service that can be checked with its page closed: a feed that
    // accepts the account's own cookies. What makes auto-sleep possible.
    feed: { url: 'https://mail.google.com/mail/feed/atom', cookiesFor: 'https://mail.google.com' },
    avatar: true,
    inbox: (title) => {
      const count = parseInboxCount(title);
      return count === null ? null : { count, email: parseEmail(title) };
    },
    compose: (mailto) => mailToComposeUrl(mailto),
  },
  outlook: {
    id: 'outlook',
    name: 'Outlook (personal)',
    short: 'Outlook',
    color: '#0f6cbd',
    start: 'https://outlook.live.com/mail/0/',
    mailHosts: OUTLOOK_MAIL,
    hosts: [...OUTLOOK_MAIL, ...MICROSOFT_LOGIN],
    inbox: parseWebmailTitle,
    compose: (mailto, host) => {
      // A work or school account composes on its own server.
      const work = OUTLOOK_MAIL.slice(1).includes((host || '').toLowerCase());
      const base = work ? `https://${host}/mail/deeplink/compose` : 'https://outlook.live.com/mail/0/deeplink/compose';
      const query = composeQuery(mailto);
      return query === null ? null : `${base}?${query}`;
    },
  },
  'outlook-work': {
    id: 'outlook-work',
    name: 'Outlook (work or school)',
    short: 'Outlook',
    color: '#0f6cbd',
    start: 'https://outlook.office.com/mail/',
    mailHosts: OUTLOOK_MAIL,
    hosts: [...OUTLOOK_MAIL, ...MICROSOFT_LOGIN],
    inbox: parseWebmailTitle,
    compose: null, // set below: the same function as `outlook`, so the two cannot drift apart
  },
  yahoo: {
    id: 'yahoo',
    name: 'Yahoo Mail',
    color: '#6001d2',
    start: 'https://mail.yahoo.com/',
    mailHosts: ['mail.yahoo.com'],
    hosts: ['mail.yahoo.com', ...YAHOO_LOGIN('login.yahoo.com')],
    inbox: parseWebmailTitle,
    compose: (mailto) => {
      const query = composeQuery(mailto);
      return query === null ? null : `https://compose.mail.yahoo.com/?${query}`;
    },
  },
  aol: {
    id: 'aol',
    name: 'AOL Mail',
    color: '#b58900',
    start: 'https://mail.aol.com/',
    mailHosts: ['mail.aol.com'],
    hosts: ['mail.aol.com', ...YAHOO_LOGIN('login.aol.com')],
    inbox: parseWebmailTitle, // AOL Mail runs on Yahoo's platform
  },
  proton: {
    id: 'proton',
    name: 'Proton Mail',
    color: '#6d4aff',
    start: 'https://mail.proton.me/',
    mailHosts: ['mail.proton.me', 'mail.protonmail.com'],
    hosts: ['mail.proton.me', 'mail.protonmail.com', 'account.proton.me', 'account.protonmail.com'],
    // The one title format known from the service's own source rather than
    // from a signed-in page. Needs Proton's "Show unread count in favicon"
    // setting left off, or the count disappears from the title.
    inbox: parseProtonTitle,
  },
};
PROVIDERS['outlook-work'].compose = PROVIDERS.outlook.compose;

// The mark shown on the badge of each account avatar: an outline for the
// services that have one, nothing for the others (they show their initial).
for (const provider of Object.values(PROVIDERS)) provider.mark = MARKS[provider.id] || null;

// The order of the "add an account" menu.
const PROVIDER_ORDER = ['gmail', 'outlook', 'outlook-work', 'yahoo', 'aol', 'proton'];

// What should happen when a page of `provider` is pointed at `url`:
//   'app'      stays in the app (the mail service and its sign-in flow)
//   'download' saved to Downloads without leaving the app (attachment and blob URLs)
//   'blank'    an empty popup target — let the page have its window
//   'mailto'   opens a compose window in the account the link was clicked in
//   'external' handed to the default browser
function classifyUrl(url, provider = PROVIDERS.gmail) {
  const s = String(url || '');
  if (/^mailto:/i.test(s)) return 'mailto';
  if (/^blob:/i.test(s)) return 'download';
  if (!s || /^about:(blank|srcdoc)$/i.test(s)) return 'blank';
  let u;
  try {
    u = new URL(s);
  } catch {
    return 'external';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'external';
  const host = u.hostname.toLowerCase();
  const under = (suffix) => host === suffix || host.endsWith('.' + suffix);
  if ((provider.hosts || []).includes(host)) return 'app';
  if ((provider.downloadSuffixes || []).some(under)) return 'download';
  return 'external';
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

// Background colour of an account's letter avatar. Accounts whose address is
// known get a colour derived from it; the others take their provider's colour,
// shaded apart so two Outlook accounts do not look identical.
function accountColor(label, providerId, siblingIndex) {
  if (/@/.test(label || '')) {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return `hsl(${h % 360} 45% 42%)`;
  }
  const [h, s, l] = hexToHsl(PROVIDERS[providerId]?.color || '#5f6368');
  const shades = [0, -12, 12, -20, 20, 28];
  return `hsl(${h} ${Math.max(s, 8)}% ${l + shades[siblingIndex % shades.length]}%)`;
}

module.exports = { PROVIDERS, PROVIDER_ORDER, classifyUrl, accountColor, composeQuery };
