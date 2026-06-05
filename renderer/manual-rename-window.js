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
    setupDrawCanvas();
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

    ensureCreateTemplateButton();
}

/**
 * Inyecta (si no existe) el botón "Crear plantilla" justo después del
 * formulario dinámico, para que el usuario pueda enseñar a Zilo a reconocer
 * este documento sin salir de la ventana.
 */
function ensureCreateTemplateButton() {
    if (document.getElementById('btn-open-tpl-mode')) return;
    const dyn = document.getElementById('dyn-form');
    if (!dyn) return;

    const btn = document.createElement('button');
    btn.id = 'btn-open-tpl-mode';
    btn.className = 'btn-create-template';
    btn.innerHTML = '🏗️ Crear plantilla para este documento';
    btn.title = 'Enseña a Zilo a reconocer y renombrar este tipo de documento automáticamente';
    btn.addEventListener('click', enterTemplateMode);

    dyn.insertAdjacentElement('afterend', btn);
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

        // Sincronizar tamaño del draw canvas con el pdf canvas
        syncDrawCanvas();
        renderOverlay();
    } catch (e) {
        console.error('[PDF] Error al renderizar:', e);
    }
}

// =================================================================================
// CREACIÓN DE PLANTILLA DESDE LA VENTANA DE RENOMBRADO
// =================================================================================

// ── Estado del modo plantilla ─────────────────────────────────────────────────
let tplMode       = false;   // true = modo creación de plantilla activo
let drawingFor    = null;    // 'id' | 'part' | null
let isDrawing     = false;
let drawStart     = { x: 0, y: 0 };
let drawCurrent   = { x: 0, y: 0 };
let tplIdZone     = null;    // { rect, text }
let tplPartZone   = null;    // { rect, text }
let tplNewTypeFolder = '';   // carpeta para nuevo tipo (si se elige crear uno)

// ── Canvas de dibujo ──────────────────────────────────────────────────────────

function syncDrawCanvas() {
    const pdf  = document.getElementById('pdf-canvas');
    const draw = document.getElementById('draw-canvas');
    if (!pdf || !draw) return;
    draw.width        = pdf.width;
    draw.height       = pdf.height;
    draw.style.width  = pdf.style.width;
    draw.style.height = pdf.style.height;
}

function setupDrawCanvas() {
    const draw = document.getElementById('draw-canvas');

    draw.addEventListener('mousedown', e => {
        if (!drawingFor || e.button !== 0) return;
        e.stopPropagation();   // evitar que el pan del scroll se active al dibujar
        e.preventDefault();
        isDrawing   = true;
        drawStart   = getRelPos(e, draw);
        drawCurrent = { ...drawStart };
    });

    draw.addEventListener('mousemove', e => {
        if (!isDrawing) return;
        drawCurrent = getRelPos(e, draw);
        renderOverlay();
    });

    draw.addEventListener('mouseup', e => {
        if (!isDrawing) return;
        isDrawing = false;
        drawCurrent = getRelPos(e, draw);
        const rect = normRect(drawStart, drawCurrent);
        if (rect.w >= 0.01 && rect.h >= 0.005) {
            handleZoneDrawn(rect);
        }
        renderOverlay();
    });

    draw.addEventListener('mouseleave', () => {
        if (isDrawing) { isDrawing = false; renderOverlay(); }
    });

    // Cancelar zona activa
    document.getElementById('btn-cancel-id').addEventListener('click',   () => cancelDrawing());
    document.getElementById('btn-cancel-part').addEventListener('click', () => cancelDrawing());
}

function getRelPos(e, canvas) {
    const r = canvas.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
    };
}

function normRect(a, b) {
    return {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
    };
}

function renderOverlay() {
    const draw = document.getElementById('draw-canvas');
    if (!draw) return;
    const DPR = window.devicePixelRatio || 1;
    const ctx = draw.getContext('2d');
    ctx.clearRect(0, 0, draw.width, draw.height);
    const W = draw.width / DPR, H = draw.height / DPR;
    ctx.save(); ctx.scale(DPR, DPR);

    const drawZoneRect = (r, stroke, fill, label) => {
        ctx.fillStyle = fill;   ctx.fillRect(r.x*W, r.y*H, r.w*W, r.h*H);
        ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.setLineDash([]);
        ctx.strokeRect(r.x*W, r.y*H, r.w*W, r.h*H);
        if (label) {
            ctx.font = 'bold 10px -apple-system,sans-serif';
            const tw = ctx.measureText(label).width;
            const lx = r.x*W + 3, ly = Math.max(12, r.y*H - 3);
            ctx.fillStyle = stroke;
            ctx.fillRect(lx - 1, ly - 10, tw + 6, 13);
            ctx.fillStyle = 'white';
            ctx.fillText(label, lx + 2, ly);
        }
    };

    if (tplIdZone?.rect)   drawZoneRect(tplIdZone.rect,   '#f59e0b', 'rgba(245,158,11,0.15)', '🔍 Identificación');
    if (tplPartZone?.rect) drawZoneRect(tplPartZone.rect, '#10b981', 'rgba(16,185,129,0.15)', '📝 Dato a extraer');

    if (isDrawing) {
        const r = normRect(drawStart, drawCurrent);
        ctx.strokeStyle = drawingFor === 'id' ? '#f59e0b' : '#10b981';
        ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x*W, r.y*H, r.w*W, r.h*H);
    }

    ctx.restore();
}

function cancelDrawing() {
    drawingFor = null;
    isDrawing  = false;
    const draw = document.getElementById('draw-canvas');
    draw.style.cursor = 'default';
    draw.classList.remove('drawing-active');
    document.getElementById('hint-id').classList.remove('active');
    document.getElementById('hint-part').classList.remove('active');
}

function startDrawing(zone) {
    drawingFor = zone;
    const draw = document.getElementById('draw-canvas');
    draw.style.cursor = 'crosshair';
    draw.classList.add('drawing-active');
    document.getElementById('hint-id').classList.toggle('active',   zone === 'id');
    document.getElementById('hint-part').classList.toggle('active', zone === 'part');
}

async function handleZoneDrawn(rect) {
    const which = drawingFor;
    cancelDrawing();

    const runId   = which === 'id'   ? 'tpl-ocr-id-running'   : 'tpl-ocr-part-running';
    const prevId  = which === 'id'   ? 'tpl-id-preview'       : 'tpl-part-preview';
    const cardId  = which === 'id'   ? 'tpl-id-zone-card'     : 'tpl-part-zone-card';
    const statId  = which === 'id'   ? 'tpl-id-status'        : 'tpl-part-status';

    const runEl  = document.getElementById(runId);
    const prevEl = document.getElementById(prevId);
    const cardEl = document.getElementById(cardId);

    if (runEl)  runEl.classList.add('visible');
    if (prevEl) { prevEl.textContent = ''; prevEl.className = 'zone-preview empty'; }

    const text = await ocrZoneManual(rect);

    if (runEl)  runEl.classList.remove('visible');
    if (cardEl) cardEl.classList.add('filled');
    if (statId) document.getElementById(statId).textContent = '✅';
    if (prevEl) {
        prevEl.className  = 'zone-preview' + (text ? '' : ' empty');
        prevEl.textContent = text || '(sin texto — amplía la zona)';
    }

    if (which === 'id')   tplIdZone   = { rect, text };
    else                   tplPartZone = { rect, text };

    renderOverlay();
    updateSaveBtn();
}

async function ocrZoneManual(rect) {
    if (!pdfDoc) return '';
    try {
        const page = await pdfDoc.getPage(1);
        const vp   = page.getViewport({ scale: 3.0 });
        const full = document.createElement('canvas');
        full.width = vp.width; full.height = vp.height;
        await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;

        const zx = rect.x * vp.width, zy = rect.y * vp.height;
        const zw = rect.w * vp.width, zh = rect.h * vp.height;
        const crop = document.createElement('canvas');
        crop.width  = Math.max(1, Math.round(zw));
        crop.height = Math.max(1, Math.round(zh));
        crop.getContext('2d').drawImage(full, zx, zy, zw, zh, 0, 0, zw, zh);

        const { data } = await Tesseract.recognize(crop.toDataURL('image/png'), 'spa');
        return data.text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    } catch { return ''; }
}

// ── Modo creación de plantilla ────────────────────────────────────────────────

function enterTemplateMode() {
    tplMode     = true;
    tplIdZone   = null;
    tplPartZone = null;
    tplNewTypeFolder = '';

    const panel = document.getElementById('right-panel');
    panel.innerHTML = '';
    panel.style.position = 'relative';

    // Spinner de guardado
    const savingDiv = document.createElement('div');
    savingDiv.className = 'saving-overlay';
    savingDiv.id = 'tpl-saving-overlay';
    savingDiv.innerHTML = `<div class="save-spin"></div><span>Creando plantilla…</span>`;
    panel.appendChild(savingDiv);

    // Cabecera
    const hdr = document.createElement('div');
    hdr.className = 'tpl-header';
    hdr.innerHTML = `
        <span class="tpl-header-title">🏗️ Nueva plantilla</span>
        <button class="btn-back-rename" id="btn-back-rename">← Volver</button>
    `;
    panel.appendChild(hdr);

    // Nombre de la plantilla
    const nameCard = document.createElement('div');
    nameCard.className = 'card';
    nameCard.innerHTML = `
        <div class="field-label">Nombre de la plantilla</div>
        <input type="text" id="tpl-name" placeholder="Ej: Facturas Endesa, Albaranes Sanvicor…">
    `;
    panel.appendChild(nameCard);

    // Asignación de tipo
    const typeCard = document.createElement('div');
    typeCard.className = 'card';
    typeCard.innerHTML = `
        <div class="field-label">Tipo de documento</div>
        <select id="tpl-type-sel">
            <option value="">⏳ Cargando tipos…</option>
        </select>
        <div class="new-type-fields" id="tpl-new-type-fields" style="display:none">
            <input type="text" id="tpl-new-type-name" placeholder="Nombre del tipo (ej: FACTURAS ENDESA)">
            <div class="folder-row">
                <input type="text" id="tpl-new-type-folder" placeholder="Carpeta destino (obligatoria)">
                <button class="btn-pick-folder" id="btn-pick-type-folder">📁</button>
            </div>
        </div>
    `;
    panel.appendChild(typeCard);

    // Zona de identificación
    const idCard = document.createElement('div');
    idCard.className = 'zone-card id-zone';
    idCard.id = 'tpl-id-zone-card';
    idCard.innerHTML = `
        <div class="zone-header">
            <span class="zone-dot id-dot"></span>
            Zona de identificación
            <span class="zone-status" id="tpl-id-status">⬜</span>
        </div>
        <div class="zone-preview empty" id="tpl-id-preview">
            Dibuja la zona con el texto que identifica el documento (membrete, título…)
        </div>
        <div class="ocr-running" id="tpl-ocr-id-running">
            <div class="ocr-spin"></div> Analizando zona…
        </div>
        <button class="btn-draw id-draw" id="btn-draw-id">🔍 Dibujar zona de identificación</button>
    `;
    panel.appendChild(idCard);

    // Zona del dato a extraer
    const partCard = document.createElement('div');
    partCard.className = 'zone-card part-zone';
    partCard.id = 'tpl-part-zone-card';
    partCard.innerHTML = `
        <div class="zone-header">
            <span class="zone-dot part-dot"></span>
            Dato a extraer para el nombre
            <span class="zone-status" id="tpl-part-status">⬜</span>
        </div>
        <div class="zone-preview empty" id="tpl-part-preview">
            Dibuja la zona con el número de pedido, referencia, fecha…
        </div>
        <div class="zone-preview empty" id="tpl-part-label-row" style="margin-top:4px;display:none">
            <input type="text" id="tpl-part-label" placeholder="Etiqueta (ej: Número pedido, Fecha…)" style="font-size:.8rem;padding:5px 8px">
        </div>
        <div class="ocr-running" id="tpl-ocr-part-running">
            <div class="ocr-spin"></div> Analizando zona…
        </div>
        <button class="btn-draw part-draw" id="btn-draw-part">📝 Dibujar zona del dato</button>
    `;
    panel.appendChild(partCard);

    // Botón guardar
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-save-tpl';
    saveBtn.id = 'btn-save-tpl';
    saveBtn.disabled = true;
    saveBtn.textContent = '💾 Crear plantilla y continuar';
    panel.appendChild(saveBtn);

    // ── Event listeners ───────────────────────────────────────────────────────
    document.getElementById('btn-back-rename').addEventListener('click', exitTemplateMode);

    document.getElementById('btn-draw-id').addEventListener('click', () => startDrawing('id'));
    document.getElementById('btn-draw-part').addEventListener('click', () => {
        startDrawing('part');
        document.getElementById('tpl-part-label-row').style.display = 'block';
    });

    document.getElementById('tpl-name').addEventListener('input', updateSaveBtn);
    document.getElementById('btn-save-tpl').addEventListener('click', saveTemplateAndContinue);

    // Selector de tipo: cargar existentes
    loadTypesForSelector();

    document.getElementById('btn-pick-type-folder').addEventListener('click', async () => {
        try {
            const res = await window.manualRenameAPI.selectFolder();
            if (res?.success && res.folder) {
                document.getElementById('tpl-new-type-folder').value = res.folder;
            } else if (typeof res === 'string' && res) {
                document.getElementById('tpl-new-type-folder').value = res;
            }
        } catch (_) {}
        updateSaveBtn();
    });

    document.getElementById('tpl-new-type-name')?.addEventListener('input', updateSaveBtn);
    document.getElementById('tpl-new-type-folder')?.addEventListener('input', updateSaveBtn);
}

async function loadTypesForSelector() {
    const sel = document.getElementById('tpl-type-sel');
    if (!sel) return;

    try {
        const types = await window.manualRenameAPI.getDocTypes() || [];
        sel.innerHTML = '';
        const optNew = document.createElement('option');
        optNew.value = '__new__';
        optNew.textContent = '+ Crear nuevo tipo de documento';
        sel.appendChild(optNew);

        types.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = `${t.icon || '📄'} ${t.name}`;
            sel.appendChild(opt);
        });

        // Pre-seleccionar el tipo activo si existe
        if (activeType) {
            const match = [...sel.options].find(o => String(o.value) === String(activeType.id));
            if (match) sel.value = match.value;
        } else {
            sel.value = '__new__';
        }

        sel.addEventListener('change', () => {
            const isNew = sel.value === '__new__';
            document.getElementById('tpl-new-type-fields').style.display = isNew ? 'flex' : 'none';
            updateSaveBtn();
        });
        sel.dispatchEvent(new Event('change'));

    } catch (e) {
        sel.innerHTML = '<option value="__new__">+ Crear nuevo tipo de documento</option>';
        document.getElementById('tpl-new-type-fields').style.display = 'flex';
    }
}

function updateSaveBtn() {
    const btn = document.getElementById('btn-save-tpl');
    if (!btn) return;
    const name      = (document.getElementById('tpl-name')?.value || '').trim();
    const hasPart   = !!tplPartZone?.rect;
    const typeSel   = document.getElementById('tpl-type-sel')?.value;
    const newName   = (document.getElementById('tpl-new-type-name')?.value || '').trim();
    const newFolder = (document.getElementById('tpl-new-type-folder')?.value || '').trim();
    // Tipo existente → OK. Tipo nuevo → requiere nombre Y carpeta destino.
    const typeOk    = (typeSel && typeSel !== '__new__')
                    || (typeSel === '__new__' && newName.length > 0 && newFolder.length > 0);
    btn.disabled    = !(name && hasPart && typeOk);
}

async function saveTemplateAndContinue() {
    const overlay = document.getElementById('tpl-saving-overlay');
    if (overlay) overlay.classList.add('visible');

    try {
        const name     = document.getElementById('tpl-name').value.trim();
        const typeSel  = document.getElementById('tpl-type-sel').value;
        const partLabel = (document.getElementById('tpl-part-label')?.value || '').trim() || 'Identificador';

        // 1. Guardar la plantilla OCR
        const renameParts = [];
        if (tplPartZone?.rect) {
            renameParts.push({
                id:        'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                type:      'ocr',
                page:      0,
                rect:      tplPartZone.rect,
                label:     partLabel,
                transform: 'none',
            });
        }

        const tplResult = await window.manualRenameAPI.saveOcrTemplate({
            nombre:         name,
            identification: tplIdZone
                ? { page: 0, rect: tplIdZone.rect, text: tplIdZone.text || '' }
                : { page: 0, rect: tplPartZone.rect, text: '' }, // fallback: usa la zona del dato
            renameParts,
        });

        if (!tplResult?.success) throw new Error('No se pudo guardar la plantilla');
        const templateId = tplResult.id;

        // 2. Crear o obtener el tipo de documento
        let typeId;
        if (typeSel === '__new__') {
            const typeName   = document.getElementById('tpl-new-type-name').value.trim().toUpperCase();
            const typeFolder = document.getElementById('tpl-new-type-folder').value.trim();
            if (!typeFolder) throw new Error('La carpeta destino es obligatoria para un tipo nuevo');
            const createRes  = await window.manualRenameAPI.createDocType({
                name:   typeName,
                icon:   '📄',
                folder: typeFolder,
                ocr_template_ids: [templateId],   // array, no JSON string
            });
            if (!createRes?.success) throw new Error(createRes?.error || 'No se pudo crear el tipo de documento');
            typeId = createRes.id;
        } else {
            typeId = parseInt(typeSel);
            // Vincular la nueva plantilla al tipo existente — preservar nombre/icono/carpeta
            const types      = await window.manualRenameAPI.getDocTypes() || [];
            const existType  = types.find(t => t.id === typeId);
            const currentIds = Array.isArray(existType?.ocr_template_ids) ? existType.ocr_template_ids : [];
            await window.manualRenameAPI.updateDocType(typeId, {
                name:             existType?.name   || '',
                icon:             existType?.icon   || '📄',
                folder:           existType?.folder || null,
                ocr_template_ids: [...currentIds, templateId],
            });
        }

        // Capturar el valor que el OCR ya extrajo, para pre-rellenar el formulario
        const prefillValue = (tplPartZone?.text || '').trim();

        // 3. Actualizar estado local y volver al formulario de renombrado
        const updatedTypes = await window.manualRenameAPI.getDocTypes() || [];
        docTypes      = updatedTypes;
        allTemplates  = await window.manualRenameAPI.getOcrTemplates() || [];
        const newType = updatedTypes.find(t => t.id === typeId);
        if (newType) activeType = newType;

        exitTemplateMode();

        // 4. Re-construir el selector de tipo y pre-seleccionar el tipo recién creado
        buildTypeSelector(typeId);

        // 5. Pre-rellenar el campo OCR con el valor ya detectado durante la creación
        if (prefillValue && activeTpl?.renameParts) {
            const ocrPart = activeTpl.renameParts.find(p => p.type === 'ocr');
            if (ocrPart) {
                const inp = document.getElementById(`inp-part-${ocrPart.id}`);
                if (inp) {
                    inp.value = prefillValue;
                    inp.dispatchEvent(new Event('input'));
                }
            }
        }

        // 6. Si el tipo tiene carpeta destino y hay un nombre válido →
        //    procesar el documento automáticamente (moverlo + indexarlo) sin pedir
        //    una segunda confirmación. Así el documento sobre el que se creó la
        //    plantilla queda ya archivado en su sitio.
        const finalName = buildFilename();
        const folderOk  = !!(activeType?.folder);
        if (folderOk && finalName && !INVALID_FILE_CHARS.test(finalName.replace(/\.pdf$/i, ''))) {
            confirmRename();   // mueve + indexa + entrena, y avanza la cola
        } else if (overlay) {
            // No se puede archivar automáticamente (sin carpeta o nombre inválido):
            // dejar el formulario listo para que el usuario revise y confirme.
            overlay.classList.remove('visible');
        }

    } catch (e) {
        if (overlay) overlay.classList.remove('visible');
        alert('Error al crear la plantilla: ' + e.message);
    }
}

function exitTemplateMode() {
    tplMode     = false;
    tplIdZone   = null;
    tplPartZone = null;
    cancelDrawing();
    renderOverlay();

    // Reconstruir panel derecho original
    const panel = document.getElementById('right-panel');
    panel.style.position = '';
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
            <button class="btn btn-skip"    id="btn-skip">Omitir</button>
            <button class="btn btn-confirm" id="btn-confirm" disabled>Confirmar y Renombrar</button>
        </div>
    `;
    document.getElementById('btn-skip').addEventListener('click',    skipFile);
    document.getElementById('btn-confirm').addEventListener('click', confirmRename);
}
