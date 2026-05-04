const { contextBridge, ipcRenderer } = require('electron');

// Exponer API segura al renderer de la ventana de renombrado manual
contextBridge.exposeInMainWorld('manualRenameAPI', {
    // Confirmar el renombrado con los datos ingresados
    confirmRename: (data) => ipcRenderer.send('manual-rename-confirmed', data),

    // Omitir el archivo actual
    skipFile: () => ipcRenderer.send('manual-rename-skipped'),

    // Cerrar la ventana
    closeWindow: () => ipcRenderer.send('manual-rename-close'),

    // Recibir datos del archivo a renombrar
    onFileData: (callback) => ipcRenderer.on('file-data', (_event, data) => callback(data)),

    // Recibir cambios de tema
    onThemeChanged: (callback) => ipcRenderer.on('theme-changed', (_event, theme) => callback(theme))
});
