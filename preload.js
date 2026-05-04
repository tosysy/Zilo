const { contextBridge, ipcRenderer } = require('electron');

// Función helper para extraer la ruta de un objeto File
// En Electron, los Files tienen la propiedad .path
function getFilePath(file) {
  return file.path || null;
}

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  moveFile: (originalPath, destFolder, newName, createSubfolder) =>
    ipcRenderer.invoke('move-file', originalPath, destFolder, newName, createSubfolder),
  renameFile: (originalPath, newName) =>
    ipcRenderer.invoke('rename-file', originalPath, newName),
  readPdfFile: (filePath) =>
    ipcRenderer.invoke('read-pdf-file', filePath),
  openFile: (filePath) =>
    ipcRenderer.invoke('open-file', filePath),
  loadOCRIndex: () =>
    ipcRenderer.invoke('load-ocr-index'),
  saveOCRIndex: (indexData) =>
    ipcRenderer.invoke('save-ocr-index', indexData),

  // Obtener la ruta de un archivo
  getFilePath: (file) => getFilePath(file),

  // Abrir ventanas separadas
  openSearchWindow: () =>
    ipcRenderer.invoke('open-search-window'),
  openSettingsWindow: () =>
    ipcRenderer.invoke('open-settings-window'),
  openManualRenameWindow: (fileData) =>
    ipcRenderer.invoke('open-manual-rename-window', fileData),

  // Listeners para eventos desde las ventanas
  onManualRenameConfirmed: (callback) =>
    ipcRenderer.on('manual-rename-confirmed', (_event, data) => callback(data)),
  onManualRenameSkipped: (callback) =>
    ipcRenderer.on('manual-rename-skipped', () => callback()),

  // Listener para archivos detectados por vigilancia de carpeta
  onWatchedFileDetected: (callback) =>
    ipcRenderer.on('watched-file-detected', (_event, fileData) => callback(fileData))
});