const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adminAPI', {
    getStatus:      ()                              => ipcRenderer.invoke('license-get-status'),
    getDevices:     (key)                           => ipcRenderer.invoke('license-get-devices', key),
    revokeDevice:   (targetId)                      => ipcRenderer.invoke('license-revoke-device', targetId),
    transferAdmin:  (targetId)                      => ipcRenderer.invoke('license-transfer-admin', targetId),
    getMachineId:   ()                              => ipcRenderer.invoke('license-get-machine-id'),
    onThemeChanged: (cb)                            => ipcRenderer.on('theme-changed', (_, theme) => cb(theme))
});
