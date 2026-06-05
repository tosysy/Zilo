const { contextBridge, ipcRenderer } = require('electron');

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
    onThemeChanged: (callback) => ipcRenderer.on('theme-changed', (_event, theme) => callback(theme)),

    // Leer PDF para previsualización
    readPdfFile: (filePath) => ipcRenderer.invoke('read-pdf-file', filePath),

    // ── Creación de plantillas desde la ventana de renombrado ─────────────────
    saveOcrTemplate:  (data)      => ipcRenderer.invoke('ocr-zonal-save-template', data),
    getOcrTemplates:  ()          => ipcRenderer.invoke('ocr-zonal-get-templates'),
    getDocTypes:      ()          => ipcRenderer.invoke('doc-types-get-all'),
    createDocType:    (data)      => ipcRenderer.invoke('doc-types-create', data),
    updateDocType:    (id, data)  => ipcRenderer.invoke('doc-types-update', { id, data }),
    selectFolder:     ()          => ipcRenderer.invoke('select-folder'),
});
