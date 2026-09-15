/**
 * @file Script para la ventana de búsqueda de documentos.
 * @description Maneja la búsqueda en el índice OCR y la visualización de resultados.
 */

// Configuración de PDF.js para usar el worker desde un CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Índice de búsqueda OCR
let ocrIndex = {};

// =================================================================================
// --- INICIALIZACIÓN ---
// =================================================================================

window.addEventListener('DOMContentLoaded', async () => {
    await loadOCRIndex();
    setupEventListeners();
    applyCurrentTheme();
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
    const searchInputs = ['search-input-1', 'search-input-2', 'search-input-3', 'search-input-4'];
    searchInputs.forEach(inputId => {
        const input = document.getElementById(inputId);
        if (input) {
            input.addEventListener('input', performSearch);
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') performSearch();
            });
        }
    });

    // Event listener para el botón de limpiar búsqueda
    document.getElementById('btn-clear-search').addEventListener('click', clearSearchFields);
}

// =================================================================================
// --- CARGA DE DATOS ---
// =================================================================================

/**
 * Carga el índice OCR desde el archivo JSON.
 */
async function loadOCRIndex() {
    try {
        const result = await window.electronAPI.loadOcrIndex();
        ocrIndex = result.success && result.data ? result.data : {};
        console.log(`📖 Índice OCR cargado con ${Object.keys(ocrIndex).length} documentos.`);
        updateSearchStats();
    } catch (error) {
        console.error('Error al cargar índice OCR:', error);
        ocrIndex = {};
    }
}

// =================================================================================
// --- BÚSQUEDA ---
// =================================================================================

/**
 * Realiza una búsqueda en el índice OCR con múltiples términos en cascada.
 * Cada filtro sucesivo filtra los resultados del filtro anterior.
 */
function performSearch() {
    const inputIds = ['search-input-1', 'search-input-2', 'search-input-3', 'search-input-4'];
    const inputs = inputIds.map(id => document.getElementById(id));

    // Obtener todos los valores de búsqueda (incluso vacíos para mantener el índice)
    const queryData = inputs.map((input, index) => ({
        input,
        value: input.value.trim(),
        upperValue: input.value.trim().toUpperCase(),
        index
    }));

    const resultsContainer = document.getElementById('search-results');
    const statsContainer = document.getElementById('search-stats');

    // Resetear clases de todos los inputs
    inputs.forEach(input => {
        input.classList.remove('search-input-found', 'search-input-not-found');
    });

    // Si no hay ningún término, mostrar mensaje inicial
    const hasAnyQuery = queryData.some(q => q.value !== '');
    if (!hasAnyQuery) {
        resultsContainer.innerHTML = '<div class="search-empty">Introduce al menos un término de búsqueda</div>';
        statsContainer.textContent = `${Object.keys(ocrIndex).length} documentos indexados`;
        return;
    }

    // Búsqueda en cascada: cada filtro filtra los resultados del anterior
    let currentResults = Object.values(ocrIndex);
    const activeQueries = [];
    let previousFilterBlockedAll = false; // Flag para saber si un filtro anterior ya bloqueó todos los resultados

    queryData.forEach(({ input, value, upperValue, index }) => {
        if (value === '') {
            // Si el campo está vacío, no aplicar ningún filtro
            return;
        }

        activeQueries.push(upperValue);

        // Si un filtro anterior ya bloqueó todo, no aplicar color a este input
        if (previousFilterBlockedAll) {
            // No aplicar ninguna clase de color
            return;
        }

        // Si el conjunto actual está vacío (filtro anterior bloqueó todo), no hay nada que buscar
        if (currentResults.length === 0) {
            previousFilterBlockedAll = true;
            return;
        }

        // Filtrar los resultados actuales con este término
        const filteredResults = currentResults.filter(entry =>
            entry.searchText.includes(upperValue)
        );

        // Determinar el color del input basado en si encuentra resultados en el conjunto actual
        if (filteredResults.length > 0) {
            input.classList.add('search-input-found');
            // Actualizar los resultados para el próximo filtro
            currentResults = filteredResults;
        } else {
            input.classList.add('search-input-not-found');
            // Si no encuentra resultados, los siguientes filtros tampoco encontrarán nada
            currentResults = [];
            previousFilterBlockedAll = true;
        }
    });

    const results = currentResults;

    statsContainer.textContent = `${results.length} resultado${results.length !== 1 ? 's' : ''} para ${activeQueries.length} término${activeQueries.length !== 1 ? 's' : ''}`;

    if (results.length === 0) {
        resultsContainer.innerHTML = `<div class="search-empty">No se encontraron documentos que contengan todos los términos.</div>`;
    } else {
        resultsContainer.innerHTML = ''; // Limpiar contenedor
        results.forEach(result => {
            const item = createSearchResultItem(result, activeQueries[0]);
            resultsContainer.appendChild(item);
        });
    }
}

/**
 * Actualiza las estadísticas de búsqueda.
 */
function updateSearchStats() {
    const statsContainer = document.getElementById('search-stats');
    statsContainer.textContent = `${Object.keys(ocrIndex).length} documentos indexados`;
}

/**
 * Crea y devuelve un elemento DOM para un resultado de búsqueda.
 * @param {object} result - El objeto del resultado de búsqueda.
 * @param {string} firstQuery - El primer término de búsqueda para resaltar el contexto.
 * @returns {HTMLElement} - El elemento div del resultado.
 */
function createSearchResultItem(result, firstQuery) {
    const docTypeIcons = { albaranes: '📋', pedidos: '📦', duas: '📄', facturas: '🧾', entradas: '📥' };
    const icon = docTypeIcons[result.docType] || '📄';
    const date = new Date(result.timestamp).toLocaleDateString('es-ES');

    const context = (text, query) => {
        const index = text.toUpperCase().indexOf(query.toUpperCase());
        if (index === -1) return text.substring(0, 100);
        const start = Math.max(0, index - 40);
        const end = Math.min(text.length, index + query.length + 40);
        let snippet = text.substring(start, end);
        if (start > 0) snippet = '...' + snippet;
        if (end < text.length) snippet = snippet + '...';
        return snippet.replace(new RegExp(query, 'gi'), '<strong>$&</strong>');
    };

    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.innerHTML = `
        <div class="search-result-header">
            <span class="search-result-icon">${icon}</span>
            <span class="search-result-name">${result.fileName}</span>
        </div>
        <div class="search-result-context">${context(result.ocrText, firstQuery)}</div>
        <div class="search-result-footer">
            <span class="search-result-date">Indexado: ${date}</span>
        </div>
    `;

    const openButton = document.createElement('button');
    openButton.className = 'search-result-open';
    openButton.textContent = 'Abrir archivo';
    openButton.addEventListener('click', () => openFile(result.filePath));

    const renameButton = document.createElement('button');
    renameButton.className = 'search-result-rename';
    renameButton.textContent = 'Renombrar';
    renameButton.addEventListener('click', () => openRenameWindow(result.filePath));

    // Crear contenedor para los botones
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'search-result-buttons';
    buttonContainer.appendChild(renameButton);
    buttonContainer.appendChild(openButton);

    const footer = div.querySelector('.search-result-footer');
    footer.appendChild(buttonContainer);
    return div;
}



// =================================================================================
// --- UTILIDADES ---
// =================================================================================

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
 * Abre la ventana de renombrado manual para un archivo desde la búsqueda.
 * @param {string} filePath - La ruta del archivo a renombrar.
 */
async function openRenameWindow(filePath) {
    try {
        // Leer el archivo PDF desde el disco
        const result = await window.electronAPI.readPdfFile(filePath);

        if (!result.success) {
            throw new Error(result.error || 'Error al leer el archivo PDF');
        }

        // Cargar el PDF y renderizar la primera página
        const pdf = await pdfjsLib.getDocument({ data: result.data }).promise;
        const page = await pdf.getPage(1);

        // Renderizar la página a datos de imagen
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

        // Obtener el nombre del archivo
        const fileName = filePath.split('\\').pop().split('/').pop();

        // Obtener el texto OCR del índice si está disponible
        const ocrText = ocrIndex[filePath]?.ocrText || '';

        // Enviar datos a la ventana de renombrado manual
        const fileData = {
            fileName: fileName,
            filePath: filePath,
            pageData: pageData,
            detectedType: null,
            currentMode: 'search', // Modo especial para indicar que viene desde búsqueda
            queueCount: 1,
            ocrText: ocrText,
            isFromSearch: true // Flag para indicar que viene desde búsqueda
        };

        await window.electronAPI.openManualRenameWindow(fileData);
    } catch (error) {
        console.error('Error al abrir ventana de renombrado:', error);
        alert('Error al preparar el archivo para renombrado: ' + error.message);
    }
}



/**
 * Limpia todos los campos de búsqueda.
 */
function clearSearchFields() {
    document.getElementById('search-input-1').value = '';
    document.getElementById('search-input-2').value = '';
    document.getElementById('search-input-3').value = '';
    document.getElementById('search-input-4').value = '';
    performSearch();
}
