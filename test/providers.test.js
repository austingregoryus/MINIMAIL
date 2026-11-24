'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PROVIDERS, PROVIDER_ORDER, classifyUrl, accountColor } = require('../src/providers');

test('every provider in the menu is fully described', () => {
  assert.deepEqual(PROVIDER_ORDER, ['gmail', 'outlook', 'outlook-work', 'yahoo', 'aol', 'proton']);
  for (const id of PROVIDER_ORDER) {
    const p = PROVIDERS[id];
    assert.equal(p.id, id, id);
    assert.ok(p.name && p.color && p.inbox, id);
    assert.match(p.start, /^https:\/\//, id);
    assert.ok(Array.isArray(p.hosts) && p.hosts.length > 0, id + ' lists the hosts that stay in the app');
    for (const host of p.hosts) assert.ok(!host.includes('://') && !host.includes('/'), `${id}: "${host}" is a bare host name`);
  }
});

test('only Gmail has a feed, which is what lets it sleep', () => {
  assert.equal(typeof PROVIDERS.gmail.feed?.url, 'string');
  for (const id of PROVIDER_ORDER.filter((i) => i !== 'gmail')) assert.equal(PROVIDERS[id].feed, undefined, id);
});

test('every provider says what its avatar shows for the service', () => {
  // An outline on a 24x24 grid, made of drawing commands alone — or nothing.
  const outline = /^[MmZzLlHhVvCcSsQqTtAaEe][MmZzLlHhVvCcSsQqTtAaEe0-9.,\s+-]*$/;
  for (const id of PROVIDER_ORDER) {
    const mark = PROVIDERS[id].mark;
    assert.ok(mark === null || (typeof mark === 'string' && outline.test(mark) && mark.length > 20), `${id}: ${String(mark).slice(0, 40)}`);
  }
  assert.equal(typeof PROVIDERS.gmail.mark, 'string');
  assert.equal(typeof PROVIDERS.proton.mark, 'string');
  // These adapters have no outline and show their initial instead.
  for (const id of ['outlook', 'outlook-work', 'yahoo', 'aol']) assert.equal(PROVIDERS[id].mark, null, id);
});

test('classifyUrl: Gmail', () => {
  const g = PROVIDERS.gmail;
  assert.equal(classifyUrl('https://mail.google.com/mail/u/0/#inbox', g), 'app');
  assert.equal(classifyUrl('https://accounts.google.com/v3/signin/identifier', g), 'app');
  assert.equal(classifyUrl('https://mail-attachment.googleusercontent.com/attachment/u/0/?x=1', g), 'download');
  assert.equal(classifyUrl('https://lh3.googleusercontent.com/a/abc=s32', g), 'download');
  assert.equal(classifyUrl('https://evil.test/mail.google.com/x', g), 'external');
  assert.equal(classifyUrl('https://notgoogleusercontent.com/attachment', g), 'external');
  assert.equal(classifyUrl('https://outlook.live.com/mail/', g), 'external'); // another provider's mail is just a web page here
});

test('classifyUrl: Outlook keeps its mail and sign-in hosts, nothing else', () => {
  const o = PROVIDERS.outlook;
  assert.equal(classifyUrl('https://outlook.live.com/mail/0/idle', o), 'app');
  assert.equal(classifyUrl('https://outlook.office.com/mail/', o), 'app');
  assert.equal(classifyUrl('https://outlook.office365.com/mail/', o), 'app');
  assert.equal(classifyUrl('https://login.live.com/ppsecure/post.srf?x=1', o), 'app');
  assert.equal(classifyUrl('https://login.microsoftonline.com/common/oauth2/authorize', o), 'app');
  assert.equal(classifyUrl('https://www.office.com/', o), 'external');
  assert.equal(classifyUrl('https://www.microsoft.com/', o), 'external');
  assert.equal(classifyUrl('https://example.com/unsubscribe', o), 'external');
  assert.equal(classifyUrl('https://outlook.live.com.evil.test/mail/', o), 'external'); // a suffix is not a subdomain
  assert.equal(classifyUrl('https://login.live.com.evil.test/', o), 'external');
});

test('classifyUrl: Yahoo and AOL, including the consent hop their sign-in goes through', () => {
  const y = PROVIDERS.yahoo;
  assert.equal(classifyUrl('https://mail.yahoo.com/d/folders/1', y), 'app');
  assert.equal(classifyUrl('https://login.yahoo.com/', y), 'app');
  assert.equal(classifyUrl('https://guce.yahoo.com/consent?brandType=nonEu&gcrumb=x', y), 'app');
  assert.equal(classifyUrl('https://www.yahoo.com/news/story.html', y), 'external'); // a news link in an email
  assert.equal(classifyUrl('https://mail.aol.com/', y), 'external');
  const a = PROVIDERS.aol;
  assert.equal(classifyUrl('https://mail.aol.com/webmail-std/en-us/suite', a), 'app');
  assert.equal(classifyUrl('https://login.aol.com/', a), 'app');
  assert.equal(classifyUrl('https://guce.yahoo.com/consent?brandType=nonEu', a), 'app');
  assert.equal(classifyUrl('https://www.aol.com/', a), 'external');
  assert.equal(classifyUrl('https://mail.yahoo.com/', a), 'external');
});

test('classifyUrl: Proton Mail', () => {
  const p = PROVIDERS.proton;
  assert.equal(classifyUrl('https://mail.proton.me/u/0/inbox', p), 'app');
  assert.equal(classifyUrl('https://account.proton.me/login', p), 'app');
  assert.equal(classifyUrl('https://account.protonmail.com/login', p), 'app');
  assert.equal(classifyUrl('https://proton.me/mail', p), 'external'); // marketing
  assert.equal(classifyUrl('https://account.protonvpn.com/', p), 'external');
});

test('classifyUrl: what does not depend on the provider', () => {
  for (const id of PROVIDER_ORDER) {
    const p = PROVIDERS[id];
    assert.equal(classifyUrl('blob:https://mail.google.com/1234-5678', p), 'download');
    assert.equal(classifyUrl('about:blank', p), 'blank');
    assert.equal(classifyUrl('', p), 'blank');
    assert.equal(classifyUrl(undefined, p), 'blank');
    assert.equal(classifyUrl('mailto:a@b.com?subject=hi', p), 'mailto');
    assert.equal(classifyUrl('file:///example.txt', p), 'blocked');
    assert.equal(classifyUrl('example:document', p), 'blocked');
  }
  assert.equal(classifyUrl('https://mail.google.com/mail/u/0/'), 'app'); // no provider given: Gmail
  assert.equal(classifyUrl('http://mail.google.com/mail/u/0/'), 'external');
  assert.equal(classifyUrl('https://mail.google.com:444/mail/u/0/'), 'external');
});

test('compose: work Outlook starts on the work service and honors the signed-in mail origin', () => {
  const { compose } = PROVIDERS['outlook-work'];
  const mailto = 'mailto:recipient@example.org';
  assert.equal(new URL(compose(mailto)).host, 'outlook.office.com');
  assert.equal(new URL(compose(mailto, 'login.microsoftonline.com')).host, 'outlook.office.com');
  assert.equal(new URL(compose(mailto, 'outlook.office365.com')).host, 'outlook.office365.com');
});

test('Gmail wake, feed and compose all use the selected mailbox and Inbox counts require its Inbox route', () => {
  const gmail = PROVIDERS.gmail;
  const inbox = 'https://mail.google.com/mail/u/1/#inbox';
  const slot = gmail.mailboxFromUrl(inbox);
  assert.equal(slot, '1');
  assert.equal(new URL(gmail.startForMailbox(slot)).searchParams.get('continue'), inbox.split('#')[0]);
  assert.equal(new URL(gmail.feedForMailbox(slot)).pathname, '/mail/u/1/feed/atom');
  assert.equal(new URL(gmail.compose('mailto:recipient@example.org', null, slot)).pathname, '/mail/u/1/');
  assert.equal(gmail.inbox('Inbox - Quarterly discussion - test@example.org - Gmail', inbox + '/thread'), null);
  assert.equal(gmail.inbox('Inbox (3) - test@example.org - Gmail', inbox).count, 3);
});

test('compose: Outlook builds a compose link for the kind of account that is signed in', () => {
  const { compose } = PROVIDERS.outlook;
  const mailto = 'mailto:Ann%20Example%3Cann%40b.com%3E,c@d.com?subject=Hi%20there&body=Line%201&cc=e%40f.com&bcc=g%40h.com';
  const query = 'to=Ann+Example%3Cann%40b.com%3E%2Cc%40d.com&subject=Hi+there&body=Line+1&cc=e%40f.com&bcc=g%40h.com';
  assert.equal(compose(mailto), `https://outlook.live.com/mail/0/deeplink/compose?${query}`); // no host known yet: personal
  assert.equal(compose(mailto, 'outlook.live.com'), `https://outlook.live.com/mail/0/deeplink/compose?${query}`);
  assert.equal(compose(mailto, 'outlook.office.com'), `https://outlook.office.com/mail/deeplink/compose?${query}`);
  assert.equal(compose(mailto, 'outlook.office365.com'), `https://outlook.office365.com/mail/deeplink/compose?${query}`);
  assert.equal(compose('mailto:a@b.com'), 'https://outlook.live.com/mail/0/deeplink/compose?to=a%40b.com');
  assert.equal(compose('https://example.com/'), null);
});

test('compose: Yahoo Mail', () => {
  assert.equal(PROVIDERS.yahoo.compose('mailto:a@b.com?subject=Hi&body=There'), 'https://compose.mail.yahoo.com/?to=a%40b.com&subject=Hi&body=There');
  assert.equal(PROVIDERS.yahoo.compose('mailto:a@b.com'), 'https://compose.mail.yahoo.com/?to=a%40b.com');
  assert.equal(PROVIDERS.yahoo.compose('not a mailto'), null);
});

test('compose: Gmail, and the providers without a compose link', () => {
  assert.equal(PROVIDERS.gmail.compose('mailto:a@b.com?subject=Hi'), 'https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1&to=a%40b.com&su=Hi');
  assert.equal(PROVIDERS.aol.compose, undefined); // these just switch to the account
  assert.equal(PROVIDERS.proton.compose, undefined);
});

test('each provider parses the unread count out of its own titles', () => {
  assert.equal(PROVIDERS.gmail.inbox('Inbox (216,447) - test@example.org - Gmail', PROVIDERS.gmail.urlForMailbox()).count, 216447);
  assert.deepEqual(PROVIDERS.outlook.inbox('Inbox (3) - someone@outlook.com - Outlook'), { count: 3, email: 'someone@outlook.com' });
  assert.equal(PROVIDERS.yahoo.inbox('(3) Inbox - Yahoo Mail').count, 3);
  assert.equal(PROVIDERS.aol.inbox('Inbox (3) - AOL Mail').count, 3);
  // Proton's real format, "(n) Inbox | address | Proton Mail", from its own source.
  assert.deepEqual(PROVIDERS.proton.inbox('(3) Inbox | someone@proton.me | Proton Mail'), { count: 3, email: 'someone@proton.me' });
  assert.deepEqual(PROVIDERS.proton.inbox('Inbox | someone@proton.me | Proton Mail'), { count: 0, email: 'someone@proton.me' });
  assert.equal(PROVIDERS.outlook.inbox('Meeting notes - someone@outlook.com - Outlook'), null);
});

// The colour an address has had since before providers existed, so existing
// accounts keep theirs. Written out here as the reference.
function legacyHue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

test('accountColor: known address, provider colour, and siblings told apart', () => {
  for (const label of ['first.last@example.com', 'me@example.org', 'hyphen-ated@sub.example.co.uk']) {
    assert.equal(accountColor(label, 'gmail', 0), `hsl(${legacyHue(label)} 45% 42%)`, label);
  }
  assert.equal(accountColor('first.last@example.com', 'outlook', 3), accountColor('first.last@example.com', 'gmail', 0)); // from the address, whatever the provider
  const first = accountColor('Outlook (personal)', 'outlook', 0);
  const second = accountColor('Outlook (personal)', 'outlook', 1);
  const third = accountColor('Outlook (personal)', 'outlook', 2);
  assert.match(first, /^hsl\(20[0-9] /); // Outlook's blue
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.notEqual(accountColor('Yahoo Mail', 'yahoo', 0), first);
  assert.notEqual(accountColor('New account', 'proton', 0), accountColor('New account', 'gmail', 0));
});
