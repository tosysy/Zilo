const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
    activate:       (key)  => ipcRenderer.invoke('license-activate', key),
    getStatus:      ()     => ipcRenderer.invoke('license-get-status'),
    onThemeChanged: (cb)   => ipcRenderer.on('theme-changed', (_, theme) => cb(theme))
});
