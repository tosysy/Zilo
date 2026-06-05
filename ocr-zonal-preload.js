const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ocrZonalAPI', {
    getAllTemplates:        ()     => ipcRenderer.invoke('ocr-zonal-get-templates'),
    saveTemplate:          (data) => ipcRenderer.invoke('ocr-zonal-save-template', data),
    deleteTemplate:        (id)   => ipcRenderer.invoke('ocr-zonal-delete-template', id),
    incrementConfirmations:(id)   => ipcRenderer.invoke('ocr-increment-confirmations', id),
    getPendingPatterns:    ()     => ipcRenderer.invoke('ocr-get-pending-patterns'),
    deletePendingPattern:  (id)   => ipcRenderer.invoke('ocr-delete-pending-pattern', id),
    promotePendingPattern: (id)   => ipcRenderer.invoke('ocr-promote-pending-pattern', id),
    mlGetStats:            ()     => ipcRenderer.invoke('ml-get-stats'),
    mlDeleteClass:         (cls)  => ipcRenderer.invoke('ml-delete-class', cls),
    mlReset:               ()     => ipcRenderer.invoke('ml-reset'),
    readPdf:               (p)    => ipcRenderer.invoke('read-pdf-file', p),
    selectPdf:             ()     => ipcRenderer.invoke('select-pdf-file'),
    closeWindow:           ()     => ipcRenderer.send('close-ocr-zonal-window'),
    onThemeChanged:        (cb)   => ipcRenderer.on('theme-changed', (_, t) => cb(t)),
    // PDF pre-cargado al abrir desde el renombrado manual
    onPreloadPdf:          (cb)   => ipcRenderer.on('preload-pdf', (_, data) => cb(data)),
    // Procesar el documento con el tipo creado y cerrar (vuelve al renombrado manual)
    finalizeFromManual:    (data) => ipcRenderer.send('ocr-zonal-finalize-manual', data),
    // Asignación de tipo de documento al guardar plantilla
    getDocTypes:           ()        => ipcRenderer.invoke('doc-types-get-all'),
    createDocType:         (data)    => ipcRenderer.invoke('doc-types-create', data),
    updateDocType:         (id, data)=> ipcRenderer.invoke('doc-types-update', { id, data }),
    selectFolder:          ()        => ipcRenderer.invoke('select-folder')
});
