'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  settings: call('settings:get'),
  saveSettings: call('settings:set'),
  setToken: call('settings:token'),
  pickWow: call('wow:pick'),
  useWow: call('wow:use'),
  overview: call('addons:overview'),
  check: call('addons:check'),
  update: call('addons:update'),
  add: call('addons:add'),
  remove: call('addons:remove'),
  ignore: call('addons:ignore'),
  backups: call('addons:backups'),
  rollback: call('addons:rollback'),
  branches: call('addons:branches'),
  changeBranch: call('addons:changeBranch'),
  changes: call('addons:changes'),
  installDep: call('addons:installDep'),
  refreshCatalog: call('catalog:refresh'),
  suggest: call('addons:suggest'),
  importRead: call('import:read'),
  importRun: call('import:run'),
  launch: call('wow:launch'),
  openFolder: call('shell:folder'),
  openUrl: call('shell:url'),
  onLog: (fn) => ipcRenderer.on('log', (_e, entry) => fn(entry)),
});
