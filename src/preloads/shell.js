'use strict';
// Bridge for the shell + settings windows. Mail pages get NO preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('minimail', {
  list: () => ipcRenderer.invoke('accounts:list'),
  // Opens the "which mail service?" menu at a point of the window.
  add: (x, y) => ipcRenderer.send('shell:add-account', { x, y }),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  switchTo: (id) => ipcRenderer.send('accounts:switch', id),
  toggleSidebar: () => ipcRenderer.send('shell:toggle-sidebar'),
  menu: (id, x, y) => ipcRenderer.send('shell:menu', { id, x, y }),
  openSettings: () => ipcRenderer.send('window:open-settings'),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPref: (key, value) => ipcRenderer.invoke('prefs:set', { key, value }),
  getVersion: () => ipcRenderer.invoke('app:version'),
  openFile: (p) => ipcRenderer.invoke('shell:open-file', p),
  showFolder: (p) => ipcRenderer.invoke('shell:show-item', p),
  onDownload: (fn) => ipcRenderer.on('download:done', (_e, dl) => fn(dl)),
  lastDownload: () => ipcRenderer.invoke('downloads:last'),
  onState: (fn) => ipcRenderer.on('state:changed', (_e, state) => fn(state)),
  // One account's notification switches: key is "count", "sound" or "banner".
  setAccountPref: (id, key, value) => ipcRenderer.invoke('account:set-pref', { id, key, value }),
  // The global mute. `until` is a moment in ms; 0 turns notifications back on.
  setMute: (until) => ipcRenderer.invoke('mute:set', until),
  muteMenu: (x, y) => ipcRenderer.send('shell:mute-menu', { x, y }),
  // The Settings window asks to be re-sized when its content grows or shrinks.
  fit: () => ipcRenderer.send('window:fit-settings'),
  onSound: (fn) => ipcRenderer.on('shell:sound', () => fn()),
});
