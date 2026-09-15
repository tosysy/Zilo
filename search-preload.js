const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Cargar el índice OCR
    loadOcrIndex: () => ipcRenderer.invoke('load-ocr-index'),

    // Abrir archivo
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),

    // Leer archivo PDF
    readPdfFile: (filePath) => ipcRenderer.invoke('read-pdf-file', filePath),

    // Abrir ventana de renombrado manual
    openManualRenameWindow: (fileData) => ipcRenderer.invoke('open-manual-rename-window', fileData),

    // Recibir tema desde la ventana principal
    onThemeChange: (callback) => ipcRenderer.on('theme-changed', (event, theme) => callback(theme))
});
