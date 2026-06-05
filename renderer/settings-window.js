/**
 * @file Script para la ventana de configuración.
 * @description Maneja la configuración simplificada (sin tipos hardcodeados).
 */

// =================================================================================
// --- INICIALIZACIÓN ---
// =================================================================================

window.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    applyCurrentTheme();
    loadWatchFolders();
    loadConcurrentLimitConfiguration();
    loadOCRIndexPathConfiguration();
});

// Recibir configuración actual desde la ventana principal
window.electronAPI.onLoadSettings((settings) => {
    // Límite de procesamiento
    const limit = settings.concurrentLimit || 50;
    document.getElementById('concurrent-limit').value = limit;
    localStorage.setItem('concurrentLimit', limit.toString());

    // Ruta del índice OCR
    if (settings.ocrIndexPath) {
        document.getElementById('ocr-index-path').value = settings.ocrIndexPath;
        localStorage.setItem('ocr-index-path', settings.ocrIndexPath);
    }

    // Carpeta vigilada
    if (settings.watchFolder !== undefined) {
        document.getElementById('watch-folder').value = settings.watchFolder || '';
        if (settings.watchFolder) localStorage.setItem('watch-folder', settings.watchFolder);
    }

    // Carpeta de incidencias
    if (settings.watchErrorFolder !== undefined) {
        document.getElementById('watch-error-folder').value = settings.watchErrorFolder || '';
        if (settings.watchErrorFolder) localStorage.setItem('watch-error-folder', settings.watchErrorFolder);
    }
});

// Cambios de tema desde la ventana principal
window.electronAPI.onThemeChange((theme) => {
    document.body.classList.toggle('dark-mode', theme === 'dark');
});

function applyCurrentTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
    }
}

function setupEventListeners() {
    // Escape cierra la ventana
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeWindow();
    });

    // Solo dígitos en el límite de concurrencia
    document.getElementById('concurrent-limit').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/[^0-9]/g, '');
    });

    // Botones principales
    document.getElementById('btn-save').addEventListener('click', saveSettings);
    document.getElementById('btn-cancel').addEventListener('click', closeWindow);

    // Índice OCR
    document.getElementById('btn-select-ocr-location').addEventListener('click', selectOCRIndexLocation);
    document.getElementById('btn-reset-ocr-location').addEventListener('click', resetOCRIndexLocation);

    // Carpeta vigilada
    document.getElementById('btn-select-watch-folder').addEventListener('click', selectWatchFolder);
    document.getElementById('btn-clear-watch-folder').addEventListener('click', clearWatchFolder);
    document.getElementById('btn-select-watch-error-folder').addEventListener('click', selectWatchErrorFolder);
    document.getElementById('btn-clear-watch-error-folder').addEventListener('click', clearWatchErrorFolder);

    // Atajo a tipos de documento
    document.getElementById('btn-open-doc-types').addEventListener('click', () => {
        window.electronAPI.openDocTypesWindow();
    });
}

// =================================================================================
// --- GUARDAR / CERRAR ---
// =================================================================================

function validateFields() {
    const errorMessage = document.getElementById('error-message');
    const watchFolder = document.getElementById('watch-folder').value.trim();
    const watchErrorFolder = document.getElementById('watch-error-folder').value.trim();

    // Si se configura una, la otra también es obligatoria
    if ((watchFolder !== '' && watchErrorFolder === '') ||
        (watchFolder === '' && watchErrorFolder !== '')) {
        document.getElementById('watch-folder').classList.add('input-error');
        document.getElementById('watch-error-folder').classList.add('input-error');
        errorMessage.textContent = 'Si configura una Carpeta Vigilada, debe especificar también la Carpeta de Incidencias (y viceversa).';
        errorMessage.style.display = 'block';
        return false;
    }

    document.getElementById('watch-folder').classList.remove('input-error');
    document.getElementById('watch-error-folder').classList.remove('input-error');
    errorMessage.style.display = 'none';
    return true;
}

function saveSettings() {
    const errorMessage = document.getElementById('error-message');
    const newLimit = parseInt(document.getElementById('concurrent-limit').value, 10);

    if (isNaN(newLimit) || newLimit < 1) {
        errorMessage.textContent = 'Por favor, introduce un número válido mayor que 0.';
        errorMessage.style.display = 'block';
        return;
    }

    if (!validateFields()) return;

    errorMessage.style.display = 'none';

    const ocrIndexPath   = document.getElementById('ocr-index-path').value || '';
    const maxPages       = parseInt(document.getElementById('max-pages')?.value ?? '0', 10);
    const watchFolder    = document.getElementById('watch-folder').value || '';
    const watchErrorFolder = document.getElementById('watch-error-folder').value || '';

    localStorage.setItem('max-pages-ocr', maxPages.toString());

    window.electronAPI.saveSettings({
        concurrentLimit: newLimit,
        ocrIndexPath,
        maxPages,
        watchFolder,
        watchErrorFolder
    });

    window.electronAPI.closeSettingsWindow();
}

function closeWindow() {
    window.electronAPI.closeSettingsWindow();
}

// =================================================================================
// --- CARPETAS VIGILADAS ---
// =================================================================================

function loadWatchFolders() {
    const watchFolder = localStorage.getItem('watch-folder');
    if (watchFolder) document.getElementById('watch-folder').value = watchFolder;

    const watchErrorFolder = localStorage.getItem('watch-error-folder');
    if (watchErrorFolder) document.getElementById('watch-error-folder').value = watchErrorFolder;
}

async function selectWatchFolder() {
    const result = await window.electronAPI.selectFolder();
    if (result.success && result.folder) {
        const input = document.getElementById('watch-folder');
        input.value = result.folder;
        input.classList.remove('input-error');
        localStorage.setItem('watch-folder', result.folder);
    }
}

function clearWatchFolder() {
    document.getElementById('watch-folder').value = '';
    localStorage.removeItem('watch-folder');
}

async function selectWatchErrorFolder() {
    const result = await window.electronAPI.selectFolder();
    if (result.success && result.folder) {
        const input = document.getElementById('watch-error-folder');
        input.value = result.folder;
        input.classList.remove('input-error');
        localStorage.setItem('watch-error-folder', result.folder);
    }
}

function clearWatchErrorFolder() {
    document.getElementById('watch-error-folder').value = '';
    localStorage.removeItem('watch-error-folder');
}

// =================================================================================
// --- CONFIGURACIÓN DE PROCESAMIENTO ---
// =================================================================================

function loadConcurrentLimitConfiguration() {
    const savedLimit = localStorage.getItem('concurrentLimit');
    document.getElementById('concurrent-limit').value = savedLimit || 50;

    const savedPages = localStorage.getItem('max-pages-ocr');
    const select = document.getElementById('max-pages');
    if (select) select.value = savedPages !== null ? savedPages : '0';
}

// =================================================================================
// --- ÍNDICE OCR ---
// =================================================================================

async function loadOCRIndexPathConfiguration() {
    const savedPath = localStorage.getItem('ocr-index-path');
    if (savedPath) {
        document.getElementById('ocr-index-path').value = savedPath;
    } else {
        const result = await window.electronAPI.getDefaultOCRIndexPath();
        if (result?.success) {
            document.getElementById('ocr-index-path').placeholder = result.path;
        }
    }
}

async function selectOCRIndexLocation() {
    const result = await window.electronAPI.selectOCRIndexLocation();
    if (result?.success && result.filePath) {
        document.getElementById('ocr-index-path').value = result.filePath;
        localStorage.setItem('ocr-index-path', result.filePath);
    }
}

async function resetOCRIndexLocation() {
    document.getElementById('ocr-index-path').value = '';
    localStorage.removeItem('ocr-index-path');

    const result = await window.electronAPI.getDefaultOCRIndexPath();
    if (result?.success) {
        document.getElementById('ocr-index-path').placeholder = result.path;
    }
}
