const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// ── Módulos de licencia, OCR Zonal y BD ──────────────────────────────────────
const { LicenseManager, ROLES } = require('./license-manager');
const { OcrZonalEngine }        = require('./ocr-zonal-engine');
const { MLEngine }              = require('./ml-engine');
const ZiloDatabase              = require('./db');

let licenseManager   = null;
let ocrZonalEngine   = null;
let mlEngine         = null;
let ziloDb           = null;
let licenseWindow    = null;
let adminPanelWindow = null;
let ocrZonalWindow   = null;
let docTypesWindow   = null;

let mainWindow;
let searchWindow = null;
let settingsWindow = null;
let manualRenameWindow = null;
let customOCRIndexPath = null; // Ruta personalizada del índice OCR

// Watch folder state
let watchFolderWatcher = null;
let watchedFiles = new Set();
const pendingWatchDebounce = new Map();

async function startWatchFolder(folderPath) {
  stopWatchFolder();
  if (!folderPath || folderPath.trim() === '') return;

  console.log('[WATCH] Iniciando vigilancia de carpeta:', folderPath);

  // Marcar archivos existentes para no procesarlos
  try {
    const files = await fs.readdir(folderPath);
    files.filter(f => f.toLowerCase().endsWith('.pdf'))
         .forEach(f => watchedFiles.add(path.join(folderPath, f)));
    console.log(`[WATCH] ${watchedFiles.size} archivos existentes marcados`);
  } catch (e) {
    console.warn('[WATCH] No se pudo escanear la carpeta inicial:', e.message);
  }

  try {
    watchFolderWatcher = require('fs').watch(folderPath, (eventType, filename) => {
      if (!filename || !filename.toLowerCase().endsWith('.pdf')) return;

      const fullPath = path.join(folderPath, filename);
      if (watchedFiles.has(fullPath)) return;

      // Debounce: el SO puede disparar varios eventos por el mismo archivo
      if (pendingWatchDebounce.has(fullPath)) {
        clearTimeout(pendingWatchDebounce.get(fullPath));
      }

      const timer = setTimeout(async () => {
        pendingWatchDebounce.delete(fullPath);
        if (watchedFiles.has(fullPath)) return;
        watchedFiles.add(fullPath);

        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > 0) {
            console.log('[WATCH] Nuevo archivo listo:', fullPath);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('watched-file-detected', { path: fullPath, name: filename });
            }
          } else {
            watchedFiles.delete(fullPath); // Archivo vacío, reintentar si vuelve a aparecer
          }
        } catch (e) {
          watchedFiles.delete(fullPath); // No accesible aún, reintentar
        }
      }, 1500); // 1.5s para que el archivo esté completamente escrito

      pendingWatchDebounce.set(fullPath, timer);
    });

    watchFolderWatcher.on('error', (e) => {
      console.error('[WATCH] Error en el watcher:', e.message);
    });

    console.log('[WATCH] Vigilancia activa en tiempo real');
  } catch (e) {
    console.error('[WATCH] Error al iniciar vigilancia:', e.message);
  }
}

function stopWatchFolder() {
  if (watchFolderWatcher) {
    watchFolderWatcher.close();
    watchFolderWatcher = null;
  }
  pendingWatchDebounce.forEach(t => clearTimeout(t));
  pendingWatchDebounce.clear();
  watchedFiles.clear();
}

// ─── Ventana de activación de licencia ───────────────────────────────────────
function openLicenseWindow() {
  return new Promise((resolve) => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width  / 2) - (900 / 2));
    const y = Math.round((height / 2) - (660 / 2));

    licenseWindow = new BrowserWindow({
      width: 900, height: 660, x, y,
      resizable: false, maximizable: false, fullscreenable: false, minimizable: false,
      closable: false,
      webPreferences: {
        preload: path.join(__dirname, 'license-preload.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: false
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Activar Zilo', autoHideMenuBar: true
    });

    licenseWindow.loadFile(path.join(__dirname, 'renderer/license-window.html'));

    // Cerramos la ventana cuando la licencia quede activa (el renderer recarga)
    licenseWindow.webContents.on('did-finish-load', () => {
      const status = licenseManager.getStatus();
      if (status.activated && licenseWindow && !licenseWindow.isDestroyed()) {
        licenseWindow.closable = true;
        licenseWindow.close();
      }
    });

    licenseWindow.on('closed', () => { licenseWindow = null; resolve(); });
  });
}

// ─── Panel de administración ──────────────────────────────────────────────────
function openAdminPanel() {
  return new Promise((resolve) => {
    if (adminPanelWindow && !adminPanelWindow.isDestroyed()) {
      adminPanelWindow.focus(); return resolve({ success: true });
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width  / 2) - (900 / 2));
    const y = Math.round((height / 2) - (620 / 2));

    adminPanelWindow = new BrowserWindow({
      width: 900, height: 620, x, y,
      parent: mainWindow, resizable: true, maximizable: true, fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, 'admin-panel-preload.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: false
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Panel de Administración — Zilo', autoHideMenuBar: true
    });

    adminPanelWindow.loadFile(path.join(__dirname, 'renderer/admin-panel-window.html'));
    mainWindow.webContents.executeJavaScript('localStorage.getItem("theme")').then(theme => {
      if (adminPanelWindow && !adminPanelWindow.isDestroyed())
        adminPanelWindow.webContents.send('theme-changed', theme || 'light');
    });
    adminPanelWindow.on('closed', () => { adminPanelWindow = null; resolve({ success: true }); });
  });
}

// ─── Ventana OCR Zonal ────────────────────────────────────────────────────────
function openOcrZonalWindow() {
  return new Promise((resolve) => {
    if (ocrZonalWindow && !ocrZonalWindow.isDestroyed()) {
      ocrZonalWindow.focus(); return resolve({ success: true });
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width  / 2) - (1200 / 2));
    const y = Math.round((height / 2) - (760 / 2));

    ocrZonalWindow = new BrowserWindow({
      width: 1200, height: 760, x, y,
      parent: mainWindow, modal: true,
      resizable: true, maximizable: true, fullscreenable: true,
      webPreferences: {
        preload: path.join(__dirname, 'ocr-zonal-preload.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: false
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Motor OCR Zonal — Zilo', autoHideMenuBar: true
    });

    ocrZonalWindow.loadFile(path.join(__dirname, 'renderer/ocr-zonal-window.html'));
    mainWindow.webContents.executeJavaScript('localStorage.getItem("theme")').then(theme => {
      if (ocrZonalWindow && !ocrZonalWindow.isDestroyed())
        ocrZonalWindow.webContents.send('theme-changed', theme || 'light');
    });
    ocrZonalWindow.on('closed', () => { ocrZonalWindow = null; resolve({ success: true }); });
  });
}

// ─── Ventana de Tipos de Documento ───────────────────────────────────────────
function openDocTypesWindow() {
  return new Promise((resolve) => {
    if (docTypesWindow && !docTypesWindow.isDestroyed()) {
      docTypesWindow.focus(); return resolve({ success: true });
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width  / 2) - (860 / 2));
    const y = Math.round((height / 2) - (600 / 2));

    docTypesWindow = new BrowserWindow({
      width: 860, height: 600, x, y,
      parent: mainWindow, resizable: true, maximizable: true,
      webPreferences: {
        preload: path.join(__dirname, 'doc-types-preload.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: false
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Tipos de Documento — Zilo', autoHideMenuBar: true
    });
    docTypesWindow.loadFile(path.join(__dirname, 'renderer/doc-types-window.html'));
    mainWindow.webContents.executeJavaScript('localStorage.getItem("theme")').then(theme => {
      if (docTypesWindow && !docTypesWindow.isDestroyed())
        docTypesWindow.webContents.send('theme-changed', theme || 'light');
    });
    docTypesWindow.on('closed', () => {
      docTypesWindow = null;
      // Notificar a la app principal para que recargue los tipos
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('doc-types-updated');
      resolve({ success: true });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 660,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: true,
    },
    icon: path.join(__dirname, 'build/icon.png'),
    title: 'Procesador PDFs',
    autoHideMenuBar: true,
    backgroundColor: '#f0f2f5',
    show: false // Ocultar la ventana principal al inicio
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  // Bloquear atajos de teclado no deseados
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control || input.meta) {
      // Bloquear Ctrl+R / Cmd+R (recargar)
      if (input.key.toLowerCase() === 'r') {
        event.preventDefault();
      }
      // Bloquear Ctrl+Shift+I / Cmd+Option+I (DevTools)
      if (input.shift && input.key.toLowerCase() === 'i') {
        event.preventDefault();
      }
      // Bloquear Ctrl+Shift+J / Cmd+Option+J (DevTools console)
      if (input.shift && input.key.toLowerCase() === 'j') {
        event.preventDefault();
      }
      // Bloquear F12 (DevTools)
    }
    if (input.key === 'F12') {
      event.preventDefault();
    }
    // Bloquear F5 (recargar)
    if (input.key === 'F5') {
      event.preventDefault();
    }
  });

  // Cuando se cierra la ventana principal, cerrar todas las demás ventanas
  mainWindow.on('close', () => {
    // Cerrar ventana de búsqueda
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.destroy();
    }

    // Cerrar ventana de configuración
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
    }

    // Cerrar ventana de renombrado manual
    if (manualRenameWindow && !manualRenameWindow.isDestroyed()) {
      manualRenameWindow.forceClose = true;
      manualRenameWindow.destroy();
    }
  });
}

function openSettingsWindowFirstTime() {
  return new Promise((resolve) => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width / 2) - (1100 / 2));
    const y = Math.round((height / 2) - (800 / 2));

    settingsWindow = new BrowserWindow({
      width: 1100,
      height: 800,
      x,
      y,
      parent: mainWindow,
      modal: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      minimizable: false,
      closable: false, // No permitir cerrar la ventana
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        devTools: true,
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Configuración Inicial',
      autoHideMenuBar: true,
      backgroundColor: '#fcfcfc'
    });

    settingsWindow.loadFile(path.join(__dirname, 'renderer/settings-window.html'));

    settingsWindow.on('closed', () => {
      settingsWindow = null;
      resolve({ success: true });
    });
  });
}

app.whenReady().then(() => {
  // ── Inicializar módulos ────────────────────────────────────────────────────
  licenseManager = new LicenseManager(app);
  licenseManager.initialize();

  // Inicializar DB primero — los motores dependen de ella
  ziloDb = new ZiloDatabase(app);
  ziloDb.initialize();

  ocrZonalEngine = new OcrZonalEngine(ziloDb);
  mlEngine       = new MLEngine(ziloDb);

  createWindow();

  // Cargar la ruta personalizada del índice OCR cuando la ventana esté lista
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      // ── Comprobar licencia activa ────────────────────────────────────────
      const licStatus = licenseManager.getStatus();
      if (!licStatus.activated) {
        await openLicenseWindow();
        // Comprobar de nuevo tras activación
        const afterActivation = licenseManager.getStatus();
        if (!afterActivation.activated) {
          app.quit();
          return;
        }
      }

      // Verificar si es la primera vez que se abre la aplicación
      const firstTimeSetup = await mainWindow.webContents.executeJavaScript('localStorage.getItem("first-time-setup")');

      if (!firstTimeSetup || firstTimeSetup === 'null') {
        // Es la primera vez - abrir configuración
        console.log('[INICIO] Primera vez detectada - abriendo configuracion');
        await openSettingsWindowFirstTime();
        // La ventana principal se mostrará cuando se guarden los ajustes
      } else {
        // No es la primera vez - cargar configuración normal y mostrar ventana
        mainWindow.show();
        const savedPath = await mainWindow.webContents.executeJavaScript('localStorage.getItem("ocr-index-path")');
        if (savedPath && savedPath !== 'null' && savedPath.trim() !== '') {
          customOCRIndexPath = savedPath;
          console.log('[INICIO] Ruta personalizada del indice OCR cargada:', customOCRIndexPath);
        } else {
          console.log('[INICIO] Usando ruta por defecto del indice OCR');
        }

        // Iniciar vigilancia de carpeta si está configurada
        const savedWatchFolder = await mainWindow.webContents.executeJavaScript('localStorage.getItem("watch-folder")');
        if (savedWatchFolder && savedWatchFolder !== 'null' && savedWatchFolder.trim() !== '') {
          startWatchFolder(savedWatchFolder);
        }
      }
    } catch (error) {
      console.error('[ERROR] No se pudo cargar la ruta personalizada del indice OCR:', error);
      mainWindow.show(); // Mostrar la ventana principal en caso de error
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Selector de carpeta
ipcMain.handle('select-folder', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, folder: result.filePaths[0] };
    }

    return { success: false, cancelled: true };
  } catch (error) {
    console.error('Error al seleccionar carpeta:', error);
    return { success: false, error: error.message };
  }
});

// Selector de archivos PDF
ipcMain.handle('select-files', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF Files', extensions: ['pdf'] }
      ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, files: result.filePaths };
    }

    return { success: false, cancelled: true };
  } catch (error) {
    console.error('Error al seleccionar archivos:', error);
    return { success: false, error: error.message };
  }
});

// Función auxiliar para copiar archivo (maneja cross-device)
async function copyFile(source, destination) {
  try {
    await fs.copyFile(source, destination);
    return true;
  } catch (error) {
    console.error('Error al copiar archivo:', error);
    throw error;
  }
}

// Función auxiliar para mover archivo (con soporte cross-device)
async function moveFileCrossDevice(source, destination) {
  try {
    // Intentar mover directamente primero (mismo disco)
    await fs.rename(source, destination);
    console.log('[SUCCESS] Archivo movido con rename (mismo disco)');
    return destination;
  } catch (error) {
    if (error.code === 'EXDEV') {
      // Error cross-device: copiar y eliminar
      console.log('[WARNING] Cross-device detectado, usando copy + delete');
      await fs.copyFile(source, destination);
      await fs.unlink(source);
      console.log('[SUCCESS] Archivo movido con copy + delete (diferentes discos)');
      return destination;
    } else {
      throw error;
    }
  }
}

// Mover archivo a carpeta de destino
ipcMain.handle('move-file', async (event, originalPath, destFolder, newName, createSubfolder = false) => {
  try {
    console.log('[INFO] Moviendo archivo...');
    console.log('  - Origen:', originalPath);
    console.log('  - Carpeta destino:', destFolder);
    console.log('  - Nuevo nombre:', newName);
    console.log('  - Crear subcarpeta:', createSubfolder);
    
    let finalDestFolder = destFolder;
    
    // Si se solicita crear subcarpeta (para pedidos)
    if (createSubfolder) {
      // Extraer el número y tipo (ej: "1-25088 PEDIDO ALMACEN.pdf" -> "1-25088 PEDIDO")
      const folderName = newName.split(' ').slice(0, 2).join(' '); // Obtiene "1-25088 PEDIDO"
      const subfolderPath = path.join(destFolder, folderName);
      
      console.log('  - Subcarpeta a crear:', subfolderPath);
      
      // Crear la subcarpeta si no existe
      try {
        await fs.access(subfolderPath);
        console.log('  - Subcarpeta ya existe');
      } catch {
        await fs.mkdir(subfolderPath, { recursive: true });
        console.log('  - Subcarpeta creada');
      }
      
      finalDestFolder = subfolderPath;
    }
    
    const newPath = path.join(finalDestFolder, newName);
    console.log('  - Ruta final:', newPath);
    
    // Verificar si el archivo destino ya existe
    try {
      await fs.access(newPath);
      // Si existe, agregar un número
      const ext = path.extname(newName);
      const nameWithoutExt = newName.replace(ext, '');
      let counter = 1;
      let finalPath = newPath;
      
      while (true) {
        try {
          finalPath = path.join(finalDestFolder, `${nameWithoutExt} (${counter})${ext}`);
          await fs.access(finalPath);
          counter++;
        } catch {
          break;
        }
      }
      
      console.log('  - Archivo ya existe, usando:', finalPath);
      await moveFileCrossDevice(originalPath, finalPath);
      return { success: true, newPath: finalPath };
    } catch {
      // El archivo no existe, podemos usar el nombre original
      await moveFileCrossDevice(originalPath, newPath);
      return { success: true, newPath: newPath };
    }
  } catch (error) {
    console.error('[ERROR] Error al mover archivo:', error);
    return { success: false, error: error.message };
  }
});

// Renombrar archivo en su ubicación original
ipcMain.handle('rename-file', async (event, originalPath, newName) => {
  try {
    const directory = path.dirname(originalPath);
    let newPath = path.join(directory, newName);
    
    // Verificar si el archivo destino ya existe
    try {
      await fs.access(newPath);
      // Si existe, agregar un número
      const ext = path.extname(newName);
      const nameWithoutExt = newName.replace(ext, '');
      let counter = 1;
      let finalPath = newPath;
      
      while (true) {
        try {
          finalPath = path.join(directory, `${nameWithoutExt} (${counter})${ext}`);
          await fs.access(finalPath);
          counter++;
        } catch {
          break;
        }
      }
      newPath = finalPath;
    } catch {
      // El archivo no existe, podemos usar el nombre original
    }
    
    await fs.rename(originalPath, newPath);
    return { success: true, newPath: newPath };
  } catch (error) {
    console.error('Error al renombrar archivo:', error);
    return { success: false, error: error.message };
  }
});

// Leer archivo PDF
ipcMain.handle('read-pdf-file', async (event, filePath) => {
  try {
    const buffer = await fs.readFile(filePath);
    return { success: true, data: buffer };
  } catch (error) {
    return { success: false, error: error.message };
  }
});



// Abrir archivo con la aplicación predeterminada
ipcMain.handle('open-file', async (event, filePath) => {
  try {
    console.log('[INFO] Abriendo archivo:', filePath);
    
    // Verificar que el archivo existe
    try {
      await fs.access(filePath);
    } catch {
      return { success: false, error: 'El archivo no existe o no se puede acceder' };
    }
    
    // Abrir con la aplicación predeterminada del sistema
    const result = await shell.openPath(filePath);
    
    if (result) {
      // Si shell.openPath devuelve un string, es un error
      console.error('Error al abrir archivo:', result);
      return { success: false, error: result };
    }
    
    console.log('[SUCCESS] Archivo abierto correctamente');
    return { success: true };
  } catch (error) {
    console.error('[ERROR] Error al abrir archivo:', error);
    return { success: false, error: error.message };
  }
});

// Ruta del archivo de índice OCR
const getOCRIndexPath = () => {
  // Si hay una ruta personalizada guardada, usarla
  if (customOCRIndexPath) {
    console.log('[INFO] Usando ruta personalizada del indice OCR:', customOCRIndexPath);
    return customOCRIndexPath;
  }
  // Si no, usar la ruta por defecto
  const defaultPath = path.join(app.getPath('userData'), 'ocr-index.json');
  console.log('[INFO] Usando ruta por defecto del indice OCR:', defaultPath);
  return defaultPath;
};

// Obtener la ruta por defecto del índice OCR
const getDefaultOCRIndexPath = () => {
  return path.join(app.getPath('userData'), 'ocr-index.json');
};

// Cargar índice OCR desde archivo
ipcMain.handle('load-ocr-index', async (event) => {
  try {
    const indexPath = getOCRIndexPath();
    console.log('[INFO] Cargando indice OCR desde:', indexPath);
    
    try {
      const data = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(data);
      console.log('[SUCCESS] Indice OCR cargado:', Object.keys(parsed).length, 'documentos');
      return { success: true, data: parsed };
    } catch (error) {
      if (error.code === 'ENOENT') {
        // El archivo no existe, devolver índice vacío
        console.log('[INFO] Archivo de indice no existe, creando nuevo');
        return { success: true, data: {} };
      }
      throw error;
    }
  } catch (error) {
    console.error('[ERROR] Error al cargar indice OCR:', error);
    return { success: false, error: error.message };
  }
});

// Guardar índice OCR en archivo
ipcMain.handle('save-ocr-index', async (event, indexData) => {
  try {
    const indexPath = getOCRIndexPath();
    console.log('[INFO] Guardando indice OCR en:', indexPath);

    // Convertir a JSON con formato legible
    const jsonData = JSON.stringify(indexData, null, 2);

    await fs.writeFile(indexPath, jsonData, 'utf8');

    console.log('[SUCCESS] Indice OCR guardado:', Object.keys(indexData).length, 'documentos');
    return { success: true, path: indexPath };
  } catch (error) {
    console.error('[ERROR] Error al guardar indice OCR:', error);
    return { success: false, error: error.message };
  }
});

// Selector de ubicación para archivo de índice OCR
ipcMain.handle('select-ocr-index-location', async (event) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Seleccionar ubicación para el archivo de índice OCR',
      defaultPath: 'ocr-index.json',
      filters: [
        { name: 'Archivo JSON', extensions: ['json'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      return { success: true, filePath: result.filePath };
    }

    return { success: false, cancelled: true };
  } catch (error) {
    console.error('Error al seleccionar ubicación:', error);
    return { success: false, error: error.message };
  }
});

// Obtener la ruta por defecto del índice OCR
ipcMain.handle('get-default-ocr-index-path', async (event) => {
  try {
    const defaultPath = getDefaultOCRIndexPath();
    return { success: true, path: defaultPath };
  } catch (error) {
    console.error('Error al obtener ruta por defecto:', error);
    return { success: false, error: error.message };
  }
});

// Abrir ventana de búsqueda
ipcMain.handle('open-search-window', async (event) => {
  try {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.focus();
      return { success: true };
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width / 2) - (1240 / 2));
    const y = Math.round((height / 2) - (720 / 2));

    searchWindow = new BrowserWindow({
      width: 1240,
      height: 720,
      x,
      y,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, 'search-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        devTools: true,
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Búsqueda de Documentos',
      autoHideMenuBar: true,
      backgroundColor: '#fcfcfc'
    });

    searchWindow.loadFile(path.join(__dirname, 'renderer/search-window.html'));

    // Bloquear atajos de teclado no deseados
    searchWindow.webContents.on('before-input-event', (event, input) => {
      if (input.control || input.meta) {
        if (input.key.toLowerCase() === 'r') {
          event.preventDefault();
        }
        if (input.shift && input.key.toLowerCase() === 'i') {
          event.preventDefault();
        }
        if (input.shift && input.key.toLowerCase() === 'j') {
          event.preventDefault();
        }
      }
      if (input.key === 'F12') {
        event.preventDefault();
      }
      if (input.key === 'F5') {
        event.preventDefault();
      }
    });

    // Sincronizar el tema actual
    const theme = mainWindow.webContents.executeJavaScript('localStorage.getItem("theme")').then(theme => {
      if (searchWindow && !searchWindow.isDestroyed()) {
        searchWindow.webContents.send('theme-changed', theme || 'light');
      }
    });

    searchWindow.on('closed', () => {
      searchWindow = null;
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});



// Abrir ventana de configuración
ipcMain.handle('open-settings-window', async (event) => {
  try {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      return { success: true };
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width / 2) - (1100 / 2));
    const y = Math.round((height / 2) - (800 / 2));

    settingsWindow = new BrowserWindow({
      width: 1100,
      height: 800,
      x,
      y,
      parent: mainWindow,
      modal: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      minimizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        devTools: true,
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Configuración',
      autoHideMenuBar: true,
      backgroundColor: '#fcfcfc'
    });

    settingsWindow.loadFile(path.join(__dirname, 'renderer/settings-window.html'));

    settingsWindow.webContents.on('before-input-event', (event, input) => {
      if (input.control || input.meta) {
        if (input.key.toLowerCase() === 'r') {
          event.preventDefault();
        }
        if (input.shift && input.key.toLowerCase() === 'i') {
          event.preventDefault();
        }
        if (input.shift && input.key.toLowerCase() === 'j') {
          event.preventDefault();
        }
      }
      if (input.key === 'F12') {
        event.preventDefault();
      }
      if (input.key === 'F5') {
        event.preventDefault();
      }
    });

    // Cargar configuración actual desde la ventana principal
    mainWindow.webContents.executeJavaScript(`({
      concurrentLimit: localStorage.getItem("concurrentLimit") || "50",
      ocrIndexPath: localStorage.getItem("ocr-index-path") || "",
      watchFolder: localStorage.getItem("watch-folder") || "",
      watchErrorFolder: localStorage.getItem("watch-error-folder") || "",
      folders: {
        albaranes: localStorage.getItem("auto-folder-albaranes") || "",
        pedidos: localStorage.getItem("auto-folder-pedidos") || "",
        duas: localStorage.getItem("auto-folder-duas") || "",
        facturas: localStorage.getItem("auto-folder-facturas") || "",
        entradas: localStorage.getItem("auto-folder-entradas") || ""
      }
    })`).then(settings => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('load-settings', {
          concurrentLimit: parseInt(settings.concurrentLimit, 10),
          ocrIndexPath: settings.ocrIndexPath,
          watchFolder: settings.watchFolder,
          watchErrorFolder: settings.watchErrorFolder,
          folders: settings.folders
        });
      }
    });

    // Sincronizar el tema actual
    mainWindow.webContents.executeJavaScript('localStorage.getItem("theme")').then(theme => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('theme-changed', theme || 'light');
      }
    });

    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });

    return { success: true };
  } catch (error) {
    console.error('Error al abrir ventana de configuración:', error);
    return { success: false, error: error.message };
  }
});

// Cerrar ventana de configuración (funciona tanto en primer arranque como normal)
ipcMain.on('close-settings-window', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.closable = true;
    settingsWindow.destroy();
  }
});

// Recibir configuración guardada desde la ventana de configuración
ipcMain.on('settings-saved', (event, settings) => {
  console.log('[CONFIG] Configuracion recibida:', settings);

  // Actualizar ruta del índice OCR
  if (settings.ocrIndexPath && settings.ocrIndexPath.trim() !== '') {
    customOCRIndexPath = settings.ocrIndexPath;
  } else {
    customOCRIndexPath = null;
  }

  // Iniciar / detener vigilancia de carpeta
  if (settings.watchFolder && settings.watchFolder.trim() !== '') {
    startWatchFolder(settings.watchFolder);
  } else {
    stopWatchFolder();
  }

  // Persistir todo en localStorage de la ventana principal
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`
      localStorage.setItem('concurrentLimit', '${settings.concurrentLimit || 50}');
      if (typeof concurrentLimit !== 'undefined') concurrentLimit = ${settings.concurrentLimit || 50};
      localStorage.setItem('ocr-index-path', ${JSON.stringify(settings.ocrIndexPath || '')});
      localStorage.setItem('max-pages-ocr', '${settings.maxPages ?? 0}');
      if (typeof maxPagesToProcess !== 'undefined') maxPagesToProcess = ${settings.maxPages ?? 0};
      localStorage.setItem('watch-folder', ${JSON.stringify(settings.watchFolder || '')});
      localStorage.setItem('watch-error-folder', ${JSON.stringify(settings.watchErrorFolder || '')});
      localStorage.setItem('first-time-setup', 'true');
    `);

    // Si la ventana principal estaba oculta (primer arranque), mostrarla ahora
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
  }
});

// Abrir ventana de renombrado manual
ipcMain.handle('open-manual-rename-window', async (event, fileData) => {
  try {
    if (manualRenameWindow && !manualRenameWindow.isDestroyed()) {
      manualRenameWindow.focus();
      // Enviar nuevos datos a la ventana existente
      manualRenameWindow.webContents.send('file-data', fileData);
      return { success: true };
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const x = Math.round((width / 2) - (1100 / 2));
    const y = Math.round((height / 2) - (750 / 2));

    manualRenameWindow = new BrowserWindow({
      width: 1100,
      height: 750,
      x,
      y,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, 'manual-rename-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        devTools: true,
      },
      icon: path.join(__dirname, 'build/icon.png'),
      title: 'Renombrado Manual',
      autoHideMenuBar: true,
      backgroundColor: '#fcfcfc'
    });

    manualRenameWindow.loadFile(path.join(__dirname, 'renderer/manual-rename-window.html'));

    // Bloquear atajos de teclado no deseados
    manualRenameWindow.webContents.on('before-input-event', (event, input) => {
      if (input.control || input.meta) {
        if (input.key.toLowerCase() === 'r') {
          event.preventDefault();
        }
        if (input.shift && input.key.toLowerCase() === 'i') {
          event.preventDefault();
        }
        if (input.shift && input.key.toLowerCase() === 'j') {
          event.preventDefault();
        }
      }
      if (input.key === 'F12') {
        event.preventDefault();
      }
      if (input.key === 'F5') {
        event.preventDefault();
      }
    });

    // Deshabilitar la ventana de búsqueda si está abierta
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.setEnabled(false);
    }

    // Cuando el usuario cierra con X, tratar como omitir
    manualRenameWindow.on('close', (event) => {
      // Si no se ha marcado para forzar cierre, es un cierre del usuario (X)
      if (!manualRenameWindow.forceClose) {
        event.preventDefault();

        // Notificar a la ventana principal que se omitió el archivo
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('manual-rename-skipped');
        }

        // Ahora sí cerrar la ventana
        manualRenameWindow.forceClose = true;
        manualRenameWindow.close();
      }
    });

    // Sincronizar el tema actual
    mainWindow.webContents.executeJavaScript('localStorage.getItem("theme")').then(theme => {
      if (manualRenameWindow && !manualRenameWindow.isDestroyed()) {
        manualRenameWindow.webContents.send('theme-changed', theme || 'light');
      }
    });

    // Esperar a que la ventana esté lista y luego enviar los datos
    manualRenameWindow.webContents.once('did-finish-load', () => {
      if (manualRenameWindow && !manualRenameWindow.isDestroyed()) {
        manualRenameWindow.webContents.send('file-data', fileData);
      }
    });

    manualRenameWindow.on('closed', () => {
      // Re-habilitar la ventana de búsqueda si está abierta
      if (searchWindow && !searchWindow.isDestroyed()) {
        searchWindow.setEnabled(true);
        searchWindow.focus();
        searchWindow.show();
      }
      manualRenameWindow = null;
    });

    return { success: true };
  } catch (error) {
    console.error('Error al abrir ventana de renombrado manual:', error);
    return { success: false, error: error.message };
  }
});

// Recibir confirmación de renombrado manual desde la ventana
ipcMain.on('manual-rename-confirmed', (event, data) => {
  console.log('[SUCCESS] Renombrado manual confirmado:', data);

  // Enviar los datos a la ventana principal
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('manual-rename-confirmed', data);
  }

  // Cerrar la ventana de renombrado (forzar cierre)
  if (manualRenameWindow && !manualRenameWindow.isDestroyed()) {
    manualRenameWindow.forceClose = true;
    manualRenameWindow.close();
  }
});

// Recibir omisión de archivo desde la ventana de renombrado manual
ipcMain.on('manual-rename-skipped', (event) => {
  console.log('[SKIPPED] Archivo omitido por el usuario');

  // Notificar a la ventana principal
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('manual-rename-skipped');
  }

  // Cerrar la ventana de renombrado (forzar cierre)
  if (manualRenameWindow && !manualRenameWindow.isDestroyed()) {
    manualRenameWindow.forceClose = true;
    manualRenameWindow.close();
  }
});

// =============================================================================
// ── IPC: SISTEMA DE LICENCIAS ─────────────────────────────────────────────────
// =============================================================================

ipcMain.handle('license-activate', async (event, key) => {
  return licenseManager.activate(key);
});

ipcMain.handle('license-get-status', async () => {
  return licenseManager.getStatus();
});

ipcMain.handle('license-get-machine-id', async () => {
  return licenseManager.getMachineId();
});

ipcMain.handle('license-get-devices', async (event, licenseKey) => {
  const status = licenseManager.getStatus();
  if (status.role !== ROLES.ADMIN) return [];
  return licenseManager.getDevices(licenseKey);
});

ipcMain.handle('license-revoke-device', async (event, targetMachineId) => {
  const myId = licenseManager.getMachineId();
  return licenseManager.revokeDevice(myId, targetMachineId);
});

ipcMain.handle('license-transfer-admin', async (event, targetMachineId) => {
  const myId = licenseManager.getMachineId();
  return licenseManager.transferAdmin(myId, targetMachineId);
});

ipcMain.handle('open-admin-panel', async () => {
  const status = licenseManager.getStatus();
  if (status.role !== ROLES.ADMIN) return { success: false, error: 'Acceso denegado. Solo el administrador puede abrir este panel.' };
  return openAdminPanel();
});

// =============================================================================
// ── IPC: MOTOR OCR ZONAL (visual, basado en zonas) ───────────────────────────
// =============================================================================

ipcMain.handle('ocr-zonal-get-templates', async () => {
  return ocrZonalEngine.getAllTemplates();
});

ipcMain.handle('ocr-zonal-save-template', async (event, data) => {
  return ocrZonalEngine.saveTemplate(data);
});

ipcMain.handle('ocr-zonal-delete-template', async (event, id) => {
  return ocrZonalEngine.deleteTemplate(id);
});

ipcMain.handle('ocr-increment-confirmations', async (event, id) => {
  return ocrZonalEngine.incrementConfirmations(id);
});

ipcMain.handle('ocr-get-pending-patterns', async () => {
  return ocrZonalEngine.getPendingPatterns();
});

ipcMain.handle('ocr-add-pending-pattern', async (event, data) => {
  return ocrZonalEngine.addPendingPattern(data);
});

ipcMain.handle('ocr-delete-pending-pattern', async (event, id) => {
  return ocrZonalEngine.deletePendingPattern(id);
});

ipcMain.handle('ocr-promote-pending-pattern', async (event, id) => {
  return ocrZonalEngine.promotePendingPattern(id);
});

// ── Motor ML ──────────────────────────────────────────────────────────────────
ipcMain.handle('ml-train', async (event, { text, className }) => {
  return mlEngine.train(text, className);
});

ipcMain.handle('ml-classify', async (event, text) => {
  return mlEngine.classify(text);
});

ipcMain.handle('ml-get-stats', async () => {
  return mlEngine.getStats();
});

ipcMain.handle('ml-delete-class', async (event, className) => {
  return mlEngine.deleteClass(className);
});

ipcMain.handle('ml-reset', async () => {
  return mlEngine.reset();
});

// Selector de PDF (para el visor OCR Zonal)
ipcMain.handle('select-pdf-file', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, files: result.filePaths };
    }
    return { success: false, cancelled: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-ocr-zonal-window', async () => {
  return openOcrZonalWindow();
});

ipcMain.on('close-ocr-zonal-window', () => {
  if (ocrZonalWindow && !ocrZonalWindow.isDestroyed()) {
    ocrZonalWindow.close();
  }
});

// =============================================================================
// ── IPC: TIPOS DE DOCUMENTO ───────────────────────────────────────────────────
// =============================================================================

ipcMain.handle('doc-types-get-all', async () => {
  try {
    const rows = ziloDb.db.prepare('SELECT * FROM doc_types ORDER BY created_at ASC').all();
    // Parsear ocr_template_ids (JSON) → array
    return rows.map(r => ({
      ...r,
      ocr_template_ids: (() => { try { return JSON.parse(r.ocr_template_ids || '[]'); } catch { return []; } })()
    }));
  } catch (e) { return []; }
});

ipcMain.handle('doc-types-create', async (event, data) => {
  try {
    const ids     = Array.isArray(data.ocr_template_ids) ? data.ocr_template_ids : [];
    const firstId = ids.length ? ids[0] : (data.ocr_template_id || null);
    const stmt = ziloDb.db.prepare(`
      INSERT INTO doc_types (name, icon, folder, ocr_template_id, ocr_template_ids)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(data.name, data.icon || '📄', data.folder || null, firstId, JSON.stringify(ids));
    return { success: true, id: result.lastInsertRowid };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('doc-types-update', async (event, { id, data }) => {
  try {
    const ids     = Array.isArray(data.ocr_template_ids) ? data.ocr_template_ids : [];
    const firstId = ids.length ? ids[0] : (data.ocr_template_id || null);
    ziloDb.db.prepare(`
      UPDATE doc_types SET name=?, icon=?, folder=?, ocr_template_id=?, ocr_template_ids=? WHERE id=?
    `).run(data.name, data.icon || '📄', data.folder || null, firstId, JSON.stringify(ids), id);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('doc-types-delete', async (event, id) => {
  try {
    ziloDb.db.prepare('DELETE FROM doc_types WHERE id=?').run(id);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('open-doc-types-window', async () => {
  return openDocTypesWindow();
});

// =============================================================================
// ── IPC: PATRONES DE RENOMBRADO APRENDIDOS ────────────────────────────────────
// =============================================================================

ipcMain.handle('learn-rename-pattern', async (event, { typeName, ocrText, finalName }) => {
  return ziloDb.learnRenamePattern(typeName, ocrText, finalName);
});

ipcMain.handle('get-learned-patterns', async (event, typeName) => {
  return ziloDb.getLearnedPatterns(typeName);
});
