'use strict';
// Run with `npm test` (node:test, no dependencies).
const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/parsers');

const feed = (ids, count) => ({
  count,
  entries: ids.map((id) => ({ id, sender: 'Ann', email: 'ann@example.com', subject: 'Subject ' + id })),
});

test('parseInboxCount reads grouped numbers, and only from Inbox titles', () => {
  // Real titles from a mailbox with six figures of unread mail.
  assert.equal(p.parseInboxCount('Inbox (216,447) - someone@gmail.com - Gmail'), 216447);
  assert.equal(p.parseInboxCount('Inbox (25,860) - someone@example.com - Example Mail'), 25860);
  assert.equal(p.parseInboxCount('Inbox (12) - someone@gmail.com - Gmail'), 12);
  assert.equal(p.parseInboxCount('Inbox (0) - someone@gmail.com - Gmail'), 0);
  // Other thousands separators Gmail may use.
  assert.equal(p.parseInboxCount('Inbox (1 234) - someone@gmail.com - Gmail'), 1234);
  assert.equal(p.parseInboxCount('Inbox (1.234) - someone@gmail.com - Gmail'), 1234);
  assert.equal(p.parseInboxCount('Inbox\u00a0(1\u202f234) - someone@gmail.com - Gmail'), 1234);
  // A conversation is open: the count is unknown, not zero.
  assert.equal(p.parseInboxCount('Re: Q3 numbers - someone@gmail.com - Gmail'), null);
  assert.equal(p.parseInboxCount('Gmail'), null);
  assert.equal(p.parseInboxCount(''), null);
  // An Inbox with nothing unread leaves the number out altogether: that is zero.
  assert.equal(p.parseInboxCount('Inbox - someone@gmail.com - Gmail'), 0);
  assert.equal(p.parseInboxCount('Inbox \u2013 someone@gmail.com - Gmail'), 0);
  // Another label's count is not the inbox count, and subjects never are.
  assert.equal(p.parseInboxCount('Updates (3,045) - someone@gmail.com - Gmail'), null);
  assert.equal(p.parseInboxCount('Sent - someone@gmail.com - Gmail'), null);
  assert.equal(p.parseInboxCount('Inbox (2) is full - someone@gmail.com - Gmail'), null);
  assert.equal(p.parseInboxCount('Invoice (12) - someone@gmail.com - Gmail'), null);
});

test('parseEmail finds the account, never an address inside the subject', () => {
  assert.equal(p.parseEmail('Inbox (3) - me@gmail.com - Gmail'), 'me@gmail.com');
  assert.equal(p.parseEmail('Inbox (3) - First.Last+tag@sub.example.co.uk - Example Mail'), 'first.last+tag@sub.example.co.uk');
  assert.equal(p.parseEmail('Inbox (3) - hyphen-ated@gmail.com - Gmail'), 'hyphen-ated@gmail.com');
  assert.equal(p.parseEmail('Re: john@example.com owes us money - me@gmail.com - Gmail'), 'me@gmail.com');
  assert.equal(p.parseEmail('Re: foo - bar@baz.com - qux - me@gmail.com - Gmail'), 'me@gmail.com');
  assert.equal(p.parseEmail('Gmail'), null);
  // Proton separates the parts of its title with " | ".
  assert.equal(p.parseEmail('(3) Inbox | someone@proton.me | Proton Mail'), 'someone@proton.me');
  assert.equal(p.parseEmail('Inbox | someone@proton.me | Proton Mail'), 'someone@proton.me');
  assert.equal(p.parseEmail('Re: ping john@example.com | someone@proton.me | Proton Mail'), 'someone@proton.me');
  assert.equal(p.parseEmail('Proton Mail'), null);
});

test('parseProtonTitle reads the format from Proton Mail\u2019s own source', () => {
  assert.deepEqual(p.parseProtonTitle('(3) Inbox | someone@proton.me | Proton Mail'), { count: 3, email: 'someone@proton.me' });
  assert.deepEqual(p.parseProtonTitle('(1,204) Inbox | someone@proton.me | Proton Mail'), { count: 1204, email: 'someone@proton.me' });
  // Nothing unread: the count is left out, which means zero.
  assert.deepEqual(p.parseProtonTitle('Inbox | someone@proton.me | Proton Mail'), { count: 0, email: 'someone@proton.me' });
  // Another folder: the inbox count is unknown, and must be left alone.
  assert.equal(p.parseProtonTitle('Archive | someone@proton.me | Proton Mail'), null);
  assert.equal(p.parseProtonTitle('(2) Starred | someone@proton.me | Proton Mail'), null);
  // Not a Proton Mail title at all.
  assert.equal(p.parseProtonTitle('Proton Mail'), null);
  assert.equal(p.parseProtonTitle('(3) Inbox | someone@proton.me | Not Proton Mail'), null);
  assert.equal(p.parseProtonTitle('Re: hello | someone@proton.me | Proton Mail'), null);
  assert.equal(p.parseProtonTitle(''), null);
});

test('parseFeed reads the count and the newest entries', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#">
<title>Gmail - Inbox for someone@gmail.com</title>
<tagline>New messages in your Gmail inbox</tagline>
<fullcount>216447</fullcount>
<link rel="alternate" href="https://mail.google.com/mail/u/0/" type="text/html"/>
<modified>2026-11-23T10:15:27Z</modified>
<entry>
  <title>Quarterly report &amp; &quot;Q3&quot; &lt;final&gt;</title>
  <link rel="alternate" href="https://mail.google.com/mail/feed/atom/16f5a" type="text/html"/>
  <modified>2026-11-23T10:15:27Z</modified>
  <issued>2026-11-23T10:15:27Z</issued>
  <id>tag:gmail.google.com,2004:1301911912301315074</id>
  <name>Ann Example</name>
  <email>ann@example.com</email>
</entry>
<entry>
  <title>Caf&#233; &#x1F600; menu</title>
  <id>tag:gmail.google.com,2004:1301911912301315073</id>
  <name>Bob</name>
  <email>bob@example.com</email>
</entry>
</feed>`;
  const feed = p.parseFeed(xml);
  assert.equal(feed.count, 216447);
  assert.equal(feed.entries.length, 2);
  assert.deepEqual(feed.entries[0], {
    id: 'tag:gmail.google.com,2004:1301911912301315074',
    sender: 'Ann Example',
    email: 'ann@example.com',
    subject: 'Quarterly report & "Q3" <final>',
  });
  assert.equal(feed.entries[1].subject, 'Café 😀 menu');
  assert.equal(feed.entries[1].sender, 'Bob');
});

test('parseFeed rejects anything that is not a Gmail feed', () => {
  assert.equal(p.parseFeed(''), null);
  assert.equal(p.parseFeed('<html><body>Sign in</body></html>'), null);
  assert.equal(p.parseFeed('<feed><entry><id>x</id></entry></feed>'), null); // no fullcount
  assert.equal(p.parseFeed('<feed><fullcount>many</fullcount></feed>'), null);
});

test('parseFeed tolerates an empty inbox', () => {
  const feed = p.parseFeed('<feed><fullcount>0</fullcount></feed>');
  assert.equal(feed.count, 0);
  assert.equal(feed.entries.length, 0);
});

test('mergeFeed: the first poll only records what is already there', () => {
  const state = { count: 0, seenKeys: undefined };
  const out = p.mergeFeed(state, feed(['a', 'b'], 2));
  assert.deepEqual(out, { fresh: [], retry: false }); // nothing is "new mail" right after launch
  assert.equal(state.count, 2);
  assert.deepEqual([...state.seenKeys], ['a', 'b']);
});

test('mergeFeed: an unloaded account shows the feed count', () => {
  const state = { count: 0, seenKeys: new Set(['a']), hasView: false };
  assert.deepEqual(p.mergeFeed(state, feed(['a'], 40)).fresh, []);
  assert.equal(state.count, 40);
});

test('mergeFeed: once the Inbox title has spoken, sleeping does not change the number', () => {
  const state = { count: 10, seenKeys: new Set(['a']), titleCount: 10 };
  const out = p.mergeFeed(state, feed(['a'], 100));
  assert.deepEqual(out.fresh, []);
  assert.equal(state.count, 10);
  p.mergeFeed(state, feed(['c', 'b', 'a'], 102));
  assert.equal(state.count, 10);
  assert.equal(state.feedCount, 102);
});

test('mergeFeed: an awake account with no Inbox title yet shows the feed count', () => {
  const state = { count: 0, seenKeys: new Set(['a']), hasView: true, titleCount: undefined };
  p.mergeFeed(state, feed(['a'], 7));
  assert.equal(state.count, 7);
});

test('mergeFeed: new threads are reported independently of a previously verified Inbox count', () => {
  const state = { count: 10, seenKeys: new Set(['a']), hasView: true, titleCount: 10, titleAt: 1000, pollAt: 5000 };
  const out = p.mergeFeed(state, feed(['c', 'b', 'a'], 12)); // reading a conversation; two new threads arrived
  assert.deepEqual(out.fresh.map((e) => e.id), ['c', 'b']);
  assert.equal(out.retry, false);
  assert.equal(state.count, 10);
});

test('mergeFeed: the page title already counted it — never count it twice', () => {
  // Inbox on screen: the title went 10 -> 11 and asked for an immediate poll.
  const byTitle = { count: 11, seenKeys: new Set(['a']), hasView: true, titleCount: 11, titleAt: 9000, pollAt: 9001 };
  assert.equal(p.mergeFeed(byTitle, feed(['b', 'a'], 11), { countedByTitle: true }).fresh.length, 1);
  assert.equal(byTitle.count, 11);

  // The race: a timer poll was already in flight when the title changed.
  const racing = { count: 11, seenKeys: new Set(['a']), titleCount: 11 };
  assert.equal(p.mergeFeed(racing, feed(['b', 'a'], 11)).fresh.length, 1);
  assert.equal(racing.count, 11);
});

test('mergeFeed: entries returning to the feed window and duplicate IDs are reported once', () => {
  const state = { count: 0 };
  p.mergeFeed(state, feed(['a'], 1));
  assert.deepEqual(p.mergeFeed(state, feed(['b', 'b'], 1)).fresh.map(({ id }) => id), ['b']);
  assert.deepEqual(p.mergeFeed(state, feed(['a', 'b'], 2)).fresh, []);
});

test('parseMailTo accepts query recipients, case-insensitive fields and literal plus signs', () => {
  const result = p.parseMailTo('MAILTO:one@example.org?To=two+tag@example.org&Subject=One+two&body=One%20two');
  assert.equal(result.to, 'one@example.org,two+tag@example.org');
  assert.equal(result.subject, 'One+two');
  assert.equal(result.body, 'One two');
});

test('sanitizeFilename handles multi-extension and superscript Windows device names', () => {
  assert.equal(p.sanitizeFilename('NUL.tar.gz'), '_NUL.tar.gz');
  assert.equal(p.sanitizeFilename('COM¹.csv'), '_COM¹.csv');
  assert.equal(p.sanitizeFilename('LPT².txt'), '_LPT².txt');
});

test('mergeFeed: reading or archiving mail is not new mail', () => {
  const state = { count: 5, seenKeys: new Set(['a', 'b']), hasView: true, titleCount: 5, titleAt: 1000, pollAt: 9000 };
  assert.deepEqual(p.mergeFeed(state, feed(['b'], 1)).fresh, []); // "a" was read
  assert.equal(state.count, 5); // the title corrects the count once the Inbox is on screen again
});

test('mergeFeed: retries are bounded and only when asked', () => {
  const quiet = () => ({ count: 3, seenKeys: new Set(['a']), hasView: true, titleCount: 4, titleAt: 9000, pollAt: 9001 });
  assert.equal(p.mergeFeed(quiet(), feed(['a'], 4), { countedByTitle: true, retries: 2 }).retry, true); // the feed lags the title
  assert.equal(p.mergeFeed(quiet(), feed(['a'], 4), { countedByTitle: true, retries: 0 }).retry, false); // give up
  assert.equal(p.mergeFeed(quiet(), feed(['a'], 4)).retry, false); // a plain poll never retries
  assert.equal(p.mergeFeed(quiet(), feed(['b', 'a'], 5), { countedByTitle: true, retries: 2 }).retry, false);
  // A retry must still keep an unloaded account's count current.
  const asleep = { count: 3, seenKeys: new Set(['a']), hasView: false };
  p.mergeFeed(asleep, feed(['a'], 9), { retries: 2 });
  assert.equal(asleep.count, 9);
});

test('mergeFeed: an entry without an id is never reported as new mail', () => {
  const state = { count: 0, seenKeys: new Set(['a']), hasView: false };
  assert.deepEqual(p.mergeFeed(state, feed(['', 'a'], 2)).fresh, []);
});

test('unwrapGoogleRedirect extracts the real destination', () => {
  const real = 'https://example.com/a?b=1&c=two%20words';
  assert.equal(p.unwrapGoogleRedirect(`https://www.google.com/url?q=${encodeURIComponent(real)}&sa=D`), real);
  assert.equal(p.unwrapGoogleRedirect(`https://google.com/url?url=${encodeURIComponent(real)}`), real);
  assert.equal(p.unwrapGoogleRedirect('https://www.google.com/url?q=javascript%3Aalert(1)'), 'https://www.google.com/url?q=javascript%3Aalert(1)');
  assert.equal(p.unwrapGoogleRedirect('https://www.google.com/search?q=x'), 'https://www.google.com/search?q=x');
  assert.equal(p.unwrapGoogleRedirect('https://example.com/url?q=https://evil.test'), 'https://example.com/url?q=https://evil.test');
  assert.equal(p.unwrapGoogleRedirect('not a url'), 'not a url');
});

test('sanitizeFilename keeps names writable and harmless', () => {
  assert.equal(p.sanitizeFilename('report.pdf'), 'report.pdf');
  assert.equal(p.sanitizeFilename('Q3 report (final).pdf'), 'Q3 report (final).pdf');
  assert.equal(p.sanitizeFilename('my:file<name>.pdf'), 'my_file_name_.pdf');
  assert.equal(p.sanitizeFilename('a/b\\c.txt'), 'a_b_c.txt');
  assert.equal(p.sanitizeFilename('trailing dots....txt...'), 'trailing dots....txt');
  assert.equal(p.sanitizeFilename('a.txt.'), 'a.txt');
  assert.equal(p.sanitizeFilename('  spaced   out  .zip  '), 'spaced out .zip');
  assert.equal(p.sanitizeFilename(''), 'download');
  assert.equal(p.sanitizeFilename(undefined), 'download');
  assert.equal(p.sanitizeFilename('...'), 'download');
  assert.equal(p.sanitizeFilename('nul.txt'), '_nul.txt');
  assert.equal(p.sanitizeFilename('CON'), '_CON');
  assert.equal(p.sanitizeFilename('com1.log'), '_com1.log');
  assert.equal(p.sanitizeFilename('console.log'), 'console.log');
  assert.equal(p.sanitizeFilename('caf\u00e9 menu \u2764.docx'), 'caf\u00e9 menu \u2764.docx');
  const long = 'x'.repeat(400) + '.pdf';
  const cut = p.sanitizeFilename(long);
  assert.equal(cut.length, 150);
  assert.ok(cut.endsWith('.pdf'));
  assert.equal(p.sanitizeFilename('control\u0000\u001fchar.txt'), 'control__char.txt');
});

test('mailToComposeUrl builds a Gmail compose URL', () => {
  assert.equal(
    p.mailToComposeUrl('mailto:a@b.com'),
    'https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1&to=a%40b.com',
  );
  const url = new URL(p.mailToComposeUrl('mailto:Ann%20Example%3Cann%40b.com%3E,c@d.com?subject=Hi%20there&body=Line%201%0ALine%202&cc=e%40f.com&bcc=g%40h.com'));
  const q = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://mail.google.com/mail/u/0/');
  assert.equal(q.get('view'), 'cm');
  assert.equal(q.get('to'), 'Ann Example<ann@b.com>,c@d.com');
  assert.equal(q.get('su'), 'Hi there'); // Gmail spells the subject parameter "su"
  assert.equal(q.get('body'), 'Line 1\nLine 2');
  assert.equal(q.get('cc'), 'e@f.com');
  assert.equal(q.get('bcc'), 'g@h.com');
  assert.equal(p.mailToComposeUrl('https://example.com/'), null);
  assert.equal(p.mailToComposeUrl('mailto:%E0%A4%A'), 'https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1&'); // malformed address: compose still opens
  assert.equal(p.mailToComposeUrl('garbage'), null);
});

test('formatCount groups thousands', () => {
  assert.equal(p.formatCount(242307), '242,307');
  assert.equal(p.formatCount(7), '7');
  assert.equal(p.formatCount(0), '0');
});

test('parseWebmailTitle reads the count next to "Inbox" in either order', () => {
  assert.deepEqual(p.parseWebmailTitle('Inbox (3) - someone@outlook.com - Outlook'), { count: 3, email: 'someone@outlook.com' });
  assert.deepEqual(p.parseWebmailTitle('(3) Inbox - Yahoo Mail'), { count: 3, email: null });
  assert.equal(p.parseWebmailTitle('Inbox (1,234) - someone@aol.com - AOL Mail').count, 1234);
  assert.equal(p.parseWebmailTitle('Inbox (0) - AOL Mail').count, 0);
  // An Inbox with nothing unread leaves the number out: that is zero, not unknown.
  assert.deepEqual(p.parseWebmailTitle('Inbox - someone@outlook.com - Outlook'), { count: 0, email: 'someone@outlook.com' });
  assert.deepEqual(p.parseWebmailTitle('(0) Inbox - Yahoo Mail'), { count: 0, email: null });
  // A conversation is open: unknown, not zero.
  assert.equal(p.parseWebmailTitle('Re: budget - someone@outlook.com - Outlook'), null);
  assert.equal(p.parseWebmailTitle('Outlook'), null);
  assert.equal(p.parseWebmailTitle('Sent (4) - Outlook'), null); // another folder's count is not the inbox's
  assert.equal(p.parseWebmailTitle('Sent - Outlook'), null);
  assert.equal(p.parseWebmailTitle(''), null);
});

test('parseMailTo decodes a mailto: link and rejects everything else', () => {
  assert.deepEqual(p.parseMailTo('mailto:a@b.com'), { to: 'a@b.com', subject: '', body: '', cc: '', bcc: '' });
  assert.deepEqual(p.parseMailTo('mailto:a@b.com,c@d.com?subject=Hi%20there&body=Two%0Alines&cc=e%40f.com&bcc=g%40h.com'), {
    to: 'a@b.com,c@d.com',
    subject: 'Hi there',
    body: 'Two\nlines',
    cc: 'e@f.com',
    bcc: 'g@h.com',
  });
  assert.equal(p.parseMailTo('mailto:%E0%A4%A').to, '');
  assert.equal(p.parseMailTo('https://example.com/'), null);
  assert.equal(p.parseMailTo('garbage'), null);
});

test('notificationPlan: an account with no switches set does everything', () => {
  const all = { sound: true, banner: true, muted: false };
  assert.deepEqual(p.notificationPlan(undefined, 0, 1000), all);
  assert.deepEqual(p.notificationPlan({}, 0, 1000), all);
  assert.deepEqual(p.notificationPlan({ count: false, sound: true, banner: true }, 0, 1000), all); // the unread count is not a notification
  // Not muted: no value, zero, or a moment already gone.
  for (const until of [undefined, null, 0, 999]) assert.deepEqual(p.notificationPlan({}, until, 1000), all, String(until));
});

test('notificationPlan: each account switches its own sound and pop-up', () => {
  const T = 1000;
  assert.deepEqual(p.notificationPlan({ sound: false }, 0, T), { sound: false, banner: true, muted: false });
  assert.deepEqual(p.notificationPlan({ banner: false }, 0, T), { sound: true, banner: false, muted: false });
  assert.deepEqual(p.notificationPlan({ sound: false, banner: false }, 0, T), { sound: false, banner: false, muted: false });
});

test('notificationPlan: the global mute silences sound and pop-up for every account', () => {
  const T = 1000;
  const muted = { sound: false, banner: false, muted: true };
  assert.deepEqual(p.notificationPlan({ sound: true, banner: true }, T + 60000, T), muted);
  assert.deepEqual(p.notificationPlan({}, p.MUTE_UNTIL_TURNED_OFF, T), muted); // until turned back on
  // A mute whose moment has passed is no mute at all.
  assert.deepEqual(p.notificationPlan({}, T, T), { sound: true, banner: true, muted: false });
  assert.equal(p.isMuted('junk', T), false);
  assert.equal(p.isMuted(undefined, T), false);
  assert.equal(p.isMuted(p.MUTE_UNTIL_TURNED_OFF, Date.now() + 365.25 * 86400000 * 50), true); // still muted 50 years on
});

test('withNotifyDefaults: each switch is on unless it was saved as off', () => {
  assert.deepEqual(p.withNotifyDefaults(undefined), { count: true, sound: true, banner: true });
  assert.deepEqual(p.withNotifyDefaults('nonsense'), { count: true, sound: true, banner: true });
  assert.deepEqual(p.withNotifyDefaults({ sound: false, banner: true }), { count: true, sound: false, banner: true });
  assert.deepEqual(p.withNotifyDefaults({ count: false, sound: false, banner: false }), { count: false, sound: false, banner: false });
  // A value that is not true or false counts as unset.
  assert.deepEqual(p.withNotifyDefaults({ count: 'no', sound: 0, banner: null }), { count: true, sound: true, banner: true });
});

test('withNotifyDefaults: accounts saved before the switches existed keep behaving as before', () => {
  const legacyOff = { showCounts: false, notificationsEnabled: false };
  assert.deepEqual(p.withNotifyDefaults(undefined, legacyOff), { count: false, sound: true, banner: false });
  assert.deepEqual(p.withNotifyDefaults(undefined, { showCounts: false }), { count: false, sound: true, banner: true });
  assert.deepEqual(p.withNotifyDefaults(undefined, { notificationsEnabled: false }), { count: true, sound: true, banner: false });
  // An account's own switch always wins over the old global one.
  assert.deepEqual(p.withNotifyDefaults({ banner: true }, legacyOff), { count: false, sound: true, banner: true });
});
