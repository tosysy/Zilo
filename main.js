const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;

let mainWindow;
let searchWindow = null;
let settingsWindow = null;
let manualRenameWindow = null;
let customOCRIndexPath = null; // Ruta personalizada del índice OCR

// Watch folder state
let watchFolderInterval = null;
let watchedFiles = new Set();

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

  watchFolderInterval = setInterval(async () => {
    try {
      const files = await fs.readdir(folderPath);
      const pdfs = files.filter(f => f.toLowerCase().endsWith('.pdf'));

      for (const filename of pdfs) {
        const fullPath = path.join(folderPath, filename);
        if (!watchedFiles.has(fullPath)) {
          watchedFiles.add(fullPath);
          console.log('[WATCH] Nuevo archivo detectado:', fullPath);

          // Esperar 3s para que el archivo esté completamente escrito
          setTimeout(async () => {
            try {
              const stat = await fs.stat(fullPath);
              if (stat.size > 0) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('watched-file-detected', { path: fullPath, name: filename });
                }
              } else {
                watchedFiles.delete(fullPath); // Reintentar en el próximo ciclo
              }
            } catch (e) {
              watchedFiles.delete(fullPath); // Reintentar si no es accesible aún
            }
          }, 3000);
        }
      }
    } catch (e) {
      console.error('[WATCH] Error al escanear carpeta:', e.message);
    }
  }, 5000);
}

function stopWatchFolder() {
  if (watchFolderInterval) {
    clearInterval(watchFolderInterval);
    watchFolderInterval = null;
  }
  watchedFiles.clear();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
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
    backgroundColor: '#6b9ac4',
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
    const y = Math.round((height / 2) - (600 / 2));

    settingsWindow = new BrowserWindow({
      width: 1100,
      height: 600,
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
    
    settingsWindow.webContents.once('did-finish-load', () => {
        settingsWindow.webContents.send('first-time-setup');
    });

    settingsWindow.on('closed', () => {
      settingsWindow = null;
      resolve({ success: true });
    });
  });
}

app.whenReady().then(() => {
  createWindow();

  // Cargar la ruta personalizada del índice OCR cuando la ventana esté lista
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
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
    const newPath = path.join(directory, newName);
    
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
    const y = Math.round((height / 2) - (600 / 2));

    settingsWindow = new BrowserWindow({
      width: 1100,
      height: 600,
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

ipcMain.on('close-settings-window', () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.destroy();
      }
    });

    settingsWindow.loadFile(path.join(__dirname, 'renderer/settings-window.html'));

    // Bloquear atajos de teclado no deseados
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

// Recibir configuración guardada desde la ventana de configuración
ipcMain.on('settings-saved', (event, settings) => {
  console.log('[CONFIG] Configuracion recibida desde ventana de configuracion:', settings);

  // Si es la primera vez, marcar como completado y mostrar ventana principal
  if (settings.isFirstTime) {
    mainWindow.webContents.executeJavaScript('localStorage.setItem("first-time-setup", "true");');
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
    }
  }

  // Actualizar la ruta personalizada del índice OCR en la variable global
  if (settings.ocrIndexPath && settings.ocrIndexPath.trim() !== '') {
    customOCRIndexPath = settings.ocrIndexPath;
    console.log('[CONFIG] Ruta personalizada del indice OCR actualizada:', customOCRIndexPath);
  } else {
    customOCRIndexPath = null;
    console.log('[CONFIG] Usando ruta por defecto del indice OCR');
  }

  // Guardar la configuración en la ventana principal
  if (mainWindow && !mainWindow.isDestroyed()) {
    const foldersJS = settings.folders ? `
      localStorage.setItem('auto-folder-albaranes', ${JSON.stringify(settings.folders.albaranes || '')});
      localStorage.setItem('auto-folder-pedidos', ${JSON.stringify(settings.folders.pedidos || '')});
      localStorage.setItem('auto-folder-duas', ${JSON.stringify(settings.folders.duas || '')});
      localStorage.setItem('auto-folder-facturas', ${JSON.stringify(settings.folders.facturas || '')});
      localStorage.setItem('auto-folder-entradas', ${JSON.stringify(settings.folders.entradas || '')});
    ` : '';

    const ocrIndexPathJS = settings.ocrIndexPath !== undefined ? `
      localStorage.setItem('ocr-index-path', ${JSON.stringify(settings.ocrIndexPath || '')});
    ` : '';

    const maxPagesJS = settings.maxPages !== undefined ? `
      localStorage.setItem('max-pages-ocr', '${settings.maxPages}');
      if (typeof maxPagesToProcess !== 'undefined') {
        maxPagesToProcess = ${settings.maxPages};
      }
    ` : '';

    const watchFolderJS = settings.watchFolder !== undefined ? `
      localStorage.setItem('watch-folder', ${JSON.stringify(settings.watchFolder || '')});
    ` : '';

    // Iniciar o detener vigilancia de carpeta
    if (settings.watchFolder !== undefined) {
      if (settings.watchFolder && settings.watchFolder.trim() !== '') {
        startWatchFolder(settings.watchFolder);
      } else {
        stopWatchFolder();
      }
    }

    mainWindow.webContents.executeJavaScript(`
      localStorage.setItem('concurrentLimit', '${settings.concurrentLimit}');
      if (typeof concurrentLimit !== 'undefined') {
        concurrentLimit = ${settings.concurrentLimit};
      }
      ${foldersJS}
      ${ocrIndexPathJS}
      ${maxPagesJS}
      ${watchFolderJS}
    `);
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