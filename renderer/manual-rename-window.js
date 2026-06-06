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
    window.manualRenameAPI.onOcrZonalClosed(handleOcrZonalClosed);
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
    correctedRects    = {};   // limpiar zonas redibujadas del documento anterior

    document.getElementById('orig-name').textContent = data.fileName || '—';

    // Cola
    const badge = document.getElementById('queue-badge');
    if ((data.queueCount || 0) > 1) {
        badge.textContent   = `${data.queueCount} en cola`;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }

    // Mensaje de alerta
    const alertBox = document.getElementById('alert-box');
    if (data.isHistoryCorrection || data.currentMode === 'history') {
        alertBox.style.display = 'block';
        alertBox.style.background = '#fef3c7';
        alertBox.style.borderColor = '#f59e0b';
        alertBox.style.color = '#92400e';
        alertBox.innerHTML = '✏️ <b>Corrigiendo un archivo ya procesado.</b> Marca la zona correcta en el PDF si lee mal y confirma. Zilo aprenderá para no repetir el fallo.';
    } else {
        alertBox.style.display =
            (!suggestedFileName && (data.currentMode === 'auto' || data.currentMode === 'manual')) ? 'block' : 'none';
    }

    if (suggestedFileName) {
        renderSuggestionMode(data.detectedType);
    } else {
        inSuggestionMode = false;
        buildTypeSelector(data.detectedType);
    }

    await loadPdf(data.filePath);

    // Calcular el desplazamiento del documento por el NIF (para alinear las zonas)
    await computeZoneOffset();

    // El PDF ya está cargado → resaltar las zonas (ya desplazadas) de la plantilla
    renderOverlay();

    // Pre-rellenar campos OCR (las zonas se leen ya desplazadas)
    if (!inSuggestionMode && activeTpl?.renameParts) {
        prefillOcrFieldsFromTemplate(activeTpl.renameParts.filter(p => p.type === 'ocr'));
    }
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
    btn.title = 'Abre el Motor OCR Zonal con este documento cargado para crear su plantilla';
    btn.addEventListener('click', openOcrZonalForThisDoc);

    dyn.insertAdjacentElement('afterend', btn);
}

/** Abre el Motor OCR Zonal con el documento actual ya cargado. */
async function openOcrZonalForThisDoc() {
    const filePath = fileData?.filePath;
    if (!filePath) { alert('No hay documento cargado.'); return; }
    try {
        await window.manualRenameAPI.openOcrZonalForFile(filePath);
    } catch (e) {
        alert('No se pudo abrir el Motor OCR Zonal: ' + e.message);
    }
}

/**
 * Cuando se cierra el Motor OCR Zonal, recargar tipos y plantillas para
 * reflejar la plantilla recién creada, y re-evaluar el documento actual.
 */
async function handleOcrZonalClosed() {
    try {
        docTypes     = await window.manualRenameAPI.getDocTypes()    || [];
        allTemplates = await window.manualRenameAPI.getOcrTemplates() || [];
    } catch (_) {}

    // Elegir el tipo cuya plantilla mejor identifica este documento
    const best = autoSelectBestType();
    const preselect = best?.id || activeType?.id || fileData?.detectedType;

    if (inSuggestionMode) {
        switchToEditMode();   // construye el formulario completo
    }
    // (re)construir el selector con el mejor tipo preseleccionado
    buildTypeSelector(preselect);

    // Re-ejecutar prefill de campos OCR con la nueva plantilla
    if (activeTpl?.renameParts) {
        prefillOcrFieldsFromTemplate(activeTpl.renameParts.filter(p => p.type === 'ocr'));
    }
}

/**
 * Busca el tipo cuya plantilla de identificación mejor coincide con el texto
 * OCR del documento actual. Devuelve null si ninguna supera el 40%.
 */
function autoSelectBestType() {
    const ocr = (fileData?.ocrText || '').toLowerCase();
    if (!ocr) return null;
    let bestType = null, bestScore = 0.4;   // umbral mínimo
    for (const t of docTypes) {
        for (const id of getTypeTemplateIds(t)) {
            const tpl = allTemplates.find(x => x.id === id);
            const ref = (tpl?.identification?.text || '').toLowerCase();
            const words = ref.split(/\s+/).filter(w => w.length >= 3);
            if (!words.length) continue;
            const score = words.filter(w => ocr.includes(w)).length / words.length;
            if (score > bestScore) { bestScore = score; bestType = t; }
        }
    }
    return bestType;
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
    renderOverlay();
    // Recalcular el desplazamiento del NIF para esta plantilla (async, no bloquea)
    computeZoneOffset().then(() => renderOverlay()).catch(() => {});
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

    // Si la detección automática (zona naranja) ya eligió una plantilla, respetarla
    const suggestedId = fileData?.suggestedTemplateId;
    if (suggestedId && ids.includes(suggestedId)) {
        const t = allTemplates.find(x => x.id === suggestedId);
        if (t) return t;
    }

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

/**
 * Si el tipo activo tiene varias plantillas (p.ej. una por proveedor), muestra un
 * desplegable para que el usuario elija/corrija cuál usar. Zilo preselecciona la
 * que mejor encaja según la zona de identificación naranja, pero el usuario manda.
 */
function renderTemplateSelector(container) {
    if (!activeType) return;
    const ids = getTypeTemplateIds(activeType);
    if (ids.length < 2) return;   // con una sola plantilla no hay nada que elegir

    const tpls = ids.map(id => allTemplates.find(t => t.id === id)).filter(Boolean);
    if (tpls.length < 2) return;

    const card = document.createElement('div');
    card.className = 'card';
    const lbl = document.createElement('div');
    lbl.className = 'field-label';
    lbl.textContent = 'Plantilla / proveedor';
    card.appendChild(lbl);

    const sel = document.createElement('select');
    sel.id = 'sel-template';
    tpls.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.nombre || t.id;
        if (activeTpl && t.id === activeTpl.id) opt.selected = true;
        sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
        activeTpl  = allTemplates.find(t => t.id === sel.value) || null;
        partValues = {};
        renderDynForm();
        updatePreview();
        renderOverlay();   // resaltar las zonas de la nueva plantilla
        // Re-ejecutar prefill con la plantilla elegida
        if (activeTpl?.renameParts) {
            prefillOcrFieldsFromTemplate(activeTpl.renameParts.filter(p => p.type === 'ocr'));
        }
    });
    card.appendChild(sel);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:.72rem;color:#888;margin-top:5px;line-height:1.4';
    hint.textContent = 'Zilo eligió la más parecida según el membrete. Cámbiala si no es correcta.';
    card.appendChild(hint);

    container.appendChild(card);
}

// ── Formulario dinámico ───────────────────────────────────────────────────────
function renderDynForm() {
    const container = document.getElementById('dyn-form');
    container.innerHTML = '';

    if (!activeType) return;

    // Selector de plantilla (cuando el tipo tiene varias, ej: un proveedor por plantilla)
    renderTemplateSelector(container);

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
                lbl.textContent = p.label || 'Dato a extraer (nº, referencia…)';
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

                // Botón para marcar/ajustar la zona OCR en el PDF (herramienta zonal)
                const drawBtn = document.createElement('button');
                drawBtn.type = 'button';
                drawBtn.className = 'btn-correct-zone';
                drawBtn.id = `btn-correct-${p.id}`;
                drawBtn.textContent = '✏️ ¿Lee mal? Marca aquí la zona correcta en el PDF';
                drawBtn.title = 'Dibuja un recuadro sobre el dato correcto en el PDF. Zilo aprenderá esa posición y dejará de usar la equivocada.';
                drawBtn.addEventListener('click', () => startCorrectionDraw(p));

                const errSpan = document.createElement('div');
                errSpan.className = 'error-msg';
                errSpan.id = `err-part-${p.id}`;

                row2.appendChild(lbl);
                row2.appendChild(inp);
                row2.appendChild(drawBtn);
                row2.appendChild(errSpan);
                inputsDiv.appendChild(row2);
            });

            card.appendChild(inputsDiv);
        }

        container.appendChild(card);

        // Pre-rellenar los campos OCR ejecutando las zonas de la plantilla
        prefillOcrFieldsFromTemplate(ocrParts);

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

    // Zonas redibujadas manualmente por el usuario → el ML aprende la posición exacta
    const correctedForLearning = [];
    if (activeTpl?.renameParts) {
        for (const p of activeTpl.renameParts) {
            if (p.type === 'ocr' && correctedRects[p.id]) {
                correctedForLearning.push({ partLabel: p.label || p.id, page: p.page || 0, rect: correctedRects[p.id] });
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
        partValues:       partValuesForLearning,    // para aprendizaje de posición (capa de texto)
        correctedRects:   correctedForLearning,     // zonas dibujadas a mano (posición exacta)
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

// ── Auto-enderezado (mismo algoritmo que el procesamiento) ─────────────────────
let pdfSkewAngle = 0;   // ángulo detectado del documento actual
let zoneOffset   = { dx: 0, dy: 0 };  // desplazamiento global calculado por el NIF

// ── Registro por NIF: calcular cuánto se ha desplazado el documento ───────────
function mrwExtractCifs(text) {
    const out = [];
    const norm = (text || '').toUpperCase();
    const re = /[A-Z]?\s?-?\s?\d[\d.\-\s]{6,10}\d[A-Z]?/g;
    let m; while ((m = re.exec(norm)) !== null) {
        const d = m[0].replace(/[^0-9]/g, '');
        if (d.length >= 7 && d.length <= 9) out.push(d);
    }
    return [...new Set(out)];
}
function mrwDigitSubseq(exp, act) {
    if (!exp || !act) return 0;
    if (act.includes(exp)) return 1;
    let mm = 0, j = 0;
    for (let i = 0; i < act.length && j < exp.length; i++) if (act[i] === exp[j]) { mm++; j++; }
    return mm / exp.length;
}

/** Calcula el desplazamiento del documento buscando el CIF cerca de la zona naranja. */
async function computeZoneOffset() {
    zoneOffset = { dx: 0, dy: 0 };
    const idRect = activeTpl?.identification?.rect;
    if (!idRect || !pdfDoc) return;
    const exps = [
        ...mrwExtractCifs(activeTpl.identification?.text || ''),
        ...((activeTpl.knownCifs || []).map(c => String(c).replace(/[^0-9]/g, ''))),
    ].filter(d => d.length >= 7);
    if (!exps.length) return;

    const dh = idRect.h, dw = idRect.w;
    const ySteps = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8];
    const xSteps = [0, 0.5, -0.5, 1, -1];
    let best = { dx: 0, dy: 0, score: 0 }, done = false;
    for (const sy of ySteps) {
        if (done) break;
        for (const sx of xSteps) {
            const r = {
                x: Math.max(0, Math.min(0.98 - dw, idRect.x + sx * dw)),
                y: Math.max(0, Math.min(0.98 - dh, idRect.y + sy * dh)),
                w: dw, h: dh,
            };
            const txt = await ocrZoneManual(r, { numeric: true });
            const d = txt.replace(/[^0-9]/g, '');
            if (d.length < 5) continue;
            let sim = 0; for (const e of exps) sim = Math.max(sim, mrwDigitSubseq(e, d));
            if (sim > best.score) { best = { dx: r.x - idRect.x, dy: r.y - idRect.y, score: sim }; if (sim >= 0.99) { done = true; break; } }
        }
    }
    if (best.score >= 0.85 && (Math.abs(best.dx) > 0.002 || Math.abs(best.dy) > 0.002)) {
        zoneOffset = { dx: best.dx, dy: best.dy };
    }
}

function detectSkewAngle(srcCanvas) {
    try {
        const targetW = 500;
        const scale = Math.min(1, targetW / srcCanvas.width);
        const w = Math.max(1, Math.round(srcCanvas.width * scale));
        const h = Math.max(1, Math.round(srcCanvas.height * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.drawImage(srcCanvas, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        const dark = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const g = 0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2];
            dark[i] = g < 140 ? 1 : 0;
        }
        const cx = w / 2;
        const variance = (a) => {
            const tan = Math.tan(a * Math.PI / 180);
            const proj = new Float64Array(h);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
                if (dark[y*w+x]) { const ny = Math.round(y + (x-cx)*tan); if (ny>=0&&ny<h) proj[ny]++; }
            let mean = 0; for (let y=0;y<h;y++) mean += proj[y]; mean /= h;
            let v = 0; for (let y=0;y<h;y++){ const d = proj[y]-mean; v += d*d; } return v;
        };
        const base = variance(0); let bestA = 0, bestS = base;
        for (let a=-8;a<=8;a+=0.5){ if(a===0)continue; const v=variance(a); if(v>bestS){bestS=v;bestA=a;} }
        if (bestA !== 0 && Math.abs(bestA) >= 0.5 && bestS > base * 1.12) return bestA;
    } catch (_) {}
    return 0;
}

function deskewCanvas(srcCanvas, angleDeg) {
    if (!angleDeg || Math.abs(angleDeg) < 0.5) return srcCanvas;
    const w = srcCanvas.width, h = srcCanvas.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h);
    ctx.translate(w/2, h/2); ctx.rotate(-angleDeg * Math.PI/180); ctx.translate(-w/2, -h/2);
    ctx.drawImage(srcCanvas, 0, 0);
    return c;
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function loadPdf(filePath) {
    if (!filePath) return;
    try {
        const res = await window.manualRenameAPI.readPdfFile(filePath);
        if (!res?.success || !res.data) return;
        pdfDoc = await pdfjsLib.getDocument({ data: res.data }).promise;
        pdfZoom = 1.0;

        // Detectar la inclinación una vez (sobre un render de referencia)
        pdfSkewAngle = 0;
        try {
            const p1 = await pdfDoc.getPage(1);
            const vp = p1.getViewport({ scale: 1.5 });
            const tmp = document.createElement('canvas'); tmp.width = vp.width; tmp.height = vp.height;
            await p1.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
            pdfSkewAngle = detectSkewAngle(tmp);
        } catch (_) {}

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

        if (pdfSkewAngle) {
            // Renderizar a un temporal y dibujar enderezado en el canvas visible
            const tmp = document.createElement('canvas'); tmp.width = viewport.width; tmp.height = viewport.height;
            await page.render({ canvasContext: tmp.getContext('2d'), viewport }).promise;
            const straight = deskewCanvas(tmp, pdfSkewAngle);
            canvas.getContext('2d').drawImage(straight, 0, 0);
        } else {
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
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
let drawingFor    = null;    // 'id' | 'ocr-part' | null
let isDrawing     = false;
let drawStart     = { x: 0, y: 0 };
let drawCurrent   = { x: 0, y: 0 };
let tplIdZone     = null;    // { rect, text }
let tplParts      = [];      // [{ id, type:'text'|'ocr'|'text-search', value?, rect?, label?, before?, after?, transform?, _preview?, _loading? }]
let tplPendingPartId = null; // id de la parte OCR esperando que se dibuje su zona
let correctionPart = null;   // parte OCR del formulario que se está corrigiendo dibujando zona
let correctedRects = {};     // { partId: rect } zonas redibujadas por el usuario (para aprendizaje)

function genTplPartId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

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

function ocrIndexOfPart(partId) {
    let idx = 0;
    for (const p of tplParts) { if (p.type === 'ocr') { idx++; if (p.id === partId) return idx; } }
    return idx;
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

    if (tplMode) {
        // ── Modo creación de plantilla: zonas que el usuario está dibujando ────
        if (tplIdZone?.rect) drawZoneRect(tplIdZone.rect, '#f59e0b', 'rgba(245,158,11,0.15)', '🔍 Identificación');
        let ocrIdx = 0;
        for (const p of tplParts) {
            if (p.type !== 'ocr' || !p.rect) continue;
            ocrIdx++;
            drawZoneRect(p.rect, '#10b981', 'rgba(16,185,129,0.15)',
                p.label ? `OCR ${ocrIdx}: ${p.label}` : `OCR ${ocrIdx}`);
        }
    } else if (activeTpl) {
        // ── Modo normal/corrección: zonas DESPLAZADAS por el offset del NIF ────
        const off = zoneOffset || { dx: 0, dy: 0 };
        const shift = (r) => ({
            x: Math.max(0, Math.min(0.98 - r.w, r.x + off.dx)),
            y: Math.max(0, Math.min(0.98 - r.h, r.y + off.dy)),
            w: r.w, h: r.h,
        });
        const idr = activeTpl.identification?.rect;
        if (idr && (activeTpl.identification.page || 0) === 0) {
            drawZoneRect(shift(idr), '#f59e0b', 'rgba(245,158,11,0.15)', '🔍 NIF/Identificación');
        }
        let ocrIdx = 0;
        for (const p of (activeTpl.renameParts || [])) {
            if (p.type !== 'ocr' || !p.rect) continue;
            if ((p.page || 0) !== 0) continue;
            ocrIdx++;
            drawZoneRect(shift(p.rect), '#10b981', 'rgba(16,185,129,0.15)',
                p.label ? `${p.label}` : `Dato ${ocrIdx}`);
        }
    }

    if (isDrawing) {
        const r = normRect(drawStart, drawCurrent);
        ctx.strokeStyle = drawingFor === 'id' ? '#f59e0b' : '#10b981';
        ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x*W, r.y*H, r.w*W, r.h*H);
    }

    ctx.restore();
}

function cancelDrawing() {
    const wasCorrection = !!correctionPart;
    drawingFor = null;
    tplPendingPartId = null;
    correctionPart = null;
    isDrawing  = false;
    const draw = document.getElementById('draw-canvas');
    draw.style.cursor = 'default';
    draw.classList.remove('drawing-active');
    document.getElementById('hint-id')?.classList.remove('active');
    document.getElementById('hint-part')?.classList.remove('active');
    if (!wasCorrection) renderTplParts();
}

/** Inicia el dibujo de una zona para CORREGIR un campo OCR del formulario. */
function startCorrectionDraw(part) {
    if (!pdfDoc) { alert('No hay PDF cargado.'); return; }
    correctionPart = part;
    drawingFor = 'correct-part';
    tplPendingPartId = null;
    const draw = document.getElementById('draw-canvas');
    draw.style.cursor = 'crosshair';
    draw.classList.add('drawing-active');
    document.getElementById('hint-id')?.classList.remove('active');
    document.getElementById('hint-part')?.classList.add('active');
    const btn = document.getElementById(`btn-correct-${part.id}`);
    if (btn) btn.textContent = '⏳ Dibuja la zona en el PDF…';
}

/**
 * Ejecuta las zonas OCR de la plantilla sobre el documento actual y pre-rellena
 * los campos que estén vacíos. Solo rellena lo que el OCR consiga leer.
 */
async function prefillOcrFieldsFromTemplate(ocrParts) {
    if (!pdfDoc || !ocrParts?.length) return;
    const off = zoneOffset || { dx: 0, dy: 0 };
    for (const p of ocrParts) {
        if (!p.rect) continue;
        const inp = document.getElementById(`inp-part-${p.id}`);
        if (!inp || inp.value.trim()) continue;   // no pisar lo que ya hay
        // Aplicar el mismo desplazamiento del NIF a la zona del dato
        const r = {
            x: Math.max(0, Math.min(0.98 - p.rect.w, p.rect.x + off.dx)),
            y: Math.max(0, Math.min(0.98 - p.rect.h, p.rect.y + off.dy)),
            w: p.rect.w, h: p.rect.h,
        };
        const numeric = partIsNumeric(p);
        try {
            let text = await ocrZoneManual(r, { numeric });
            // Si lee la etiqueta o ruido, desplazar el recuadro hasta encontrar el dato
            if (mrwScoreCandidate(text, numeric) < 1 && (numeric || !text.trim())) {
                const found = await mrwLocalSearch(r, numeric);
                if (found.score >= 0.8 && found.text.trim()) {
                    text = found.text;
                    correctedRects[p.id] = found.rect;   // recordar la posición encontrada
                }
            }
            text = applyTransform(text, p.transform);
            if (text) {
                inp.value = text;
                inp.dispatchEvent(new Event('input'));
            }
        } catch (_) {}
    }
}

/** Inicia el dibujo de la zona de identificación. */
function startDrawingId() {
    drawingFor = 'id';
    tplPendingPartId = null;
    const draw = document.getElementById('draw-canvas');
    draw.style.cursor = 'crosshair';
    draw.classList.add('drawing-active');
    document.getElementById('hint-id').classList.add('active');
    document.getElementById('hint-part').classList.remove('active');
}

/** Inicia el dibujo de la zona de una parte OCR concreta. */
function startDrawingPart(partId) {
    drawingFor = 'ocr-part';
    tplPendingPartId = partId;
    const draw = document.getElementById('draw-canvas');
    draw.style.cursor = 'crosshair';
    draw.classList.add('drawing-active');
    document.getElementById('hint-id').classList.remove('active');
    document.getElementById('hint-part').classList.add('active');
    renderTplParts();
}

async function handleZoneDrawn(rect) {
    const which = drawingFor;
    const pid   = tplPendingPartId;
    const corrPart = correctionPart;
    cancelDrawing();

    // ── Corrección de un campo OCR del formulario ─────────────────────────────
    if (which === 'correct-part' && corrPart) {
        const inp = document.getElementById(`inp-part-${corrPart.id}`);
        const btn = document.getElementById(`btn-correct-${corrPart.id}`);
        if (btn) btn.textContent = '⏳ Analizando…';

        let text = await ocrZoneManual(rect, { numeric: partIsNumeric(corrPart) });
        text = applyTransform(text, corrPart.transform);

        if (inp) {
            inp.value = text;
            inp.dispatchEvent(new Event('input'));
            inp.focus();
        }
        if (btn) btn.textContent = text ? '✅ Zona marcada — Redibujar' : '✏️ Marcar zona en el PDF';

        // Guardar la zona dibujada para que el ML aprenda la posición correcta
        correctedRects[corrPart.id] = rect;
        return;
    }

    if (which === 'id') {
        const runEl  = document.getElementById('tpl-ocr-id-running');
        const prevEl = document.getElementById('tpl-id-preview');
        const cardEl = document.getElementById('tpl-id-zone-card');
        if (runEl)  runEl.classList.add('visible');
        const text = await ocrZoneManual(rect);
        if (runEl)  runEl.classList.remove('visible');
        if (cardEl) cardEl.classList.add('filled');
        const statEl = document.getElementById('tpl-id-status');
        if (statEl) statEl.textContent = '✅';
        if (prevEl) {
            prevEl.className  = 'zone-preview' + (text ? '' : ' empty');
            prevEl.textContent = text || '(sin texto — amplía la zona)';
        }
        tplIdZone = { rect, text };
        renderOverlay();
        updateSaveBtn();
        return;
    }

    // Parte OCR
    if (which === 'ocr-part' && pid) {
        const part = tplParts.find(p => p.id === pid);
        if (part) {
            part.rect     = rect;
            part._preview = '';
            part._loading = true;
            renderTplParts();
            renderOverlay();

            const text = await ocrZoneManual(rect);
            const p2 = tplParts.find(p => p.id === pid);
            if (p2) { p2._preview = text; p2._loading = false; }
            renderTplParts();
            updateTplPreview();
        }
        updateSaveBtn();
    }
}

// Worker numérico reutilizable (solo dígitos) — más fiable para números
let _numWorker = null, _numWorkerPromise = null;
async function getNumWorker() {
    if (_numWorker) return _numWorker;
    if (_numWorkerPromise) return _numWorkerPromise;
    _numWorkerPromise = (async () => {
        const w = await Tesseract.createWorker('eng');
        await w.setParameters({ tessedit_char_whitelist: '0123456789-/.', tessedit_pageseg_mode: '7' });
        _numWorker = w; return w;
    })();
    return _numWorkerPromise;
}

async function ocrZoneManual(rect, opts = {}) {
    if (!pdfDoc) return '';
    try {
        const page = await pdfDoc.getPage(1);
        const vp   = page.getViewport({ scale: 3.0 });
        let full = document.createElement('canvas');
        full.width = vp.width; full.height = vp.height;
        await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;
        if (pdfSkewAngle) full = deskewCanvas(full, pdfSkewAngle);  // enderezar igual que la vista

        const zx = rect.x * vp.width, zy = rect.y * vp.height;
        const zw = rect.w * vp.width, zh = rect.h * vp.height;

        // Preprocesado: upscale ×2 + gris + umbral
        const cw = Math.max(1, Math.round(zw * 2)), ch = Math.max(1, Math.round(zh * 2));
        const crop = document.createElement('canvas');
        crop.width = cw; crop.height = ch;
        const cx = crop.getContext('2d');
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.drawImage(full, zx, zy, zw, zh, 0, 0, cw, ch);
        try {
            const im = cx.getImageData(0, 0, cw, ch), d = im.data;
            for (let i = 0; i < d.length; i += 4) {
                const g = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
                const v = g > 145 ? 255 : 0; d[i]=d[i+1]=d[i+2]=v;
            }
            cx.putImageData(im, 0, 0);
        } catch (_) {}

        const url = crop.toDataURL('image/png');
        if (opts.numeric) {
            try {
                const w = await getNumWorker();
                const { data } = await w.recognize(url);
                const t = (data.text || '').replace(/\s+/g, ' ').trim();
                if (t) return t;
            } catch (_) {}
        }
        const { data } = await Tesseract.recognize(url, 'spa');
        return (data.text || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    } catch { return ''; }
}

/** ¿Una parte busca un valor numérico? */
function partIsNumeric(part) {
    if (!part) return false;
    if (part.transform === 'numbers_only' || part.transform === 'strip_zeros') return true;
    const lbl = (part.label || '').toLowerCase();
    return /n[uú]m|numero|pedido|albar|factura|ref|c[oó]digo|importe|nif|cif/.test(lbl);
}

/** Puntúa si un texto es el DATO buscado o una etiqueta/ruido (igual que el procesamiento). */
function mrwScoreCandidate(txt, numeric) {
    if (!txt || !txt.trim()) return -1;
    const t = txt.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const labels = ['albaran','numero','num','fecha','codigo','cliente','pedido','referencia',
                    'descripcion','pagina','copia','cantidad','precio','importe','total','iva',
                    'base','forma','pago','direccion'];
    const isLabel = labels.some(l => t.includes(l));
    if (numeric) {
        const digits = (txt.match(/\d/g) || []).length;
        const letters = (txt.match(/[a-zA-Z]/g) || []).length;
        if (digits < 2) return isLabel ? 0 : 0.1;
        let s = 1 + Math.min(digits, 10) * 0.05 - letters * 0.05;
        if (isLabel) s -= 0.6;
        return s;
    }
    if (isLabel) return 0.2;
    return 0.5 + Math.min(1, txt.trim().length / 12);
}

/** Búsqueda local: desplaza el recuadro por los alrededores hasta encontrar el dato. */
async function mrwLocalSearch(rect, numeric) {
    const dh = rect.h, dw = rect.w;
    const offsets = [
        { dx: 0, dy: 0 }, { dx: 0, dy: dh * 0.9 }, { dx: 0, dy: dh * 1.7 },
        { dx: 0, dy: -dh * 0.9 }, { dx: dw * 0.6, dy: dh * 0.9 }, { dx: -dw * 0.6, dy: dh * 0.9 },
        { dx: dw * 0.6, dy: 0 }, { dx: -dw * 0.6, dy: 0 }, { dx: 0, dy: dh * 0.45 },
    ];
    let best = { text: '', rect, score: -1 };
    for (const o of offsets) {
        const r = {
            x: Math.max(0, Math.min(0.98 - dw, rect.x + o.dx)),
            y: Math.max(0, Math.min(0.98 - dh, rect.y + o.dy)),
            w: dw, h: dh,
        };
        const txt = await ocrZoneManual(r, { numeric });
        const sc  = mrwScoreCandidate(txt, numeric);
        if (sc > best.score) best = { text: txt, rect: r, score: sc };
        if (sc >= 1.2) break;
    }
    return best;
}

// ── Modo creación de plantilla ────────────────────────────────────────────────

function enterTemplateMode() {
    tplMode     = true;
    tplIdZone   = null;
    tplParts    = [];
    tplPendingPartId = null;

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

    // Constructor del formato de nombre (igual que el Motor OCR Zonal)
    const fmtCard = document.createElement('div');
    fmtCard.className = 'card';
    fmtCard.innerHTML = `
        <div class="field-label">Formato del nombre del archivo</div>
        <div class="tpl-parts-builder" id="tpl-parts-list">
            <div class="tpl-parts-empty">Añade partes para componer el nombre</div>
        </div>
        <div class="tpl-parts-add">
            <button class="tpl-btn-add tpl-add-text"   id="tpl-btn-add-text">+ Texto fijo</button>
            <button class="tpl-btn-add tpl-add-ocr"    id="tpl-btn-add-ocr">+ Zona OCR</button>
            <button class="tpl-btn-add tpl-add-search" id="tpl-btn-add-search">+ Búsqueda</button>
        </div>
        <div class="tpl-preview-box" id="tpl-preview-box" style="display:none">
            <span class="tpl-preview-label">Vista previa del nombre:</span>
            <span class="tpl-preview-value empty" id="tpl-preview-value">—</span>
        </div>
    `;
    panel.appendChild(fmtCard);

    // Botón guardar
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-save-tpl';
    saveBtn.id = 'btn-save-tpl';
    saveBtn.disabled = true;
    saveBtn.textContent = '💾 Crear plantilla y continuar';
    panel.appendChild(saveBtn);

    // ── Event listeners ───────────────────────────────────────────────────────
    document.getElementById('btn-back-rename').addEventListener('click', exitTemplateMode);
    document.getElementById('btn-draw-id').addEventListener('click', startDrawingId);

    document.getElementById('tpl-btn-add-text').addEventListener('click', addTplTextPart);
    document.getElementById('tpl-btn-add-ocr').addEventListener('click', addTplOcrPart);
    document.getElementById('tpl-btn-add-search').addEventListener('click', addTplSearchPart);

    document.getElementById('tpl-name').addEventListener('input', updateSaveBtn);
    document.getElementById('btn-save-tpl').addEventListener('click', saveTemplateAndContinue);

    renderTplParts();

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

// ── Constructor de partes del nombre (igual que Motor OCR Zonal) ───────────────
function addTplTextPart() {
    tplParts.push({ id: genTplPartId(), type: 'text', value: '' });
    renderTplParts();
    updateSaveBtn();
}

function addTplOcrPart() {
    if (!pdfDoc) { alert('No hay PDF cargado.'); return; }
    const part = { id: genTplPartId(), type: 'ocr', label: '', transform: 'none', rect: null, _preview: '', _loading: false };
    tplParts.push(part);
    renderTplParts();
    startDrawingPart(part.id);
    updateSaveBtn();
}

function addTplSearchPart() {
    tplParts.push({ id: genTplPartId(), type: 'text-search', label: '', before: '', after: '', transform: 'none' });
    renderTplParts();
    updateSaveBtn();
}

function tplEsc(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderTplParts() {
    const container = document.getElementById('tpl-parts-list');
    if (!container) return;
    if (!tplParts.length) {
        container.innerHTML = '<div class="tpl-parts-empty">Añade partes para componer el nombre</div>';
        updateTplPreview();
        return;
    }

    container.innerHTML = '';
    let ocrIdx = 0;

    tplParts.forEach(part => {
        const card = document.createElement('div');
        const drawingThis = (part.id === tplPendingPartId);

        if (part.type === 'text') {
            card.className = 'tpl-part-card text';
            card.innerHTML = `
                <div class="tpl-part-head">
                    <span class="tpl-part-badge badge-text">📝 Texto fijo</span>
                    <button class="tpl-part-del" data-id="${part.id}">✕</button>
                </div>
                <input type="text" class="tpl-part-input" placeholder="Texto estático (ej: FACTURA , - , / …)" value="${tplEsc(part.value||'')}">
            `;
            card.querySelector('.tpl-part-input').addEventListener('input', e => {
                const p = tplParts.find(x => x.id === part.id);
                if (p) { p.value = e.target.value; updateTplPreview(); }
            });

        } else if (part.type === 'text-search') {
            card.className = 'tpl-part-card search';
            card.innerHTML = `
                <div class="tpl-part-head">
                    <span class="tpl-part-badge badge-search">🔎 Búsqueda de texto</span>
                    <button class="tpl-part-del" data-id="${part.id}">✕</button>
                </div>
                <input type="text" class="tpl-part-input part-label" placeholder="Etiqueta (ej: Número pedido…)" value="${tplEsc(part.label||'')}">
                <div class="tpl-search-hint">💡 Busca el texto que aparece tras una palabra clave en cualquier parte del documento.</div>
                <input type="text" class="tpl-part-input part-before" placeholder="Texto ANTES del dato (ej: PEDIDO NÚM:)" value="${tplEsc(part.before||'')}">
                <input type="text" class="tpl-part-input part-after" placeholder="Texto DESPUÉS (opcional)" value="${tplEsc(part.after||'')}">
                ${tplTransformSelect(part)}
            `;
            card.querySelector('.part-label').addEventListener('input', e => { const p=tplParts.find(x=>x.id===part.id); if(p) p.label=e.target.value; });
            card.querySelector('.part-before').addEventListener('input', e => { const p=tplParts.find(x=>x.id===part.id); if(p){p.before=e.target.value; updateTplPreview();} updateSaveBtn(); });
            card.querySelector('.part-after').addEventListener('input', e => { const p=tplParts.find(x=>x.id===part.id); if(p) p.after=e.target.value; });
            card.querySelector('.tpl-transform')?.addEventListener('change', e => { const p=tplParts.find(x=>x.id===part.id); if(p){p.transform=e.target.value; updateTplPreview();} });

        } else {
            // OCR
            ocrIdx++;
            const myIdx   = ocrIdx;
            const hasZone = part.rect != null;
            card.className = 'tpl-part-card ocr' + (drawingThis ? ' drawing' : '');
            card.innerHTML = `
                <div class="tpl-part-head">
                    <span class="tpl-part-badge badge-ocr">🔍 Zona OCR ${myIdx}</span>
                    <button class="tpl-part-del" data-id="${part.id}">✕</button>
                </div>
                <input type="text" class="tpl-part-input part-label" placeholder="Etiqueta (ej: Número pedido, Fecha…)" value="${tplEsc(part.label||'')}">
                ${drawingThis
                    ? `<div class="tpl-draw-now">⏳ Dibuja la zona en el PDF…</div>`
                    : `<button class="tpl-btn-draw-zone" data-id="${part.id}">${hasZone ? '↺ Redibujar zona' : '✏️ Dibujar zona en el PDF'}</button>`}
                ${hasZone && !drawingThis ? `
                    <div class="tpl-part-ocr ${part._preview ? '' : 'empty'}">
                        ${part._loading ? '⏳ Analizando…' : (part._preview ? '"'+tplEsc(part._preview)+'"' : '(sin texto — amplía la zona)')}
                    </div>
                    ${tplTransformSelect(part)}` : ''}
            `;
            card.querySelector('.part-label').addEventListener('input', e => { const p=tplParts.find(x=>x.id===part.id); if(p) p.label=e.target.value; renderOverlay(); });
            card.querySelector('.tpl-btn-draw-zone')?.addEventListener('click', () => startDrawingPart(part.id));
            card.querySelector('.tpl-transform')?.addEventListener('change', e => { const p=tplParts.find(x=>x.id===part.id); if(p){p.transform=e.target.value; updateTplPreview();} });
        }

        card.querySelector('.tpl-part-del').addEventListener('click', () => {
            if (tplPendingPartId === part.id) cancelDrawing();
            tplParts = tplParts.filter(x => x.id !== part.id);
            renderTplParts();
            renderOverlay();
            updateSaveBtn();
        });

        container.appendChild(card);
    });

    updateTplPreview();
}

function tplTransformSelect(part) {
    const t = part.transform || 'none';
    const opt = (v, lbl) => `<option value="${v}"${t===v?' selected':''}>${lbl}</option>`;
    return `
        <div class="tpl-transform-row">
            <span class="tpl-transform-lbl">Transformar:</span>
            <select class="tpl-transform">
                ${opt('none','Sin cambios')}
                ${opt('strip_zeros','Quitar ceros iniciales')}
                ${opt('upper','MAYÚSCULAS')}
                ${opt('lower','minúsculas')}
                ${opt('replace_slash','/ → -')}
                ${opt('numbers_only','Solo números')}
            </select>
        </div>`;
}

function tplApplyTransform(text, transform) {
    switch (transform) {
        case 'strip_zeros':   return text.replace(/\b0+(\d)/g, '$1');
        case 'upper':         return text.toUpperCase();
        case 'lower':         return text.toLowerCase();
        case 'replace_slash': return text.replace(/\//g, '-');
        case 'numbers_only':  return text.replace(/[^\d]/g, '');
        default:              return text;
    }
}

function updateTplPreview() {
    const box = document.getElementById('tpl-preview-box');
    const val = document.getElementById('tpl-preview-value');
    if (!box || !val) return;
    if (!tplParts.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const preview = tplParts.map(p => {
        if (p.type === 'text') return p.value || '';
        if (p.type === 'text-search') return p.before ? `[${p.label || 'búsqueda'}]` : '';
        const raw = p._preview || (p.rect ? '?' : '');
        return tplApplyTransform(raw, p.transform || 'none');
    }).join('').trim();
    val.textContent = preview ? `${preview}.pdf` : '—';
    val.className   = 'tpl-preview-value' + (preview ? '' : ' empty');
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
    const hasParts  = tplParts.length > 0;
    const partsOk   = tplParts.every(p => {
        if (p.type === 'text')        return true;
        if (p.type === 'ocr')         return p.rect != null;
        if (p.type === 'text-search') return (p.before || '').trim().length > 0;
        return true;
    });
    const typeSel   = document.getElementById('tpl-type-sel')?.value;
    const newName   = (document.getElementById('tpl-new-type-name')?.value || '').trim();
    const newFolder = (document.getElementById('tpl-new-type-folder')?.value || '').trim();
    // Tipo existente → OK. Tipo nuevo → requiere nombre Y carpeta destino.
    const typeOk    = (typeSel && typeSel !== '__new__')
                    || (typeSel === '__new__' && newName.length > 0 && newFolder.length > 0);
    btn.disabled    = !(name && hasParts && partsOk && typeOk);
}

async function saveTemplateAndContinue() {
    const overlay = document.getElementById('tpl-saving-overlay');
    if (overlay) overlay.classList.add('visible');

    try {
        const name     = document.getElementById('tpl-name').value.trim();
        const typeSel  = document.getElementById('tpl-type-sel').value;

        // 1. Construir las partes y guardar la plantilla OCR
        const firstOcrRect = tplParts.find(p => p.type === 'ocr' && p.rect)?.rect;
        const renameParts = tplParts.map(p => {
            if (p.type === 'text') return { id: p.id, type: 'text', value: p.value || '' };
            if (p.type === 'text-search') return {
                id: p.id, type: 'text-search',
                label: p.label || '', before: p.before || '', after: p.after || '',
                transform: p.transform || 'none',
            };
            return { id: p.id, type: 'ocr', page: 0, rect: p.rect, label: p.label || '', transform: p.transform || 'none' };
        });

        const tplResult = await window.manualRenameAPI.saveOcrTemplate({
            nombre:         name,
            identification: tplIdZone
                ? { page: 0, rect: tplIdZone.rect, text: tplIdZone.text || '' }
                : { page: 0, rect: firstOcrRect || { x: 0, y: 0, w: 0.3, h: 0.05 }, text: '' },
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

        // Capturar los valores que el OCR ya extrajo (por id de parte) para pre-rellenar
        const prefillById = {};
        tplParts.forEach(p => {
            if (p.type === 'ocr' && (p._preview || '').trim()) prefillById[p.id] = p._preview.trim();
        });

        // 3. Actualizar estado local y volver al formulario de renombrado
        const updatedTypes = await window.manualRenameAPI.getDocTypes() || [];
        docTypes      = updatedTypes;
        allTemplates  = await window.manualRenameAPI.getOcrTemplates() || [];
        const newType = updatedTypes.find(t => t.id === typeId);
        if (newType) activeType = newType;

        exitTemplateMode();

        // 4. Re-construir el selector de tipo y pre-seleccionar el tipo recién creado
        buildTypeSelector(typeId);

        // 5. Pre-rellenar cada campo OCR con el valor ya detectado durante la creación
        if (activeTpl?.renameParts) {
            for (const part of activeTpl.renameParts) {
                if (part.type !== 'ocr') continue;
                const val = prefillById[part.id];
                if (!val) continue;
                const inp = document.getElementById(`inp-part-${part.id}`);
                if (inp) { inp.value = val; inp.dispatchEvent(new Event('input')); }
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
    tplParts    = [];
    tplPendingPartId = null;
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
