const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Recibir tema desde la ventana principal
    onThemeChange: (callback) => ipcRenderer.on('theme-changed', (event, theme) => callback(theme)),

    // Cerrar la ventana de backups
    closeBackupWindow: () => ipcRenderer.send('close-backup-window'),

    // APIs de Backup y Restauración
    getBackups: () => ipcRenderer.invoke('get-backups'),
    getBackupStats: () => ipcRenderer.invoke('get-backup-stats'),
    restoreBackup: (backupId) => ipcRenderer.invoke('restore-backup', backupId),
    deleteBackup: (backupId) => ipcRenderer.invoke('delete-backup', backupId),
    clearAllBackups: () => ipcRenderer.invoke('clear-all-backups'),

    // Abrir archivo con el visor del sistema
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),

    // Recargar índice OCR (para notificar a la ventana principal)
    reloadOCRIndex: () => ipcRenderer.invoke('reload-ocr-index-from-backup-window')
});
