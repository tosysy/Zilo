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
let currentManualOcrText = '';
let currentManualIsHistory  = false;   // corrección desde el historial
let currentManualHistoryPath = null;   // ruta original del archivo en el historial

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

// Umbral de confirmaciones para considerar EXPERTA a una plantilla (por proveedor)
const TEMPLATE_EXPERT_THRESHOLD = 10;
let _tplExpertCache = null;
function _invalidateTplCache() { _tplExpertCache = null; }
async function _getTemplatesCached() {
    if (!_tplExpertCache) {
        try { _tplExpertCache = await window.electronAPI.getOcrTemplates() || []; }
        catch (_) { _tplExpertCache = []; }
    }
    return _tplExpertCache;
}

/**
 * Zilo es "experto" en una PLANTILLA concreta (un proveedor) cuando esa plantilla
 * acumula ≥ TEMPLATE_EXPERT_THRESHOLD confirmaciones. El aprendizaje es por
 * plantilla, NO por tipo: ser experto en SANVICOR no implica serlo en BASTOS.
 */
async function _isExpertForTemplate(templateId) {
    if (!templateId) return false;
    const tpls = await _getTemplatesCached();
    const tpl  = tpls.find(t => t.id === templateId);
    const confirmations = tpl ? (tpl.confirmations || 0) : 0;
    return confirmations >= TEMPLATE_EXPERT_THRESHOLD;
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
    document.getElementById('btn-history').addEventListener('click', openHistoryModal);
    document.getElementById('history-close').addEventListener('click', () => { document.getElementById('history-overlay').style.display = 'none'; });
    document.getElementById('history-refresh').addEventListener('click', loadHistoryList);
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
        // Se permite procesar aunque NO haya tipos ni plantillas:
        // los documentos que no se reconozcan irán a la cola de revisión manual,
        // donde el usuario puede crear el tipo y la plantilla sobre la marcha.
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
        const { text, words } = await extractTextFromPDF(file);
        file._ocrWords = words;   // posiciones de palabra para alinear con precisión

        updateFileStatus(fileId, 'Analizando contenido...', 60);

        // ── Modo manual: siempre a la cola de renombrado ──────────────────────
        if (currentMode === 'manual') {
            queueForManualRename(file, fileId, null, text);
            return;
        }

        // ── Modo tipo directo ──────────────────────────────────────────────────
        if (currentMode === 'type' && currentDocType) {
            let renameText = '', fromParts = false, tplId = null;
            let dirOffset = null, dirRects = null;
            if (_getTypeTemplateIds(currentDocType).length) {
                updateFileStatus(fileId, 'Extrayendo nombre...', 55);
                const r = await extractRenameTextForType(file, currentDocType, text);
                renameText = r.text || '';
                fromParts  = r.fromParts || false;
                tplId      = r.templateId || null;
                dirOffset  = r.zoneOffset || null;
                dirRects   = r.partFinalRects || null;
            }
            // Fallback: patrones aprendidos si no hay template OCR configurado
            if (!renameText && text) {
                renameText = await _extractByLearnedPattern(text, currentDocType.name);
            }
            // Experto POR PLANTILLA (no por tipo): cada proveedor aprende por separado
            const expert = await _isExpertForTemplate(tplId);
            if (expert) {
                await processWithType(file, fileId, currentDocType, text, false, renameText, fromParts, tplId);
            } else {
                const suggested = generateAdaptiveName(file.name, currentDocType, renameText, fromParts);
                updateFileStatus(fileId, `💡 Confirmar: ${suggested}`, 70);
                queueForManualRename(file, fileId, currentDocType.name, text, currentDocType, suggested, tplId, dirOffset, dirRects);
            }
            return;
        }

        // ── Modo automático: detectar tipo vía OCR Zonal ──────────────────────
        if (currentMode === 'auto') {
            updateFileStatus(fileId, 'Detectando tipo...', 60);
            const matched = await detectDocumentType(file, text);
            if (matched && matched.confianza === 'high') {
                // Experto POR PLANTILLA del proveedor concreto detectado
                const expert = await _isExpertForTemplate(matched.templateId);
                if (expert) {
                    const src = matched.source === 'ml' ? `🤖 ML ${Math.round((matched.mlConfidence||0)*100)}%` : '🎯 Zonas';
                    updateFileStatus(fileId, `${src} — procesando...`, 65);
                    await processWithType(file, fileId, matched.type, text, true, matched.renameText, matched.fromParts, matched.templateId);
                } else {
                    const suggested = generateAdaptiveName(file.name, matched.type, matched.renameText, matched.fromParts);
                    updateFileStatus(fileId, `💡 ${matched.type.name} — confirmar...`, 70);
                    queueForManualRename(file, fileId, matched.type.name, text, matched.type, suggested, matched.templateId, matched.zoneOffset, matched.partFinalRects);
                }
            } else if (matched && matched.confianza === 'medium') {
                const suggested = matched.renameText
                    ? generateAdaptiveName(file.name, matched.type, matched.renameText, matched.fromParts)
                    : null;
                updateFileStatus(fileId, `🟡 Posible: ${matched.type.name} — confirmar...`, 70);
                queueForManualRename(file, fileId, matched.type.name, text, matched.type, suggested, matched.templateId, matched.zoneOffset, matched.partFinalRects);
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
        // Auto-enderezar el escaneo para que las zonas encajen con los datos
        const straight = _autoDeskew(c, null);
        cache[pageIndex] = { canvas: straight, vp, page }; // 'page' necesario para getTextContent()
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

// =================================================================================
// AUTO-ENDEREZADO DE ESCANEOS (corrección de inclinación)
// =================================================================================

/**
 * Detecta el ángulo de inclinación de un documento por "perfil de proyección":
 * el ángulo que alinea mejor las líneas de texto en horizontal.
 * @returns {number} grados (positivo = horario), 0 si no hay inclinación clara.
 */
function _detectSkewAngle(srcCanvas) {
    try {
        const targetW = 500;
        const scale = Math.min(1, targetW / srcCanvas.width);
        const w = Math.max(1, Math.round(srcCanvas.width * scale));
        const h = Math.max(1, Math.round(srcCanvas.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(srcCanvas, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;

        // Binarizar: píxel oscuro (texto) = 1
        const dark = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const g = 0.299 * px[i*4] + 0.587 * px[i*4+1] + 0.114 * px[i*4+2];
            dark[i] = g < 140 ? 1 : 0;
        }

        const cx = w / 2;
        const variance = (angleDeg) => {
            const tan = Math.tan(angleDeg * Math.PI / 180);
            const proj = new Float64Array(h);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (dark[y * w + x]) {
                        const ny = Math.round(y + (x - cx) * tan);
                        if (ny >= 0 && ny < h) proj[ny]++;
                    }
                }
            }
            let mean = 0; for (let y = 0; y < h; y++) mean += proj[y]; mean /= h;
            let v = 0; for (let y = 0; y < h; y++) { const d = proj[y] - mean; v += d * d; }
            return v;
        };

        const base = variance(0);
        let bestAngle = 0, bestScore = base;
        for (let a = -8; a <= 8; a += 0.5) {
            if (a === 0) continue;
            const v = variance(a);
            if (v > bestScore) { bestScore = v; bestAngle = a; }
        }
        // Solo si la mejora es clara (>12%) y el ángulo es significativo
        if (bestAngle !== 0 && Math.abs(bestAngle) >= 0.5 && bestScore > base * 1.12) {
            return bestAngle;
        }
    } catch (_) {}
    return 0;
}

/** Rota un canvas para corregir la inclinación detectada. */
function _deskewCanvas(srcCanvas, angleDeg) {
    if (!angleDeg || Math.abs(angleDeg) < 0.5) return srcCanvas;
    const w = srcCanvas.width, h = srcCanvas.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-angleDeg * Math.PI / 180);   // corregir = girar al revés
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(srcCanvas, 0, 0);
    return c;
}

/** Detecta y corrige la inclinación de un canvas (si la hay). */
function _autoDeskew(srcCanvas, logName) {
    const angle = _detectSkewAngle(srcCanvas);
    if (angle) {
        try { window.electronAPI.logToCmd(`📐 Documento${logName ? ' "'+logName+'"' : ''} inclinado ${angle.toFixed(1)}° → lo enderezo antes de leer las zonas.`); } catch (_) {}
        return _deskewCanvas(srcCanvas, angle);
    }
    return srcCanvas;
}

/**
 * OCR de una zona recortada de un canvas.
 * Igual que hace la ventana de entrenamiento — más fiable que filtrar por bbox.
 */
async function _ocrCrop(canvas, vp, normRect) {
    return _ocrCropSmart(canvas, vp, normRect, {});
}

// Worker de Tesseract para OCR numérico (solo dígitos) — reutilizable
let _numOcrWorker = null;
let _numOcrWorkerPromise = null;
async function _getNumOcrWorker() {
    if (_numOcrWorker) return _numOcrWorker;
    if (_numOcrWorkerPromise) return _numOcrWorkerPromise;
    _numOcrWorkerPromise = (async () => {
        const w = await Tesseract.createWorker('eng');   // 'eng' acierta más con dígitos
        await w.setParameters({
            tessedit_char_whitelist: '0123456789-/.',
            tessedit_pageseg_mode: '7',                   // tratar como una sola línea
        });
        _numOcrWorker = w;
        return w;
    })();
    return _numOcrWorkerPromise;
}

/**
 * Recorta una zona, la PREPROCESA (escala + gris + umbral) y hace OCR.
 * Con opts.numeric=true usa un OCR restringido a dígitos (mucho más fiable
 * para números de albarán/pedido).
 */
async function _ocrCropSmart(canvas, vp, normRect, opts = {}) {
    const zx = normRect.x * vp.width,  zy = normRect.y * vp.height;
    const zw = normRect.w * vp.width,  zh = normRect.h * vp.height;

    // Upscale ×2 sobre el canvas (que ya está a 3x) → texto pequeño más legible
    const SCALE = 2;
    const cw = Math.max(1, Math.round(zw * SCALE));
    const ch = Math.max(1, Math.round(zh * SCALE));
    const crop = document.createElement('canvas');
    crop.width = cw; crop.height = ch;
    const ctx = crop.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, zx, zy, zw, zh, 0, 0, cw, ch);

    // Escala de grises + umbral (binariza) → limpia ruido del escaneo
    try {
        const img = ctx.getImageData(0, 0, cw, ch);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = g > 145 ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
    } catch (_) {}

    const url = crop.toDataURL('image/png');

    if (opts.numeric) {
        try {
            const w = await _getNumOcrWorker();
            const { data } = await w.recognize(url);
            const t = (data.text || '').replace(/\s+/g, ' ').trim();
            if (t) return t;
        } catch (_) {}
    }

    const { data } = await Tesseract.recognize(url, 'spa');
    return (data.text || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Clave ESTABLE de una parte OCR. Debe ser idéntica al grabar una corrección y al
 * leer la zona aprendida; si no, las correcciones se guardan con una clave y se
 * leen con otra (bug histórico "undefined" vs "part") y nunca se aplican.
 * Las plantillas garantizan `part.id` (db.js asigna ids a las antiguas).
 */
function partKey(part) {
    if (!part) return 'part';
    if (part.id != null && part.id !== '') return String(part.id);
    if (part.label) return String(part.label);
    return 'part';
}

/** ¿La parte busca un valor numérico? (para activar OCR de solo dígitos) */
function _partIsNumeric(part) {
    if (!part) return false;
    if (part.transform === 'numbers_only' || part.transform === 'strip_zeros') return true;
    const lbl = (part.label || '').toLowerCase();
    return /n[uú]m|numero|pedido|albar|factura|ref|c[oó]digo|importe|nif|cif/.test(lbl);
}

// =================================================================================
// APRENDIZAJE ADAPTATIVO DE POSICIONES OCR
// =================================================================================

/**
 * Busca un texto en la capa de texto nativa del PDF y devuelve su bounding-box
 * normalizada (0-1). Para PDFs digitales es exacta; para escaneados, null.
 *
 * @param {PDFPageProxy} pdfPage
 * @param {string} targetText  - texto a buscar (≥3 chars)
 * @returns {Promise<{x,y,w,h}|null>}
 */
async function _findTextPositionInPage(pdfPage, targetText) {
    if (!targetText?.trim() || targetText.trim().length < 3) return null;
    try {
        const content = await pdfPage.getTextContent();
        const vp      = pdfPage.getViewport({ scale: 1 });
        const pw      = vp.viewBox ? vp.viewBox[2] : vp.width  / (vp.scale || 1);
        const ph      = vp.viewBox ? vp.viewBox[3] : vp.height / (vp.scale || 1);
        const target  = _normalizeText(targetText).slice(0, 60);

        // Agrupar ítems por línea (tolerancia ±3 puntos PDF)
        const lineMap = {};
        for (const item of content.items) {
            if (!item.str?.trim()) continue;
            const yKey = Math.round(item.transform[5] / 3) * 3;
            if (!lineMap[yKey]) lineMap[yKey] = { rawY: item.transform[5], items: [] };
            lineMap[yKey].items.push(item);
        }

        for (const line of Object.values(lineMap)) {
            const lineNorm = _normalizeText(line.items.map(i => i.str).join(' '));
            if (!lineNorm.includes(target)) continue;

            // Ítem específico que contiene el texto buscado
            const hit = line.items.find(i => _normalizeText(i.str).includes(target))
                      || line.items[0];

            const rx = hit.transform[4];
            const ry = hit.transform[5];
            const rw = hit.width || Math.min(pw * 0.25, 100);
            const rh = Math.abs(hit.transform[3]) || 12;

            return {
                x: Math.max(0, Math.min(0.98, rx / pw)),
                y: Math.max(0, Math.min(0.98, 1 - (ry + rh) / ph)),
                w: Math.max(0.02, Math.min(0.9,  rw / pw)),
                h: Math.max(0.01, Math.min(0.5,  rh / ph)),
            };
        }
    } catch (e) {
        console.warn('[PosLearn] _findTextPositionInPage:', e.message);
    }
    return null;
}

/**
 * Registra asincrónicamente la posición donde se encontró texto.
 * Prioriza la posición de la capa de texto (más precisa) sobre la zona OCR usada.
 *
 * @param {string}         templateId
 * @param {object}         part       - parte OCR del template
 * @param {object}         pg         - { canvas, vp, page }
 * @param {{x,y,w,h}}      usedRect   - zona que produjo el resultado
 * @param {string}         foundText  - texto extraído
 * @param {string}         source     - 'ocr' | 'adaptive'
 */
function _recordPositionAsync(templateId, part, pg, usedRect, foundText, source) {
    if (!templateId || !part) return;
    (async () => {
        try {
            let rect       = usedRect;
            let finalSource = source;

            // Intentar posición exacta de la capa de texto (más precisa)
            if (foundText?.trim().length >= 3 && pg?.page) {
                const textPos = await _findTextPositionInPage(pg.page, foundText.trim());
                if (textPos) {
                    rect        = textPos;
                    finalSource = 'text_layer';
                }
            }

            await window.electronAPI.recordPartPosition({
                templateId,
                partLabel: partKey(part),
                page:      part.page  || 0,
                rect,
                source:    finalSource,
            });
        } catch (e) {
            console.warn('[PosLearn] Error al registrar posición:', e.message);
        }
    })();
}

/**
 * Versión de _ocrCrop con aprendizaje de posición y cascada de extracción:
 *
 *  1. Zona original (o ancla-ajustada)
 *  2. Zona adaptativa aprendida (si hay ≥3 confirmaciones y es distinta)
 *  3. Búsqueda en capa de texto nativa (si ninguna zona produjo texto)
 *
 * Registra automáticamente la posición que funcionó.
 *
 * @param {object} pg       - { canvas, vp, page }
 * @param {{x,y,w,h}} rect  - zona original (posiblemente ajustada por ancla)
 * @param {object} tpl      - plantilla completa (necesitamos tpl.id)
 * @param {object} part     - parte OCR (necesitamos part.label, part.page)
 * @returns {Promise<string>}
 */
/**
 * Puntúa si un texto extraído es el DATO buscado o una etiqueta/ruido.
 * Penaliza etiquetas ("Nº ALBARAN", "FECHA"…). Premia números si numeric.
 */
function _scoreCandidate(txt, numeric) {
    if (!txt || !txt.trim()) return -1;

    // Rechazar BASURA de OCR: cadenas dominadas por símbolos raros (=.·.¡—Í.'='·)
    // no son ni un número ni un dato válido → puntuación negativa para descartarlas.
    const noSpace = txt.replace(/\s/g, '');
    if (noSpace.length) {
        const alnum  = (noSpace.match(/[a-zA-Z0-9]/g) || []).length;
        const symbol = noSpace.length - alnum;
        if (alnum === 0) return -1;
        if (symbol / noSpace.length > 0.4) return -1;   // más de 40% símbolos = ruido
    }

    const t = _normalizeText(txt);
    const labels = ['albaran','numero','num','fecha','codigo','cliente','pedido',
                    'referencia','descripcion','pagina','copia','cantidad','precio',
                    'importe','total','iva','base','forma','pago','direccion'];
    const isLabel = labels.some(l => t.includes(l));
    if (numeric) {
        const digits = (txt.match(/\d/g) || []).length;
        const letters = (txt.match(/[a-zA-Z]/g) || []).length;
        if (digits < 2) return isLabel ? 0 : 0.1;
        // muchos dígitos y pocas letras = buen número; etiqueta penaliza
        let s = 1 + Math.min(digits, 10) * 0.05 - letters * 0.05;
        if (isLabel) s -= 0.6;
        return s;
    }
    if (isLabel) return 0.2;
    return 0.5 + Math.min(1, txt.trim().length / 12);
}

/**
 * Búsqueda LOCAL: si el recuadro cae sobre la etiqueta y no sobre el dato,
 * prueba a desplazarlo por los alrededores (abajo, arriba, lados) y se queda
 * con la variante que mejor encaja con lo buscado (un número, normalmente).
 * @returns {{ text, rect, score }}
 */
async function _localZoneSearch(pg, rect, numeric) {
    const dh = rect.h, dw = rect.w;
    const offsets = [
        { dx: 0,        dy: 0 },
        { dx: 0,        dy: dh * 0.9 },   // justo debajo (cabecera → valor)
        { dx: 0,        dy: dh * 1.7 },
        { dx: 0,        dy: -dh * 0.9 },  // justo encima
        { dx: dw * 0.6, dy: dh * 0.9 },
        { dx: -dw * 0.6, dy: dh * 0.9 },
        { dx: dw * 0.6, dy: 0 },
        { dx: -dw * 0.6, dy: 0 },
        { dx: 0,        dy: dh * 0.45 },
    ];
    let best = { text: '', rect, score: -1 };
    for (const o of offsets) {
        const r = {
            x: Math.max(0, Math.min(0.98 - dw, rect.x + o.dx)),
            y: Math.max(0, Math.min(0.98 - dh, rect.y + o.dy)),
            w: dw, h: dh,
        };
        const txt = await _ocrCropSmart(pg.canvas, pg.vp, r, { numeric });
        const sc  = _scoreCandidate(txt, numeric);
        if (sc > best.score) best = { text: txt, rect: r, score: sc };
        if (sc >= 1.2) break;   // ya es claramente un buen número
    }
    return best;
}

async function _ocrCropWithLearning(pg, rect, tpl, part) {
    const templateId = tpl?.id;
    const partLabel  = partKey(part);
    const page       = part.page  || 0;
    const numeric    = _partIsNumeric(part);   // OCR de solo dígitos si es un número

    // ── 0. ¿Hay una corrección del usuario para esta parte? Tiene prioridad ────
    // Si el usuario ya marcó dónde está el dato, usamos ESA zona SIEMPRE,
    // por encima de la zona original (que puede estar leyendo el campo equivocado).
    if (templateId) {
        try {
            const learned = await window.electronAPI.getAdaptiveZone({
                templateId, partLabel, page, originalRect: rect,
            });
            if (learned && learned.userConfirmed) {
                const textU = await _ocrCropSmart(pg.canvas, pg.vp, learned, { numeric });
                if (textU.trim()) {
                    window.electronAPI.logToCmd(`✏️  CAMPO "${partLabel}": uso la zona que TÚ corregiste (${learned.confidence} corrección/es). Ya no leo del campo equivocado de antes. Leído: "${textU.slice(0,30)}"`);
                    _recordPositionAsync(templateId, part, pg, learned, textU, 'adaptive');
                    return textU;
                }
            }
        } catch (_) {}
    }

    // ── 1. Zona original ──────────────────────────────────────────────────────
    const text1 = await _ocrCropSmart(pg.canvas, pg.vp, rect, { numeric });
    const score1 = _scoreCandidate(text1, numeric);

    // Si el recuadro lee bien el dato (buena puntuación), usarlo
    if (score1 >= 1) {
        _recordPositionAsync(templateId, part, pg, rect, text1, 'ocr');
        return text1;
    }

    // ── 1b. Búsqueda LOCAL: el recuadro cayó sobre la etiqueta o ruido →
    //        desplazarlo por los alrededores hasta encontrar el dato ──────────
    if (numeric || score1 < 0.3) {
        // Primero: ¿ya aprendí dónde está (de búsquedas anteriores)? → 1 lectura
        if (templateId) {
            try {
                const adaptive = await window.electronAPI.getAdaptiveZone({ templateId, partLabel, page, originalRect: rect });
                if (adaptive && adaptive.confidence >= 2) {
                    const txtA = await _ocrCropSmart(pg.canvas, pg.vp, adaptive, { numeric });
                    if (_scoreCandidate(txtA, numeric) >= 1) {
                        _recordPositionAsync(templateId, part, pg, adaptive, txtA, 'adaptive');
                        return txtA;
                    }
                }
            } catch (_) {}
        }
        // Si no, búsqueda local completa por los alrededores
        try {
            const found = await _localZoneSearch(pg, rect, numeric);
            if (found.score > score1 && found.score >= 0.8 && found.text.trim()) {
                const moved = (Math.abs(found.rect.x - rect.x) + Math.abs(found.rect.y - rect.y));
                window.electronAPI.logToCmd(`🔀 CAMPO "${partLabel}": el recuadro caía sobre la etiqueta; lo desplacé ${(moved*100).toFixed(0)}% y encontré el dato: "${found.text.slice(0,30)}"`);
                _recordPositionAsync(templateId, part, pg, found.rect, found.text, 'ocr');
                return found.text;
            }
        } catch (_) {}
    }

    // Si la original dio algo (aunque flojo) y la búsqueda no mejoró, usarlo
    if (text1.trim() && score1 > 0.1) {
        _recordPositionAsync(templateId, part, pg, rect, text1, 'ocr');
        return text1;
    }

    // ── 2. Zona adaptativa aprendida (auto, sin corrección explícita) ─────────
    if (templateId) {
        try {
            const adaptive = await window.electronAPI.getAdaptiveZone({
                templateId, partLabel, page, originalRect: rect,
            });

            if (adaptive && adaptive.confidence >= 3) {
                const drift = Math.abs(adaptive.centerX - (rect.x + rect.w / 2))
                            + Math.abs(adaptive.centerY - (rect.y + rect.h / 2));

                if (drift > 0.02) {
                    const text2 = await _ocrCropSmart(pg.canvas, pg.vp, adaptive, { numeric });
                    if (text2.trim()) {
                        console.log(
                            `[AdaptZone] "${partLabel}": zona aprendida usada` +
                            ` (conf:${adaptive.confidence}, drift:${(drift * 100).toFixed(1)}%` +
                            `, spread:±${(adaptive.spreadY * 100).toFixed(1)}%↕)`
                        );
                        _recordPositionAsync(templateId, part, pg, adaptive, text2, 'adaptive');
                        return text2;
                    }
                }
            }
        } catch (_) {}
    }

    // ── 3. Capa de texto nativa (PDFs digitales sin texto en la zona dibujada) ─
    if (pg?.page) {
        try {
            const content = await pg.page.getTextContent();
            const vp      = pg.page.getViewport({ scale: 1 });
            const pw      = vp.viewBox ? vp.viewBox[2] : vp.width  / (vp.scale || 1);
            const ph      = vp.viewBox ? vp.viewBox[3] : vp.height / (vp.scale || 1);

            // Buscar ítems de texto que estén dentro de la zona original expandida ×1.5
            const ex = Math.max(0, rect.x - rect.w * 0.25);
            const ey = Math.max(0, rect.y - rect.h * 0.25);
            const ew = Math.min(1 - ex, rect.w * 1.5);
            const eh = Math.min(1 - ey, rect.h * 1.5);

            const candidates = [];
            for (const item of content.items) {
                if (!item.str?.trim()) continue;
                const nx = item.transform[4] / pw;
                const ny = 1 - item.transform[5] / ph;
                if (nx >= ex && nx <= ex + ew && ny >= ey && ny <= ey + eh) {
                    candidates.push(item.str.trim());
                }
            }

            if (candidates.length) {
                const text3 = candidates.join(' ').replace(/\s+/g, ' ').trim();
                if (text3) {
                    console.log(`[TextLayer] "${partLabel}": encontrado en capa de texto`);
                    // Registrar posición del primer ítem encontrado
                    _recordPositionAsync(templateId, part, pg,
                        { x: ex, y: ey, w: ew, h: eh }, text3, 'text_layer');
                    return text3;
                }
            }
        } catch (_) {}
    }

    return ''; // Todas las estrategias fallaron
}

/**
 * Registra posiciones de partes OCR a partir de la capa de texto del PDF,
 * usando los valores que el usuario confirmó manualmente.
 * Solo requiere el PDF y los valores confirmados — no hace OCR.
 *
 * @param {string}   filePath        - ruta del PDF
 * @param {string}   templateId
 * @param {object[]} parts           - renameParts de la plantilla
 * @param {object}   confirmedValues - { partLabel: confirmedText }
 */
async function _recordPositionsFromConfirmedValues(filePath, templateId, parts, confirmedValues) {
    if (!templateId || !parts?.length || !filePath) return;
    try {
        const result = await window.electronAPI.readPdfFile(filePath);
        if (!result.success) return;
        const pdf = await pdfjsLib.getDocument({ data: result.data }).promise;

        for (const part of parts) {
            if (part.type !== 'ocr') continue;
            const label = partKey(part);
            const value = confirmedValues[label] || confirmedValues[part.id] || confirmedValues[part.label] || '';
            if (!value?.trim() || value.trim().length < 3) continue;

            try {
                const page = await pdf.getPage((part.page || 0) + 1);
                const pos  = await _findTextPositionInPage(page, value.trim());
                if (pos) {
                    window.electronAPI.recordPartPosition({
                        templateId,
                        partLabel: label,
                        page:      part.page || 0,
                        rect:      pos,
                        source:    'text_layer_manual',
                    }).catch(() => {});
                }
            } catch (_) {}
        }
    } catch (e) {
        console.warn('[PosLearn] _recordPositionsFromConfirmedValues:', e.message);
    }
}

/** Normaliza texto para comparación robusta: sin acentos, sin puntuación, minúsculas. */
function _normalizeText(t) {
    return (t || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')  // eliminar diacríticos
        .replace(/[^a-z0-9\s]/g, ' ')            // quitar puntuación
        .replace(/\s+/g, ' ').trim();
}

/** Extrae secuencias de dígitos largas (CIF, NIF, nº de cuenta…) de un texto. */
function _extractDigitRuns(t) {
    const digits = (t || '').replace(/[^0-9]/g, ' ').split(/\s+/).filter(d => d.length >= 6);
    // También la concatenación de todos los dígitos (por si el CIF sale partido)
    const allDigits = (t || '').replace(/[^0-9]/g, '');
    if (allDigits.length >= 7) digits.push(allDigits);
    return [...new Set(digits)];
}

/**
 * Similitud entre el texto extraído de la zona de identificación y el guardado.
 * Combina coincidencia de palabras + coincidencia FUERTE de CIF/NIF (dígitos).
 * Un CIF que coincide es una señal casi definitiva del proveedor correcto.
 */
function _similarity(extracted, saved) {
    if (!extracted || !saved) return 0;
    const normSaved = _normalizeText(saved);
    const normExt   = _normalizeText(extracted);

    // 1. Coincidencia de palabras (la base)
    const words = normSaved.split(/\s+/).filter(w => w.length > 2);
    const wordScore = words.length
        ? words.filter(w => normExt.includes(w)).length / words.length
        : 0;

    // 2. Coincidencia de CIF/NIF (secuencias de dígitos largas)
    const savedDigits = _extractDigitRuns(saved);
    const extDigitsStr = (extracted || '').replace(/[^0-9]/g, '');
    let digitMatch = false;
    for (const d of savedDigits) {
        if (d.length >= 6 && extDigitsStr.includes(d)) { digitMatch = true; break; }
    }

    // Si el CIF coincide → señal muy fuerte (mínimo 0.9, sumado al de palabras)
    if (digitMatch) return Math.min(1, Math.max(0.9, wordScore + 0.5));

    return wordScore;
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
/**
 * Busca un valor en el texto OCR completo usando la etiqueta del campo como
 * referencia. Inmune a inclinación/desplazamiento del escaneo, porque encuentra
 * el dato por CONTENIDO, no por posición.
 *
 * @param {string} fullText - texto OCR completo del documento
 * @param {string} label    - etiqueta del campo (ej: "Nº Albarán")
 * @param {boolean} numeric - si el valor esperado es un número
 */
function _findValueByLabelInText(fullText, label, numeric) {
    if (!fullText || !label) return '';
    const txt = fullText.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    // Palabra clave: la más significativa de la etiqueta
    const stop = ['numero', 'num', 'dato', 'campo', 'valor', 'del', 'los', 'las'];
    const words = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .split(/\s+/).filter(w => w.length >= 4 && !stop.includes(w));
    const keyword = words[words.length - 1] || label.toLowerCase().trim();
    if (keyword.length < 3) return '';

    const idx = txt.indexOf(keyword);
    if (idx === -1) return '';

    const after = txt.slice(idx + keyword.length, idx + keyword.length + 50);
    if (numeric) {
        const m = after.match(/[0-9][0-9.\-\/ ]{0,15}[0-9]/);
        if (m) return m[0].replace(/\s/g, '');
    }
    const w = after.replace(/^[\s:.\-\/]+/, '').split(/\s+/)[0];
    return w || '';
}

/** Cuántos dígitos de `exp` aparecen en orden dentro de `act` (0-1). */
function _digitSubseqScore(exp, act) {
    if (!exp || !act) return 0;
    if (act.includes(exp)) return 1;
    let matches = 0, j = 0;
    for (let i = 0; i < act.length && j < exp.length; i++) {
        if (act[i] === exp[j]) { matches++; j++; }
    }
    return matches / exp.length;
}

/**
 * REGISTRO GLOBAL por el NIF: localiza dónde está realmente el CIF de la
 * plantilla buscándolo alrededor de la zona de identificación, y calcula el
 * desplazamiento (dx, dy) del documento. Ese mismo desplazamiento se aplica a
 * TODOS los recuadros OCR para que queden alineados.
 *
 * @returns {{dx, dy, confident, score}}
 */
async function _findIdZoneOffset(pg, idRect, expectedDigitsList) {
    if (!idRect || !expectedDigitsList?.length) return { dx: 0, dy: 0, confident: false, score: 0 };
    const exps = expectedDigitsList.filter(d => d && d.length >= 7);
    if (!exps.length) return { dx: 0, dy: 0, confident: false, score: 0 };

    const dh = idRect.h, dw = idRect.w;
    const ySteps = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8];
    const xSteps = [0, 0.5, -0.5, 1, -1];

    let best = { dx: 0, dy: 0, score: 0, found: '' };
    let done = false;
    for (const sy of ySteps) {
        if (done) break;
        for (const sx of xSteps) {
            const r = {
                x: Math.max(0, Math.min(0.98 - dw, idRect.x + sx * dw)),
                y: Math.max(0, Math.min(0.98 - dh, idRect.y + sy * dh)),
                w: dw, h: dh,
            };
            const txt = await _ocrCropSmart(pg.canvas, pg.vp, r, { numeric: true });
            const d   = txt.replace(/[^0-9]/g, '');
            if (d.length < 5) continue;
            let sim = 0;
            for (const e of exps) sim = Math.max(sim, _digitSubseqScore(e, d));
            if (sim > best.score) {
                best = { dx: r.x - idRect.x, dy: r.y - idRect.y, score: sim, found: txt };
                if (sim >= 0.99) { done = true; break; }
            }
        }
    }
    return { ...best, confident: best.score >= 0.85 };
}

/**
 * Offset PRECISO a partir de las posiciones de palabra del OCR de página completa.
 * Localiza el CIF/teléfono esperado (uniendo palabras contiguas si el número viene
 * partido) y calcula cuánto se ha desplazado respecto a la zona de identificación.
 * Mucho más fiable que la rejilla ciega `_findIdZoneOffset` en escaneos.
 * @returns {{ dx, dy, confident, score }}
 */
function _findOffsetFromWords(pageWords, idRect, expectedDigits) {
    const none = { dx: 0, dy: 0, confident: false, score: 0 };
    if (!pageWords?.length || !idRect) return none;
    const exps = (expectedDigits || []).filter(d => d && d.length >= 7);
    if (!exps.length) return none;

    const words = pageWords
        .map(w => ({ ...w, digits: (w.text || '').replace(/[^0-9]/g, '') }))
        .filter(w => w.digits.length >= 1)
        .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));

    let best = { score: 0, cx: 0, cy: 0 };
    const consider = (digits, cx, cy) => {
        if (digits.length < 5) return;
        let s = 0;
        for (const e of exps) s = Math.max(s, _digitSubseqScore(e, digits));
        if (s > best.score) best = { score: s, cx, cy };
    };

    for (let i = 0; i < words.length; i++) {
        consider(words[i].digits, words[i].cx, words[i].cy);
        // Unir hasta 3 palabras contiguas de la misma línea (números partidos)
        let digits = words[i].digits;
        let minx = words[i].cx - words[i].w / 2, maxx = words[i].cx + words[i].w / 2;
        for (let j = i + 1; j < Math.min(i + 4, words.length); j++) {
            if (Math.abs(words[j].cy - words[i].cy) > words[i].h * 0.8) break;  // otra línea
            digits += words[j].digits;
            minx = Math.min(minx, words[j].cx - words[j].w / 2);
            maxx = Math.max(maxx, words[j].cx + words[j].w / 2);
            consider(digits, (minx + maxx) / 2, words[i].cy);
        }
    }

    if (best.score < 0.85) return none;
    const idcx = idRect.x + idRect.w / 2, idcy = idRect.y + idRect.h / 2;
    return { dx: best.cx - idcx, dy: best.cy - idcy, confident: true, score: best.score };
}

function _median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Offset de alineación cuando la zona de identificación NO tiene un dígito único
 * (p.ej. el membrete/logo "SANVICOR herramientas industriales … www.sanvicor.es").
 * Localiza en el documento las palabras de la zona y usa la MEDIANA de sus
 * posiciones (robusta a apariciones dispersas) para estimar cuánto se ha desplazado
 * el documento respecto a la zona de identificación de la plantilla.
 * @returns {{ dx, dy, confident, score }}
 */
function _findZoneOffsetFromWords(pageWords, idRect, idText, knownCifs) {
    const none = { dx: 0, dy: 0, confident: false, score: 0 };
    if (!pageWords?.length || !idRect) return none;
    const idWords = [...new Set(
        _normalizeText(idText || '').split(/\s+/)
            .filter(w => w.length >= 4 && !/^\d+$/.test(w) && !_GENERIC_WORDS.has(w))
    )];
    const idDigits = [
        ...((idText || '').match(/\d[\d\s.\-]{4,}\d/g) || []).map(s => s.replace(/\D/g, '')).filter(d => d.length >= 6),
        ...((knownCifs || []).map(c => String(c).replace(/[^0-9]/g, '')).filter(d => d.length >= 7)),
    ];
    if (!idWords.length && !idDigits.length) return none;

    const pts = [];
    for (const w of pageWords) {
        const t = _normalizeText(w.text || '');
        const d = (w.text || '').replace(/[^0-9]/g, '');
        let hit = idWords.some(iw => t.includes(iw));
        if (!hit && d.length >= 5) hit = idDigits.some(id => d.includes(id) || id.includes(d));
        if (hit) pts.push({ x: w.cx, y: w.cy });
    }
    if (pts.length < 2) return none;   // necesitamos al menos 2 anclas para fiarnos

    // Mediana robusta y luego acotar al CLÚSTER (el membrete) descartando apariciones
    // dispersas de la misma palabra en el cuerpo del documento.
    const mx = _median(pts.map(p => p.x)), my = _median(pts.map(p => p.y));
    const near = pts.filter(p => Math.abs(p.x - mx) < 0.20 && Math.abs(p.y - my) < 0.20);
    const use  = near.length >= 2 ? near : pts;
    const cx = use.reduce((s, p) => s + p.x, 0) / use.length;
    const cy = use.reduce((s, p) => s + p.y, 0) / use.length;

    const idcx = idRect.x + idRect.w / 2, idcy = idRect.y + idRect.h / 2;
    const score = Math.min(1, use.length / Math.max(2, idWords.length || 2));
    return { dx: cx - idcx, dy: cy - idcy, confident: true, score };
}

/**
 * Localiza el recuadro EXACTO donde aparece un valor leído, usando las posiciones
 * de palabra del OCR. Sirve para que la preview dibuje el recuadro justo encima del
 * dato real (no en la posición original de la plantilla). Si el valor sale repetido,
 * elige la aparición más cercana a la posición esperada (recuadro desplazado).
 * @returns {{x,y,w,h}|null}
 */
function _findValueRectInWords(pageWords, value, expectedRect = null, numeric = false) {
    if (!pageWords?.length || !value || !value.trim()) return null;
    const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
    const valDigits = value.replace(/[^0-9]/g, '');
    const valNorm   = norm(value);
    const useDigits = numeric || (valDigits.length >= 4);
    if (useDigits && valDigits.length < 3) return null;
    if (!useDigits && valNorm.length < 3) return null;

    const sorted = pageWords.filter(w => (w.text || '').trim())
        .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));

    const cands = [];
    for (let i = 0; i < sorted.length; i++) {
        let txt = sorted[i].text;
        let minx = sorted[i].cx - sorted[i].w / 2, maxx = sorted[i].cx + sorted[i].w / 2;
        let miny = sorted[i].cy - sorted[i].h / 2, maxy = sorted[i].cy + sorted[i].h / 2;
        const push = () => cands.push({ txt, x: minx, y: miny, w: maxx - minx, h: maxy - miny,
            cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 });
        push();
        for (let j = i + 1; j < Math.min(i + 3, sorted.length); j++) {
            if (Math.abs(sorted[j].cy - sorted[i].cy) > sorted[i].h * 0.8) break;
            txt += sorted[j].text;
            minx = Math.min(minx, sorted[j].cx - sorted[j].w / 2);
            maxx = Math.max(maxx, sorted[j].cx + sorted[j].w / 2);
            miny = Math.min(miny, sorted[j].cy - sorted[j].h / 2);
            maxy = Math.max(maxy, sorted[j].cy + sorted[j].h / 2);
            push();
        }
    }

    let matches = cands.filter(c => {
        if (useDigits) { const d = c.txt.replace(/[^0-9]/g, ''); return d === valDigits || (valDigits && d.includes(valDigits)); }
        return norm(c.txt).includes(valNorm);
    });
    if (!matches.length) return null;

    if (expectedRect) {
        const ex = expectedRect.x + expectedRect.w / 2, ey = expectedRect.y + expectedRect.h / 2;
        matches.sort((a, b) =>
            ((a.cx - ex) ** 2 + (a.cy - ey) ** 2) - ((b.cx - ex) ** 2 + (b.cy - ey) ** 2));
    } else {
        matches.sort((a, b) => a.txt.length - b.txt.length);
    }

    const best = matches[0];
    const pad = 0.004;
    return {
        x: Math.max(0, best.x - pad),
        y: Math.max(0, best.y - pad),
        w: Math.min(1, best.w + pad * 2),
        h: Math.min(1, best.h + pad * 2),
    };
}

/**
 * Calcula el desplazamiento de alineación (offset global) de una plantilla usando
 * el dato único de su zona de identificación (teléfono/CIF). Prefiere la posición
 * REAL de la palabra (precisa); si no hay words o no casa, cae a la rejilla OCR.
 * Devuelve {dx,dy} en coordenadas normalizadas. Compartido por la detección
 * automática y el modo tipo directo para que la sugerencia muestre los recuadros
 * desplazados igual.
 */
async function _computeAlignOffset(getCanvas, tpl, commonCifs = null, matchedDigit = null, pageWords = null) {
    const off0 = { dx: 0, dy: 0 };
    if (!tpl?.identification?.rect) return off0;
    const { digitRuns } = _zoneContentTokens(tpl);
    const alignDigits = [...new Set([matchedDigit, ...digitRuns]
        .filter(d => d && d.length >= 7 && !(commonCifs && commonCifs.has(d))))];

    // 1) Posición real del dígito único (preciso y fiable cuando existe)
    const byWords = alignDigits.length
        ? _findOffsetFromWords(pageWords, tpl.identification.rect, alignDigits)
        : { confident: false };
    if (byWords.confident) {
        if (Math.abs(byWords.dx) > 0.002 || Math.abs(byWords.dy) > 0.002) {
            window.electronAPI.logToCmd(`📍 Alineé por la posición REAL del NIF (${Math.round(byWords.score*100)}%): desplazo los recuadros ${(byWords.dx*100).toFixed(1)}% en X y ${(byWords.dy*100).toFixed(1)}% en Y.`);
        }
        return { dx: byWords.dx, dy: byWords.dy };
    }

    // 2) Sin dígito único → alinear por las PALABRAS de la zona (membrete/logo)
    const byZone = _findZoneOffsetFromWords(pageWords, tpl.identification.rect, tpl.identification.text, tpl.knownCifs);
    if (byZone.confident) {
        if (Math.abs(byZone.dx) > 0.002 || Math.abs(byZone.dy) > 0.002) {
            window.electronAPI.logToCmd(`📍 Alineé por el membrete/identificación: desplazo los recuadros ${(byZone.dx*100).toFixed(1)}% en X y ${(byZone.dy*100).toFixed(1)}% en Y.`);
        }
        return { dx: byZone.dx, dy: byZone.dy };
    }

    // 3) Fallback: rejilla OCR alrededor de la zona
    try {
        const pgId = await getCanvas(tpl.identification.page || 0);
        const reg  = await _findIdZoneOffset(pgId, tpl.identification.rect, alignDigits);
        if (reg.confident) return { dx: reg.dx, dy: reg.dy };
    } catch (_) {}
    return off0;
}

async function _buildRenameText(getCanvas, tpl, fullOcrText = '') {
    // Nuevo formato: array de partes
    if (Array.isArray(tpl.renameParts) && tpl.renameParts.length) {
        // ── REGISTRO GLOBAL: alinear todos los recuadros usando el NIF ────────
        let gOffset = tpl._gOffset || { dx: 0, dy: 0 };   // puede venir precalculado de la detección
        if (!tpl._gOffset && tpl.identification?.rect) {
            try {
                const expDigits = [..._extractCifCandidates(tpl.identification.text || ''), ...(tpl.knownCifs || [])]
                    .map(c => c.replace(/[^0-9]/g, '')).filter(d => d.length >= 7);
                const pgId = await getCanvas(tpl.identification.page || 0);
                const off  = await _findIdZoneOffset(pgId, tpl.identification.rect, expDigits);
                if (off.confident && (Math.abs(off.dx) > 0.002 || Math.abs(off.dy) > 0.002)) {
                    gOffset = { dx: off.dx, dy: off.dy };
                    window.electronAPI.logToCmd(`📍 Alineé el documento por el NIF (${Math.round(off.score*100)}% de certeza): desplazo TODOS los recuadros ${(off.dx*100).toFixed(1)}% en X y ${(off.dy*100).toFixed(1)}% en Y.`);
                }
            } catch (_) {}
        }

        const segments = [];
        const partFinalRects = {};   // { partId: rect real donde está el dato (para la preview) }
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
                // Aplicar el desplazamiento global calculado con el NIF
                let rect  = {
                    ...part.rect,
                    x: Math.max(0, Math.min(0.98 - part.rect.w, part.rect.x + gOffset.dx)),
                    y: Math.max(0, Math.min(0.98 - part.rect.h, part.rect.y + gOffset.dy)),
                };

                // ── Palabra ancla: ajustar zona Y si el layout ha cambiado ─────
                if (part.anchor?.text && part.anchor?.refY != null) {
                    const currentY = await _findAnchorY(pg.page, part.anchor.text);
                    if (currentY !== null) {
                        const deltaY = currentY - part.anchor.refY;
                        if (Math.abs(deltaY) > 0.005) {
                            rect = { ...rect, y: Math.max(0, Math.min(0.98 - rect.h, rect.y + deltaY)) };
                            console.log(`[Anchor] "${part.anchor.text}": desplazamiento ${(deltaY * 100).toFixed(1)}%`);
                        }
                    } else {
                        console.warn(`[Anchor] No encontrada: "${part.anchor.text}" — usando posición original`);
                    }
                }

                // ── Extracción con aprendizaje de posición (cascada 3 niveles) ──
                let text = await _ocrCropWithLearning(pg, rect, tpl, part);

                // ── Fallback inmune a inclinación: buscar por la ETIQUETA en el
                //    texto completo si la zona no dio nada o dio algo no numérico ─
                const numeric = _partIsNumeric(part);
                const rawDigits = (text || '').replace(/[^0-9]/g, '');
                const zonaFallo = !text.trim() || (numeric && rawDigits.length < 2);
                if (zonaFallo && fullOcrText && part.label) {
                    const byLabel = _findValueByLabelInText(fullOcrText, part.label, numeric);
                    if (byLabel) {
                        window.electronAPI.logToCmd(`🧭 CAMPO "${part.label}": el recuadro falló (documento torcido/desplazado), pero lo encontré por su etiqueta en el texto: "${byLabel}"`);
                        text = byLabel;
                    }
                }

                // ── Recuadro REAL para la preview: situar el recuadro justo encima
                //    del valor leído (usando posiciones de palabra del OCR) ───────
                const partWords = (tpl._allWords || []).find(p => p.page === (part.page || 0))?.words || null;
                const realRect  = _findValueRectInWords(partWords, text, rect, numeric);
                partFinalRects[partKey(part)] = realRect || rect;

                text = _applyPartTransform(text, part.transform || 'none');
                segments.push(text);
            }
        }
        tpl._partFinalRects = partFinalRects;   // leído por el llamador para la preview
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
        let renameText = '', fromParts = false, templateId = null, zoneOffset = null, partFinalRects = null;
        if (_getTypeTemplateIds(mlType).length) {
            try {
                const r  = await extractRenameTextForType(file, mlType, ocrText);
                renameText = r.text || '';
                fromParts  = r.fromParts || false;
                templateId = r.templateId || null;
                zoneOffset = r.zoneOffset || null;
                partFinalRects = r.partFinalRects || null;
            } catch (_) {}
        }
        // Fallback: patrones aprendidos de ejemplos manuales
        if (!renameText && ocrText) {
            renameText = await _extractByLearnedPattern(ocrText, mlType.name);
        }
        return {
            type: mlType, renameText, fromParts, templateId, zoneOffset, partFinalRects,
            confianza: 'high', source: 'ml',
            mlConfidence: mlResult.confidence,
        };
    }

    // ── Detección por zonas OCR (con hint ML como filtro) ────────────────────
    const zoneResult = await detectTypeByOcrZonal(file, mlType, ocrText);
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

/** Dígitos de una cadena CIF/NIF. */
function _cifDigits(s) { return (s || '').replace(/[^0-9]/g, ''); }

/**
 * CIFs que aparecen en 2+ plantillas → NO sirven para distinguir proveedor
 * (típicamente el NIF de tu propia empresa, que está en todos los documentos).
 */
function _buildCommonCifSet(allTemplates) {
    const counts = {};
    for (const t of allTemplates) {
        const cifs = new Set([
            ..._extractCifCandidates(t.identification?.text || ''),
            ...(t.knownCifs || []),
        ].map(_cifDigits).filter(d => d.length >= 7));
        for (const d of cifs) counts[d] = (counts[d] || 0) + 1;
    }
    const common = new Set();
    for (const [d, n] of Object.entries(counts)) if (n >= 2) common.add(d);
    return common;
}

const _GENERIC_WORDS = new Set(['albaran','factura','pedido','entrada','dua','documento','copia','original','herramientas','industriales','telefono','email','correo','direccion','poligono','calle','avenida']);

/**
 * Extrae la "huella de identificación" de una plantilla: lo que el usuario marcó
 * en la zona de identificación (tpl.identification.text) más los CIF aprendidos.
 *  - words:     palabras distintivas (≥4, no genéricas, no solo dígitos)
 *  - digitRuns: secuencias largas de dígitos (teléfono, CIF, código) — muy únicas
 */
function _zoneContentTokens(tpl) {
    const idText = tpl.identification?.text || '';
    const words = [...new Set(
        _normalizeText(idText).split(/\s+/)
            .filter(w => w.length >= 4 && !/^\d+$/.test(w) && !_GENERIC_WORDS.has(w))
    )];
    const fromText = (idText.match(/\d[\d\s.\-]{4,}\d/g) || [])
        .map(s => s.replace(/\D/g, '')).filter(d => d.length >= 6);
    const fromCifs = (tpl.knownCifs || []).map(_cifDigits).filter(d => d.length >= 7);
    const digitRuns = [...new Set([...fromText, ...fromCifs])];
    return { words, digitRuns };
}

/**
 * Puntúa cuánto encaja una plantilla con un documento. DECISIVO: el CONTENIDO de la
 * zona de identificación que marcó el usuario (teléfono/CIF/texto único) debe
 * aparecer en el documento. El nombre del proveedor solo suma un pequeño apoyo y
 * NUNCA clasifica por sí solo (decisión del usuario: la zona es obligatoria).
 */
function _templateMatchScore(tpl, fullOcrText, commonCifs) {
    const text      = _normalizeText(fullOcrText || '');
    const docDigits = _cifDigits(fullOcrText);

    const { words, digitRuns } = _zoneContentTokens(tpl);
    const distinctiveDigits = digitRuns.filter(d => !commonCifs.has(d));
    const matchedDigit = distinctiveDigits.find(d => docDigits.includes(d) || _digitsFuzzyIncluded(d, docDigits, 1));
    const digitHit  = !!matchedDigit;

    const wordFrac = words.length ? words.filter(w => text.includes(w)).length / words.length : 0;
    const hasZoneTokens = (words.length + distinctiveDigits.length) > 0;

    // Señal PRINCIPAL = la zona. Un teléfono/CIF único presente ≈ identificación segura.
    let zoneScore = digitHit ? 0.95 : wordFrac;

    // APOYO secundario: nombre de la plantilla (membrete) presente en el texto.
    // Solo suma si la zona ya tiene algo de presencia; nunca clasifica solo.
    const nameWords = [...new Set(
        _normalizeText(tpl.nombre || '').split(/\s+/)
            .filter(w => w.length >= 4 && !/^\d+$/.test(w) && !_GENERIC_WORDS.has(w))
    )];
    const nameFrac  = nameWords.length ? nameWords.filter(w => text.includes(w)).length / nameWords.length : 0;
    const nameBonus = (zoneScore >= 0.3 && nameFrac >= 0.5) ? 0.15 : 0;

    const score = hasZoneTokens ? Math.min(1, zoneScore + nameBonus) : 0;
    return { score, zoneScore, nameFrac, digitHit, matchedDigit, hasZoneTokens };
}

/**
 * Detecta el tipo de documento y extrae el texto de renombrado usando zonas visuales.
 * Itera TODOS los tipos y TODAS sus plantillas vinculadas → elige la mejor coincidencia global.
 * @param {object|null} mlHint - Tipo sugerido por ML (prioriza ese tipo si hay empate)
 */
async function detectTypeByOcrZonal(file, mlHint = null, fullOcrText = '') {
    const typesWithTemplate = userDocTypes.filter(t => _getTypeTemplateIds(t).length > 0);
    if (!typesWithTemplate.length) return null;

    const allTemplates = await window.electronAPI.getOcrTemplates();
    if (!allTemplates?.length) return null;

    const tplMap = {};
    allTemplates.forEach(t => { tplMap[t.id] = t; });

    const getCanvas = await _loadPdfCanvases(file.path);
    if (!getCanvas) return null;

    // CIFs compartidos entre plantillas (NIF de tu empresa…) → NO sirven para identificar
    const commonCifs = _buildCommonCifSet(allTemplates);
    if (commonCifs.size) {
        window.electronAPI.logToCmd(`ℹ️ Ignoro estos CIF por aparecer en varias plantillas (NIF propio/compartido): ${[...commonCifs].join(', ')}`);
    }

    window.electronAPI.logToCmd(`🎯 Analizando "${file.name}" — identifico al proveedor por el CONTENIDO de su zona de identificación (nombre/web/CIF)...`);

    const IDENT_MIN = 0.6;   // umbral mínimo para dar por identificado al proveedor
    let best = null, bestScore = 0;

    for (const type of typesWithTemplate) {
        for (const tplId of _getTypeTemplateIds(type)) {
            const tpl = tplMap[tplId];
            if (!tpl) continue;
            const hasRename = (Array.isArray(tpl.renameParts) && tpl.renameParts.length) || tpl.rename?.rect;
            if (!hasRename || !tpl.identification?.rect) continue;

            // Identificación por el CONTENIDO de la zona que marcó el usuario
            // (teléfono/CIF/texto único). El nombre solo es apoyo secundario.
            const m = _templateMatchScore(tpl, fullOcrText, commonCifs);
            let score = m.score;
            let via   = m.digitHit
                ? `dato único de la zona presente (${m.matchedDigit})`
                : (m.zoneScore > 0 ? 'contenido de la zona en el texto' : 'sin coincidencia de la zona');

            // Si el contenido de la zona no se ve en el texto completo, leer la zona
            // naranja directamente como última comprobación (documento torcido, etc.).
            if (score < IDENT_MIN && tpl.identification?.rect && (tpl.identification.text || '').trim()) {
                const id    = await getCanvas(tpl.identification.page || 0);
                const idTxt = await _ocrCrop(id.canvas, id.vp, tpl.identification.rect);
                const zs    = _similarity(idTxt, tpl.identification.text || '');
                if (zs > score) { score = zs; via = 'lectura directa de la zona naranja'; }
            }

            window.electronAPI.logToCmd(`   · "${tpl.nombre}": ${Math.round(score*100)}% (${via})`);

            if (score >= IDENT_MIN && score > bestScore) {
                bestScore = score;
                best = { type, tpl, score, matchedDigit: m.matchedDigit };
            }
        }
    }

    // ── Sin proveedor identificado → NO se clasifica → revisión manual ─────────
    if (!best) {
        window.electronAPI.logToCmd('   ⛔ No identifiqué a ningún proveedor (su nombre/web/CIF no aparece) → REVISIÓN MANUAL.');
        return null;
    }

    // Calcular el desplazamiento de alineación usando el dato único de la zona
    // (teléfono o CIF) que coincidió, preferentemente por su POSICIÓN REAL de
    // palabra. Así alineamos TODOS los recuadros los mismos píxeles.
    const idPageWords = (file._ocrWords || []).find(p => p.page === (best.tpl.identification?.page || 0))?.words || null;
    const offset = await _computeAlignOffset(getCanvas, best.tpl, commonCifs, best.matchedDigit, idPageWords);

    // Construir el nombre (offset global + búsqueda local por campo)
    const tplForBuild = { ...best.tpl, _gOffset: offset, _allWords: file._ocrWords };
    const renameText  = await _buildRenameText(getCanvas, tplForBuild, fullOcrText);

    window.electronAPI.logToCmd(`   ✅ ELEGIDA la plantilla "${best.tpl.nombre}" (tipo ${best.type.name}) — proveedor identificado al ${Math.round(best.score*100)}%.`);

    return {
        type: best.type,
        renameText,
        fromParts:  Array.isArray(best.tpl.renameParts) && best.tpl.renameParts.length > 0,
        templateId: best.tpl.id,
        confianza:  best.score >= 0.90 ? 'high' : 'medium',
        _tplNombre: best.tpl.nombre,
        zoneOffset: offset,   // (C) las zonas se mostrarán desplazadas igual en la sugerencia
        partFinalRects: tplForBuild._partFinalRects || null,   // (D) recuadros sobre el dato real
    };
}

/**
 * Comprueba si el CIF/NIF guardado en el texto de identificación de una plantilla
 * aparece en el texto completo del documento, tolerando errores de OCR.
 *
 * @param {string} savedIdText  - texto de identificación de la plantilla (contiene el CIF)
 * @param {string} fullOcrText  - texto OCR completo del documento
 * @param {string} docDigitText - fullOcrText sin separadores (precalculado)
 */
function _cifAppearsInText(savedIdText, fullOcrText, docDigitText) {
    if (!savedIdText || !fullOcrText) return false;

    // Posibles CIF/NIF en el texto guardado: letra opcional + 7-8 dígitos
    const candidates = _extractCifCandidates(savedIdText);
    if (!candidates.length) return false;

    const docDigits = (docDigitText || fullOcrText.replace(/[^0-9]/g, ''));
    const docDigitsOnly = fullOcrText.replace(/[^0-9]/g, '');

    for (const cif of candidates) {
        const cifDigits = cif.replace(/[^0-9]/g, '');
        if (cifDigits.length < 7) continue;

        // 1. Coincidencia exacta de la secuencia de dígitos
        if (docDigitsOnly.includes(cifDigits)) return true;

        // 2. Coincidencia tolerante: permitir 1 dígito mal leído por OCR
        if (_digitsFuzzyIncluded(cifDigits, docDigitsOnly, 1)) return true;
    }
    return false;
}

/** Extrae posibles CIF/NIF (ej: B36979128, 36979128, 12345678Z) de un texto. */
function _extractCifCandidates(text) {
    const out = [];
    const norm = (text || '').toUpperCase();
    // Patrón: letra opcional + 7-8 dígitos + letra opcional
    const re = /[A-Z]?\s?[-]?\s?\d[\d\.\-\s]{6,10}\d[A-Z]?/g;
    let m;
    while ((m = re.exec(norm)) !== null) {
        const digits = m[0].replace(/[^0-9]/g, '');
        if (digits.length >= 7 && digits.length <= 9) out.push(m[0].replace(/\s/g, ''));
    }
    return [...new Set(out)];
}

/**
 * Extrae SOLO el CIF/NIF que aparece junto a la etiqueta "CIF" o "NIF".
 * Evita confundir el CIF del proveedor con el del cliente u otros números.
 */
function _extractCifNearKeyword(text) {
    const norm = (text || '').toUpperCase();
    const out = [];
    const re = /(?:C\.?\s*I\.?\s*F\.?|N\.?\s*I\.?\s*F\.?)[\s.:/_-]*([A-Z]?\s?-?\s?\d[\d.\-\s]{6,10}\d[A-Z]?)/g;
    let m;
    while ((m = re.exec(norm)) !== null) {
        const digits = (m[1] || '').replace(/[^0-9]/g, '');
        if (digits.length >= 7 && digits.length <= 9) out.push(m[1].replace(/\s/g, ''));
    }
    return [...new Set(out)];
}

/** ¿La secuencia `needle` aparece en `haystack` permitiendo `maxErrors` dígitos distintos? */
function _digitsFuzzyIncluded(needle, haystack, maxErrors = 1) {
    const n = needle.length;
    if (n === 0 || haystack.length < n) return false;
    for (let i = 0; i + n <= haystack.length; i++) {
        let errors = 0;
        for (let j = 0; j < n; j++) {
            if (haystack[i + j] !== needle[j]) {
                if (++errors > maxErrors) break;
            }
        }
        if (errors <= maxErrors) return true;
    }
    return false;
}

/**
 * Extrae el texto de renombrado para un tipo concreto (modo tipo directo o ML de alta confianza).
 * Con una sola plantilla la usa directamente; con varias, compara zonas de identificación
 * y elige la que mejor encaje con el documento actual (ej: proveedor A vs proveedor B).
 * Siempre devuelve { text, fromParts, templateId }.
 */
async function extractRenameTextForType(file, type, fullOcrText = '') {
    const tplIds = _getTypeTemplateIds(type);
    if (!tplIds.length) return { text: '', fromParts: false, templateId: null };

    const allTemplates = await window.electronAPI.getOcrTemplates();
    if (!allTemplates?.length) return { text: '', fromParts: false, templateId: null };

    const tplMap = {};
    allTemplates.forEach(t => { tplMap[t.id] = t; });

    const getCanvas = await _loadPdfCanvases(file.path);
    if (!getCanvas) return { text: '', fromParts: false, templateId: null };

    const commonCifs = _buildCommonCifSet(allTemplates);
    const wordsFor = (tpl) => (file._ocrWords || []).find(p => p.page === (tpl.identification?.page || 0))?.words || null;

    // ── Una sola plantilla: sin necesidad de comparar ────────────────────────
    if (tplIds.length === 1) {
        const tpl = tplMap[tplIds[0]];
        if (!tpl) return { text: '', fromParts: false, templateId: null };
        const zoneOffset = await _computeAlignOffset(getCanvas, tpl, commonCifs, null, wordsFor(tpl));
        const tb = { ...tpl, _gOffset: zoneOffset, _allWords: file._ocrWords };
        const text = await _buildRenameText(getCanvas, tb, fullOcrText);
        return { text, fromParts: Array.isArray(tpl.renameParts) && tpl.renameParts.length > 0, templateId: tpl.id, zoneOffset, partFinalRects: tb._partFinalRects || null };
    }

    // ── Varias plantillas: elegir por el CONTENIDO de la zona (+ apoyo nombre) ─
    let bestTpl = null, bestScore = -1, bestDigit = null;

    for (const tplId of tplIds) {
        const tpl = tplMap[tplId];
        if (!tpl) continue;
        const m = _templateMatchScore(tpl, fullOcrText, commonCifs);
        let score = m.score;
        // Respaldo: zona naranja si el texto no decidió
        if (score < 0.6 && tpl.identification?.rect) {
            const id    = await getCanvas(tpl.identification.page || 0);
            const idTxt = await _ocrCrop(id.canvas, id.vp, tpl.identification.rect);
            score = Math.max(score, _similarity(idTxt, tpl.identification.text));
        }
        if (score > bestScore) { bestScore = score; bestTpl = tpl; bestDigit = m.matchedDigit; }
    }

    if (!bestTpl) return { text: '', fromParts: false, templateId: null };
    const zoneOffset = await _computeAlignOffset(getCanvas, bestTpl, commonCifs, bestDigit, wordsFor(bestTpl));
    const tb = { ...bestTpl, _gOffset: zoneOffset, _allWords: file._ocrWords };
    const text = await _buildRenameText(getCanvas, tb, fullOcrText);
    return {
        text,
        fromParts:  Array.isArray(bestTpl.renameParts) && bestTpl.renameParts.length > 0,
        templateId: bestTpl.id,
        zoneOffset,
        partFinalRects: tb._partFinalRects || null,
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
        await saveToOCRIndex(result.newPath, newName, text, type.name, templateId, file.name, autoDetected ? 'auto' : 'tipo');
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
            try { await window.electronAPI.incrementOcrConfirmations(templateId); _invalidateTplCache(); } catch (_) {}
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
        const { text, words } = await extractTextFromPDF(file);
        file._ocrWords = words;   // posiciones de palabra para alinear con precisión

        updateFileStatus(fileId, 'Detectando tipo...', 60);
        const matched = await detectDocumentType(file, text);

        const errorFolder = localStorage.getItem('watch-error-folder');

        // Solo auto-renombrar si Zilo es EXPERTO EN ESA PLANTILLA (proveedor)
        const expertAndConfident = matched?.confianza === 'high'
            && await _isExpertForTemplate(matched.templateId)
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
    window.electronAPI.onManualTemplateCreated(async data => {
        await handleManualTemplateCreated(data);
    });
}

/**
 * El usuario creó una plantilla (en el Motor OCR Zonal) para el documento que
 * está en la cola de renombrado manual. Procesar ese documento con el tipo
 * creado: extraer el nombre con la plantilla, mover, indexar, entrenar, y
 * avanzar la cola (lo que cierra/reemplaza el modal de renombrado).
 */
async function handleManualTemplateCreated(data) {
    const file   = currentManualFile;
    const fileId = currentManualFileId;
    const text   = currentManualOcrText;
    if (!file) return;

    try {
        // Recargar tipos para incluir el recién creado
        try { userDocTypes = await window.electronAPI.getDocTypes(); } catch (_) {}
        renderUserTypeButtons();

        const type = userDocTypes.find(t => t.id === parseInt(data?.typeId));
        if (!type) {
            // No se encontró el tipo → dejar el documento en la cola para revisión
            updateFileStatus(fileId, '⚠️ Tipo no encontrado tras crear plantilla', 100, 'skipped');
            currentManualFile = null; currentManualFileId = null;
            processNextManualRename();
            return;
        }

        updateFileStatus(fileId, `🎯 Aplicando plantilla de ${type.name}...`, 70);

        const templateId = data?.templateId || null;

        // Preferir el nombre EXACTO de la vista previa de la plantilla (lo que el
        // usuario acaba de ver y validar). Solo si no viene, re-extraer con OCR.
        if (data?.finalName && data.finalName.trim()) {
            const renameText = data.finalName.replace(/\.pdf$/i, '').trim();
            // fromParts=true → processWithType usa el nombre tal cual, sin anteponer el tipo
            await processWithType(file, fileId, type, text, false, renameText, true, templateId);
        } else {
            let renameText = '', fromParts = false, tplId = templateId;
            try {
                const r = await extractRenameTextForType(file, type, text);
                renameText = r.text || '';
                fromParts  = r.fromParts || false;
                tplId      = r.templateId || tplId;
            } catch (_) {}
            await processWithType(file, fileId, type, text, false, renameText, fromParts, tplId);
        }
        _mlStatsCache = null;
    } catch (err) {
        console.error('[ManualTemplate] Error:', err);
        updateFileStatus(fileId, `❌ Error: ${err.message}`, 100, 'error');
    }

    // Avanzar la cola → muestra el siguiente o cierra el modal
    currentManualFile = null; currentManualFileId = null;
    processNextManualRename();
}

function queueForManualRename(file, fileId, detectedType, ocrText, suggestedType = null, suggestedFileName = null, suggestedTemplateId = null, zoneOffset = null, partFinalRects = null) {
    const label = suggestedFileName ? '💡 Confirmar sugerencia...' : '⏳ En cola de revisión...';
    updateFileStatus(fileId, label, 75);
    manualRenameQueue.push({ file, fileId, detectedType, ocrText, suggestedType, suggestedFileName, suggestedTemplateId, zoneOffset, partFinalRects });
    if (!currentManualFile) processNextManualRename();
}

async function processNextManualRename() {
    if (!manualRenameQueue.length) {
        currentManualFile = null; currentManualFileId = null;
        // Cerrar el modal de renombrado si sigue abierto (p.ej. tras crear plantilla)
        try { await window.electronAPI.closeManualRenameWindow(); } catch (_) {}
        return;
    }
    const entry = manualRenameQueue.shift();
    const { file, fileId, detectedType, ocrText, suggestedType, suggestedFileName, suggestedTemplateId, zoneOffset, partFinalRects } = entry;
    currentManualFile   = file;
    currentManualFileId = fileId;
    currentManualOcrText = ocrText || '';
    currentManualFile._suggestedType = suggestedType;
    // Estado de corrección desde historial
    currentManualIsHistory  = !!entry.isHistoryCorrection;
    currentManualHistoryPath = entry.historyOriginalPath || null;

    // Cargar plantillas OCR para que la ventana pueda mostrar el formulario dinámico
    let templates = [];
    try { templates = await window.electronAPI.getOcrTemplates() || []; } catch (_) {}

    try {
        await window.electronAPI.openManualRenameWindow({
            fileName:          file.name,
            filePath:          file.path,
            detectedType:      detectedType || '',
            ocrText:           ocrText || '',
            currentMode:       entry.isHistoryCorrection ? 'history' : 'auto',
            docTypes:          userDocTypes,
            templates,
            suggestedFileName: suggestedFileName || '',
            suggestedTemplateId: suggestedTemplateId || null,
            zoneOffset:        zoneOffset || null,
            partFinalRects:    partFinalRects || null,
            isHistoryCorrection: !!entry.isHistoryCorrection,
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

    const isHistory   = currentManualIsHistory;
    const historyPath = currentManualHistoryPath;

    try {
        // Buscar carpeta destino: prioridad → tipo seleccionado → folder de la data
        let targetFolder = data.destinationFolder || '';
        if (data.selectedTypeId) {
            const t = userDocTypes.find(x => x.id === parseInt(data.selectedTypeId));
            if (t?.folder) targetFolder = t.folder;
        }
        // Corrección desde historial: el archivo ya está archivado; re-renombrar en su carpeta
        if (isHistory && historyPath) {
            targetFolder = historyPath.replace(/[\\/][^\\/]*$/, '');  // directorio actual
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
            // Si es corrección y el nombre no cambia, no mover (evita "(1)"); solo re-aprender
            const sameName = isHistory && (data.newFileName === file.name);
            const result = sameName
                ? { success: true, newPath: file.path }
                : await window.electronAPI.moveFile(file.path, targetFolder, data.newFileName, false);
            if (result.success) {
                updateFileStatus(fileId, `✅ ${data.newFileName}`, 100, isHistory ? 'success' : 'success');
                processedFiles.add(file.path);
                if (!isHistory) { fileCounter++; updateFileCounter(); }
                // En corrección: quitar la entrada antigua del índice si la ruta cambió
                if (isHistory && result.newPath !== historyPath) {
                    try { await window.electronAPI.removeOcrDocument(historyPath); } catch (_) {}
                }
                await saveToOCRIndex(result.newPath, data.newFileName, data.ocrText || '', data.selectedType || 'manual', data.templateId || null, file.name, isHistory ? 'corregido' : 'manual');

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
                    try {
                        const r = await window.electronAPI.incrementOcrConfirmations(data.templateId);
                        _invalidateTplCache();
                        const conf = r?.confirmations || 0;
                        const faltan = Math.max(0, 10 - conf);
                        if (faltan > 0) {
                            window.electronAPI.logToCmd(`📊 Plantilla confirmada ${conf}/10 veces. Le faltan ${faltan} confirmaciones para que renombre SOLA los documentos de ESTE proveedor.`);
                        } else {
                            window.electronAPI.logToCmd(`⭐ ¡Plantilla EXPERTA! (${conf} confirmaciones). A partir de ahora renombro automáticamente los documentos de ESTE proveedor.`);
                        }
                    } catch (_) {}
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

                // 🎯 Aprendizaje de posición: registrar dónde está el texto confirmado
                if (data.templateId && data.partValues && file?.path) {
                    // data.partValues = { partLabel: valor_confirmado } — enviado desde manual-rename-window
                    const tpl = (await window.electronAPI.getOcrTemplates() || []).find(t => t.id === data.templateId);
                    if (tpl?.renameParts) {
                        _recordPositionsFromConfirmedValues(
                            file.path, data.templateId,
                            tpl.renameParts, data.partValues
                        ).catch(() => {});
                    }
                }

                // 🎯 Zonas redibujadas a mano por el usuario → posición exacta y fiable
                if (data.templateId && Array.isArray(data.correctedRects) && data.correctedRects.length) {
                    for (const c of data.correctedRects) {
                        try {
                            await window.electronAPI.recordPartPosition({
                                templateId: data.templateId,
                                partLabel:  c.partLabel,
                                page:       c.page || 0,
                                rect:       c.rect,
                                source:     'user_drawn',
                            });
                            window.electronAPI.logToCmd(`🎓 APRENDIDO: para el campo "${c.partLabel}" usaré a partir de ahora la zona que marcaste. He borrado la posición equivocada anterior. No repetiré el fallo.`);
                        } catch (_) {}
                    }
                }

                // 🆔 Aprender el CIF/NIF del documento → esta plantilla
                // Solo el que está junto a "CIF/NIF" (el del proveedor, no el del cliente)
                if (data.templateId && (data.ocrText || '')) {
                    const cifs = _extractCifNearKeyword(data.ocrText);
                    for (const cif of cifs) {
                        try {
                            const r = await window.electronAPI.addTemplateCif({ templateId: data.templateId, cif });
                            if (r?.learned) window.electronAPI.logToCmd(`🆔 APRENDIDO: el CIF/NIF "${r.cif}" pertenece a esta plantilla. La próxima vez la reconoceré por ese CIF aunque la zona naranja falle.`);
                        } catch (_) {}
                    }
                }
            } else {
                updateFileStatus(fileId, `❌ ${result.error}`, 100, 'error');
            }
        }
    } catch (err) {
        updateFileStatus(fileId, `❌ Error: ${err.message}`, 100, 'error');
    }

    // Recargar tipos: el usuario pudo crear un tipo/plantilla nuevo durante el
    // renombrado, y los siguientes documentos deben poder reconocerlo.
    try { userDocTypes = await window.electronAPI.getDocTypes(); } catch (_) {}
    renderUserTypeButtons();

    currentManualFile = null;
    currentManualIsHistory = false;
    currentManualHistoryPath = null;
    processNextManualRename();
}

function handleManualRenameSkipped() {
    if (currentManualFileId && !currentManualIsHistory) updateFileStatus(currentManualFileId, '↪️ Omitido', 100, 'skipped');
    currentManualFile = null;
    currentManualIsHistory = false;
    currentManualHistoryPath = null;
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
    const wordsByPage  = [];   // [{ page, words: [{ text, conf, cx, cy, w, h }] }]

    for (let pageNum = 1; pageNum <= pagesToProc; pageNum++) {
        try {
            const page     = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 3.0 });
            const canvas   = document.createElement('canvas');
            canvas.width   = viewport.width;
            canvas.height  = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const straight = _autoDeskew(canvas, file.name);   // enderezar antes de OCR
            const { data } = await Tesseract.recognize(straight.toDataURL('image/png'), 'spa');
            combinedText  += data.text + '\n';
            // Posiciones de palabra (normalizadas 0..1 en el MISMO canvas deskewado)
            // → permiten localizar con precisión el NIF/CIF y los datos.
            wordsByPage.push({
                page:  pageNum - 1,
                words: _normalizeOcrWords(data, straight.width, straight.height),
            });
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

    const wc = (wordsByPage[0]?.words || []).length;
    window.electronAPI.logToCmd(`🔤 OCR capturó ${wc} palabras con posición en la 1ª página (necesarias para alinear los recuadros).`);

    return { text: combinedText, words: wordsByPage };
}

/**
 * Extrae las palabras de un resultado de Tesseract con su posición NORMALIZADA
 * (centro y tamaño en 0..1) respecto al canvas de ancho/alto dados. Tesseract.js
 * expone `data.words[].bbox = {x0,y0,x1,y1}`; si por la versión no viniese poblado,
 * se intenta reconstruir desde `data.lines`/`data.blocks`.
 */
function _normalizeOcrWords(data, cw, ch) {
    if (!cw || !ch) return [];
    let raw = Array.isArray(data?.words) ? data.words : [];
    if (!raw.length && Array.isArray(data?.lines)) {
        raw = data.lines.flatMap(l => Array.isArray(l.words) ? l.words : []);
    }
    const out = [];
    for (const w of raw) {
        const b = w?.bbox;
        if (!b || b.x1 == null) continue;
        const text = (w.text || '').trim();
        if (!text) continue;
        out.push({
            text,
            conf: w.confidence != null ? w.confidence : 0,
            cx: ((b.x0 + b.x1) / 2) / cw,
            cy: ((b.y0 + b.y1) / 2) / ch,
            w:  (b.x1 - b.x0) / cw,
            h:  (b.y1 - b.y0) / ch,
        });
    }
    return out;
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

// =================================================================================
// HISTORIAL DE ARCHIVOS PROCESADOS (corregible)
// =================================================================================

function openHistoryModal() {
    document.getElementById('history-overlay').style.display = 'flex';
    loadHistoryList();
}

async function loadHistoryList() {
    const list = document.getElementById('history-list');
    list.innerHTML = '<div style="color:#999;text-align:center;padding:20px">Cargando…</div>';
    let res;
    try { res = await window.electronAPI.getRecentDocuments(15); } catch (_) { res = { results: [] }; }
    const docs = res?.results || [];

    if (!docs.length) {
        list.innerHTML = '<div style="color:#999;text-align:center;padding:24px">Aún no hay archivos procesados.</div>';
        return;
    }

    list.innerHTML = '';
    docs.forEach(doc => {
        const fecha = new Date(doc.timestamp).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        const modeIcon = doc.mode === 'auto' ? '🤖' : doc.mode === 'manual' ? '✍️' : '📂';
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #eee;border-radius:9px;background:#fafafa';
        item.innerHTML = `
            <span style="font-size:1.3rem">${modeIcon}</span>
            <div style="flex:1;min-width:0">
                <div style="font-weight:700;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(doc.file_name)}</div>
                <div style="font-size:.74rem;color:#888;margin-top:2px">${esc(doc.doc_type || '—')} · ${fecha}${doc.original_name ? ' · era: ' + esc(doc.original_name) : ''}</div>
            </div>
            <button class="hist-correct-btn" style="border:1.5px solid #f59e0b;background:#fffbeb;color:#b45309;border-radius:7px;padding:6px 12px;cursor:pointer;font-size:.8rem;font-weight:700;white-space:nowrap">✏️ Corregir</button>
        `;
        item.querySelector('.hist-correct-btn').addEventListener('click', () => correctFromHistory(doc));
        list.appendChild(item);
    });
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/**
 * Abre la ventana de renombrado para corregir un archivo ya procesado.
 * El archivo está en su carpeta destino; al confirmar se re-renombra en su sitio.
 */
async function correctFromHistory(doc) {
    document.getElementById('history-overlay').style.display = 'none';

    // Comprobar que el archivo sigue existiendo
    const file = { path: doc.file_path, name: doc.file_name };

    // Resolver el tipo por nombre
    try { userDocTypes = await window.electronAPI.getDocTypes(); } catch (_) {}
    const type = userDocTypes.find(t => t.name?.toUpperCase() === (doc.doc_type || '').toUpperCase());

    // Encolar como corrección (bypass de detección)
    const fileId = `hist-${Date.now()}-${Math.random()}`;
    file.fileId = fileId;

    manualRenameQueue.push({
        file, fileId,
        detectedType:        type ? type.id : (doc.doc_type || ''),
        ocrText:             doc.ocr_text || '',
        suggestedType:       type || null,
        suggestedFileName:   '',                       // mostrar formulario de edición directo
        suggestedTemplateId: doc.template_id || null,
        isHistoryCorrection: true,
        historyOriginalPath: doc.file_path,
    });
    if (!currentManualFile) processNextManualRename();
}

async function saveToOCRIndex(filePath, fileName, text, docType, templateId = null, originalName = null, mode = null) {
    try {
        await window.electronAPI.addOcrDocument({
            filePath, fileName, ocrText: text || '', docType: docType || '',
            templateId, originalName, mode,
        });
    } catch (e) {
        console.warn('[OCRIndex] Error al guardar en base de datos:', e.message);
    }
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