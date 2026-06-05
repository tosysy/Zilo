const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('docTypesAPI', {
    getAll:         ()           => ipcRenderer.invoke('doc-types-get-all'),
    create:         (data)       => ipcRenderer.invoke('doc-types-create', data),
    update:         (id, data)   => ipcRenderer.invoke('doc-types-update', { id, data }),
    remove:         (id)         => ipcRenderer.invoke('doc-types-delete', id),
    selectFolder:   ()           => ipcRenderer.invoke('select-folder'),
    getAllTemplates: ()           => ipcRenderer.invoke('ocr-zonal-get-templates'),
    onThemeChanged: (cb)         => ipcRenderer.on('theme-changed', (_, theme) => cb(theme))
});
