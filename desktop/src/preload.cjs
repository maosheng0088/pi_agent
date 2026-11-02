'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (location.href === 'piconsole://app/offline.html') contextBridge.exposeInMainWorld('piDesktop', Object.freeze({ state: () => ipcRenderer.invoke('piconsole:state'), action: name => ipcRenderer.invoke('piconsole:action', name) }));
if (location.href === 'piconsole://app/update.html') contextBridge.exposeInMainWorld('piDesktopUpdates', Object.freeze({ state: () => ipcRenderer.invoke('piconsole:update-state'), action: name => ipcRenderer.invoke('piconsole:update-action', name) }));
