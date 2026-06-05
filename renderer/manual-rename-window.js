/**
 * manual-rename-window.js
 * Lógica de la ventana de renombrado manual con formulario dinámico
 * basado en el parts builder de la plantilla OCR del tipo seleccionado.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Estado ────────────────────────────────────────────────────────────────────
let fileData          = null;   // datos recibidos desde app.js
let docTypes          = [];     // tipos de documento del usuario
let allTemplates      = [];     // todas las plantillas OCR
let activeType        = null;   // tipo de documento seleccionado
let activeTpl         = null;   // plantilla seleccionada (puede ser null)
let partValues        = {};     // { partId: string } valores de las partes OCR
let suggestedFileName = '';     // nombre pre-calculado por Zilo (puede ser vacío)
let inSuggestionMode  = false;  // true = mostrando sugerencia; false = formulario completo

let pdfDoc        = null;
let pdfZoom       = 1.0;
const ZOOM_MIN    = 0.3;
const ZOOM_MAX    = 4.0;
const ZOOM_STEP   = 0.25;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    applyStoredTheme();
    setupTheme();
    setupZoom();
    setupPan();
    setupButtons();
    window.manualRenameAPI.onFileData(handleFileData);
});

function applyStoredTheme() {
    try {
        const t = localStorage.getItem('theme');
        if (t === 'dark') document.body.classList.add('dark-mode');
    } catch (_) {}
}

function setupTheme() {
    window.manualRenameAPI.onThemeChanged(t =>
        document.body.classList.toggle('dark-mode', t === 'dark'));
}

// ── Recepción de datos ────────────────────────────────────────────────────────
async function handleFileData(data) {
    fileData          = data;
    docTypes          = data.docTypes     || [];
    allTemplates      = data.templates    || [];
    suggestedFileName = data.suggestedFileName || '';

    document.getElementById('orig-name').textContent = data.fileName || '—';

    // Cola
    const badge = document.getElementById('queue-badge');
    if ((data.queueCount || 0) > 1) {
        badge.textContent   = `${data.queueCount} en cola`;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }

    // Mensaje de alerta (solo en modo manual sin sugerencia)
    document.getElementById('alert-box').style.display =
        (!suggestedFileName && (data.currentMode === 'auto' || data.currentMode === 'manual')) ? 'block' : 'none';

    if (suggestedFileName) {
        renderSuggestionMode(data.detectedType);
    } else {
        inSuggestionMode = false;
        buildTypeSelector(data.detectedType);
    }

    await loadPdf(data.filePath);
}

// ── Modo sugerencia ───────────────────────────────────────────────────────────
function renderSuggestionMode(detectedType) {
    inSuggestionMode = true;

    // Resolver tipo detectado
    const byId   = docTypes.find(t => String(t.id) === String(detectedType));
    const byName = docTypes.find(t => t.name?.toLowerCase() === String(detectedType || '').toLowerCase());
    activeType   = byId || byName || null;
    activeTpl    = pickBestTemplate(activeType);

    // Actualizar preview
    document.getElementById('final-name').textContent = suggestedFileName;

    // Construir panel derecho
    const panel = document.getElementById('right-panel');
    panel.innerHTML = '';

    // Tarjeta de sugerencia
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'border: 2px solid #86efac; background: #f0fdf4;';

    const title = document.createElement('div');
    title.className   = 'field-label';
    title.textContent = '🤖 Sugerencia de Zilo';
    title.style.color = '#15803d';
    card.appendChild(title);

    if (activeType) {
        const typeBadge = document.createElement('div');
        typeBadge.style.cssText = 'font-size:.8rem;color:#6b7280;margin:3px 0 8px;';
        typeBadge.textContent   = `Tipo detectado: ${activeType.icon || '📄'} ${activeType.name}`;
        card.appendChild(typeBadge);
    }

    const nameBox = document.createElement('div');
    nameBox.style.cssText = 'font-size:1rem;font-weight:700;color:#166534;word-break:break-all;padding:10px 12px;background:white;border-radius:8px;border:1px solid #bbf7d0;margin-bottom:12px;text-align:center;';
    nameBox.id = 'suggestion-name-box';
    nameBox.textContent = suggestedFileName;
    card.appendChild(nameBox);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    const btnConfirm = document.createElement('button');
    btnConfirm.className  = 'btn btn-confirm';
    btnConfirm.style.flex = '2';
    btnConfirm.textContent = '✅ Confirmar nombre';
    btnConfirm.addEventListener('click', confirmSuggestion);

    const btnEdit = document.createElement('button');
    btnEdit.className   = 'btn btn-skip';
    btnEdit.style.flex  = '1';
    btnEdit.textContent = '✏️ Editar';
    btnEdit.addEventListener('click', switchToEditMode);

    btnRow.appendChild(btnConfirm);
    btnRow.appendChild(btnEdit);
    card.appendChild(btnRow);

    // Nombre original
    const origBox = document.createElement('div');
    origBox.className = 'name-original';
    origBox.innerHTML = `<strong>Nombre original:</strong><br><span style="color:#1e40af;font-weight:600;word-break:break-all">${esc(fileData.fileName || '—')}</span>`;

    // Nombre final
    const finalBox = document.createElement('div');
    finalBox.className = 'name-final';
    finalBox.innerHTML = `<strong>Nombre final:</strong><br><span id="final-name" style="color:#166534;font-weight:700;word-break:break-all">${esc(suggestedFileName)}</span>`;

    // Botón omitir
    const actionsRow = document.createElement('div');
    actionsRow.className = 'actions';
    const btnSkip = document.createElement('button');
    btnSkip.className   = 'btn btn-skip';
    btnSkip.textContent = 'Omitir';
    btnSkip.addEventListener('click', skipFile);
    actionsRow.appendChild(btnSkip);

    panel.appendChild(card);
    panel.appendChild(origBox);
    panel.appendChild(finalBox);
    panel.appendChild(actionsRow);
}

function confirmSuggestion() {
    if (!activeType) return;
    window.manualRenameAPI.confirmRename({
        selectedTypeId:    activeType.id,
        selectedType:      activeType.name,
        newFileName:       suggestedFileName,
        ocrText:           fileData?.ocrText || '',
        templateId:        activeTpl?.id || null,
        destinationFolder: activeType.folder || '',
    });
}

function switchToEditMode() {
    inSuggestionMode = false;
    suggestedFileName = '';
    // Reconstruir panel con formulario completo
    const panel = document.getElementById('right-panel');
    panel.innerHTML = `
        <div id="alert-box" class="alert-box">
            ✏️ Modifica los datos y confirma el nombre del archivo.
        </div>
        <div class="card">
            <div class="field-label">Tipo de documento</div>
            <select id="sel-type"></select>
            <div class="error-msg" id="err-type">Selecciona el tipo de documento.</div>
        </div>
        <div id="dyn-form"></div>
        <div class="name-original">
            <strong>Nombre original:</strong><br>
            <span id="orig-name" style="color:#1e40af;font-weight:600;word-break:break-all">${esc(fileData?.fileName || '—')}</span>
        </div>
        <div class="name-final">
            <strong>Nombre final:</strong><br>
            <span id="final-name" style="color:#166534;font-weight:700;word-break:break-all">—</span>
        </div>
        <div class="actions">
            <button class="btn btn-skip" id="btn-skip">Omitir</button>
            <button class="btn btn-confirm" id="btn-confirm" disabled>Confirmar y Renombrar</button>
        </div>
    `;
    document.getElementById('btn-skip').addEventListener('click', skipFile);
    document.getElementById('btn-confirm').addEventListener('click', confirmRename);
    buildTypeSelector(fileData?.detectedType);
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Selector de tipos ─────────────────────────────────────────────────────────
function buildTypeSelector(preselect) {
    const sel = document.getElementById('sel-type');
    sel.innerHTML = '<option value="">— Selecciona el tipo —</option>';

    docTypes.forEach(t => {
        const opt       = document.createElement('option');
        opt.value       = t.id;
        opt.textContent = `${t.icon || '📄'} ${t.name}`;
        sel.appendChild(opt);
    });

    // Pre-seleccionar si viene sugerido
    if (preselect) {
        // Puede ser id numérico o nombre
        const byId   = docTypes.find(t => String(t.id) === String(preselect));
        const byName = docTypes.find(t => t.name.toLowerCase() === String(preselect).toLowerCase());
        const found  = byId || byName;
        if (found) sel.value = found.id;
    }

    sel.addEventListener('change', onTypeChanged);
    onTypeChanged(); // init
}

function onTypeChanged() {
    const sel  = document.getElementById('sel-type');
    clearError('err-type');
    const id   = parseInt(sel.value);
    activeType = docTypes.find(t => t.id === id) || null;
    activeTpl  = pickBestTemplate(activeType);
    partValues = {};
    renderDynForm();
    updatePreview();
}

// ── Selección de plantilla ────────────────────────────────────────────────────
/**
 * Dado un tipo, elige la plantilla más apropiada comparando texto de identificación
 * con el ocrText del documento (coincidencia de palabras clave).
 */
function pickBestTemplate(type) {
    if (!type) return null;
    const ids = getTypeTemplateIds(type);
    if (!ids.length) return null;

    const ocrText = (fileData?.ocrText || '').toLowerCase();

    if (ids.length === 1) return allTemplates.find(t => t.id === ids[0]) || null;

    // Múltiples plantillas: puntuar por palabras del texto de identificación
    let bestTpl = null, bestScore = -1;
    for (const id of ids) {
        const tpl = allTemplates.find(t => t.id === id);
        if (!tpl) continue;
        const ref   = (tpl.identification?.text || '').toLowerCase();
        const words = ref.split(/\s+/).filter(w => w.length >= 3);
        if (!words.length) { if (bestScore < 0) { bestTpl = tpl; bestScore = 0; } continue; }
        const matches = words.filter(w => ocrText.includes(w)).length;
        const score   = matches / words.length;
        if (score > bestScore) { bestScore = score; bestTpl = tpl; }
    }
    return bestTpl;
}

function getTypeTemplateIds(type) {
    if (Array.isArray(type.ocr_template_ids) && type.ocr_template_ids.length)
        return type.ocr_template_ids;
    if (type.ocr_template_id) return [type.ocr_template_id];
    return [];
}

// ── Formulario dinámico ───────────────────────────────────────────────────────
function renderDynForm() {
    const container = document.getElementById('dyn-form');
    container.innerHTML = '';

    if (!activeType) return;

    const parts = activeTpl?.renameParts;

    if (Array.isArray(parts) && parts.length) {
        // ── Modo parts builder ──────────────────────────────────────────────
        const ocrParts = parts.filter(p => p.type === 'ocr');

        const card = document.createElement('div');
        card.className = 'card parts-form';

        // Vista previa del patrón
        const label = document.createElement('div');
        label.className = 'field-label';
        label.textContent = 'Constructor de nombre';
        card.appendChild(label);

        const row = document.createElement('div');
        row.className = 'parts-preview-row';
        row.id = 'parts-preview-row';
        parts.forEach(p => {
            const chip = document.createElement('span');
            if (p.type === 'text') {
                chip.className   = 'part-static';
                chip.textContent = p.value || '';
            } else {
                chip.className   = 'part-placeholder';
                chip.id          = `chip-${p.id}`;
                chip.textContent = `[${p.label || 'texto'}]`;
            }
            row.appendChild(chip);
        });
        card.appendChild(row);

        // Inputs para partes OCR
        if (ocrParts.length) {
            const inputsDiv = document.createElement('div');
            inputsDiv.className = 'parts-inputs';
            inputsDiv.style.marginTop = '10px';

            ocrParts.forEach(p => {
                const row2 = document.createElement('div');
                row2.className = 'part-input-row';

                const lbl    = document.createElement('label');
                lbl.htmlFor  = `inp-part-${p.id}`;
                lbl.textContent = p.label || 'Campo OCR';
                if (p.transform && p.transform !== 'none') {
                    lbl.textContent += ` (${transformLabel(p.transform)})`;
                }

                const inp      = document.createElement('input');
                inp.type       = 'text';
                inp.id         = `inp-part-${p.id}`;
                inp.dataset.partId = p.id;
                inp.placeholder    = `Introduce ${p.label || 'el valor'}…`;
                inp.addEventListener('input', () => {
                    partValues[p.id] = inp.value;
                    updateChip(p);
                    updatePreview();
                });
                inp.addEventListener('keydown', e => {
                    if (e.key === 'Enter') confirmRename();
                });

                const errSpan = document.createElement('div');
                errSpan.className = 'error-msg';
                errSpan.id = `err-part-${p.id}`;

                row2.appendChild(lbl);
                row2.appendChild(inp);
                row2.appendChild(errSpan);
                inputsDiv.appendChild(row2);
            });

            card.appendChild(inputsDiv);
        }

        container.appendChild(card);

        // Focus en primer input OCR
        setTimeout(() => {
            const first = container.querySelector('input[type="text"]');
            if (first) first.focus();
        }, 80);

    } else {
        // ── Modo simple: sin template o template antiguo sin parts ──────────
        const card = document.createElement('div');
        card.className = 'card';

        const label = document.createElement('div');
        label.className = 'field-label';
        label.textContent = 'Nombre del archivo';

        const inp      = document.createElement('input');
        inp.type       = 'text';
        inp.id         = 'inp-simple';
        inp.placeholder = 'Introduce el nombre del archivo…';
        inp.addEventListener('input', updatePreview);
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') confirmRename();
        });

        const hint = document.createElement('p');
        hint.className = 'simple-hint';
        hint.textContent = 'El tipo de documento se añadirá automáticamente al inicio del nombre.';

        card.appendChild(label);
        card.appendChild(inp);
        card.appendChild(hint);
        container.appendChild(card);

        setTimeout(() => inp.focus(), 80);
    }
}

function updateChip(part) {
    const chip = document.getElementById(`chip-${part.id}`);
    if (!chip) return;
    const raw = partValues[part.id] || '';
    const val = applyTransform(raw, part.transform);
    chip.textContent = val ? val : `[${part.label || 'texto'}]`;
    chip.style.opacity = val ? '1' : '0.5';
}

function transformLabel(t) {
    const map = { strip_zeros: 'sin ceros', upper: 'MAYÚSC', lower: 'minúsc', replace_slash: '/ → -', numbers_only: 'solo números' };
    return map[t] || t;
}

// ── Preview del nombre final ──────────────────────────────────────────────────
const INVALID_FILE_CHARS = /[\\/:*?"<>|]/;

function updatePreview() {
    const name = buildFilename();

    // Detectar caracteres inválidos en el nombre (sin la extensión .pdf)
    const baseName    = name ? name.replace(/\.pdf$/i, '') : '';
    const invalidFound = baseName
        ? [...new Set(baseName.split('').filter(c => INVALID_FILE_CHARS.test(c)))]
        : [];
    const hasInvalid  = invalidFound.length > 0;

    document.getElementById('final-name').textContent = name || '—';

    // Mostrar / ocultar aviso de caracteres inválidos
    let warnEl = document.getElementById('invalid-char-warn');
    if (!warnEl) {
        warnEl = document.createElement('div');
        warnEl.id = 'invalid-char-warn';
        warnEl.style.cssText = [
            'font-size:.75rem', 'color:#dc2626',
            'background:#fee2e2', 'border:1px solid #fca5a5',
            'border-radius:6px', 'padding:5px 9px', 'margin-top:-6px',
            'display:none'
        ].join(';');
        // Insertar justo después del bloque nombre-final
        const finalBox = document.getElementById('final-name')?.closest?.('.name-final');
        if (finalBox?.parentNode) finalBox.after(warnEl);
    }

    if (hasInvalid) {
        warnEl.textContent = `⚠️ Carácter${invalidFound.length > 1 ? 'es' : ''} no permitido${invalidFound.length > 1 ? 's' : ''} en nombres de archivo: ${invalidFound.map(c => `"${c}"`).join('  ')}`;
        warnEl.style.display = 'block';
    } else {
        warnEl.style.display = 'none';
    }

    document.getElementById('btn-confirm').disabled = !name || !activeType || hasInvalid;
}

function buildFilename() {
    if (!activeType) return '';

    const parts = activeTpl?.renameParts;

    if (Array.isArray(parts) && parts.length) {
        // Parts builder
        let result = '';
        for (const p of parts) {
            if (p.type === 'text') {
                result += p.value || '';
            } else {
                const raw = partValues[p.id] || '';
                result += applyTransform(raw, p.transform);
            }
        }
        const clean = result.replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        return clean + '.pdf';
    } else {
        // Modo simple
        const inp = document.getElementById('inp-simple');
        const val = (inp?.value || '').trim();
        if (!val) return '';
        const clean = val.replace(/\s+/g, ' ').trim();
        if (!clean) return '';
        return `${activeType.name} ${clean}.pdf`;
    }
}

function applyTransform(val, transform) {
    if (!val) return val;
    switch (transform) {
        case 'strip_zeros': return val.replace(/^0+/, '') || '0';
        case 'upper':       return val.toUpperCase();
        case 'lower':       return val.toLowerCase();
        case 'replace_slash': return val.replace(/\//g, '-');
        case 'numbers_only':  return val.replace(/\D/g, '');
        default:            return val;
    }
}

// ── Confirmar / Omitir ────────────────────────────────────────────────────────
function confirmRename() {
    let valid = true;

    // Validar tipo
    if (!activeType) {
        showError('err-type', 'Selecciona el tipo de documento.');
        document.getElementById('sel-type').classList.add('error');
        valid = false;
    }

    // Validar inputs de partes OCR
    const parts = activeTpl?.renameParts;
    if (Array.isArray(parts) && parts.length) {
        parts.filter(p => p.type === 'ocr').forEach(p => {
            const inp = document.getElementById(`inp-part-${p.id}`);
            if (!inp) return;
            if (!inp.value.trim()) {
                inp.classList.add('error');
                showError(`err-part-${p.id}`, 'Este campo es obligatorio.');
                if (valid) inp.focus();
                valid = false;
            } else {
                inp.classList.remove('error');
            }
        });
    } else {
        const inp = document.getElementById('inp-simple');
        if (inp && !inp.value.trim()) {
            inp.classList.add('error');
            if (valid) inp.focus();
            valid = false;
        }
    }

    if (!valid) return;

    const newFileName = buildFilename();
    if (!newFileName) return;

    // Construir mapa { partLabel: valorConfirmado } para aprendizaje de posición
    const partValuesForLearning = {};
    if (activeTpl?.renameParts) {
        for (const p of activeTpl.renameParts) {
            if (p.type === 'ocr' && partValues[p.id]) {
                partValuesForLearning[p.label || p.id] = partValues[p.id];
            }
        }
    }

    window.manualRenameAPI.confirmRename({
        selectedTypeId:   activeType.id,
        selectedType:     activeType.name,
        newFileName,
        ocrText:          fileData?.ocrText || '',
        templateId:       activeTpl?.id || null,
        destinationFolder: activeType.folder || '',
        partValues:       partValuesForLearning,   // para aprendizaje de posición
    });
}

function skipFile() {
    window.manualRenameAPI.skipFile();
}

// ── Errores ───────────────────────────────────────────────────────────────────
function showError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
}
function clearError(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.classList.remove('show');
    const field = document.getElementById(id.replace('err-', 'sel-'));
    if (field) field.classList.remove('error');
}

// ── Botones ───────────────────────────────────────────────────────────────────
function setupButtons() {
    document.getElementById('btn-confirm').addEventListener('click', confirmRename);
    document.getElementById('btn-skip').addEventListener('click', skipFile);
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
let _zoomBusy = false;

function setupZoom() {
    document.getElementById('btn-zoom-in').addEventListener('click',    () => adjustZoom(+ZOOM_STEP));
    document.getElementById('btn-zoom-out').addEventListener('click',   () => adjustZoom(-ZOOM_STEP));
    document.getElementById('btn-zoom-reset').addEventListener('click', () => { pdfZoom = 1.0; renderPage(); });

    document.getElementById('pdf-scroll').addEventListener('wheel', e => {
        e.preventDefault();
        adjustZoom(e.deltaY < 0 ? +ZOOM_STEP : -ZOOM_STEP, e.clientX, e.clientY);
    }, { passive: false });
}

async function adjustZoom(delta, focalClientX, focalClientY) {
    if (!pdfDoc) return;

    // Capturar fracción del canvas bajo el cursor ANTES de cambiar el zoom
    const scroll  = document.getElementById('pdf-scroll');
    const canvas  = document.getElementById('pdf-canvas');
    let fracX = 0.5, fracY = 0.5;
    let mouseInScrollX = 0, mouseInScrollY = 0;
    let useFocal = false;

    if (focalClientX != null) {
        const scrollRect = scroll.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        mouseInScrollX = focalClientX - scrollRect.left;
        mouseInScrollY = focalClientY - scrollRect.top;
        if (focalClientX >= canvasRect.left && focalClientX <= canvasRect.right &&
            focalClientY >= canvasRect.top  && focalClientY <= canvasRect.bottom) {
            fracX    = (focalClientX - canvasRect.left) / canvasRect.width;
            fracY    = (focalClientY - canvasRect.top)  / canvasRect.height;
            useFocal = true;
        }
    }

    if (_zoomBusy) {
        pdfZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(pdfZoom + delta).toFixed(2)));
        return;
    }

    _zoomBusy = true;
    pdfZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +(pdfZoom + delta).toFixed(2)));
    await renderPage();

    if (useFocal) {
        // Tras renderizar, el canvas tiene nuevas dimensiones CSS; ajustar scroll
        const scrollRect    = scroll.getBoundingClientRect();
        const newCanvasRect = canvas.getBoundingClientRect();
        // Posición del canvas en el contenido desplazable
        const canvasInScrollX = newCanvasRect.left - scrollRect.left + scroll.scrollLeft;
        const canvasInScrollY = newCanvasRect.top  - scrollRect.top  + scroll.scrollTop;
        scroll.scrollLeft = canvasInScrollX + fracX * newCanvasRect.width  - mouseInScrollX;
        scroll.scrollTop  = canvasInScrollY + fracY * newCanvasRect.height - mouseInScrollY;
    }

    _zoomBusy = false;
}

// ── Pan (arrastrar) ───────────────────────────────────────────────────────────
function setupPan() {
    const scroll = document.getElementById('pdf-scroll');
    let down = false, sx = 0, sy = 0, slx = 0, sly = 0;

    scroll.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        down = true; sx = e.clientX; sy = e.clientY;
        slx = scroll.scrollLeft; sly = scroll.scrollTop;
        scroll.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', e => {
        if (!down) return;
        scroll.scrollLeft = slx - (e.clientX - sx);
        scroll.scrollTop  = sly - (e.clientY - sy);
    });
    window.addEventListener('mouseup', () => {
        down = false;
        scroll.style.cursor = 'grab';
    });
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function loadPdf(filePath) {
    if (!filePath) return;
    try {
        const res = await window.manualRenameAPI.readPdfFile(filePath);
        if (!res?.success || !res.data) return;
        pdfDoc = await pdfjsLib.getDocument({ data: res.data }).promise;
        pdfZoom = 1.0;
        await renderPage();
    } catch (e) {
        console.error('[PDF] Error al cargar:', e);
    }
}

async function renderPage() {
    if (!pdfDoc) return;
    try {
        const page     = await pdfDoc.getPage(1);
        const scroll   = document.getElementById('pdf-scroll');
        const DPR      = window.devicePixelRatio || 1;
        const BASE     = (scroll.clientWidth - 20) / page.getViewport({ scale: 1 }).width;
        const scale    = BASE * pdfZoom * DPR;
        const viewport = page.getViewport({ scale });
        const canvas   = document.getElementById('pdf-canvas');
        canvas.width   = viewport.width;
        canvas.height  = viewport.height;
        canvas.style.width  = (viewport.width  / DPR) + 'px';
        canvas.style.height = (viewport.height / DPR) + 'px';
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        document.getElementById('zoom-label').textContent = Math.round(pdfZoom * 100) + '%';
    } catch (e) {
        console.error('[PDF] Error al renderizar:', e);
    }
}
