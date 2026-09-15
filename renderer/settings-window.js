/**
 * @file Script para la ventana de configuración.
 * @description Maneja la configuración de la aplicación.
 */

// Variables globales
let foldersLocked = true;
let lockTimeout = null;
let isFirstTime = false; // Para saber si es la configuración inicial

// =================================================================================
// --- INICIALIZACIÓN ---
// =================================================================================

window.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    applyCurrentTheme();
    loadFolderConfiguration();
    loadConcurrentLimitConfiguration();
    loadOCRIndexPathConfiguration();
});

// Escuchar la solicitud de cargar la configuración actual
window.electronAPI.onLoadSettings((settings) => {
    // Actualizar el límite de procesamiento con el valor de la ventana principal
    const limit = settings.concurrentLimit || 50;
    document.getElementById('concurrent-limit').value = limit;
    // Guardar en localStorage local para la próxima vez
    localStorage.setItem('concurrentLimit', limit.toString());

    // Cargar la ruta del índice OCR
    if (settings.ocrIndexPath) {
        document.getElementById('ocr-index-path').value = settings.ocrIndexPath;
        localStorage.setItem('ocr-index-path', settings.ocrIndexPath);
    }

    // Cargar la carpeta vigilada
    if (settings.watchFolder !== undefined) {
        document.getElementById('watch-folder').value = settings.watchFolder || '';
        if (settings.watchFolder) localStorage.setItem('watch-folder', settings.watchFolder);
    }

    // Cargar la carpeta de incidencias
    if (settings.watchErrorFolder !== undefined) {
        document.getElementById('watch-error-folder').value = settings.watchErrorFolder || '';
        if (settings.watchErrorFolder) localStorage.setItem('watch-error-folder', settings.watchErrorFolder);
    }

    // Cargar las carpetas configuradas
    if (settings.folders) {
        const types = ['albaranes', 'pedidos', 'duas', 'facturas', 'entradas'];
        types.forEach(type => {
            const folder = settings.folders[type];
            if (folder) {
                document.getElementById(`folder-${type}`).value = folder;
                // Guardar en localStorage para que esté disponible al guardar
                localStorage.setItem(`auto-folder-${type}`, folder);
            }
        });
    }
});

// Escuchar si es la primera vez que se configura
window.electronAPI.onFirstTimeSetup(() => {
    isFirstTime = true;
    const closeButton = document.querySelector('.close-btn');
    if (closeButton) {
        closeButton.style.display = 'none';
    }
    // Cambiar el texto del botón de guardar
    const saveButton = document.getElementById('save-button');
    if (saveButton) {
        saveButton.textContent = 'Guardar y Continuar';
    }
});

// Escuchar cambios de tema
window.electronAPI.onThemeChange((theme) => {
    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
});

function applyCurrentTheme() {
    // El tema se sincronizará desde la ventana principal
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
    }
}

function setupEventListeners() {
    // Escuchar tecla Escape para cerrar o validar
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!isFirstTime) {
                closeWindow();
            } else {
                validateFolders();
            }
        }
    });

    const concurrentLimitInput = document.getElementById('concurrent-limit');
    concurrentLimitInput.addEventListener('input', (event) => {
        event.target.value = event.target.value.replace(/[^0-9]/g, '');
    });

    // Event listeners para botones principales
    document.getElementById('btn-save').addEventListener('click', saveSettings);
    document.getElementById('btn-cancel').addEventListener('click', closeWindow);

    // Event listener para el candado de carpetas
    document.getElementById('lock-folders').addEventListener('click', toggleFolderLock);

    // Event listeners para botones de selección de carpetas
    const folderBrowseButtons = document.querySelectorAll('.folder-browse-btn');
    folderBrowseButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const folderType = e.currentTarget.getAttribute('data-folder-type');
            if (folderType) {
                selectFolderForType(folderType);
            }
        });
    });

    // Event listeners para botones de ubicación de índice OCR
    document.getElementById('btn-select-ocr-location').addEventListener('click', selectOCRIndexLocation);
    document.getElementById('btn-reset-ocr-location').addEventListener('click', resetOCRIndexLocation);

    // Event listeners para carpeta vigilada
    document.getElementById('btn-select-watch-folder').addEventListener('click', selectWatchFolder);
    document.getElementById('btn-clear-watch-folder').addEventListener('click', clearWatchFolder);
    document.getElementById('btn-select-watch-error-folder').addEventListener('click', selectWatchErrorFolder);
    document.getElementById('btn-clear-watch-error-folder').addEventListener('click', clearWatchErrorFolder);
}

// =================================================================================
// --- FUNCIONES DE ACCIÓN ---
// =================================================================================

/**
 * Valida que todas las carpetas obligatorias estén configuradas.
 * @returns {boolean} True si todo es válido.
 */
function validateFolders() {
    const folderIds = [
        'folder-albaranes',
        'folder-pedidos',
        'folder-duas',
        'folder-facturas',
        'folder-entradas'
    ];

    const watchFolder = document.getElementById('watch-folder').value.trim();
    const watchErrorFolder = document.getElementById('watch-error-folder').value.trim();

    let allValid = true;
    
    // Si es la primera vez, las de detección automática son obligatorias
    if (isFirstTime) {
        folderIds.forEach(id => {
            const input = document.getElementById(id);
            if (!input || !input.value || input.value.trim() === '') {
                input?.classList.add('input-error');
                allValid = false;
            } else {
                input?.classList.remove('input-error');
            }
        });
    }

    // Validación cruzada para watch folder e incidencias
    const watchInput = document.getElementById('watch-folder');
    const errorInput = document.getElementById('watch-error-folder');

    if ((watchFolder !== '' && watchErrorFolder === '') || (watchFolder === '' && watchErrorFolder !== '')) {
        watchInput.classList.add('input-error');
        errorInput.classList.add('input-error');
        allValid = false;
        
        const errorMessage = document.getElementById('error-message');
        errorMessage.textContent = 'Si configura una Carpeta Vigilada, debe especificar OBLIGATORIAMENTE una Carpeta de Incidencias (y viceversa).';
        errorMessage.style.display = 'block';
        return false;
    } else {
        watchInput.classList.remove('input-error');
        errorInput.classList.remove('input-error');
    }

    // Si es la primera vez, la carpeta vigilada también es obligatoria según tu petición anterior
    if (isFirstTime && watchFolder === '') {
        watchInput.classList.add('input-error');
        errorInput.classList.add('input-error');
        allValid = false;
    }

    const errorMessage = document.getElementById('error-message');
    if (!allValid) {
        if (isFirstTime) {
            errorMessage.textContent = 'Debe especificar todas las rutas de detección automática y configurar la carpeta vigilada junto con su carpeta de incidencias.';
        }
        errorMessage.style.display = 'block';
    } else {
        errorMessage.style.display = 'none';
    }

    return allValid;
}

/**
 * Guarda la configuración y notifica a la ventana principal.
 */
function saveSettings() {
    const newLimit = parseInt(document.getElementById('concurrent-limit').value, 10);
    const errorMessage = document.getElementById('error-message');

    if (isNaN(newLimit) || newLimit < 1) {
        errorMessage.textContent = 'Por favor, introduce un número válido mayor que 0.';
        errorMessage.style.display = 'block';
        return;
    }

    // Validar carpetas siempre ahora por la nueva restricción
    if (!validateFolders()) {
        return;
    }

    errorMessage.style.display = 'none';

    // Recopilar las carpetas configuradas
    const folders = {
        albaranes: document.getElementById('folder-albaranes').value || '',
        pedidos: document.getElementById('folder-pedidos').value || '',
        duas: document.getElementById('folder-duas').value || '',
        facturas: document.getElementById('folder-facturas').value || '',
        entradas: document.getElementById('folder-entradas').value || ''
    };

    // Obtener la ruta del índice OCR
    const ocrIndexPath = document.getElementById('ocr-index-path').value || '';

    const maxPages = parseInt(document.getElementById('max-pages')?.value ?? '1', 10);
    localStorage.setItem('max-pages-ocr', maxPages.toString());

    const watchFolder = document.getElementById('watch-folder').value || '';
    const watchErrorFolder = document.getElementById('watch-error-folder').value || '';

    // Enviar configuración a la ventana principal
    window.electronAPI.saveSettings({
        concurrentLimit: newLimit,
        ocrIndexPath: ocrIndexPath,
        folders: folders,
        maxPages: maxPages,
        watchFolder: watchFolder,
        watchErrorFolder: watchErrorFolder,
        isFirstTime: isFirstTime
    });

    // Si no es la primera vez, cerrar la ventana
    if (!isFirstTime) {
        window.electronAPI.closeSettingsWindow();
    }
}

/**
 * Cierra la ventana sin guardar.
 */
function closeWindow() {
    // No permitir cerrar si es la primera vez y marcar errores
    if (isFirstTime) {
        validateFolders();
        return;
    }
    window.electronAPI.closeSettingsWindow();
}

// =================================================================================
// --- GESTIÓN DE CARPETAS ---
// =================================================================================

/**
 * Carga la configuración de carpetas desde localStorage
 */
function loadFolderConfiguration() {
    const types = ['albaranes', 'pedidos', 'duas', 'facturas', 'entradas'];
    types.forEach(type => {
        const folder = localStorage.getItem(`auto-folder-${type}`);
        if (folder) {
            document.getElementById(`folder-${type}`).value = folder;
        }
    });

    // Cargar carpeta vigilada
    const watchFolder = localStorage.getItem('watch-folder');
    if (watchFolder) {
        document.getElementById('watch-folder').value = watchFolder;
    }

    // Cargar carpeta de incidencias
    const watchErrorFolder = localStorage.getItem('watch-error-folder');
    if (watchErrorFolder) {
        document.getElementById('watch-error-folder').value = watchErrorFolder;
    }
}

/**
 * Carga la configuración del límite de procesamiento concurrente desde localStorage
 */
function loadConcurrentLimitConfiguration() {
    const savedLimit = localStorage.getItem('concurrentLimit');
    if (savedLimit) {
        document.getElementById('concurrent-limit').value = savedLimit;
        console.log(`⚙️ Límite de procesamiento cargado en modal: ${savedLimit}`);
    } else {
        document.getElementById('concurrent-limit').value = 50;
    }

    const savedPages = localStorage.getItem('max-pages-ocr');
    const select = document.getElementById('max-pages');
    if (select) {
        select.value = savedPages !== null ? savedPages : '0';
    }
}

/**
 * Alterna el estado del candado de carpetas
 */
function toggleFolderLock() {
    foldersLocked = !foldersLocked;
    const lockBtn = document.getElementById('lock-folders');
    const browseButtons = document.querySelectorAll('.folder-browse-btn');

    if (foldersLocked) {
        lockBtn.textContent = '🔒';
        browseButtons.forEach(btn => btn.disabled = true);
        if (lockTimeout) clearTimeout(lockTimeout);
    } else {
        lockBtn.textContent = '🔓';
        browseButtons.forEach(btn => btn.disabled = false);

        // Auto-lock después de 5 segundos
        if (lockTimeout) clearTimeout(lockTimeout);
        lockTimeout = setTimeout(() => {
            toggleFolderLock();
        }, 5000);
    }
}

/**
 * Selecciona una carpeta para un tipo de documento
 */
async function selectFolderForType(type) {
    const result = await window.electronAPI.selectFolder();

    if (result.success && result.folder) {
        const input = document.getElementById(`folder-${type}`);
        input.value = result.folder;
        input.classList.remove('input-error');

        // Guardar en localStorage
        localStorage.setItem(`auto-folder-${type}`, result.folder);

        // Auto-bloquear inmediatamente después de seleccionar
        if (!foldersLocked) {
            toggleFolderLock();
        }

        console.log(`📁 Carpeta para ${type} configurada: ${result.folder}`);
    }
}

/**
 * Selecciona la ubicación del archivo de índice OCR
 */
async function selectOCRIndexLocation() {
    const result = await window.electronAPI.selectOCRIndexLocation();

    if (result.success && result.filePath) {
        document.getElementById('ocr-index-path').value = result.filePath;
        localStorage.setItem('ocr-index-path', result.filePath);
        console.log(`💾 Ubicación de índice OCR configurada: ${result.filePath}`);
    }
}

/**
 * Restaura la ubicación por defecto del archivo de índice OCR
 */
async function resetOCRIndexLocation() {
    const result = await window.electronAPI.getDefaultOCRIndexPath();

    if (result.success && result.path) {
        document.getElementById('ocr-index-path').value = result.path;
        localStorage.removeItem('ocr-index-path');
        console.log(`💾 Ubicación de índice OCR restaurada a por defecto: ${result.path}`);
    }
}

// =================================================================================
// --- GESTIÓN DE UBICACIÓN DEL ÍNDICE OCR ---
// =================================================================================

/**
 * Carga la configuración de la ruta del índice OCR desde localStorage
 */
async function loadOCRIndexPathConfiguration() {
    const savedPath = localStorage.getItem('ocr-index-path');

    if (savedPath) {
        document.getElementById('ocr-index-path').value = savedPath;
        console.log(`💾 Ruta del índice OCR cargada: ${savedPath}`);
    } else {
        // Mostrar la ruta por defecto
        const result = await window.electronAPI.getDefaultOCRIndexPath();
        if (result.success) {
            document.getElementById('ocr-index-path').placeholder = result.path;
            console.log(`💾 Ruta por defecto del índice OCR: ${result.path}`);
        }
    }
}

/**
 * Selecciona la ubicación del archivo de índice OCR
 */
async function selectOCRIndexLocation() {
    const result = await window.electronAPI.selectOCRIndexLocation();

    if (result.success && result.filePath) {
        document.getElementById('ocr-index-path').value = result.filePath;
        localStorage.setItem('ocr-index-path', result.filePath);
        console.log(`💾 Ubicación del índice OCR configurada: ${result.filePath}`);
    }
}

/**
 * Restaura la ubicación por defecto del archivo de índice OCR
 */
async function resetOCRIndexLocation() {
    document.getElementById('ocr-index-path').value = '';
    localStorage.removeItem('ocr-index-path');

    const result = await window.electronAPI.getDefaultOCRIndexPath();
    if (result.success) {
        document.getElementById('ocr-index-path').placeholder = result.path;
        console.log(`💾 Ubicación del índice OCR restaurada a por defecto: ${result.path}`);
    }
}

/**
 * Selecciona la carpeta a vigilar
 */
async function selectWatchFolder() {
    const result = await window.electronAPI.selectFolder();
    if (result.success && result.folder) {
        const input = document.getElementById('watch-folder');
        input.value = result.folder;
        input.classList.remove('input-error');
        localStorage.setItem('watch-folder', result.folder);
        console.log(`👁️ Carpeta vigilada configurada: ${result.folder}`);
    }
}

/**
 * Elimina la carpeta vigilada
 */
function clearWatchFolder() {
    document.getElementById('watch-folder').value = '';
    localStorage.removeItem('watch-folder');
    console.log('👁️ Carpeta vigilada eliminada');
}

/**
 * Selecciona la carpeta de incidencias para la vigilancia
 */
async function selectWatchErrorFolder() {
    const result = await window.electronAPI.selectFolder();
    if (result.success && result.folder) {
        const input = document.getElementById('watch-error-folder');
        input.value = result.folder;
        input.classList.remove('input-error');
        localStorage.setItem('watch-error-folder', result.folder);
        console.log(`⚠️ Carpeta de incidencias configurada: ${result.folder}`);
    }
}

/**
 * Elimina la carpeta de incidencias
 */
function clearWatchErrorFolder() {
    document.getElementById('watch-error-folder').value = '';
    localStorage.removeItem('watch-error-folder');
    console.log('⚠️ Carpeta de incidencias eliminada');
}