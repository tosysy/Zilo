/**
 * @file Script para la ventana de renombrado manual
 * @description Gestiona la UI y lógica de la ventana de renombrado manual
 */

// Configuración de PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Estado actual
let currentFileData = null;
let currentZoom = 1.0;
let originalImage = null;
let baseScale = 1.0; // Escala base para ajustar la imagen al contenedor

// =================================================================================
// --- INICIALIZACIÓN ---
// =================================================================================

window.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    setupThemeListener();
    setupFileDataListener();
    setupCanvasZoom();
});

/**
 * Configura los event listeners para los inputs
 */
function setupEventListeners() {
    const serieInput = document.getElementById('manual-serie');
    const codigoInput = document.getElementById('manual-codigo');
    const docTypeSelect = document.getElementById('manual-doc-type');

    // Validar solo números
    const onlyNumbers = (e) => {
        if (!/^\d$/.test(e.key) && !['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
        }
    };

    serieInput.addEventListener('keydown', onlyNumbers);
    codigoInput.addEventListener('keydown', onlyNumbers);

    serieInput.addEventListener('input', () => { clearFieldError('manual-serie'); updatePreviewFilename(); });
    codigoInput.addEventListener('input', () => { clearFieldError('manual-codigo'); updatePreviewFilename(); });
    docTypeSelect.addEventListener('change', () => { clearFieldError('manual-doc-type'); updatePreviewFilename(); });

    // Permitir Enter para confirmar
    const confirmOnEnter = (e) => {
        if (e.key === 'Enter') {
            confirmRename();
        }
    };
    serieInput.addEventListener('keypress', confirmOnEnter);
    codigoInput.addEventListener('keypress', confirmOnEnter);

    // Event listeners para botones de zoom
    document.getElementById('btn-zoom-in').addEventListener('click', zoomIn);
    document.getElementById('btn-zoom-out').addEventListener('click', zoomOut);
    document.getElementById('btn-zoom-reset').addEventListener('click', resetZoom);

    // Event listeners para botones de acción
    document.getElementById('btn-skip').addEventListener('click', skipFile);
    document.getElementById('btn-confirm').addEventListener('click', confirmRename);
}

/**
 * Configura el listener para cambios de tema
 */
function setupThemeListener() {
    window.manualRenameAPI.onThemeChanged((theme) => {
        if (theme === 'dark') {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    });
}

/**
 * Configura el listener para recibir datos del archivo
 */
function setupFileDataListener() {
    window.manualRenameAPI.onFileData(async (data) => {
        console.log('📥 Datos del archivo recibidos:', data);
        currentFileData = data;
        await displayFileData(data);
    });
}

/**
 * Configura el zoom con la rueda del mouse en el canvas
 */
function setupCanvasZoom() {
    const container = document.querySelector('.pdf-canvas-container');

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) {
            zoomIn();
        } else {
            zoomOut();
        }
    }, { passive: false });

    // Configurar drag-to-scroll
    setupDragScroll(container);
}

/**
 * Configura el arrastre para desplazarse por el contenido
 * @param {HTMLElement} container - El contenedor scrollable
 */
function setupDragScroll(container) {
    let isDown = false;
    let startX;
    let startY;
    let scrollLeft;
    let scrollTop;

    container.addEventListener('mousedown', (e) => {
        // Solo permitir drag con botón izquierdo
        if (e.button !== 0) return;

        isDown = true;
        container.style.cursor = 'grabbing';
        startX = e.pageX - container.offsetLeft;
        startY = e.pageY - container.offsetTop;
        scrollLeft = container.scrollLeft;
        scrollTop = container.scrollTop;
    });

    container.addEventListener('mouseleave', () => {
        isDown = false;
        container.style.cursor = 'grab';
    });

    container.addEventListener('mouseup', () => {
        isDown = false;
        container.style.cursor = 'grab';
    });

    container.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - container.offsetLeft;
        const y = e.pageY - container.offsetTop;
        const walkX = (x - startX) * 1.5; // Velocidad de desplazamiento
        const walkY = (y - startY) * 1.5;
        container.scrollLeft = scrollLeft - walkX;
        container.scrollTop = scrollTop - walkY;
    });
}

// =================================================================================
// --- RENDERIZADO Y UI ---
// =================================================================================

/**
 * Muestra los datos del archivo en la UI
 * @param {object} data - Datos del archivo
 */
async function displayFileData(data) {
    const { fileName, pageData, detectedType, currentMode, queueCount, isFromSearch } = data;

    // Actualizar título con contador de cola
    const queueBadge = document.getElementById('queue-badge');
    if (queueCount > 1) {
        queueBadge.textContent = `${queueCount} en cola`;
        queueBadge.style.display = 'inline-block';
    } else {
        queueBadge.style.display = 'none';
    }

    // Mostrar el nombre original del archivo
    document.getElementById('original-filename').textContent = fileName || '-';

    // Mostrar mensaje solo si NO viene desde búsqueda y viene del procesamiento automático
    const autoDetectMessage = document.getElementById('auto-detect-message');
    if (!isFromSearch && currentMode !== 'search') {
        autoDetectMessage.style.display = 'block';
    } else {
        autoDetectMessage.style.display = 'none';
    }

    // Mostrar selector de tipo si es modo auto, manual o viene desde búsqueda
    const docTypeSelector = document.getElementById('doc-type-selector');
    const docTypeSelect = document.getElementById('manual-doc-type');

    if (currentMode === 'auto' || currentMode === 'manual' || currentMode === 'search' || isFromSearch) {
        docTypeSelector.style.display = 'block';
        docTypeSelect.value = detectedType || '';
    } else {
        docTypeSelector.style.display = 'none';
    }

    // Renderizar PDF
    await renderPDFPreview(pageData);

    // Limpiar inputs, errores y enfocar
    document.getElementById('manual-serie').value = '';
    document.getElementById('manual-codigo').value = '';
    clearFieldError('manual-serie');
    clearFieldError('manual-codigo');
    clearFieldError('manual-doc-type');
    updatePreviewFilename();

    // Enfocar el primer campo
    setTimeout(() => {
        if ((currentMode === 'auto' || currentMode === 'search' || isFromSearch) && !detectedType) {
            docTypeSelect.focus();
        } else {
            document.getElementById('manual-serie').focus();
        }
    }, 100);
}

/**
 * Renderiza la vista previa del PDF en el canvas
 * @param {ArrayBuffer} pageData - Datos de la imagen PNG
 */
async function renderPDFPreview(pageData) {
    try {
        const canvas = document.getElementById('pdf-preview-canvas');
        const context = canvas.getContext('2d');
        const container = document.querySelector('.pdf-canvas-container');

        // Crear una imagen desde el ArrayBuffer
        const blob = new Blob([pageData], { type: 'image/png' });
        const imageUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
            // Guardar la imagen original para zoom
            originalImage = img;

            // Establecer zoom inicial al 100%
            currentZoom = 1.0;

            // Calcular la escala base para que al 100% encaje exactamente en el contenedor
            const containerWidth = container.clientWidth - 20; // Restar padding
            // baseScale × 1.0 (zoom) debe dar el containerWidth
            baseScale = containerWidth / (img.width * currentZoom);

            // Ajustar el ancho del contenedor de vista previa SOLO al cargar
            const previewSection = document.querySelector('.pdf-preview-section');
            const initialWidth = Math.round(img.width * baseScale * currentZoom);
            const containerPadding = 50; // Padding + scrollbar
            const newWidth = Math.min(initialWidth + containerPadding, window.innerWidth * 0.7);
            previewSection.style.width = `${newWidth}px`;

            // Renderizar con zoom actual
            renderWithZoom();

            // Liberar la URL del objeto
            URL.revokeObjectURL(imageUrl);

            console.log('✅ Vista previa del PDF renderizada');
            console.log(`Dimensiones originales: ${img.width}x${img.height}`);
            console.log(`Contenedor width: ${containerWidth}px`);
            console.log(`Escala base: ${baseScale}, Zoom inicial: ${currentZoom}`);

            // Calcular dimensiones finales del canvas
            const finalWidth = Math.round(img.width * baseScale * currentZoom);
            const finalHeight = Math.round(img.height * baseScale * currentZoom);
            console.log(`Dimensiones al 100%: ${finalWidth}x${finalHeight}px (encaja en contenedor)`);
            console.log(`Si cambias zoom a 150%: ${Math.round(img.width * baseScale * 1.5)}px (más grande, puede tener scroll)`);
            console.log(`Si cambias zoom a 300%: ${Math.round(img.width * baseScale * 3)}px (máximo zoom, con scroll)`);
        };

        img.onerror = () => {
            console.error('❌ Error al cargar la imagen');
            URL.revokeObjectURL(imageUrl);
        };

        img.src = imageUrl;
    } catch (error) {
        console.error('❌ Error al renderizar PDF:', error);
    }
}

/**
 * Renderiza el canvas con el nivel de zoom actual
 */
function renderWithZoom() {
    if (!originalImage) return;

    const canvas = document.getElementById('pdf-preview-canvas');
    const context = canvas.getContext('2d');

    // Calcular el factor de escala total (escala base * zoom del usuario)
    const totalScale = baseScale * currentZoom;

    // Calcular dimensiones finales del documento completo
    const finalWidth = Math.round(originalImage.width * totalScale);
    const finalHeight = Math.round(originalImage.height * totalScale);

    // Establecer las dimensiones del canvas al documento completo
    canvas.width = finalWidth;
    canvas.height = finalHeight;

    // Limpiar y dibujar con interpolación de alta calidad
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(originalImage, 0, 0, finalWidth, finalHeight);

    // Actualizar indicador de zoom
    document.getElementById('zoom-level').textContent = Math.round(currentZoom * 100) + '%';

    console.log(`Zoom: ${currentZoom}, Escala total: ${totalScale}, Dimensiones finales: ${finalWidth}x${finalHeight}`);
}

/**
 * Aumenta el zoom
 */
function zoomIn() {
    if (currentZoom < 3.0) {
        currentZoom += 0.25;
        renderWithZoom();
    }
}

/**
 * Reduce el zoom
 */
function zoomOut() {
    if (currentZoom > 0.5) {
        currentZoom -= 0.25;
        renderWithZoom();
    }
}

/**
 * Restablece el zoom al 100% (zoom inicial)
 */
function resetZoom() {
    currentZoom = 1.0;
    renderWithZoom();
}

/**
 * Actualiza el nombre de archivo de previsualización
 */
function updatePreviewFilename() {
    const serie = document.getElementById('manual-serie').value.trim();
    const codigo = document.getElementById('manual-codigo').value.trim();
    const previewSpan = document.getElementById('preview-filename');

    const needsTypeSelection = currentFileData?.currentMode === 'auto' || currentFileData?.currentMode === 'manual' || currentFileData?.currentMode === 'search' || currentFileData?.isFromSearch;
    let selectedType = currentFileData?.currentMode;
    if (needsTypeSelection) {
        selectedType = document.getElementById('manual-doc-type').value;
    }

    if (serie && codigo && selectedType) {
        const orderNumber = serie + codigo.padStart(6, '0');
        previewSpan.textContent = generateNewFilename(orderNumber, selectedType, currentFileData?.ocrText || '');
    } else {
        previewSpan.textContent = '-';
    }
}

// =================================================================================
// --- LÓGICA DE RENOMBRADO ---
// =================================================================================

/**
 * Genera el nuevo nombre de archivo
 * @param {string} orderNumber - Número de 7 dígitos
 * @param {string} docType - Tipo de documento
 * @param {string} text - Texto OCR para detectar palabras clave
 * @returns {string} - El nuevo nombre de archivo
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
 * Formatea un número de 7 dígitos a "S-NNNNNN"
 * @param {string} orderNumber - El número de 7 dígitos
 * @returns {string} - El número formateado
 */
function formatOrderNumber(orderNumber) {
    if (orderNumber && orderNumber.length === 7) {
        const serie = orderNumber[0];
        const codigo = parseInt(orderNumber.substring(1), 10);
        return `${serie}-${codigo}`;
    }
    return orderNumber;
}

/**
 * Muestra un error inline en un campo
 */
function showFieldError(fieldId, message) {
    const field = document.getElementById(fieldId);
    const errorSpan = document.getElementById('error-' + fieldId.replace('manual-', ''));
    field.classList.add('field-error');
    if (errorSpan) {
        errorSpan.textContent = message;
        errorSpan.classList.add('visible');
    }
    field.focus();
}

/**
 * Limpia el error de un campo
 */
function clearFieldError(fieldId) {
    const field = document.getElementById(fieldId);
    const errorSpan = document.getElementById('error-' + fieldId.replace('manual-', ''));
    field.classList.remove('field-error');
    if (errorSpan) {
        errorSpan.textContent = '';
        errorSpan.classList.remove('visible');
    }
}

/**
 * Confirma el renombrado y envía los datos al proceso principal
 */
function confirmRename() {
    const serie = document.getElementById('manual-serie').value.trim();
    const codigo = document.getElementById('manual-codigo').value.trim();
    const docTypeSelect = document.getElementById('manual-doc-type');
    const needsTypeSelection = currentFileData?.currentMode === 'auto' || currentFileData?.currentMode === 'manual' || currentFileData?.currentMode === 'search' || currentFileData?.isFromSearch;
    const selectedType = needsTypeSelection ? docTypeSelect.value : currentFileData?.currentMode;

    // Limpiar errores previos
    clearFieldError('manual-doc-type');
    clearFieldError('manual-serie');
    clearFieldError('manual-codigo');

    // Validaciones
    if (needsTypeSelection && !selectedType) {
        showFieldError('manual-doc-type', 'Selecciona el tipo de documento.');
        return;
    }

    if (!serie || !/^\d$/.test(serie)) {
        showFieldError('manual-serie', 'La serie debe ser un único dígito (0-9).');
        return;
    }

    if (!codigo || !/^\d+$/.test(codigo)) {
        showFieldError('manual-codigo', 'El código solo puede contener números.');
        return;
    }

    // Preparar datos
    const orderNumber = serie + codigo.padStart(6, '0');
    const data = {
        orderNumber,
        selectedType,
        ocrText: currentFileData?.ocrText || '',
        filePath: currentFileData?.filePath, // Incluir filePath para renombrado desde búsqueda
        isFromSearch: currentFileData?.isFromSearch || false
    };

    console.log('✅ Confirmando renombrado:', data);
    window.manualRenameAPI.confirmRename(data);
}

/**
 * Omite el archivo actual
 */
function skipFile() {
    console.log('↪️ Omitiendo archivo');
    window.manualRenameAPI.skipFile();
}
