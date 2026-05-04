const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Enviar configuración guardada a la ventana principal
    saveSettings: (settings) => ipcRenderer.send('settings-saved', settings),

    // Recibir configuración actual
    onLoadSettings: (callback) => ipcRenderer.on('load-settings', (event, settings) => callback(settings)),

    // Recibir la señal de que es la primera vez que se abre
    onFirstTimeSetup: (callback) => ipcRenderer.on('first-time-setup', () => callback()),

    // Recibir tema desde la ventana principal
    onThemeChange: (callback) => ipcRenderer.on('theme-changed', (event, theme) => callback(theme)),

    // Cerrar la ventana de configuración
    closeSettingsWindow: () => ipcRenderer.send('close-settings-window'),

    // Seleccionar carpeta
    selectFolder: () => ipcRenderer.invoke('select-folder'),

    // Seleccionar ubicación del archivo de índice OCR
    selectOCRIndexLocation: () => ipcRenderer.invoke('select-ocr-index-location'),

    // Obtener la ruta por defecto del índice OCR
    getDefaultOCRIndexPath: () => ipcRenderer.invoke('get-default-ocr-index-path')
});