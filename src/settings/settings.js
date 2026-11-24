'use strict';
const api = window.minimail;
const APP_KEYS = ['showBadge', 'prefetchAccounts', 'sleepAccounts', 'dozeOthers', 'sleepWhenAway', 'launchOnStartup'];
// Each account's switches, and the column each appears in.
const ACCOUNT_KEYS = ['count', 'sound', 'banner'];
const COLUMN_LABELS = { count: 'Unread count', sound: 'Sound', banner: 'Pop-up' };

const accountsEl = document.getElementById('accounts');
let rows = []; // one per account, in the order the accounts arrive

function setToggle(btn, on) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
}

function buildRow(account) {
  const row = document.createElement('div');
  row.className = 'acc-row';

  const who = document.createElement('div');
  who.className = 'who';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = account.providerColor || '#5f6368';
  const name = document.createElement('span');
  name.className = 'name';
  who.append(dot, name);
  row.appendChild(who);

  const toggles = {};
  for (const key of ACCOUNT_KEYS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle';
    setToggle(btn, true);
    btn.addEventListener('click', async () => {
      const saved = await api.setAccountPref(account.id, key, !btn.classList.contains('on'));
      // Show what the app saved, not what was clicked: the app may have refused.
      if (saved) for (const k of ACCOUNT_KEYS) setToggle(toggles[k], saved[k] !== false);
    });
    toggles[key] = btn;
    row.appendChild(btn);
  }
  return { id: account.id, el: row, dot, name, toggles };
}

function renderAccounts(accounts) {
  const same = accounts.length === rows.length && accounts.every((a, i) => a.id === rows[i].id);
  if (!same) {
    accountsEl.textContent = '';
    rows = accounts.map(buildRow);
    for (const row of rows) accountsEl.appendChild(row.el);
    api.fit(); // the window is sized to its content, which just changed
  }
  accounts.forEach((a, i) => {
    const row = rows[i];
    if (row.name.textContent !== a.label) row.name.textContent = a.label;
    row.dot.style.background = a.providerColor || '#5f6368';
    const initial = (/@/.test(a.label || '') ? a.label[0] : (a.providerName || '?')[0]).toUpperCase();
    if (row.dot.textContent !== initial) row.dot.textContent = initial;
    for (const key of ACCOUNT_KEYS) {
      setToggle(row.toggles[key], !a.notify || a.notify[key] !== false);
      row.toggles[key].setAttribute('aria-label', `${a.label}: ${COLUMN_LABELS[key]}`);
      row.toggles[key].title = `${COLUMN_LABELS[key]} for ${a.label}`;
    }
  });
}

async function init() {
  document.getElementById('version').textContent = await api.getVersion();
  const { accounts, prefs } = await api.list();
  renderAccounts(accounts);
  for (const key of APP_KEYS) {
    const btn = document.getElementById('p-' + key);
    setToggle(btn, !!prefs[key]);
    btn.addEventListener('click', async () => {
      const updated = await api.setPref(key, !btn.classList.contains('on'));
      if (updated) setToggle(btn, !!updated[key]);
    });
  }
}

init();
api.onState((state) => renderAccounts(state.accounts || []));
