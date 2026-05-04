/**
 * @file Script principal para la aplicación de renombrado y clasificación de PDFs.
 * @description Gestiona la interfaz, el procesamiento de archivos mediante OCR,
 * el renombrado automático y manual, y la búsqueda de documentos indexados.
 * @author Gemini (revisado y refactorizado)
 * @version 2.0.0
 */

// =================================================================================
// --- INICIALIZACIÓN Y VARIABLES GLOBALES ---
// =================================================================================

// Configuración de PDF.js para usar el worker desde un CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Estado de la aplicación
let currentMode = '';
let processedFiles = new Set();
let destinationFolder = '';
let destinationFolders = {}; // Para modo automático
let fileCounter = 0;
let concurrentLimit = 50; // Límite de procesamiento simultáneo por defecto
let maxPagesToProcess = 0; // Páginas a procesar por PDF (0 = todas)

// Cola para renombrado manual
let manualRenameQueue = [];
let currentManualFile = null;
let currentManualFileId = null;

// Sistema de bloqueo de carpetas
let foldersLocked = true;
let lockTimeout = null;

// Índice de búsqueda OCR
let ocrIndex = {};

// =================================================================================
// --- EVENTOS DEL CICLO DE VIDA DE LA PÁGINA ---
// =================================================================================

/**
 * Se ejecuta cuando el contenido del DOM está completamente cargado.
 * Inicializa la aplicación.
 */
window.addEventListener('DOMContentLoaded', () => {
    // Cargar la configuración guardada por el usuario
    loadInitialSettings();

    // Configurar los listeners de eventos principales
    setupEventListeners();

    // Inicializar el estado visual de la UI
    updateLockState();
    loadOCRIndex();

    // Configurar listeners para eventos de la ventana de renombrado manual
    setupManualRenameListeners();

    // Listener para archivos detectados por vigilancia de carpeta
    window.electronAPI.onWatchedFileDetected(async (fileData) => {
        console.log('👁️ Archivo vigilado detectado:', fileData.name);
        await processWatchedFile(fileData);
    });
});

/**
 * Carga la configuración inicial desde localStorage.
 */
function loadInitialSettings() {
    // Cargar tema (claro/oscuro)
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        document.getElementById('theme-icon').textContent = '🌙';
    } else {
        document.getElementById('theme-icon').textContent = '☀️';
    }

    // Cargar límite de procesamiento concurrente
    const savedLimit = localStorage.getItem('concurrentLimit');
    if (savedLimit) {
        concurrentLimit = parseInt(savedLimit, 10);
        console.log(`⚙️ Límite de procesamiento cargado: ${concurrentLimit}`);
    }

    // Cargar páginas máximas a procesar por PDF
    const savedPages = localStorage.getItem('max-pages-ocr');
    if (savedPages !== null) {
        maxPagesToProcess = parseInt(savedPages, 10);
        console.log(`📄 Páginas OCR por PDF: ${maxPagesToProcess === 0 ? 'todas' : maxPagesToProcess}`);
    }

    // Limpiar rutas corruptas del localStorage
    cleanCorruptedPaths();
}

/**
 * Limpia rutas corruptas que no empiezan con una letra de unidad (C:\, D:\, etc.)
 */
function cleanCorruptedPaths() {
    const types = ['albaranes', 'pedidos', 'duas', 'facturas', 'entradas'];
    let cleaned = false;

    types.forEach(type => {
        const folder = localStorage.getItem(`auto-folder-${type}`);
        if (folder && !/^[A-Z]:\\/.test(folder)) {
            console.warn(`🧹 Limpiando ruta corrupta para ${type}: ${folder}`);
            localStorage.removeItem(`auto-folder-${type}`);
            cleaned = true;
        }
    });

    if (cleaned) {
        console.log('✅ Rutas corruptas limpiadas. Por favor, reconfigura las carpetas en el modal de Configuración.');
    }
}

/**
 * Configura todos los event listeners iniciales de la aplicación.
 */
function setupEventListeners() {
    // FIX: Se configuran una sola vez para evitar duplicados al cambiar de modo.
    setupDragAndDrop();
    setupFileInput();

    // Event listeners para botones de navegación
    document.getElementById('change-mode-header').addEventListener('click', changeMode);
    document.getElementById('btn-search').addEventListener('click', showSearchModal);
    document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('btn-settings').addEventListener('click', showSettingsModal);

    // Event listeners para botones de selección de modo
    const modeButtons = document.querySelectorAll('.selection-btn');
    modeButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const mode = e.currentTarget.getAttribute('data-mode');
            if (mode) {
                selectMode(mode);
            }
        });
    });

    // Event listeners para botones de carpeta
    document.getElementById('lock-single').addEventListener('click', () => toggleLock('single'));
    document.getElementById('browse-single').addEventListener('click', selectDestinationFolder);

    // Event listener para el área de carga de archivos
    document.getElementById('upload-area').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });
}

/**
 * Configura los listeners para eventos de la ventana de renombrado manual
 */
function setupManualRenameListeners() {
    // Listener para cuando se confirma el renombrado
    window.electronAPI.onManualRenameConfirmed(async (data) => {
        console.log('✅ Renombrado confirmado desde ventana:', data);
        await handleManualRenameConfirmed(data);
    });

    // Listener para cuando se omite el archivo
    window.electronAPI.onManualRenameSkipped(() => {
        console.log('↪️ Archivo omitido desde ventana');
        handleManualRenameSkipped();
    });
}


// =================================================================================
// --- GESTIÓN DE MODOS Y SELECCIÓN DE CARPETAS ---
// =================================================================================

/**
 * Cambia el modo de operación de la aplicación (auto, albaranes, etc.).
 * @param {string} mode - El modo a seleccionar.
 */
function selectMode(mode) {
    currentMode = mode;
    
    document.getElementById('selection-screen').style.display = 'none';
    document.getElementById('processing-screen').style.display = 'flex';
    document.getElementById('change-mode-header').style.display = 'block';
    
    const modeConfig = {
        auto: { icon: '🤖', title: 'Detección Automática', description: 'Detecta automáticamente el tipo de documento' },
        albaranes: { icon: '📋', title: 'Albaranes de Venta', description: 'Formato: 1 013770 → 1-13770 ALBARAN.pdf' },
        pedidos: { icon: '📦', title: 'Pedidos de Clientes', description: 'Detecta RESTO/RESTOS automáticamente' },
        duas: { icon: '📄', title: 'DUAs', description: 'Formato: 1/013770 → 1-13770 DUA.pdf' },
        facturas: { icon: '🧾', title: 'Facturas', description: 'Formato: 4/041258 → 4-41258 FACTURA.pdf' },
        entradas: { icon: '📥', title: 'Entradas', description: 'Formato: 1/013770 → 1-13770 ENTRADA.pdf' }
    };
    
    const config = modeConfig[mode];
    document.getElementById('mode-icon').textContent = config.icon;
    document.getElementById('mode-title').textContent = config.title;
    document.getElementById('mode-description').textContent = config.description;
    
    if (mode === 'auto') {
        // En modo automático, no mostramos selector de carpetas en pantalla principal
        // Las carpetas se configuran en el modal de Configuración
        document.getElementById('single-folder-selector').style.display = 'none';

        // Cargar las carpetas desde localStorage
        const types = ['albaranes', 'pedidos', 'duas', 'facturas', 'entradas'];
        types.forEach(type => {
            const savedFolder = localStorage.getItem(`auto-folder-${type}`);
            if (savedFolder) {
                destinationFolders[type] = savedFolder;
            }
        });
        console.log('🗂️ Carpetas cargadas para modo AUTO:', destinationFolders);
    } else {
        // En modos específicos, mostrar selector de carpeta único
        document.getElementById('single-folder-selector').style.display = 'block';

        const savedFolder = localStorage.getItem(`${mode}-folder`);
        if (savedFolder) {
            destinationFolder = savedFolder;
            document.getElementById('destination-folder').value = savedFolder;
        }
    }
    
    updateLockState();
}

/**
 * Vuelve a la pantalla de selección de modo.
 */
function changeMode() {
    document.getElementById('selection-screen').style.display = 'flex';
    document.getElementById('processing-screen').style.display = 'none';
    document.getElementById('change-mode-header').style.display = 'none';
    
    // Limpiar estado
    document.getElementById('file-list').innerHTML = '';
    processedFiles.clear();
    fileCounter = 0;
    updateFileCounter();
}

// =================================================================================
// --- MANEJO DE ARCHIVOS (DRAG & DROP, INPUT) ---
// =================================================================================

function setupDragAndDrop() {
    const uploadArea = document.getElementById('upload-area');

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');

        // En Electron, dataTransfer.files contiene la propiedad .path
        const files = Array.from(e.dataTransfer.files)
            .filter(f => f.name.toLowerCase().endsWith('.pdf'))
            .map(f => ({
                path: f.path,  // En Electron drag & drop, .path está disponible
                name: f.name
            }));

        if (files.length > 0) handleFiles(files);
    });
}

async function setupFileInput() {
    // Reemplazar el comportamiento del clic en el área de upload
    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');

    // Cancelar el onclick original que viene del HTML
    uploadArea.onclick = null;

    uploadArea.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Usar el diálogo nativo de Electron
        const result = await window.electronAPI.selectFiles();

        if (result.success && result.files && result.files.length > 0) {
            // Crear objetos con path para cada archivo seleccionado
            const files = result.files.map(filePath => ({
                path: filePath,
                name: filePath.split('\\').pop().split('/').pop()
            }));

            handleFiles(files);
        }
    });

    // Ocultar el input file original
    if (fileInput) {
        fileInput.style.display = 'none';
        fileInput.remove();
    }
}

/**
 * Valida carpetas y procesa los archivos en lotes.
 * @param {File[]} files - Array de archivos a procesar.
 */
async function handleFiles(files) {
    if (!validateDestinationFolders()) return;

    // Verificar que los archivos tienen la propiedad .path
    console.log('🔍 Verificando archivos recibidos:', files.length);
    files.forEach((file, i) => {
        console.log(`  Archivo ${i + 1}: ${file.name}`);
        console.log(`    - Tiene .path: ${file.path !== undefined}`);
        console.log(`    - Valor de .path: ${file.path}`);
    });

    const listElement = document.getElementById('file-list');
    const newFiles = files.filter(file => !processedFiles.has(file.path));

    if (newFiles.length === 0) return;

    console.log(`🌀 Procesando ${newFiles.length} archivos en lotes de ${concurrentLimit}`);

    // Añadir todos los elementos a la UI de una vez para que el usuario los vea
    newFiles.forEach(file => {
        const fileId = `file-${Date.now()}-${Math.random()}`;
        file.fileId = fileId; // Adjuntar el ID al objeto file
        const fileItem = createFileItem(file, fileId);
        listElement.insertBefore(fileItem, listElement.firstChild);
    });
    
    // Procesar los archivos en lotes (chunks)
    for (let i = 0; i < newFiles.length; i += concurrentLimit) {
        const chunk = newFiles.slice(i, i + concurrentLimit);
        console.log(`📦 Procesando lote ${Math.floor(i / concurrentLimit) + 1} con ${chunk.length} archivos.`);
        
        const promises = chunk.map(file => processFile(file, file.fileId));
        await Promise.all(promises);
    }
    
    console.log('✅ Todos los lotes han sido procesados.');
}

/**
 * Procesa un archivo detectado por la vigilancia de carpeta, usando siempre modo auto.
 */
async function processWatchedFile(fileData) {
    const file = { path: fileData.path, name: fileData.name };
    console.log(`[WATCH] Iniciando procesamiento: "${file.name}" (${file.path})`);

    // Cargar carpetas destino desde localStorage
    const types = ['albaranes', 'pedidos', 'duas', 'facturas', 'entradas'];
    types.forEach(type => {
        const folder = localStorage.getItem(`auto-folder-${type}`);
        if (folder) destinationFolders[type] = folder;
    });
    console.log('[WATCH] Carpetas destino cargadas:', destinationFolders);

    const missingAll = types.every(t => !destinationFolders[t]);
    if (missingAll) {
        console.error('[WATCH] ❌ No hay carpetas destino configuradas, ignorando:', file.name);
        return;
    }

    // Crear elemento en la lista de archivos
    const fileId = `file-${Date.now()}-${Math.random()}`;
    file.fileId = fileId;
    const listElement = document.getElementById('file-list');
    const fileItem = createFileItem(file, fileId);
    listElement.insertBefore(fileItem, listElement.firstChild);
    processedFiles.add(file.path);

    try {
        console.log('[WATCH] Leyendo PDF...');
        updateFileStatus(fileId, 'Extrayendo texto...', 30);
        const text = await extractTextFromPDF(file);
        console.log(`[WATCH] Texto extraído (${text.length} chars):`, text.substring(0, 300));

        updateFileStatus(fileId, 'Analizando contenido...', 60);
        const detectedMode = detectDocumentType(text);
        console.log('[WATCH] Tipo detectado:', detectedMode || 'ninguno');

        if (!detectedMode) {
            console.warn('[WATCH] ⚠️ No se detectó tipo, enviando a renombrado manual');
            await queueForManualRename(file, fileId, null, text, true);
            return;
        }

        const orderNumber = extractOrderNumber(text, detectedMode);
        console.log('[WATCH] Número de orden extraído:', orderNumber || 'no encontrado');

        if (orderNumber) {
            const newFileName = generateNewFilename(orderNumber, detectedMode, text);
            const targetFolder = destinationFolders[detectedMode];
            console.log(`[WATCH] Renombrando a "${newFileName}", destino: "${targetFolder}"`);

            if (!targetFolder) {
                console.error(`[WATCH] ❌ Sin carpeta configurada para tipo "${detectedMode}"`);
                updateFileStatus(fileId, `❌ Sin carpeta configurada para ${detectedMode}`, 100, 'error');
                return;
            }

            updateFileStatus(fileId, 'Moviendo archivo...', 80);
            const result = await window.electronAPI.moveFile(
                file.path, targetFolder, newFileName, detectedMode === 'pedidos'
            );
            console.log('[WATCH] Resultado moveFile:', result);

            if (result.success) {
                updateFileStatus(fileId, `✅ Movido: ${newFileName}`, 100, 'success');
                fileCounter++;
                updateFileCounter();
                await saveToOCRIndex(result.newPath, newFileName, text, detectedMode);
                console.log('[WATCH] ✅ Procesamiento completado:', newFileName);
            } else {
                throw new Error(result.error);
            }
        } else {
            console.warn('[WATCH] ⚠️ Número no encontrado, enviando a renombrado manual');
            await queueForManualRename(file, fileId, detectedMode, text, true);
        }
    } catch (error) {
        console.error(`[WATCH] ❌ Error procesando "${file.name}":`, error);
        updateFileStatus(fileId, `❌ Error: ${error.message}`, 100, 'error');
    }
}

/**
 * Valida si las carpetas de destino están configuradas.
 * @returns {boolean} - True si las carpetas son válidas, false en caso contrario.
 */
function validateDestinationFolders() {
    if (currentMode === 'auto') {
        const types = ['albaranes', 'pedidos', 'duas', 'facturas', 'entradas'];
        const missingFolders = types.filter(type => !destinationFolders[type]);

        if (missingFolders.length > 0) {
            const names = { albaranes: 'Albaranes', pedidos: 'Pedidos', duas: 'DUAs', facturas: 'Facturas', entradas: 'Entradas' };
            const folderList = missingFolders.map(t => `  • ${names[t]}`).join('\n');
            alert(`⚙️ Configuración incompleta\n\nPara usar el modo de Detección Automática, debes configurar las carpetas destino en el modal de Configuración (botón ⚙️).\n\nCarpetas faltantes:\n${folderList}`);
            return false;
        }
    } else {
        if (!destinationFolder) {
            alert('Por favor, selecciona una carpeta destino antes de procesar archivos.');
            return false;
        }
    }
    return true;
}


// =================================================================================
// --- LÓGICA DE PROCESAMIENTO DE PDF (OCR Y EXTRACCIÓN DE DATOS) ---
// =================================================================================

/**
 * Procesa un único archivo PDF.
 * @param {File} file - El archivo a procesar.
 * @param {string} fileId - El ID del elemento DOM asociado.
 */
async function processFile(file, fileId) {
    const fileItem = document.getElementById(fileId);
    const statusElement = fileItem.querySelector('.file-status');
    const progressFill = fileItem.querySelector('.progress-fill');

    try {
        updateFileStatus(fileId, 'Extrayendo texto...', 30);
        const text = await extractTextFromPDF(file);
        
        updateFileStatus(fileId, 'Analizando contenido...', 60);
        let detectedMode = currentMode === 'auto' ? detectDocumentType(text) : currentMode;
        
        if (currentMode === 'auto' && !detectedMode) {
            console.log(`🟡 No se detectó tipo para ${file.name}, enviando a renombrado manual.`);
            queueForManualRename(file, fileId, null, text);
            return;
        }

        const orderNumber = extractOrderNumber(text, detectedMode);
        
        if (orderNumber) {
            const newFileName = generateNewFilename(orderNumber, detectedMode, text);
            let targetFolder = (currentMode === 'auto') ? destinationFolders[detectedMode] : destinationFolder;
            
            if (!targetFolder) throw new Error(`No hay carpeta configurada para el tipo: ${detectedMode}`);
            
            updateFileStatus(fileId, 'Moviendo archivo...', 80);
            const createSubfolder = (detectedMode === 'pedidos');
            const result = await window.electronAPI.moveFile(file.path, targetFolder, newFileName, createSubfolder);

            if (result.success) {
                updateFileStatus(fileId, `✅ Movido: ${newFileName}`, 100, 'success');
                processedFiles.add(file.path);
                fileCounter++;
                updateFileCounter();
                await saveToOCRIndex(result.newPath, newFileName, text, detectedMode);
            } else {
                throw new Error(result.error);
            }
        } else {
            console.log(`🟡 No se encontró número para ${file.name}, enviando a renombrado manual.`);
            queueForManualRename(file, fileId, detectedMode, text);
        }
        
    } catch (error) {
        console.error(`❌ Error en processFile (${file.name}):`, error);
        updateFileStatus(fileId, `❌ Error: ${error.message}`, 100, 'error');
    }
}

/**
 * Extrae texto de la primera página de un PDF usando OCR.
 * @param {File} file - El archivo PDF (objeto con .path y .name).
 * @returns {Promise<string>} - El texto extraído.
 */
async function extractTextFromPDF(file) {
    const result = await window.electronAPI.readPdfFile(file.path);
    if (!result.success) throw new Error(result.error || 'Error al leer el archivo PDF');

    const pdf = await pdfjsLib.getDocument({ data: result.data }).promise;
    const totalPages = pdf.numPages;
    const pagesToProcess = maxPagesToProcess === 0
        ? totalPages
        : Math.min(totalPages, maxPagesToProcess);

    let combinedText = '';
    for (let pageNum = 1; pageNum <= pagesToProcess; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const scale = 3.0;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const { data } = await Tesseract.recognize(canvas.toDataURL('image/png'), 'spa');
        combinedText += data.text + '\n';
    }

    console.log(`📜 Texto extraído de ${file.name} (${pagesToProcess}/${totalPages} pág.):\n`, combinedText.substring(0, 500) + '...');
    return combinedText;
}

/**
 * Detecta el tipo de documento basado en palabras clave y patrones en el texto.
 * @param {string} text - El texto extraído del PDF.
 * @returns {string|null} - El tipo de documento detectado o null.
 */
function detectDocumentType(text) {
    const cleanText = text.toUpperCase();
    const header = cleanText.substring(0, 400);

    // Búsqueda por patrones específicos y robustos
    if (/FACTURA\s+\d\/\d{6}/.test(cleanText)) return 'facturas';
    if (/DUA\s+\d\/\d+/.test(cleanText)) return 'duas';
    if (/ENTRADA\s+\d\/\d+/.test(cleanText)) return 'entradas';
    if (/PEDIDO\s+CLIENTE/.test(cleanText) || /PEDIDO\s*(Nº|N°|NO|#)?\s*\d\s+\d{6}/.test(cleanText)) return 'pedidos';
    if (/(ALBARAN|ALBARÁN)\s*(Nº|N°|NO|#)?\s*\d\s+\d{6}/.test(cleanText)) return 'albaranes';

    // Búsqueda por palabras clave como fallback
    if (/FACTURA/.test(header) && /\d\/\d+/.test(header)) return 'facturas';
    if (/DUA/.test(header) && /\d\/\d+/.test(header)) return 'duas';
    if (/ENTRADA/.test(header) && /\d\/\d+/.test(header)) return 'entradas';
    if (/(ALBARAN|ALBARÁN)/.test(header)) return 'albaranes';
    if (/PEDIDO/.test(header)) return 'pedidos';

    console.log('❓ No se pudo detectar el tipo de documento.');
    return null;
}

/**
 * Enrutador para llamar a la función de extracción de número correcta según el tipo.
 * @param {string} text - Texto del PDF.
 * @param {string} type - Tipo de documento.
 * @returns {string|null} - El número de pedido encontrado.
 */
function extractOrderNumber(text, type) {
    const extractors = {
        albaranes: text => text.match(/\b(\d)\s+(\d{6})\b/) ? text.match(/\b(\d)\s+(\d{6})\b/).slice(1).join('') : null,
        pedidos: text => text.match(/\b\d{7}\b/)?.[0] || null,
        duas: text => (text.match(/DUA\s+(\d)\/(\d{6})/i) || text.match(/(\d)\/(\d{6})/))?.slice(1).join('') || null,
        facturas: text => (text.match(/(?:FACTURA|RA)\s+(\d)\/(\d{6})/i))?.slice(1).join('') || null,
        entradas: text => (text.match(/ENTRADA\s+(\d)\/(\d{6})/i) || text.match(/(\d)\/(\d{6})/))?.slice(1).join('') || null,
    };
    return extractors[type] ? extractors[type](text) : null;
}

/**
 * Genera el nuevo nombre de archivo basado en el número, tipo y contenido.
 * @param {string} orderNumber - Número de 7 dígitos.
 * @param {string} docType - Tipo de documento.
 * @param {string} text - Texto del PDF para buscar palabras clave adicionales.
 * @returns {string} - El nuevo nombre de archivo.
 */
function generateNewFilename(orderNumber, docType, text) {
    const formatted = formatOrderNumber(orderNumber);
    const suffixes = {
        albaranes: 'ALBARAN',
        pedidos: `PEDIDO ALMACEN${/\b(RESTOS|RESTO)\b/i.test(text) ? ' RESTO' : ''}`,
        duas: 'DUA',
        facturas: 'FACTURA',
        entradas: 'ENTRADA',
    };
    return `${formatted} ${suffixes[docType] || 'DOCUMENTO'}.pdf`;
}

/**
 * Formatea un número de 7 dígitos a "S-NNNNNN".
 * @param {string} orderNumber - El número de 7 dígitos.
 * @returns {string} - El número formateado.
 */
function formatOrderNumber(orderNumber) {
    if (orderNumber && orderNumber.length === 7) {
        const serie = orderNumber[0];
        const codigo = parseInt(orderNumber.substring(1), 10);
        return `${serie}-${codigo}`;
    }
    return orderNumber;
}

// =================================================================================
// --- GESTIÓN DE RENOMBRADO MANUAL (MODAL) ---
// =================================================================================

/**
 * Añade un archivo a la cola de renombrado manual y abre la ventana si es el primero.
 * @param {File} file - El archivo a renombrar.
 * @param {string} fileId - ID del elemento DOM.
 * @param {string|null} detectedType - Tipo detectado (si lo hay).
 * @param {string} ocrText - Texto extraído del PDF.
 */
async function queueForManualRename(file, fileId, detectedType, ocrText, isFromWatch = false) {
    updateFileStatus(fileId, '⌛ Esperando entrada manual...', 70);

    // Leer el archivo PDF desde el disco
    const result = await window.electronAPI.readPdfFile(file.path);

    if (!result.success) {
        updateFileStatus(fileId, `❌ Error al leer PDF: ${result.error}`, 100, 'error');
        return;
    }

    const pdf = await pdfjsLib.getDocument({ data: result.data }).promise;
    const page = await pdf.getPage(1);

    // Renderizar la página a datos de imagen para enviarla a la ventana
    const scale = 2.0;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;

    // Convertir canvas a ArrayBuffer
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const pageData = await blob.arrayBuffer();

    manualRenameQueue.push({
        file,
        fileId,
        detectedType,
        ocrText,
        pageData,
        isFromWatch
    });

    if (manualRenameQueue.length === 1) {
        await processNextManualRename();
    }
}

/**
 * Procesa el siguiente archivo en la cola de renombrado manual.
 */
async function processNextManualRename() {
    if (manualRenameQueue.length > 0) {
        const next = manualRenameQueue[0];
        await openManualRenameWindow(next);
    }
}

/**
 * Abre la ventana de renombrado manual con los datos del archivo.
 * @param {object} queueItem - El objeto de la cola con los datos del archivo.
 */
async function openManualRenameWindow({ file, fileId, detectedType, ocrText, pageData, isFromWatch }) {
    currentManualFile = file;
    currentManualFileId = fileId;
    if (isFromWatch) currentManualFile._isFromWatch = true;

    const fileData = {
        fileName: file.name,
        pageData: pageData,
        detectedType: detectedType,
        currentMode: isFromWatch ? 'auto' : currentMode,
        queueCount: manualRenameQueue.length,
        ocrText: ocrText,
        // filePath para que el handler pueda recuperarlo al confirmar
        filePath: isFromWatch ? file.path : undefined,
        isFromSearch: false
    };

    await window.electronAPI.openManualRenameWindow(fileData);
}

/**
 * Maneja la confirmación del renombrado desde la ventana
 * @param {object} data - Datos del renombrado (orderNumber, selectedType, ocrText)
 */
async function handleManualRenameConfirmed(data) {
    const { orderNumber, selectedType, ocrText, filePath, isFromSearch } = data;
    const isFromWatch = !isFromSearch && currentManualFile?._isFromWatch === true;

    const newFileName = generateNewFilename(orderNumber, selectedType, ocrText);

    let targetFolder;
    if (isFromSearch) {
        targetFolder = localStorage.getItem(`auto-folder-${selectedType}`);
        if (!targetFolder) {
            alert(`Error: No hay carpeta configurada para ${selectedType}.\n\nPor favor, configura las carpetas en el modo "Detección Automática".`);
            return;
        }
        console.log(`📁 Usando carpeta del modo auto para ${selectedType}: ${targetFolder}`);
    } else if (isFromWatch) {
        targetFolder = destinationFolders[selectedType] || localStorage.getItem(`auto-folder-${selectedType}`);
        if (!targetFolder) {
            updateFileStatus(currentManualFileId, `❌ Sin carpeta configurada para ${selectedType}`, 100, 'error');
            currentManualFile = null;
            currentManualFileId = null;
            manualRenameQueue.shift();
            await processNextManualRename();
            return;
        }
    } else {
        targetFolder = currentMode === 'auto' ? destinationFolders[selectedType] : destinationFolder;
        if (!targetFolder) {
            alert(`Error: No hay carpeta configurada para ${selectedType}`);
            return;
        }
    }

    const sourceFilePath = isFromSearch ? filePath : (isFromWatch ? filePath : currentManualFile.path);

    if (isFromSearch) {
        console.log(`🔍 Renombrando desde búsqueda: ${sourceFilePath} → ${newFileName}`);
    } else {
        updateFileStatus(currentManualFileId, 'Moviendo archivo...', 90);
    }

    const createSubfolder = (selectedType === 'pedidos');
    const result = await window.electronAPI.moveFile(sourceFilePath, targetFolder, newFileName, createSubfolder);

    if (result.success) {
        if (isFromSearch) {
            console.log(`✅ Archivo movido exitosamente desde búsqueda: ${result.newPath}`);

            // Eliminar la entrada antigua del índice OCR
            if (ocrIndex[sourceFilePath]) {
                console.log(`🗑️ Eliminando entrada antigua del índice: ${sourceFilePath}`);
                delete ocrIndex[sourceFilePath];
            }
        } else {
            updateFileStatus(currentManualFileId, `✅ Movido: ${newFileName}`, 100, 'success');
            processedFiles.add(currentManualFile.path);
            fileCounter++;
            updateFileCounter();
        }

        // Guardar la nueva entrada en el índice OCR
        await saveToOCRIndex(result.newPath, newFileName, ocrText, selectedType);
    } else {
        if (isFromSearch) {
            alert(`❌ Error al mover el archivo:\n\n${result.error}`);
        } else {
            updateFileStatus(currentManualFileId, `❌ Error al mover: ${result.error}`, 100, 'error');
        }
    }

    // Si no viene desde búsqueda, pasar al siguiente archivo en la cola
    if (!isFromSearch) {
        currentManualFile = null;
        currentManualFileId = null;
        manualRenameQueue.shift();
        await processNextManualRename();
    }
}

/**
 * Maneja cuando se omite el archivo desde la ventana
 */
function handleManualRenameSkipped() {
    updateFileStatus(currentManualFileId, '↪️ Omitido por el usuario', 100, 'skipped');

    // Pasar al siguiente archivo en la cola
    currentManualFile = null;
    currentManualFileId = null;
    manualRenameQueue.shift();
    processNextManualRename();
}

// =================================================================================
// --- SISTEMA DE BÚSQUEDA OCR ---
// =================================================================================

/**
 * Carga el índice OCR desde el archivo JSON.
 */
async function loadOCRIndex() {
    try {
        const result = await window.electronAPI.loadOCRIndex();
        ocrIndex = result.success && result.data ? result.data : {};
        console.log(`📖 Índice OCR cargado con ${Object.keys(ocrIndex).length} documentos.`);
    } catch (error) {
        console.error('Error al cargar índice OCR:', error);
        ocrIndex = {};
    }
}

/**
 * Guarda una nueva entrada en el índice OCR.
 * @param {string} filePath - Ruta completa del archivo.
 * @param {string} fileName - Nombre del archivo.
 * @param {string} ocrText - Texto extraído.
 * @param {string} docType - Tipo de documento.
 */
async function saveToOCRIndex(filePath, fileName, ocrText, docType) {
    try {
        ocrIndex[filePath] = {
            fileName,
            filePath,
            docType,
            ocrText,
            timestamp: new Date().toISOString(),
            searchText: ocrText.toUpperCase() // Para búsqueda case-insensitive
        };
        const result = await window.electronAPI.saveOCRIndex(ocrIndex);
        if (result.success) {
            console.log(`💾 Guardado en índice OCR: ${fileName}`);
        } else {
            console.error('Error al guardar índice:', result.error);
        }
    } catch (error) {
        console.error('Error en saveToOCRIndex:', error);
    }
}



// =================================================================================
// --- FUNCIONES DE LA INTERFAZ DE USUARIO (UI) ---
// =================================================================================

/**
 * Crea un elemento DOM para un archivo en la lista de procesamiento.
 * @param {File} file - El archivo.
 * @param {string} fileId - El ID único para el elemento DOM.
 * @returns {HTMLElement} - El elemento div creado.
 */
function createFileItem(file, fileId) {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.id = fileId;
    div.innerHTML = `
        <div class="file-info">
            <div class="file-name">${file.name}</div>
            <div class="file-status">En cola...</div>
            <div class="progress-bar"><div class="progress-fill"></div></div>
        </div>
    `;
    return div;
}

/**
 * Actualiza el estado visual de un archivo en la lista.
 * @param {string} fileId - ID del elemento DOM.
 * @param {string} message - Mensaje de estado.
 * @param {number} progress - Porcentaje de progreso (0-100).
 * @param {'success'|'error'|'skipped'|'info'} type - Tipo de estado.
 */
function updateFileStatus(fileId, message, progress, type = 'info') {
    const fileItem = document.getElementById(fileId);
    if (!fileItem) return;

    const statusElement = fileItem.querySelector('.file-status');
    const progressFill = fileItem.querySelector('.progress-fill');

    statusElement.innerHTML = message;
    progressFill.style.width = `${progress}%`;
    
    // Resetear clases y aplicar la nueva
    statusElement.className = 'file-status';
    progressFill.className = 'progress-fill';

    if (type === 'success') {
        statusElement.classList.add('status-success');
    } else if (type === 'error') {
        statusElement.classList.add('status-error');
        progressFill.classList.add('progress-error');
    } else if (type === 'skipped') {
        progressFill.classList.add('progress-skipped');
    }
}

/**
 * Actualiza el contador de archivos procesados en la UI.
 */
function updateFileCounter() {
    document.getElementById('file-counter').textContent = `${fileCounter} archivo${fileCounter !== 1 ? 's' : ''}`;
}



// =================================================================================
// --- FUNCIONES AUXILIARES Y DE UTILIDAD ---
// =================================================================================

/**
 * Cambia el tema entre claro y oscuro.
 */
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    document.getElementById('theme-icon').textContent = isDark ? '🌙' : '☀️';
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

/**
 * Alterna el estado de bloqueo de las carpetas.
 */
function toggleLock() {
    foldersLocked = !foldersLocked;
    updateLockState();
    
    if (lockTimeout) clearTimeout(lockTimeout);
    
    if (!foldersLocked) {
        lockTimeout = setTimeout(() => {
            foldersLocked = true;
            updateLockState();
            console.log('🔒 Carpetas bloqueadas automáticamente por inactividad.');
        }, 5000); // 5 segundos
    }
}

/**
 * Actualiza la UI para reflejar el estado de bloqueo de carpetas.
 */
function updateLockState() {
    const lock = document.getElementById('lock-single');
    const button = document.getElementById('browse-single');

    const isLocked = foldersLocked;
    if (lock) {
        lock.textContent = isLocked ? '🔒' : '🔓';
        lock.title = isLocked ? 'Desbloquear para editar carpetas' : 'Bloquear carpetas (se bloqueará en 5s)';
        isLocked ? lock.classList.remove('unlocked') : lock.classList.add('unlocked');
    }
    if (button) button.disabled = isLocked;
}

/**
 * Abre un diálogo para seleccionar la carpeta de destino (modo simple).
 */
async function selectDestinationFolder() {
    await selectFolder(null);
}

/**
 * Abre un diálogo para seleccionar una carpeta de destino para un tipo específico (modo auto).
 * @param {string} type - El tipo de documento (albaranes, pedidos, duas, facturas, entradas).
 */
async function selectFolderForType(type) {
    await selectFolder(type);
}

/**
 * Abre un diálogo para seleccionar una carpeta de destino.
 * @param {string|null} type - El tipo de documento si es para modo auto.
 */
async function selectFolder(type = null) {
    if (foldersLocked) {
        alert('🔒 Las carpetas están bloqueadas. Haz clic en el candado para desbloquear.');
        return;
    }

    if (lockTimeout) clearTimeout(lockTimeout);

    const result = await window.electronAPI.selectFolder();

    // Bloquear siempre después de la selección
    foldersLocked = true;
    updateLockState();

    if (result.success) {
        if (type) {
            destinationFolders[type] = result.path;
            document.getElementById(`folder-${type}`).value = result.path;
            localStorage.setItem(`auto-folder-${type}`, result.path);
            console.log(`✅ Carpeta para ${type}: ${result.path}`);
        } else {
            destinationFolder = result.path;
            document.getElementById('destination-folder').value = result.path;
            localStorage.setItem(`${currentMode}-folder`, result.path);
        }
    }
}

/**
 * Abre un archivo usando el visor por defecto del sistema operativo.
 * @param {string} filePath - La ruta del archivo a abrir.
 */
async function openFile(filePath) {
    const result = await window.electronAPI.openFile(filePath);
    if (!result.success) {
        alert('Error al abrir el archivo: ' + result.error);
    }
}

/**
 * Abre la ventana de búsqueda.
 */
async function showSearchModal() {
    try {
        await window.electronAPI.openSearchWindow();
    } catch (error) {
        console.error('Error al abrir ventana de búsqueda:', error);
        alert('Error al abrir la ventana de búsqueda');
    }
}

/**
 * Abre la ventana de configuración.
 */
async function showSettingsModal() {
    try {
        await window.electronAPI.openSettingsWindow();
    } catch (error) {
        console.error('Error al abrir ventana de configuración:', error);
        alert('Error al abrir la ventana de configuración');
    }
}

