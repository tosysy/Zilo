/**
 * @file app.js — Zilo (versión adaptativa)
 * @description Sin tipos hardcodeados. El usuario define sus propios tipos de documento.
 * El motor OCR Zonal aprende a reconocerlos automáticamente con el tiempo.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Estado global ─────────────────────────────────────────────────────────────
let currentMode        = '';       // 'auto' | 'manual' | tipo-id numérico
let currentDocType     = null;     // objeto tipo activo { id, name, icon, folder, ocr_template_ids[] }
let userDocTypes       = [];       // tipos cargados de la BD
let processedFiles     = new Set();
let destinationFolder  = '';
let fileCounter        = 0;
let concurrentLimit    = 3;   // Valor conservador: Tesseract es pesado, 50 ficheros en paralelo crashea máquinas normales
let maxPagesToProcess  = 0;
let foldersLocked      = true;
let lockTimeout        = null;
let ocrIndex           = {};

// Cola renombrado manual
let manualRenameQueue    = [];
let currentManualFile    = null;
let currentManualFileId  = null;

// Caché de estadísticas ML (se invalida tras cada entrenamiento)
let _mlStatsCache = null;

/**
 * Devuelve las estadísticas ML, usando caché para no llamar a IPC en cada archivo.
 */
async function _getMlStats() {
    if (!_mlStatsCache) {
        try { _mlStatsCache = await window.electronAPI.mlGetStats(); } catch (_) { _mlStatsCache = {}; }
    }
    return _mlStatsCache;
}

// Caché de patrones aprendidos por tipo (evita un IPC por archivo en lotes)
const _patternCache = {};
const _PATTERN_CACHE_TTL = 30_000; // 30 s

/**
 * Devuelve los patrones aprendidos para un tipo, con caché de 30 segundos.
 * Se invalida al aprender un nuevo patrón (ver llamadas a invalidatePatternCache).
 */
async function _getCachedPatterns(typeName) {
    const now = Date.now();
    const cached = _patternCache[typeName];
    if (cached && (now - cached.ts) < _PATTERN_CACHE_TTL) return cached.data;
    try {
        const data = await window.electronAPI.getLearnedPatterns(typeName) || [];
        _patternCache[typeName] = { data, ts: now };
        return data;
    } catch (_) { return []; }
}

function _invalidatePatternCache(typeName) {
    delete _patternCache[typeName];
}

/**
 * Zilo es "experto" en un tipo cuando:
 *  - Ha procesado ≥20 documentos de ese tipo (ML robusto), O
 *  - Ha procesado ≥10 documentos Y tiene un patrón de renombrado
 *    confirmado ≥3 veces (sabe clasificar Y sabe dónde está el número).
 */
async function _isExpertForType(typeName) {
    const stats    = await _getMlStats();
    // Normalizar nombre antes de comparar — evita que "Factura" y "FACTURA" sean clases distintas
    const normName = typeName.trim().toUpperCase();
    const key      = Object.keys(stats?.classes || {}).find(k => k.trim().toUpperCase() === normName);
    const docCount = key ? (stats.classes[key].docCount || 0) : 0;

    if (docCount >= 20) return true;

    if (docCount >= 10) {
        const patterns = await _getCachedPatterns(typeName);
        if (patterns.some(p => p.confirmations >= 3)) return true;
    }
    return false;
}

// ── Búsqueda de texto en OCR ya extraído (sin re-OCR) ───────────────────────

/**
 * Busca `beforeKw` en el texto OCR ya disponible y devuelve lo que sigue.
 * Opera completamente sobre texto normalizado (sin acentos, minúsculas, espacios simples)
 * para evitar desajustes de offset entre el texto original y el normalizado.
 *
 * Si hay `afterKw`, extrae hasta él. Si no, usa heurística de parada:
 * para cuando aparece la primera palabra larga de solo letras (≥4 chars)
 * — típicamente una etiqueta como "fecha", "tipo", "cliente" — o a los 30 chars.
 */
function _searchInOcrText(ocrText, beforeKw, afterKw) {
    if (!ocrText || !beforeKw) return '';

    const norm = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();

    const normOcr    = norm(ocrText);
    const normBefore = norm(beforeKw);
    const idx = normOcr.indexOf(normBefore);
    if (idx === -1) return '';

    const rest = normOcr.slice(idx + normBefore.length).replace(/^[\s:.]+/, '');

    let extracted;
    if (afterKw) {
        const normAfter = norm(afterKw);
        const endIdx    = rest.indexOf(normAfter);
        // Si no encuentra el afterKw, tomar hasta 40 chars como fallback
        extracted = endIdx !== -1 ? rest.slice(0, endIdx) : rest.slice(0, 40);
    } else {
        // Sin afterKw: tomar tokens hasta encontrar una "palabra etiqueta"
        // (≥4 letras puras) o superar 30 chars.
        // Ej: "1 013770 fecha 05/01" → para en "fecha" → "1 013770"
        const tokens = rest.split(/\s+/);
        const parts  = [];
        for (const tok of tokens) {
            if (parts.length > 0 && /^[a-z]{4,}$/.test(tok)) break;
            if (parts.join(' ').length >= 30) break;
            parts.push(tok);
        }
        extracted = parts.join(' ');
    }

    return extracted.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * Aplica los patrones aprendidos de ejemplos manuales para extraer
 * el texto de renombrado directamente del texto OCR ya disponible.
 * Retorna el primer resultado válido (los patrones vienen ordenados
 * por número de confirmaciones descendente).
 */
async function _extractByLearnedPattern(ocrText, typeName) {
    if (!ocrText || !typeName) return '';
    const patterns = await _getCachedPatterns(typeName);
    if (!patterns.length) return '';
    for (const p of patterns) {
        const result = _searchInOcrText(ocrText, p.before_kw, p.after_kw);
        if (result && result.length > 1) {
            console.log(`[Pattern] "${typeName}": "${p.before_kw}" → "${result}" (×${p.confirmations})`);
            return result;
        }
    }
    return '';
}

// =================================================================================
// INICIALIZACIÓN
// =================================================================================

window.addEventListener('DOMContentLoaded', () => {
    loadInitialSettings();
    setupEventListeners();
    updateLockState();
    loadOCRIndex();
    loadUserDocTypes();
    setupManualRenameListeners();

    window.electronAPI.onWatchedFileDetected(async (fileData) => {
        console.log('👁️ Archivo vigilado:', fileData.name);
        await processWatchedFile(fileData);
    });

    // Recargar tipos cuando el usuario cierra la ventana de gestión
    window.electronAPI.onDocTypesUpdated(() => loadUserDocTypes());

    // Mostrar botón admin solo si admin
    (async () => {
        try {
            const s = await window.electronAPI.getLicenseStatus();
            if (s?.role === 'admin') document.getElementById('btn-admin-panel').style.display = 'inline-flex';
        } catch (e) {}
    })();
});

function loadInitialSettings() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        document.getElementById('theme-icon').textContent = '🌙';
    } else {
        document.getElementById('theme-icon').textContent = '☀️';
    }
    const savedLimit = localStorage.getItem('concurrentLimit');
    if (savedLimit) concurrentLimit = parseInt(savedLimit, 10);

    const savedPages = localStorage.getItem('max-pages-ocr');
    if (savedPages !== null) maxPagesToProcess = parseInt(savedPages, 10);
}

function setupEventListeners() {
    setupDragAndDrop();
    setupFileInput();

    document.getElementById('change-mode-header').addEventListener('click', changeMode);
    document.getElementById('btn-search').addEventListener('click', showSearchModal);
    document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('btn-settings').addEventListener('click', showSettingsModal);
    document.getElementById('btn-admin-panel').addEventListener('click', () => window.electronAPI.openAdminPanel());
    document.getElementById('btn-ocr-zonal').addEventListener('click', () => window.electronAPI.openOcrZonalWindow());
    document.getElementById('btn-manage-types').addEventListener('click', () => window.electronAPI.openDocTypesWindow());

    // Modos hardcodeados (auto / manual)
    document.querySelectorAll('.selection-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            const mode = e.currentTarget.getAttribute('data-mode');
            if (mode) selectMode(mode, null);
        });
    });

    document.getElementById('lock-single').addEventListener('click', () => toggleLock('single'));
    document.getElementById('browse-single').addEventListener('click', selectDestinationFolder);
    document.getElementById('upload-area').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });
}

/**
 * Devuelve el array de IDs de plantillas OCR vinculadas a un tipo.
 * Soporta el nuevo campo ocr_template_ids (array JSON) y el antiguo ocr_template_id (string).
 */
function _getTypeTemplateIds(type) {
    if (Array.isArray(type.ocr_template_ids) && type.ocr_template_ids.length) {
        return type.ocr_template_ids;
    }
    if (type.ocr_template_id) return [type.ocr_template_id];
    return [];
}

// =================================================================================
// TIPOS DE DOCUMENTO — carga dinámica
// =================================================================================

async function loadUserDocTypes() {
    try {
        userDocTypes = await window.electronAPI.getDocTypes();
        renderUserTypeButtons();
    } catch (e) {
        console.error('Error cargando tipos:', e);
    }
}

function renderUserTypeButtons() {
    const grid = document.getElementById('user-types-grid');
    if (!userDocTypes.length) {
        grid.innerHTML = '<div class="no-types-hint">Aún no has definido tipos de documento.<br>Pulsa "Gestionar tipos" para crear el primero.</div>';
        return;
    }
    grid.innerHTML = userDocTypes.map(t => `
        <button class="user-type-btn" data-type-id="${t.id}">
            <span class="ubt-icon">${t.icon}</span>
            <span class="ubt-name">${t.name}</span>
        </button>
    `).join('');

    grid.querySelectorAll('.user-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id   = parseInt(btn.getAttribute('data-type-id'), 10);
            const type = userDocTypes.find(t => t.id === id);
            if (type) selectMode('type', type);
        });
    });
}

// =================================================================================
// GESTIÓN DE MODOS
// =================================================================================

function selectMode(mode, docType = null) {
    currentMode    = mode;
    currentDocType = docType;

    document.getElementById('selection-screen').style.display   = 'none';
    document.getElementById('processing-screen').style.display  = 'flex';
    document.getElementById('change-mode-header').style.display = 'block';

    const badge = document.getElementById('current-type-badge');

    if (mode === 'auto') {
        document.getElementById('mode-icon').textContent        = '🤖';
        document.getElementById('mode-title').textContent       = 'Detección Automática';
        document.getElementById('mode-description').textContent = 'Zilo detecta el tipo y renombra solo usando OCR Zonal';
        document.getElementById('single-folder-selector').style.display = 'none';
        badge.style.display = 'none';

    } else if (mode === 'manual') {
        document.getElementById('mode-icon').textContent        = '✍️';
        document.getElementById('mode-title').textContent       = 'Renombrado Manual';
        document.getElementById('mode-description').textContent = 'Tú seleccionas el tipo y confirmas el nombre del archivo';
        document.getElementById('single-folder-selector').style.display = 'none';
        badge.style.display = 'none';

    } else if (mode === 'type' && docType) {
        document.getElementById('mode-icon').textContent        = docType.icon;
        document.getElementById('mode-title').textContent       = docType.name;
        document.getElementById('mode-description').textContent = `Renombrado directo como "${docType.name}"`;
        badge.textContent   = docType.folder ? `📁 ${docType.folder}` : '📁 Se pedirá destino al procesar';
        badge.style.display = 'inline-flex';

        if (docType.folder) {
            destinationFolder = docType.folder;
            document.getElementById('destination-folder').value = docType.folder;
            document.getElementById('single-folder-selector').style.display = 'none';
        } else {
            document.getElementById('single-folder-selector').style.display = 'block';
        }
    }

    updateLockState();
}

function changeMode() {
    document.getElementById('selection-screen').style.display   = 'flex';
    document.getElementById('processing-screen').style.display  = 'none';
    document.getElementById('change-mode-header').style.display = 'none';
    document.getElementById('file-list').innerHTML = '';
    processedFiles.clear();
    fileCounter = 0;
    updateFileCounter();
    currentMode    = '';
    currentDocType = null;
    // Recargar tipos por si cambiaron
    loadUserDocTypes();
}

// =================================================================================
// DRAG & DROP / INPUT
// =================================================================================

function setupDragAndDrop() {
    const ua = document.getElementById('upload-area');
    ua.addEventListener('dragover', e => { e.preventDefault(); ua.classList.add('dragover'); });
    ua.addEventListener('dragleave', () => ua.classList.remove('dragover'));
    ua.addEventListener('drop', e => {
        e.preventDefault();
        ua.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files)
            .filter(f => f.name.toLowerCase().endsWith('.pdf'))
            .map(f => ({ path: f.path, name: f.name }));
        if (files.length) handleFiles(files);
    });
}

async function setupFileInput() {
    const ua        = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');
    ua.onclick      = null;
    ua.addEventListener('click', async e => {
        e.preventDefault();
        e.stopPropagation();
        const result = await window.electronAPI.selectFiles();
        if (result.success && result.files?.length) {
            const files = result.files.map(fp => ({ path: fp, name: fp.split('\\').pop().split('/').pop() }));
            handleFiles(files);
        }
    });
    if (fileInput) fileInput.remove();
}

// =================================================================================
// PROCESAMIENTO DE ARCHIVOS
// =================================================================================

async function handleFiles(files) {
    if (!validateDestination()) return;

    const list     = document.getElementById('file-list');
    const newFiles = files.filter(f => !processedFiles.has(f.path));
    if (!newFiles.length) return;

    newFiles.forEach(f => {
        const fileId = `file-${Date.now()}-${Math.random()}`;
        f.fileId = fileId;
        list.insertBefore(createFileItem(f, fileId), list.firstChild);
    });

    for (let i = 0; i < newFiles.length; i += concurrentLimit) {
        const chunk = newFiles.slice(i, i + concurrentLimit);
        await Promise.allSettled(chunk.map(f => processFile(f, f.fileId)));
    }
}

function validateDestination() {
    if (currentMode === 'manual') return true;
    if (currentMode === 'auto') {
        const hasAnyType = userDocTypes.length > 0;
        if (!hasAnyType) {
            alert('⚙️ Primero define al menos un tipo de documento.\n\nPulsa "Gestionar tipos de documento" para crear tipos y enseñarle a Zilo.');
            return false;
        }
        const hasTemplates = userDocTypes.some(t => _getTypeTemplateIds(t).length > 0);
        if (!hasTemplates) {
            alert('⚙️ Ningún tipo tiene plantilla OCR vinculada.\n\nAbre el Motor OCR Zonal 🎯 para crear plantillas y vincúlalas a tus tipos de documento.');
            return false;
        }
        return true;
    }
    if (currentMode === 'type') {
        if (!destinationFolder && !currentDocType?.folder) {
            alert('Selecciona una carpeta destino antes de procesar.');
            return false;
        }
        return true;
    }
    return true;
}

/**
 * Procesa un archivo individual.
 */
async function processFile(file, fileId) {
    try {
        updateFileStatus(fileId, 'Extrayendo texto...', 30);
        const text = await extractTextFromPDF(file);

        updateFileStatus(fileId, 'Analizando contenido...', 60);

        // ── Modo manual: siempre a la cola de renombrado ──────────────────────
        if (currentMode === 'manual') {
            queueForManualRename(file, fileId, null, text);
            return;
        }

        // ── Modo tipo directo ──────────────────────────────────────────────────
        if (currentMode === 'type' && currentDocType) {
            let renameText = '', fromParts = false, tplId = null;
            if (_getTypeTemplateIds(currentDocType).length) {
                updateFileStatus(fileId, 'Extrayendo nombre...', 55);
                const r = await extractRenameTextForType(file, currentDocType);
                renameText = r.text || '';
                fromParts  = r.fromParts || false;
                tplId      = r.templateId || null;
            }
            // Fallback: patrones aprendidos si no hay template OCR configurado
            if (!renameText && text) {
                renameText = await _extractByLearnedPattern(text, currentDocType.name);
            }
            const expert = await _isExpertForType(currentDocType.name);
            if (expert) {
                await processWithType(file, fileId, currentDocType, text, false, renameText, fromParts, tplId);
            } else {
                const suggested = generateAdaptiveName(file.name, currentDocType, renameText, fromParts);
                updateFileStatus(fileId, `💡 Confirmar: ${suggested}`, 70);
                queueForManualRename(file, fileId, currentDocType.name, text, currentDocType, suggested);
            }
            return;
        }

        // ── Modo automático: detectar tipo vía OCR Zonal ──────────────────────
        if (currentMode === 'auto') {
            updateFileStatus(fileId, 'Detectando tipo...', 60);
            const matched = await detectDocumentType(file, text);
            if (matched && matched.confianza === 'high') {
                const expert = await _isExpertForType(matched.type.name);
                if (expert) {
                    const src = matched.source === 'ml' ? `🤖 ML ${Math.round((matched.mlConfidence||0)*100)}%` : '🎯 Zonas';
                    updateFileStatus(fileId, `${src} — procesando...`, 65);
                    await processWithType(file, fileId, matched.type, text, true, matched.renameText, matched.fromParts, matched.templateId);
                } else {
                    const suggested = generateAdaptiveName(file.name, matched.type, matched.renameText, matched.fromParts);
                    updateFileStatus(fileId, `💡 ${matched.type.name} — confirmar...`, 70);
                    queueForManualRename(file, fileId, matched.type.name, text, matched.type, suggested);
                }
            } else if (matched && matched.confianza === 'medium') {
                const suggested = matched.renameText
                    ? generateAdaptiveName(file.name, matched.type, matched.renameText, matched.fromParts)
                    : null;
                updateFileStatus(fileId, `🟡 Posible: ${matched.type.name} — confirmar...`, 70);
                queueForManualRename(file, fileId, matched.type.name, text, matched.type, suggested);
            } else {
                updateFileStatus(fileId, '⚠️ Tipo no detectado → revisión manual', 70);
                queueForManualRename(file, fileId, null, text);
            }
        }
    } catch (err) {
        console.error(`❌ processFile "${file.name}":`, err);
        updateFileStatus(fileId, `❌ Error: ${err.message}`, 100, 'error');
    }
}

// ── Helpers OCR zonal ─────────────────────────────────────────────────────────

/**
 * Carga un PDF y devuelve un mapa pageIndex → canvas renderizado a 3x.
 * Reutilizable entre detectTypeByOcrZonal y extractRenameTextForType.
 */
async function _loadPdfCanvases(filePath) {
    const result = await window.electronAPI.readPdfFile(filePath);
    if (!result.success) return null;
    const pdfDoc = await pdfjsLib.getDocument({ data: result.data }).promise;
    const cache  = {};

    async function getCanvas(pageIndex) {
        if (cache[pageIndex]) return cache[pageIndex];
        const page = await pdfDoc.getPage(pageIndex + 1);
        const vp   = page.getViewport({ scale: 3.0 });
        const c    = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        cache[pageIndex] = { canvas: c, vp, page }; // 'page' necesario para getTextContent()
        return cache[pageIndex];
    }

    return getCanvas;
}

/**
 * Busca una palabra o frase ancla en la capa de texto del PDF.
 * Reagrupa ítems por línea (coordenada Y ±5 puntos) para manejar textos divididos.
 * @returns {number|null} Y normalizada (0=arriba, 1=abajo) o null si no se encontró
 */
async function _findAnchorY(pdfPage, anchorText) {
    if (!pdfPage || !anchorText?.trim()) return null;
    try {
        const content    = await pdfPage.getTextContent();
        const vp1        = pdfPage.getViewport({ scale: 1 });
        const pageHeight = vp1.viewBox ? vp1.viewBox[3] : (vp1.height / vp1.scale);
        const lower      = anchorText.toLowerCase().trim();

        // Reconstruir líneas agrupando ítems con el mismo Y (±5 puntos PDF)
        const lineMap = {};
        for (const item of content.items) {
            if (!item.str?.trim()) continue;
            const rawY = item.transform[5];
            const yKey = Math.round(rawY / 5) * 5;
            if (!lineMap[yKey]) lineMap[yKey] = { rawY, text: '' };
            lineMap[yKey].text += item.str;
        }

        // Buscar ancla en las líneas reconstruidas
        for (const line of Object.values(lineMap)) {
            if (line.text.toLowerCase().includes(lower)) {
                return Math.max(0, Math.min(1, 1 - line.rawY / pageHeight));
            }
        }

        // Fallback: buscar en ítems individuales (por si el texto ancla es una sola palabra)
        for (const item of content.items) {
            if (item.str && item.str.toLowerCase().includes(lower)) {
                return Math.max(0, Math.min(1, 1 - item.transform[5] / pageHeight));
            }
        }
    } catch (e) {
        console.warn('[Anchor] Error buscando ancla:', e);
    }
    return null;
}

/**
 * OCR de una zona recortada de un canvas.
 * Igual que hace la ventana de entrenamiento — más fiable que filtrar por bbox.
 */
async function _ocrCrop(canvas, vp, normRect) {
    const zx = normRect.x * vp.width,  zy = normRect.y * vp.height;
    const zw = normRect.w * vp.width,  zh = normRect.h * vp.height;
    const crop = document.createElement('canvas');
    crop.width  = Math.max(1, Math.round(zw));
    crop.height = Math.max(1, Math.round(zh));
    crop.getContext('2d').drawImage(canvas, zx, zy, zw, zh, 0, 0, zw, zh);
    const { data } = await Tesseract.recognize(crop.toDataURL('image/png'), 'spa');
    return data.text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Normaliza texto para comparación robusta: sin acentos, sin puntuación, minúsculas. */
function _normalizeText(t) {
    return (t || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')  // eliminar diacríticos
        .replace(/[^a-z0-9\s]/g, ' ')            // quitar puntuación
        .replace(/\s+/g, ' ').trim();
}

/** Similitud de texto por palabras en común (normalizada). */
function _similarity(extracted, saved) {
    if (!extracted || !saved) return 0;
    const normSaved = _normalizeText(saved);
    const normExt   = _normalizeText(extracted);
    const words = normSaved.split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return 0;
    return words.filter(w => normExt.includes(w)).length / words.length;
}

/**
 * Extrae la "huella" de un texto OCR: palabras únicas y significativas.
 * Usada para comparar documentos similares en el sistema de aprendizaje.
 */
function _extractFingerprint(ocrText) {
    if (!ocrText) return [];
    const stopwords = new Set([
        'para', 'como', 'pero', 'este', 'esta', 'esto', 'esos', 'esas',
        'son', 'han', 'hay', 'ser', 'fue', 'era', 'tiene', 'puede', 'debe',
        'desde', 'hasta', 'entre', 'sobre', 'también', 'cuando', 'todo',
        'cada', 'donde', 'mismo', 'misma', 'otro', 'otra', 'todos', 'todas',
        'dicho', 'dicha', 'fecha', 'numero', 'número', 'total', 'importe'
    ]);
    return [...new Set(
        ocrText.toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')  // quitar tildes
            .replace(/[^a-z\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 4 && !stopwords.has(w))
    )].slice(0, 25);
}

/**
 * Aplica una transformación de texto al resultado OCR de una zona de renombrado.
 */
function _applyPartTransform(text, transform) {
    switch (transform) {
        case 'strip_zeros':   return text.replace(/\b0+(\d)/g, '$1');
        case 'upper':         return text.toUpperCase();
        case 'lower':         return text.toLowerCase();
        case 'replace_slash': return text.replace(/\//g, '-');
        case 'numbers_only':  return text.replace(/[^\d]/g, '');
        default:              return text;
    }
}

/**
 * Busca un dato en el texto completo de una página usando delimitadores de texto.
 * Primero intenta la capa de texto nativa del PDF; si no hay texto, hace OCR completo.
 * @param {Function} getCanvas  - función async (pageIndex) → { canvas, vp, page }
 * @param {number}   pageIndex  - 0-indexed
 * @param {string}   before     - texto que aparece ANTES del dato (obligatorio)
 * @param {string}   after      - texto que aparece DESPUÉS del dato (vacío = fin de línea)
 * @returns {Promise<string>}   - texto extraído o cadena vacía
 */
async function _searchTextByKeyword(getCanvas, pageIndex, before, after) {
    if (!before?.trim()) return '';

    const beforeLower = before.trim().toLowerCase();
    const afterLower  = after?.trim().toLowerCase() || '';

    let fullText = '';

    // 1. Intentar capa de texto nativa del PDF
    try {
        const pg      = await getCanvas(pageIndex);
        const content = await pg.page.getTextContent();
        // Reconstruir texto completo respetando saltos de línea por posición Y
        const lineMap = {};
        for (const item of content.items) {
            if (!item.str) continue;
            const yKey = Math.round(item.transform[5] / 5) * 5;
            if (!lineMap[yKey]) lineMap[yKey] = { rawY: item.transform[5], text: '' };
            lineMap[yKey].text += item.str + ' ';
        }
        fullText = Object.values(lineMap)
            .sort((a, b) => b.rawY - a.rawY)   // orden visual (top→bottom)
            .map(l => l.text.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
    } catch (_) {}

    // 2. Fallback: OCR de página completa (documentos escaneados sin capa de texto)
    if (!fullText.trim()) {
        try {
            const pg  = await getCanvas(pageIndex);
            const vp  = pg.page.getViewport({ scale: 2.5 });
            const cnv = document.createElement('canvas');
            cnv.width  = vp.width;  cnv.height = vp.height;
            await pg.page.render({ canvasContext: cnv.getContext('2d'), viewport: vp }).promise;
            const { data } = await Tesseract.recognize(cnv.toDataURL('image/png'), 'spa');
            fullText = data.text || '';
        } catch (_) { return ''; }
    }

    // 3. Buscar "before" en el texto y extraer lo que sigue
    const textLower = fullText.toLowerCase();
    const idx = textLower.indexOf(beforeLower);
    if (idx === -1) return '';

    const start = idx + beforeLower.length;
    const rest  = fullText.slice(start).replace(/^\s+/, '');   // quitar espacio inicial

    // Delimitar: hasta afterLower o hasta el fin de la línea
    let extracted = '';
    if (afterLower) {
        const endIdx = rest.toLowerCase().indexOf(afterLower);
        extracted = endIdx !== -1 ? rest.slice(0, endIdx) : rest.split(/\r?\n/)[0];
    } else {
        extracted = rest.split(/\r?\n/)[0];
    }

    return extracted.replace(/\s+/g, ' ').trim();
}

/**
 * Construye el nombre de archivo desde las partes de una plantilla.
 * Soporta el nuevo formato (renameParts) y el antiguo (rename.rect) para compatibilidad.
 */
async function _buildRenameText(getCanvas, tpl) {
    // Nuevo formato: array de partes
    if (Array.isArray(tpl.renameParts) && tpl.renameParts.length) {
        const segments = [];
        for (const part of tpl.renameParts) {
            if (part.type === 'text') {
                segments.push(part.value || '');
            } else if (part.type === 'text-search' && part.before) {
                // Buscar en las primeras páginas (normalmente la etiqueta está en la 1ª o 2ª)
                let text = '';
                for (let pi = 0; pi < 3; pi++) {
                    try {
                        text = await _searchTextByKeyword(getCanvas, pi, part.before, part.after || '');
                        if (text) break;
                    } catch (_) { break; }
                }
                text = _applyPartTransform(text, part.transform || 'none');
                segments.push(text);
            } else if (part.type === 'ocr' && part.rect) {
                const pg  = await getCanvas(part.page || 0);
                let rect  = part.rect;

                // ── Palabra ancla: ajustar zona si el layout se ha desplazado ──
                if (part.anchor?.text && part.anchor?.refY != null) {
                    const currentY = await _findAnchorY(pg.page, part.anchor.text);
                    if (currentY !== null) {
                        const deltaY = currentY - part.anchor.refY;
                        if (Math.abs(deltaY) > 0.005) { // ignorar ruido < 0.5%
                            rect = {
                                ...rect,
                                y: Math.max(0, Math.min(0.98 - rect.h, rect.y + deltaY))
                            };
                            console.log(`[Anchor] "${part.anchor.text}": desplazamiento ${(deltaY * 100).toFixed(1)}%`);
                        }
                    } else {
                        console.warn(`[Anchor] No encontrada: "${part.anchor.text}" — usando posición original`);
                    }
                }

                let text = await _ocrCrop(pg.canvas, pg.vp, rect);
                text = _applyPartTransform(text, part.transform || 'none');
                segments.push(text);
            }
        }
        return segments.join('').trim();
    }
    // Compatibilidad con plantillas antiguas (campo rename)
    if (tpl.rename?.rect) {
        const rn = await getCanvas(tpl.rename.page || 0);
        return await _ocrCrop(rn.canvas, rn.vp, tpl.rename.rect);
    }
    return '';
}

/**
 * Detección combinada: ML (Naive Bayes + TF-IDF) + Zonas OCR.
 *
 * Pipeline:
 *  1. ML clasifica el texto OCR → obtiene tipo + confianza
 *  2. Si ML tiene alta confianza y suficientes ejemplos → usa resultado ML
 *     (y aplica zonas OCR del template asociado para extraer el texto de renombrado)
 *  3. Si ML tiene confianza media → lo usa como hint para reducir candidatos en zonas
 *  4. Si ML falla o confianza baja → cae en detección pura por zonas OCR
 *  5. Si nada funciona → renombrado manual
 */
async function detectDocumentType(file, ocrText) {
    // ── Clasificación ML ──────────────────────────────────────────────────────
    let mlResult = null;
    try {
        mlResult = await window.electronAPI.mlClassify(ocrText || '');
    } catch (_) {}

    // ── Búsqueda del tipo de usuario por nombre ML ────────────────────────────
    let mlType = null;
    if (mlResult?.type && mlResult.docCount >= 5) {
        mlType = userDocTypes.find(t =>
            t.name.toLowerCase() === mlResult.type.toLowerCase()
        );
    }

    // ── Alta confianza ML (≥0.80) + suficientes ejemplos ─────────────────────
    if (mlType && mlResult.confidence >= 0.80 && mlResult.docCount >= 5) {
        let renameText = '', fromParts = false, templateId = null;
        if (_getTypeTemplateIds(mlType).length) {
            try {
                const r  = await extractRenameTextForType(file, mlType);
                renameText = r.text || '';
                fromParts  = r.fromParts || false;
                templateId = r.templateId || null;
            } catch (_) {}
        }
        // Fallback: patrones aprendidos de ejemplos manuales
        if (!renameText && ocrText) {
            renameText = await _extractByLearnedPattern(ocrText, mlType.name);
        }
        return {
            type: mlType, renameText, fromParts, templateId,
            confianza: 'high', source: 'ml',
            mlConfidence: mlResult.confidence,
        };
    }

    // ── Detección por zonas OCR (con hint ML como filtro) ────────────────────
    const zoneResult = await detectTypeByOcrZonal(file, mlType);
    if (zoneResult) {
        // Fallback: si las zonas detectaron el tipo pero no extrajeron rename text
        if (!zoneResult.renameText && ocrText) {
            zoneResult.renameText = await _extractByLearnedPattern(ocrText, zoneResult.type.name);
        }
        return { ...zoneResult, source: 'zones', mlConfidence: mlResult?.confidence };
    }

    // ── ML con confianza media como sugerencia ────────────────────────────────
    if (mlType && mlResult.confidence >= 0.50 && mlResult.docCount >= 3) {
        return {
            type: mlType, renameText: '', fromParts: false, templateId: null,
            confianza: 'medium', source: 'ml_hint',
            mlConfidence: mlResult.confidence,
        };
    }

    return null;
}

/**
 * Detecta el tipo de documento y extrae el texto de renombrado usando zonas visuales.
 * Itera TODOS los tipos y TODAS sus plantillas vinculadas → elige la mejor coincidencia global.
 * @param {object|null} mlHint - Tipo sugerido por ML (prioriza ese tipo si hay empate)
 */
async function detectTypeByOcrZonal(file, mlHint = null) {
    const typesWithTemplate = userDocTypes.filter(t => _getTypeTemplateIds(t).length > 0);
    if (!typesWithTemplate.length) return null;

    const allTemplates = await window.electronAPI.getOcrTemplates();
    if (!allTemplates?.length) return null;

    const tplMap = {};
    allTemplates.forEach(t => { tplMap[t.id] = t; });

    const getCanvas = await _loadPdfCanvases(file.path);
    if (!getCanvas) return null;

    let best = null, bestScore = 0;

    for (const type of typesWithTemplate) {
        const tplIds = _getTypeTemplateIds(type);

        for (const tplId of tplIds) {
            const tpl = tplMap[tplId];
            if (!tpl?.identification?.rect) continue;
            // Debe tener al menos un sistema de renombrado válido
            const hasRename = (Array.isArray(tpl.renameParts) && tpl.renameParts.length) || tpl.rename?.rect;
            if (!hasRename) continue;

            // Extraer y comparar zona de identificación
            const id    = await getCanvas(tpl.identification.page || 0);
            const idTxt = await _ocrCrop(id.canvas, id.vp, tpl.identification.rect);
            const score = _similarity(idTxt, tpl.identification.text);

            // Pequeño bonus si ML sugirió este mismo tipo (desempate)
            const adjustedScore = score + (mlHint && mlHint.id === type.id ? 0.02 : 0);

            if (score >= 0.6 && adjustedScore > bestScore) {
                const renameText = await _buildRenameText(getCanvas, tpl);
                bestScore = adjustedScore;
                best = {
                    type,
                    renameText,
                    fromParts:  Array.isArray(tpl.renameParts) && tpl.renameParts.length > 0,
                    templateId: tpl.id,
                    confianza:  score >= 0.85 ? 'high' : 'medium'
                };
            }
        }
    }

    return best;
}

/**
 * Extrae el texto de renombrado para un tipo concreto (modo tipo directo o ML de alta confianza).
 * Con una sola plantilla la usa directamente; con varias, compara zonas de identificación
 * y elige la que mejor encaje con el documento actual (ej: proveedor A vs proveedor B).
 * Siempre devuelve { text, fromParts, templateId }.
 */
async function extractRenameTextForType(file, type) {
    const tplIds = _getTypeTemplateIds(type);
    if (!tplIds.length) return { text: '', fromParts: false, templateId: null };

    const allTemplates = await window.electronAPI.getOcrTemplates();
    if (!allTemplates?.length) return { text: '', fromParts: false, templateId: null };

    const tplMap = {};
    allTemplates.forEach(t => { tplMap[t.id] = t; });

    const getCanvas = await _loadPdfCanvases(file.path);
    if (!getCanvas) return { text: '', fromParts: false, templateId: null };

    // ── Una sola plantilla: sin necesidad de comparar ────────────────────────
    if (tplIds.length === 1) {
        const tpl = tplMap[tplIds[0]];
        if (!tpl) return { text: '', fromParts: false, templateId: null };
        const text = await _buildRenameText(getCanvas, tpl);
        return { text, fromParts: Array.isArray(tpl.renameParts) && tpl.renameParts.length > 0, templateId: tpl.id };
    }

    // ── Varias plantillas: elegir la de mayor similitud en zona de identificación
    let bestTpl = null, bestScore = -1;

    for (const tplId of tplIds) {
        const tpl = tplMap[tplId];
        if (!tpl) continue;
        if (!tpl.identification?.rect) {
            // Sin zona de identificación: candidato de reserva (score 0) si ninguno puntúa más
            if (bestScore < 0) { bestTpl = tpl; bestScore = 0; }
            continue;
        }
        const id    = await getCanvas(tpl.identification.page || 0);
        const idTxt = await _ocrCrop(id.canvas, id.vp, tpl.identification.rect);
        const score = _similarity(idTxt, tpl.identification.text);
        if (score > bestScore) { bestScore = score; bestTpl = tpl; }
    }

    if (!bestTpl) return { text: '', fromParts: false, templateId: null };
    const text = await _buildRenameText(getCanvas, bestTpl);
    return {
        text,
        fromParts:  Array.isArray(bestTpl.renameParts) && bestTpl.renameParts.length > 0,
        templateId: bestTpl.id
    };
}

/**
 * Renombra y mueve un archivo usando un tipo concreto.
 * @param {string}  renameText - Texto extraído de la zona de renombrado
 * @param {boolean} fromParts  - true si el texto viene de un parts builder (el usuario controló el formato completo)
 */
async function processWithType(file, fileId, type, text, autoDetected, renameText, fromParts = false, templateId = null) {
    const targetFolder = type.folder || destinationFolder;
    if (!targetFolder) {
        updateFileStatus(fileId, `⚠️ "${type.name}" sin carpeta destino → renombrado manual`, 70);
        queueForManualRename(file, fileId, type.name, text, type);
        return;
    }

    // Generar nombre del archivo
    let newName = generateAdaptiveName(file.name, type, renameText, fromParts);

    updateFileStatus(fileId, 'Moviendo archivo...', 80);
    const result = await window.electronAPI.moveFile(file.path, targetFolder, newName, false);

    if (result.success) {
        updateFileStatus(fileId, `✅ ${newName}`, 100, 'success');
        processedFiles.add(file.path);
        fileCounter++;
        updateFileCounter();
        await saveToOCRIndex(result.newPath, newName, text, type.name);
        console.log(`✅ [${type.name}] ${newName}`);

        // 🧠 Aprendizaje ML
        try { await window.electronAPI.mlTrain(text, type.name); _mlStatsCache = null; } catch (_) {}
        // 🧠 Aprendizaje de patrón de renombrado (dónde está el número en el documento)
        if (text && renameText) {
            try {
                await window.electronAPI.learnRenamePattern(type.name, text, newName);
                _invalidatePatternCache(type.name);
            } catch (_) {}
        }
        if (templateId) {
            try { await window.electronAPI.incrementOcrConfirmations(templateId); } catch (_) {}
        }
    } else {
        throw new Error(result.error);
    }
}

/**
 * Genera el nombre adaptativo del archivo.
 * - fromParts=true : el usuario configuró el formato completo → usar renameText tal cual
 * - fromParts=false: zona OCR simple → prefijar con nombre del tipo (ej: "ENTRADA 001")
 * - Sin renameText  : fallback → nombre original + tipo
 */
function generateAdaptiveName(originalName, type, renameText, fromParts = false) {
    if (renameText && renameText.trim()) {
        const clean = renameText.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
        if (clean.length > 2) {
            // Con parts builder el usuario controla todo; sin parts, anteponemos el tipo
            if (fromParts) return `${clean}.pdf`;
            return `${type.name} ${clean}.pdf`;
        }
    }
    // Fallback: nombre original normalizado + tipo
    const base = originalName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '').trim();
    return `${base} ${type.name}.pdf`;
}

/**
 * Procesa un archivo detectado por watch folder.
 */
async function processWatchedFile(fileData) {
    const file   = { path: fileData.path, name: fileData.name };
    const fileId = `file-${Date.now()}-${Math.random()}`;
    file.fileId  = fileId;

    // Recargar tipos actualizados
    try { userDocTypes = await window.electronAPI.getDocTypes(); } catch (e) {}

    const list = document.getElementById('file-list');
    list.insertBefore(createFileItem(file, fileId), list.firstChild);
    processedFiles.add(file.path);

    try {
        updateFileStatus(fileId, 'Extrayendo texto...', 30);
        const text = await extractTextFromPDF(file);

        updateFileStatus(fileId, 'Detectando tipo...', 60);
        const matched = await detectDocumentType(file, text);

        const errorFolder = localStorage.getItem('watch-error-folder');

        // Solo auto-renombrar si: es experto Y (la detección vino de zona OCR O la confianza ML es suficiente)
        const expertAndConfident = matched?.confianza === 'high'
            && await _isExpertForType(matched.type.name)
            && (matched.source === 'zones' || (matched.mlConfidence || 0) >= 0.65);

        if (expertAndConfident) {
            // Experto confirmado → renombra automáticamente sin preguntar
            await processWithType(file, fileId, matched.type, text, true, matched.renameText, matched.fromParts, matched.templateId);
            _mlStatsCache = null; // Invalidar cache tras entrenamiento en carpeta vigilada
        } else if (matched?.confianza === 'high' || matched?.confianza === 'medium') {
            // Zilo detectó el tipo pero aún no es experto: mover a incidencias para revisión manual
            // Entrenar ML igualmente con la detección parcial para acelerar el aprendizaje
            try {
                await window.electronAPI.mlTrain(text, matched.type.name);
                _mlStatsCache = null;
            } catch (_) {}

            if (errorFolder) {
                const hint = `_REVISAR_${matched.type.name}`;
                const hintName = file.name.replace(/\.pdf$/i, `${hint}.pdf`);
                updateFileStatus(fileId, `💡 ${matched.type.name} — movido a revisión`, 80);
                await window.electronAPI.moveFile(file.path, errorFolder, hintName, false);
                updateFileStatus(fileId, `💡 Revisión pendiente → ${hintName}`, 100, 'skipped');
            } else {
                updateFileStatus(fileId, `💡 ${matched.type.name} — sin carpeta de revisión`, 100, 'skipped');
            }
        } else {
            if (errorFolder) {
                updateFileStatus(fileId, '⚠️ Sin detección → incidencias', 80);
                await window.electronAPI.moveFile(file.path, errorFolder, file.name, false);
                updateFileStatus(fileId, '⚠️ Movido a incidencias', 100, 'skipped');
            } else {
                updateFileStatus(fileId, '⚠️ Tipo no detectado', 100, 'skipped');
            }
        }
    } catch (err) {
        console.error('[WATCH] Error:', err);
        updateFileStatus(fileId, `❌ Error: ${err.message}`, 100, 'error');
    }
}

// =================================================================================
// COLA DE RENOMBRADO MANUAL
// =================================================================================

function setupManualRenameListeners() {
    window.electronAPI.onManualRenameConfirmed(async data => {
        await handleManualRenameConfirmed(data);
    });
    window.electronAPI.onManualRenameSkipped(() => handleManualRenameSkipped());
}

function queueForManualRename(file, fileId, detectedType, ocrText, suggestedType = null, suggestedFileName = null) {
    const label = suggestedFileName ? '💡 Confirmar sugerencia...' : '⏳ En cola de revisión...';
    updateFileStatus(fileId, label, 75);
    manualRenameQueue.push({ file, fileId, detectedType, ocrText, suggestedType, suggestedFileName });
    if (!currentManualFile) processNextManualRename();
}

async function processNextManualRename() {
    if (!manualRenameQueue.length) { currentManualFile = null; return; }
    const { file, fileId, detectedType, ocrText, suggestedType, suggestedFileName } = manualRenameQueue.shift();
    currentManualFile   = file;
    currentManualFileId = fileId;
    currentManualFile._suggestedType = suggestedType;

    // Cargar plantillas OCR para que la ventana pueda mostrar el formulario dinámico
    let templates = [];
    try { templates = await window.electronAPI.getOcrTemplates() || []; } catch (_) {}

    try {
        await window.electronAPI.openManualRenameWindow({
            fileName:          file.name,
            filePath:          file.path,
            detectedType:      detectedType || '',
            ocrText:           ocrText || '',
            currentMode:       'auto',
            docTypes:          userDocTypes,
            templates,
            suggestedFileName: suggestedFileName || '',
            queueCount:        manualRenameQueue.length + 1,
        });
    } catch (err) {
        // Si la ventana falla al abrirse, no bloquear la cola — saltar este archivo
        console.error('[Cola manual] Error al abrir ventana, saltando archivo:', file.name, err);
        updateFileStatus(fileId, '❌ Error al abrir ventana de revisión', 100, 'error');
        currentManualFile   = null;
        currentManualFileId = null;
        processNextManualRename();
    }
}

async function handleManualRenameConfirmed(data) {
    const file   = currentManualFile;
    const fileId = currentManualFileId;
    if (!file) return;

    try {
        // Buscar carpeta destino: prioridad → tipo seleccionado → folder de la data
        let targetFolder = data.destinationFolder || '';
        if (data.selectedTypeId) {
            const t = userDocTypes.find(x => x.id === parseInt(data.selectedTypeId));
            if (t?.folder) targetFolder = t.folder;
        }
        if (!targetFolder) {
            updateFileStatus(fileId, '⚠️ Sin carpeta destino — configúrala en Gestionar Tipos', 100, 'skipped');
            processedFiles.add(file.path);
            // Entrenar ML aunque no haya carpeta — el usuario confirmó el tipo, ese dato es valioso
            const ocrForML  = data.ocrText    || '';
            const typeForML = data.selectedType || '';
            if (ocrForML && typeForML) {
                try { await window.electronAPI.mlTrain(ocrForML, typeForML); _mlStatsCache = null; } catch (_) {}
            }
        } else {
            const result = await window.electronAPI.moveFile(file.path, targetFolder, data.newFileName, false);
            if (result.success) {
                updateFileStatus(fileId, `✅ ${data.newFileName}`, 100, 'success');
                processedFiles.add(file.path);
                fileCounter++;
                updateFileCounter();
                await saveToOCRIndex(result.newPath, data.newFileName, data.ocrText || '', data.selectedType || 'manual');

                // 🧠 Aprendizaje ML
                const ocrForML  = data.ocrText || '';
                const typeForML = data.selectedType || '';
                if (ocrForML && typeForML) {
                    try { await window.electronAPI.mlTrain(ocrForML, typeForML); _mlStatsCache = null; } catch (_) {}
                }
                // 🧠 Aprendizaje de patrón de renombrado (dónde está el número)
                if (ocrForML && typeForML && data.newFileName) {
                    try {
                        await window.electronAPI.learnRenamePattern(typeForML, ocrForML, data.newFileName);
                        _invalidatePatternCache(typeForML);
                    } catch (_) {}
                }
                if (data.templateId) {
                    try { await window.electronAPI.incrementOcrConfirmations(data.templateId); } catch (_) {}
                }
                // Registrar patrón pendiente para el panel OCR Zonal
                try {
                    const fp = _extractFingerprint(ocrForML);
                    if (fp.length >= 3) {
                        await window.electronAPI.addPendingPattern({
                            fingerprint: fp,
                            typeName:    typeForML,
                            typeId:      data.selectedTypeId ? parseInt(data.selectedTypeId) : null,
                            finalName:   data.newFileName,
                        });
                    }
                } catch (_) {}
            } else {
                updateFileStatus(fileId, `❌ ${result.error}`, 100, 'error');
            }
        }
    } catch (err) {
        updateFileStatus(fileId, `❌ Error: ${err.message}`, 100, 'error');
    }

    currentManualFile = null;
    processNextManualRename();
}

function handleManualRenameSkipped() {
    if (currentManualFileId) updateFileStatus(currentManualFileId, '↪️ Omitido', 100, 'skipped');
    currentManualFile = null;
    processNextManualRename();
}

// =================================================================================
// OCR — EXTRACCIÓN DE TEXTO
// =================================================================================

async function extractTextFromPDF(file) {
    const result = await window.electronAPI.readPdfFile(file.path);
    if (!result.success) throw new Error(result.error || 'Error al leer el PDF');

    const pdf          = await pdfjsLib.getDocument({ data: result.data }).promise;
    const totalPages   = pdf.numPages;
    const pagesToProc  = maxPagesToProcess === 0 ? totalPages : Math.min(totalPages, maxPagesToProcess);
    let   combinedText = '';

    for (let pageNum = 1; pageNum <= pagesToProc; pageNum++) {
        try {
            const page     = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 3.0 });
            const canvas   = document.createElement('canvas');
            canvas.width   = viewport.width;
            canvas.height  = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const { data } = await Tesseract.recognize(canvas.toDataURL('image/png'), 'spa');
            combinedText  += data.text + '\n';
        } catch (pageErr) {
            console.warn(`[OCR] Error en página ${pageNum}:`, pageErr.message);
            // Continuar con las demás páginas
        }
    }

    // Validar que se extrajo algo útil
    const meaningful = combinedText.replace(/\s+/g, '').length;
    if (meaningful < 10) {
        console.warn(`[OCR] Texto extraído insuficiente (${meaningful} chars) en "${file.name}" — PDF escaneado sin capa de texto?`);
    }

    return combinedText;
}

// =================================================================================
// ÍNDICE OCR
// =================================================================================

async function loadOCRIndex() {
    try {
        const result = await window.electronAPI.loadOCRIndex();
        if (result.success) ocrIndex = result.data || {};
    } catch (e) {}
}

async function saveToOCRIndex(filePath, fileName, text, docType) {
    try {
        ocrIndex[filePath] = { fileName, text, docType, timestamp: new Date().toISOString() };
        await window.electronAPI.saveOCRIndex(ocrIndex);
    } catch (e) {}
}

// =================================================================================
// UI — LISTA DE ARCHIVOS
// =================================================================================

function createFileItem(file, fileId) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.id        = fileId;
    item.innerHTML = `
        <div class="file-info">
            <span class="file-icon">📄</span>
            <div class="file-details">
                <span class="file-name">${file.name}</span>
                <span class="file-status">En cola...</span>
            </div>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
    `;
    return item;
}

function updateFileStatus(fileId, status, progress, type = '') {
    const item = document.getElementById(fileId);
    if (!item) return;
    const statusEl   = item.querySelector('.file-status');
    const progressEl = item.querySelector('.progress-fill');
    if (statusEl)   statusEl.textContent = status;
    if (progressEl) progressEl.style.width = `${progress}%`;
    if (type === 'success') item.classList.add('success');
    if (type === 'error')   item.classList.add('error');
    if (type === 'skipped') item.classList.add('skipped');
}

function updateFileCounter() {
    const el = document.getElementById('file-counter');
    if (el) el.textContent = `${fileCounter} archivo${fileCounter !== 1 ? 's' : ''}`;
}

// =================================================================================
// CARPETAS Y CANDADO
// =================================================================================

async function selectDestinationFolder() {
    const result = await window.electronAPI.selectFolder();
    if (result.success && result.folder) {
        destinationFolder = result.folder;
        document.getElementById('destination-folder').value = result.folder;
        if (currentDocType) {
            // Actualizar la carpeta del tipo en la BD
            await window.electronAPI.updateDocType(currentDocType.id, { ...currentDocType, folder: result.folder });
            currentDocType.folder = result.folder;
        }
        if (!foldersLocked) toggleLock('single');
    }
}

function toggleLock(type) {
    foldersLocked = !foldersLocked;
    const btn     = document.getElementById(`lock-${type}`);
    const browse  = document.getElementById(`browse-${type}`);
    if (btn)    btn.textContent = foldersLocked ? '🔒' : '🔓';
    if (browse) browse.disabled = foldersLocked;
    if (!foldersLocked) {
        if (lockTimeout) clearTimeout(lockTimeout);
        lockTimeout = setTimeout(() => toggleLock(type), 5000);
    } else {
        if (lockTimeout) clearTimeout(lockTimeout);
    }
}

function updateLockState() {
    const btn    = document.getElementById('lock-single');
    const browse = document.getElementById('browse-single');
    if (btn)    btn.textContent = foldersLocked ? '🔒' : '🔓';
    if (browse) browse.disabled = foldersLocked;
}

// =================================================================================
// TEMA
// =================================================================================

function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    document.getElementById('theme-icon').textContent = isDark ? '🌙' : '☀️';
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

// =================================================================================
// VENTANAS
// =================================================================================

async function showSearchModal() {
    try { await window.electronAPI.openSearchWindow(); } catch (e) { alert('Error al abrir búsqueda'); }
}

async function showSettingsModal() {
    try { await window.electronAPI.openSettingsWindow(); } catch (e) { alert('Error al abrir configuración'); }
}