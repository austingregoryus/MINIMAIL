# MINIMA<span style="color:#8ab4f8">I</span>L

One window for all your web mail. Minimail is a thin shell that shows each mail
service's own website, one account per tab in the sidebar, and gets out of the
way. No ads layer, no AI, no analytics. It began as a lean replacement for Kiwi for
Gmail (see `../kiwi-re/FINDINGS.md`).

## Services

| Service | Tried with a real account | Unread count | New-mail toast | Compose from `mailto:` | Unloads when idle |
| --- | --- | --- | --- | --- | --- |
| Gmail | yes, in daily use | instant, from the page | sender + subject | yes | yes (10 min) |
| Proton Mail | no — title format taken from Proton's own source | from the page | count only | — | no |
| Outlook (personal, work or school) | no — kept ready | from the page (format assumed) | count only | built, untried | no |
| Yahoo Mail | no — kept ready | from the page (format assumed) | count only | built, untried | no |
| AOL Mail | no — kept ready | from the page (format assumed) | count only | — | no |

**Gmail is the only service that has been used with a real account.** Proton
Mail's title format is known exactly, because its web app is open source
(`useMailboxPageTitle.ts`): `(3) Inbox | you@proton.me | Proton Mail`, with the
number left out when nothing is unread. Its sign-in has not been tried. Outlook,
Yahoo and AOL are adapters kept ready for anyone who has those accounts: where to
start and which hosts stay in the app are set, but their title formats are assumed
and nothing has been confirmed.

Leave Proton's own **"Show unread count in favicon"** setting off. With it on,
Proton drops the count from the title and Minimail would always read zero.

Gmail is also the one service that can be checked with its page closed: it has a
feed that accepts the account's own cookies. That is what lets it unload when idle
and still notify, and what gives its toasts a sender and subject. The others can
only be watched while open, so they stay loaded — which costs memory.

Adding a service is one entry in `src/providers.js`.

## Run

```
npm install
npm start        # dev mode
npm test         # unit tests: parsers, new-mail detection, providers (no dependencies)
npm run icons    # regenerate build/icon.ico + icon.png (pure Node, no image deps)
npm run icon-concepts   # render the other icon candidates for comparison -> build/icon-concepts.png
node scripts/build-marks.js <svg-folder> src/marks.js   # rebuild the service outlines, from plain single-path SVG files
npm run dist     # build the Windows installer -> dist/Minimail Setup <version>.exe
```

The icon is a white envelope on a blue tile, drawn by `scripts/make-icon.js` at
every size from 16px up. It is blue rather than dark because the taskbar it sits on
usually is dark; the alternatives (a white tile, an `M`) are in
`scripts/icon-concepts.js`.

The installed app registers itself as a `mailto:` handler. Settings carry over from
dev mode (both use `%APPDATA%/minimail`).

## How it works

- **Accounts.** One shell window (title bar + sidebar) with a `WebContentsView` per
  account, each in its own `persist:` session partition, so sign-ins never mix.
  The active account loads at launch; the others load 3 seconds later unless
  "Prefetch background accounts" is off, in which case they load when first clicked.
  Click **+** to choose a service. No code is injected into mail pages.
- **Unread counts.** While an Inbox is on screen, the count is read from the page
  title and matches what the service itself shows. Gmail is additionally polled
  once a minute, page open or not, and threads that arrive while no Inbox is on
  screen are added to its number.
- **Notifications.** Gmail: a thread that was not in the previous poll. The others:
  a rise in the Inbox count, ignoring rises while a page is still filling in and
  counts that dip and bounce back. Clicking a pop-up switches to that account. The
  services' own web notifications are turned off so nothing arrives twice.
- **Per account.** In Settings, each account has three switches: *Unread count*
  (the red number on its avatar), *Sound* and *Pop-up*. With the pop-up off but
  sound on, Minimail plays a short chime of its own.
- **Mute.** The speaker under the gear silences sound and pop-ups for every
  account at once, for 15 minutes, 1 hour, 4 hours, or until you turn it back on.
  It stays lit while on, survives a restart, and a timed mute runs out on its own.
  Unread counts keep counting.
- **Auto-sleep.** A background Gmail account unloads after 10 minutes; counts and
  notifications keep working, and clicking it reloads it.
- **Links.** Each service's own site and sign-in flow stay in the app. Everything
  else opens in your default browser. Ctrl+click opens a background browser tab.
- **Downloads.** Attachments are saved straight to your `Downloads` folder, and a
  toast in the title bar offers *Open* and *Folder*. Two files with the same name
  never overwrite each other.
- **Popups.** A page's own windows (popout compose, print) open as child windows in
  the same session.
- **Avatars.** Gmail accounts show your Google profile photo, cached in
  `settings.json`. Other accounts show the first letter of their address. Until an
  address is known, the avatar is the service's mark (Gmail, Proton Mail) or its
  initial.
- **Service badge.** A small badge on the lower-left of each avatar says which
  service the account is on: the Gmail or Proton Mail outline in the service's
  colour, or the service's initial where it has no outline. The outlines come
  from [Simple Icons](https://simpleicons.org) (public domain); the names and
  logos belong to their owners and are used only to label the account.
- **Title bar.** The logo and the wordmark on the left, then the active account
  and the unread total as a small chip. The minimize, maximize and close buttons
  are Windows' own, drawn over the right end of the bar: Minimail sets their height
  and symbol colour, but Windows decides their shape and hover colours.

## Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+1` … `Ctrl+9` | Switch to account N |
| `Ctrl+Shift+B` | Hide/show sidebar — a thin `›` strip stays clickable when hidden. Inside a text field the page keeps it (Gmail's bold, add Bcc) |
| `F5` / `Ctrl+R` | Reload the mail window that has focus, or the active account |
| `F12` / `Ctrl+Shift+I` | DevTools for the focused view |

Right-click for Cut/Copy/Paste, link and image actions. Right-click an account for
*Load/Reload*, *Refresh avatar* (Gmail) and *Remove account* (asks first, then
clears that account's saved sign-in).

## Settings

The gear at the bottom of the sidebar. **Accounts** has one row per account with
its *Unread count*, *Sound* and *Pop-up* switches. **App** has the taskbar badge,
prefetch, auto-sleep, and start at login.

`%APPDATA%/minimail/settings.json` (the previous version is kept as `settings.bak.json`):

```json
{
  "accounts": [{
    "id": "…", "provider": "gmail", "label": "you@gmail.com",
    "notify": { "count": true, "sound": true, "banner": true },
    "avatar": "data:image/jpeg;base64,…", "avatarSize": 128
  }],
  "activeId": "…",
  "sidebarCollapsed": false,
  "prefetchAccounts": true,
  "showBadge": true,
  "sleepAccounts": true,
  "launchOnStartup": false,
  "mutedUntil": 0
}
```

A missing `notify` switch means "on". `mutedUntil` is when the mute ends, in
milliseconds; `0` is not muted, and `8640000000000000` is "until I turn it back on".

## Known limits

- Accounts of services other than Gmail are shown as "Outlook", "Yahoo Mail" and
  so on until an address shows up in their page title. Accounts can't be renamed.
- The unread count is the one the service shows for the Inbox. Mail read on another
  device isn't subtracted until that account's Inbox is next on screen.
- Gmail's feed reports its own total, which counts differently and can be far higher
  than the Inbox number (894,721 against 218,388 for one large mailbox). It is only
  shown for a Gmail account that has not displayed its Inbox since the app started.
- Reading the count from the title needs the service's interface language to be
  English ("Inbox").
- New mail that arrives while you have a conversation open is notified when you go
  back to the Inbox.
- Pasting images into a compose box, and attachment downloads, have only been
  tried with Gmail.
- No tray mode — closing the window quits the app. The installer is unsigned, so
  SmartScreen asks the first time.

## Developer diagnostics

None of these run in normal use. The first three are **offline**: they run in a
throwaway profile against a lab on `127.0.0.1`, and cancel and report any request
that tries to leave the machine.

```
npm test                                  # unit tests, no browser
npm run autotest                          # smoke test: bridge, layout, payload, toast
npx electron . --experiment               # full flows: downloads, links, counts, toasts, compose, sleep
npx electron . --shot                     # render the sidebar from a copy of the real settings -> PNG
SHOT=settings npx electron . --shot       # …the settings window
SHOT=welcome  npx electron . --shot       # …the first-run screen
```

Two modes touch the real world. **Say so before running either.**

```
npx electron . --probe                    # loads your own account pages, in hidden windows
MINIMAIL_ALLOW_SIGNIN_PAGES=1 npx electron . --online   # loads Google's real sign-in page
```

`--online` puts sign-in prompts (passkeys, Windows Hello, authenticator pushes) on
the screen every time it runs. It refuses to start without the variable above.

`MINIMAIL_DEBUG=1` enables verbose logging. `MINIMAIL_SLEEP_MS` and
`MINIMAIL_POLL_MS` override the auto-sleep and polling intervals for testing.
