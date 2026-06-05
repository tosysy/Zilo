const { contextBridge, ipcRenderer } = require('electron');

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
  loadOcrIndex: () =>
    ipcRenderer.invoke('load-ocr-index'),
  // Alias antiguo para compatibilidad con search-window.js
  loadOCRIndex: () =>
    ipcRenderer.invoke('load-ocr-index'),
  addOcrDocument: (data) =>
    ipcRenderer.invoke('add-ocr-document', data),
  getRecentDocuments: (limit) =>
    ipcRenderer.invoke('get-recent-documents', limit),
  removeOcrDocument: (filePath) =>
    ipcRenderer.invoke('remove-ocr-document', filePath),
  saveOCRIndex: (indexData) =>
    ipcRenderer.invoke('save-ocr-index', indexData),
  getFilePath: (file) => getFilePath(file),
  openSearchWindow: () => ipcRenderer.invoke('open-search-window'),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  openManualRenameWindow: (fileData) => ipcRenderer.invoke('open-manual-rename-window', fileData),
  closeManualRenameWindow: () => ipcRenderer.invoke('close-manual-rename-window'),
  onManualRenameConfirmed: (callback) =>
    ipcRenderer.on('manual-rename-confirmed', (_event, data) => callback(data)),
  onManualRenameSkipped: (callback) =>
    ipcRenderer.on('manual-rename-skipped', () => callback()),
  onManualTemplateCreated: (callback) =>
    ipcRenderer.on('manual-template-created', (_event, data) => callback(data)),
  logToCmd: (msg) => ipcRenderer.send('log-to-cmd', msg),
  onWatchedFileDetected: (callback) =>
    ipcRenderer.on('watched-file-detected', (_event, fileData) => callback(fileData)),
  getLicenseStatus:    ()           => ipcRenderer.invoke('license-get-status'),
  openAdminPanel:      ()           => ipcRenderer.invoke('open-admin-panel'),
  openOcrZonalWindow:         ()     => ipcRenderer.invoke('open-ocr-zonal-window'),
  getOcrTemplates:            ()     => ipcRenderer.invoke('ocr-zonal-get-templates'),
  incrementOcrConfirmations:  (id)   => ipcRenderer.invoke('ocr-increment-confirmations', id),
  addTemplateCif:             (data) => ipcRenderer.invoke('ocr-add-template-cif', data),
  addPendingPattern:          (data) => ipcRenderer.invoke('ocr-add-pending-pattern', data),
  // Aprendizaje adaptativo de posiciones OCR
  recordPartPosition: (data) => ipcRenderer.invoke('position-record',       data),
  getAdaptiveZone:    (data) => ipcRenderer.invoke('position-get-adaptive', data),
  getPositionStats:   (tplId)=> ipcRenderer.invoke('position-get-stats',    tplId),

  mlTrain:      (text, className) => ipcRenderer.invoke('ml-train',        { text, className }),
  mlClassify:   (text)            => ipcRenderer.invoke('ml-classify',     text),
  mlGetStats:   ()                => ipcRenderer.invoke('ml-get-stats'),
  mlDeleteClass:(className)       => ipcRenderer.invoke('ml-delete-class', className),
  mlReset:      ()                => ipcRenderer.invoke('ml-reset'),
  getDocTypes:        ()           => ipcRenderer.invoke('doc-types-get-all'),
  updateDocType:      (id, data)   => ipcRenderer.invoke('doc-types-update', { id, data }),
  openDocTypesWindow: ()           => ipcRenderer.invoke('open-doc-types-window'),
  onDocTypesUpdated:  (cb)         => ipcRenderer.on('doc-types-updated', () => cb()),
  learnRenamePattern: (typeName, ocrText, finalName) =>
    ipcRenderer.invoke('learn-rename-pattern', { typeName, ocrText, finalName }),
  getLearnedPatterns: (typeName) =>
    ipcRenderer.invoke('get-learned-patterns', typeName),
});
