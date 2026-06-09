/**
 * @file Módulo de base de datos SQLite para Zilo
 * @description Gestiona el índice OCR y el sistema de backups usando SQLite con FTS5
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class ZiloDatabase {
    constructor(app) {
        this.app = app;
        this.db = null;
        this.dbPath = null;
    }

    /**
     * Inicializa la base de datos SQLite
     * @param {string} customPath - Ruta personalizada para la base de datos (opcional)
     */
    initialize(customPath = null) {
        try {
            // Cerrar conexión anterior si existe
            if (this.db) {
                console.log('[DB] Cerrando conexión anterior...');
                try {
                    this.db.close();
                } catch (closeError) {
                    console.error('[DB] Error al cerrar conexión anterior:', closeError);
                }
                this.db = null;
            }

            // Determinar la ruta de la base de datos
            if (customPath) {
                // Si hay ruta personalizada, crear subcarpeta ZiloDB
                const customDir = path.dirname(customPath);
                const dbSubfolder = path.join(customDir, 'ZiloDB');
                this.dbPath = path.join(dbSubfolder, path.basename(customPath));
            } else {
                // Ruta por defecto en userData
                this.dbPath = path.join(this.app.getPath('userData'), 'zilo.db');
            }

            console.log(`[DB] Inicializando base de datos en: ${this.dbPath}`);

            // Crear directorio si no existe
            const dbDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            // Abrir conexión a la base de datos
            this.db = new Database(this.dbPath);

            // Configurar pragmas para optimizar rendimiento
            this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging para mejor concurrencia
            this.db.pragma('synchronous = NORMAL'); // Balance entre seguridad y velocidad
            this.db.pragma('foreign_keys = ON'); // Habilitar foreign keys

            // Crear tablas si no existen
            this.createTables();

            console.log('[DB] Base de datos inicializada correctamente');
            return { success: true, path: this.dbPath };
        } catch (error) {
            console.error('[DB ERROR] Error al inicializar base de datos:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Crea las tablas necesarias en la base de datos
     */
    createTables() {
        // Tabla para el índice OCR con búsqueda de texto completo (FTS5)
        this.db.exec(`
            -- Tabla principal de documentos indexados
            CREATE TABLE IF NOT EXISTS ocr_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
                file_name TEXT NOT NULL,
                doc_type TEXT NOT NULL,
                ocr_text TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- Índice de texto completo usando FTS5 para búsqueda rápida
            CREATE VIRTUAL TABLE IF NOT EXISTS ocr_documents_fts USING fts5(
                file_path,
                file_name,
                ocr_text,
                content='ocr_documents',
                content_rowid='id'
            );

            -- Triggers para mantener sincronizado el índice FTS5
            CREATE TRIGGER IF NOT EXISTS ocr_documents_ai AFTER INSERT ON ocr_documents BEGIN
                INSERT INTO ocr_documents_fts(rowid, file_path, file_name, ocr_text)
                VALUES (new.id, new.file_path, new.file_name, new.ocr_text);
            END;

            CREATE TRIGGER IF NOT EXISTS ocr_documents_ad AFTER DELETE ON ocr_documents BEGIN
                DELETE FROM ocr_documents_fts WHERE rowid = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS ocr_documents_au AFTER UPDATE ON ocr_documents BEGIN
                UPDATE ocr_documents_fts
                SET file_path = new.file_path,
                    file_name = new.file_name,
                    ocr_text = new.ocr_text
                WHERE rowid = old.id;
            END;

            -- Tabla de backups
            CREATE TABLE IF NOT EXISTS backups (
                id TEXT PRIMARY KEY,
                original_path TEXT NOT NULL,
                backup_path TEXT NOT NULL,
                processed_file_name TEXT NOT NULL,
                processed_file_path TEXT,
                destination_folder TEXT NOT NULL,
                document_type TEXT,
                mode TEXT,
                timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- Tabla de historial de operaciones
            CREATE TABLE IF NOT EXISTS backup_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                backup_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (backup_id) REFERENCES backups(id) ON DELETE CASCADE
            );

            -- Tipos de documento definidos por el usuario
            CREATE TABLE IF NOT EXISTS doc_types (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                name                TEXT    NOT NULL UNIQUE,
                icon                TEXT    NOT NULL DEFAULT '📄',
                folder              TEXT,
                ocr_template_id     TEXT,
                ocr_template_ids    TEXT    NOT NULL DEFAULT '[]',
                created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- Patrones de renombrado aprendidos automáticamente de ejemplos manuales
            CREATE TABLE IF NOT EXISTS learned_patterns (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                type_name     TEXT    NOT NULL,
                before_kw     TEXT    NOT NULL,
                after_kw      TEXT    NOT NULL DEFAULT '',
                confirmations INTEGER NOT NULL DEFAULT 1,
                last_confirmed DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- Índices para mejorar el rendimiento
            CREATE INDEX IF NOT EXISTS idx_ocr_doc_type ON ocr_documents(doc_type);
            CREATE INDEX IF NOT EXISTS idx_ocr_timestamp ON ocr_documents(timestamp);
            CREATE INDEX IF NOT EXISTS idx_backup_timestamp ON backups(timestamp);
            CREATE INDEX IF NOT EXISTS idx_backup_history_backup_id ON backup_history(backup_id);
            CREATE INDEX IF NOT EXISTS idx_lp_type ON learned_patterns(type_name);
        `);

        // ── Historial de posiciones para aprendizaje adaptativo ──────────────
        this.db.exec(`
            -- Cada fila = una extracción confirmada con éxito
            -- Acumula historial de dónde aparece realmente cada dato en los documentos
            CREATE TABLE IF NOT EXISTS ocr_position_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id TEXT    NOT NULL,
                part_label  TEXT    NOT NULL,   -- label o id de la parte OCR
                page        INTEGER NOT NULL DEFAULT 0,
                norm_x      REAL    NOT NULL,   -- posición normalizada 0-1
                norm_y      REAL    NOT NULL,
                norm_w      REAL    NOT NULL,
                norm_h      REAL    NOT NULL,
                source      TEXT    NOT NULL DEFAULT 'ocr',  -- 'ocr' | 'text_layer' | 'adaptive'
                confirmed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                FOREIGN KEY (template_id) REFERENCES ocr_templates(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pos_hist
                ON ocr_position_history(template_id, part_label, page);
        `);

        // ── Aprendizaje por campo: votos de ancla/lado/patrón ────────────────
        this.db.exec(`
            -- Votos acumulativos por campo. kind ∈ {anchor, side, pattern}.
            -- El valor efectivo de cada kind = el de mayor 'count'.
            CREATE TABLE IF NOT EXISTS ocr_field_votes (
                template_id TEXT    NOT NULL,
                part_label  TEXT    NOT NULL,
                kind        TEXT    NOT NULL,        -- 'anchor' | 'side' | 'pattern'
                value       TEXT    NOT NULL,
                count       INTEGER NOT NULL DEFAULT 0,
                updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                PRIMARY KEY (template_id, part_label, kind, value)
            );
            CREATE INDEX IF NOT EXISTS idx_field_votes
                ON ocr_field_votes(template_id, part_label, kind);

            -- Resultado de cada documento por plantilla (para la confianza de auto).
            -- all_ok = 1 si todos los campos se extrajeron bien y el usuario NO corrigió.
            CREATE TABLE IF NOT EXISTS ocr_template_outcomes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id TEXT    NOT NULL,
                ts          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                all_ok      INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_tpl_outcomes
                ON ocr_template_outcomes(template_id, ts);
        `);

        // ── Tablas de plantillas OCR (migradas desde JSON) ────────────────────
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ocr_templates (
                id            TEXT PRIMARY KEY,
                nombre        TEXT NOT NULL,
                identification TEXT NOT NULL DEFAULT '{}',
                rename_parts  TEXT NOT NULL DEFAULT '[]',
                confirmations INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tpl_nombre ON ocr_templates(nombre);

            -- Patrones pendientes de formalizar (migrados desde JSON)
            CREATE TABLE IF NOT EXISTS pending_patterns (
                id          TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL DEFAULT '[]',
                type_name   TEXT NOT NULL DEFAULT '',
                type_id     INTEGER,
                renames     TEXT NOT NULL DEFAULT '[]',
                count       INTEGER NOT NULL DEFAULT 1,
                promoted    INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pp_type ON pending_patterns(type_name);
            CREATE INDEX IF NOT EXISTS idx_pp_promoted ON pending_patterns(promoted);

            -- Modelo ML: metadatos globales (fila única)
            CREATE TABLE IF NOT EXISTS ml_metadata (
                id          INTEGER PRIMARY KEY CHECK(id = 1),
                total_docs  INTEGER NOT NULL DEFAULT 0,
                version     INTEGER NOT NULL DEFAULT 2,
                last_trained TEXT
            );

            -- Clases del modelo (una por tipo de documento)
            CREATE TABLE IF NOT EXISTS ml_classes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                class_name  TEXT NOT NULL UNIQUE,
                total_words INTEGER NOT NULL DEFAULT 0,
                doc_count   INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_ml_class ON ml_classes(class_name);

            -- Frecuencias de palabras por clase (el "núcleo" del modelo)
            CREATE TABLE IF NOT EXISTS ml_word_counts (
                class_id INTEGER NOT NULL,
                word     TEXT    NOT NULL,
                count    INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (class_id, word),
                FOREIGN KEY (class_id) REFERENCES ml_classes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_wc_word ON ml_word_counts(word);

            -- Frecuencia de documentos (para TF-IDF)
            CREATE TABLE IF NOT EXISTS ml_doc_freq (
                word           TEXT    PRIMARY KEY,
                doc_frequency  INTEGER NOT NULL DEFAULT 1
            );

            -- Corpus de entrenamiento (últimos MAX_CORPUS_SIZE documentos)
            CREATE TABLE IF NOT EXISTS ml_corpus (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                class_name TEXT NOT NULL,
                tokens     TEXT NOT NULL,
                added_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_corpus_class ON ml_corpus(class_name);
        `);

        // ── Migraciones en caliente ────────────────────────────────────────────
        // ocr_template_ids: columna añadida en v1.1 (array de IDs como JSON)
        const dtCols = this.db.prepare("PRAGMA table_info(doc_types)").all();
        if (!dtCols.some(c => c.name === 'ocr_template_ids')) {
            this.db.exec("ALTER TABLE doc_types ADD COLUMN ocr_template_ids TEXT NOT NULL DEFAULT '[]'");
            const rows = this.db.prepare("SELECT id, ocr_template_id FROM doc_types WHERE ocr_template_id IS NOT NULL AND ocr_template_id != ''").all();
            const upd  = this.db.prepare("UPDATE doc_types SET ocr_template_ids=? WHERE id=?");
            for (const row of rows) upd.run(JSON.stringify([row.ocr_template_id]), row.id);
            console.log('[DB] Migración ocr_template_ids completada:', rows.length, 'tipos migrados');
        }

        // ── ocr_templates: CIFs aprendidos de confirmaciones del usuario ───────
        const otCols = this.db.prepare("PRAGMA table_info(ocr_templates)").all();
        if (!otCols.some(c => c.name === 'known_cifs')) {
            this.db.exec("ALTER TABLE ocr_templates ADD COLUMN known_cifs TEXT NOT NULL DEFAULT '[]'");
        }

        // ── ocr_documents: columnas para historial corregible ──────────────────
        const odCols = this.db.prepare("PRAGMA table_info(ocr_documents)").all();
        if (!odCols.some(c => c.name === 'template_id')) {
            this.db.exec("ALTER TABLE ocr_documents ADD COLUMN template_id TEXT");
        }
        if (!odCols.some(c => c.name === 'original_name')) {
            this.db.exec("ALTER TABLE ocr_documents ADD COLUMN original_name TEXT");
        }
        if (!odCols.some(c => c.name === 'mode')) {
            this.db.exec("ALTER TABLE ocr_documents ADD COLUMN mode TEXT");
        }

        // ── Limpieza de historial de posiciones roto ──────────────────────────
        // Antes del fix de la clave estable, las correcciones se grababan con
        // part_label = "undefined"/"part" (claves de fallback). Ese historial no
        // se corresponde con ningún part.id real → lo borramos para empezar limpio.
        try {
            const del = this.db.prepare(
                "DELETE FROM ocr_position_history WHERE part_label IN ('undefined','part','')"
            ).run();
            if (del.changes > 0) {
                console.log('[DB] Historial de posiciones roto eliminado:', del.changes, 'filas');
            }
        } catch (_) { /* tabla puede no existir aún en bases muy antiguas */ }

        // ── Auto-migración desde JSON en primer arranque ───────────────────────
        this._migrateJsonIfNeeded();

        console.log('[DB] Tablas creadas/verificadas correctamente');
    }

    /**
     * Si las tablas nuevas están vacías y existe el JSON correspondiente,
     * migra los datos automáticamente y renombra el JSON como .backup
     */
    _migrateJsonIfNeeded() {
        const userData = this.app.getPath('userData');

        // ── Plantillas OCR ────────────────────────────────────────────────────
        const tplCount = this.db.prepare('SELECT COUNT(*) as n FROM ocr_templates').get().n;
        const tplJson  = path.join(userData, 'zilo-ocr-templates.json');
        if (tplCount === 0 && fs.existsSync(tplJson)) {
            try {
                const data = JSON.parse(fs.readFileSync(tplJson, 'utf8'));
                if (Array.isArray(data) && data.length > 0) {
                    const insert = this.db.prepare(
                        `INSERT OR IGNORE INTO ocr_templates(id, nombre, identification, rename_parts, confirmations, created_at)
                         VALUES (?,?,?,?,?,?)`
                    );
                    const run = this.db.transaction(() => {
                        for (const t of data) {
                            insert.run(
                                t.id,
                                t.nombre || '',
                                JSON.stringify(t.identification || {}),
                                JSON.stringify(t.renameParts   || []),
                                t.confirmations || 0,
                                t.createdAt     || new Date().toISOString()
                            );
                        }
                    });
                    run();
                    fs.renameSync(tplJson, tplJson + '.backup');
                    console.log(`[DB] Migradas ${data.length} plantillas OCR desde JSON`);
                }
            } catch (e) { console.error('[DB] Error migrando plantillas OCR:', e.message); }
        }

        // ── Patrones pendientes ───────────────────────────────────────────────
        const ppCount = this.db.prepare('SELECT COUNT(*) as n FROM pending_patterns').get().n;
        const ppJson  = path.join(userData, 'zilo-pending-patterns.json');
        if (ppCount === 0 && fs.existsSync(ppJson)) {
            try {
                const data = JSON.parse(fs.readFileSync(ppJson, 'utf8'));
                if (Array.isArray(data) && data.length > 0) {
                    const insert = this.db.prepare(
                        `INSERT OR IGNORE INTO pending_patterns(id, fingerprint, type_name, type_id, renames, count, promoted, created_at)
                         VALUES (?,?,?,?,?,?,?,?)`
                    );
                    const run = this.db.transaction(() => {
                        for (const p of data) {
                            insert.run(
                                p.id,
                                JSON.stringify(p.fingerprint || []),
                                p.typeName  || '',
                                p.typeId    || null,
                                JSON.stringify(p.renames || []),
                                p.count     || 1,
                                p.promoted  ? 1 : 0,
                                p.createdAt || new Date().toISOString()
                            );
                        }
                    });
                    run();
                    fs.renameSync(ppJson, ppJson + '.backup');
                    console.log(`[DB] Migrados ${data.length} patrones pendientes desde JSON`);
                }
            } catch (e) { console.error('[DB] Error migrando patrones pendientes:', e.message); }
        }

        // ── Modelo ML ─────────────────────────────────────────────────────────
        const mlCount = this.db.prepare('SELECT COUNT(*) as n FROM ml_metadata').get().n;
        const mlJson  = path.join(userData, 'zilo-ml-model.json');
        if (mlCount === 0 && fs.existsSync(mlJson)) {
            try {
                const model = JSON.parse(fs.readFileSync(mlJson, 'utf8'));
                if (model && model.totalDocs > 0) {
                    this._migrateMLModel(model);
                    fs.renameSync(mlJson, mlJson + '.backup');
                    console.log(`[DB] Modelo ML migrado: ${model.totalDocs} docs, ${Object.keys(model.classes || {}).length} clases`);
                }
            } catch (e) { console.error('[DB] Error migrando modelo ML:', e.message); }
        }
    }

    _migrateMLModel(model) {
        const insertClass   = this.db.prepare(`INSERT OR IGNORE INTO ml_classes(class_name, total_words, doc_count) VALUES (?,?,?)`);
        const getClassId    = this.db.prepare(`SELECT id FROM ml_classes WHERE class_name = ?`);
        const insertWord    = this.db.prepare(`INSERT OR REPLACE INTO ml_word_counts(class_id, word, count) VALUES (?,?,?)`);
        const insertDocFreq = this.db.prepare(`INSERT OR REPLACE INTO ml_doc_freq(word, doc_frequency) VALUES (?,?)`);
        const insertCorpus  = this.db.prepare(`INSERT INTO ml_corpus(class_name, tokens) VALUES (?,?)`);
        const insertMeta    = this.db.prepare(`INSERT OR REPLACE INTO ml_metadata(id, total_docs, version, last_trained) VALUES (1,?,?,?)`);

        const run = this.db.transaction(() => {
            insertMeta.run(model.totalDocs || 0, model.version || 2, model.lastTrained || null);

            for (const [className, cls] of Object.entries(model.classes || {})) {
                insertClass.run(className, cls.totalWords || 0, cls.docCount || 0);
                const classId = getClassId.get(className)?.id;
                if (!classId) continue;
                for (const [word, count] of Object.entries(cls.wordCounts || {})) {
                    insertWord.run(classId, word, count);
                }
            }

            for (const [word, freq] of Object.entries(model.docFreq || {})) {
                insertDocFreq.run(word, freq);
            }

            for (const entry of (model.corpus || [])) {
                insertCorpus.run(entry.className, entry.tokens);
            }
        });
        run();
    }

    // =========================================================================
    // MÉTODOS PARA ÍNDICE OCR
    // =========================================================================

    /**
     * Añade un documento al índice OCR
     * @param {string} filePath - Ruta completa del archivo
     * @param {string} fileName - Nombre del archivo
     * @param {string} ocrText - Texto extraído por OCR
     * @param {string} docType - Tipo de documento
     * @returns {object} - Resultado de la operación
     */
    addOcrDocument(filePath, fileName, ocrText, docType, templateId = null, originalName = null, mode = null) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO ocr_documents (file_path, file_name, doc_type, ocr_text, timestamp, template_id, original_name, mode)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const timestamp = new Date().toISOString();
            stmt.run(filePath, fileName, docType, ocrText, timestamp, templateId, originalName, mode);

            console.log(`[DB] Documento aniadido al indice: ${fileName}`);
            return { success: true };
        } catch (error) {
            console.error('[DB ERROR] Error al aniadir documento:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Devuelve los últimos N documentos procesados (para el historial corregible).
     */
    getRecentDocuments(limit = 15) {
        try {
            const rows = this.db.prepare(`
                SELECT file_path, file_name, doc_type, ocr_text, timestamp, template_id, original_name, mode
                FROM ocr_documents
                ORDER BY timestamp DESC
                LIMIT ?
            `).all(limit);
            return { success: true, results: rows };
        } catch (error) {
            console.error('[DB ERROR] getRecentDocuments:', error);
            return { success: false, error: error.message, results: [] };
        }
    }

    /**
     * Borra las posiciones APRENDIDAS AUTOMÁTICAMENTE (no las del usuario) de una
     * parte concreta. Se usa cuando el usuario corrige: así Zilo "olvida" dónde
     * leía mal y deja de repetir el error.
     */
    clearAutoPositions(templateId, partLabel, page) {
        try {
            const r = this.db.prepare(`
                DELETE FROM ocr_position_history
                WHERE template_id=? AND part_label=? AND page=?
                  AND source NOT IN ('user_drawn','text_layer_manual')
            `).run(templateId, partLabel, page);
            return { success: true, deleted: r.changes };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Elimina un documento del índice OCR por su ruta
     * @param {string} filePath - Ruta del archivo a eliminar
     * @returns {object} - Resultado de la operación
     */
    removeOcrDocument(filePath) {
        try {
            const stmt = this.db.prepare('DELETE FROM ocr_documents WHERE file_path = ?');
            const result = stmt.run(filePath);

            console.log(`[DB] Documento eliminado del indice: ${filePath}`);
            return { success: true, changes: result.changes };
        } catch (error) {
            console.error('[DB ERROR] Error al eliminar documento:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Busca documentos usando texto completo (FTS5)
     * @param {string[]} searchTerms - Array de términos de búsqueda
     * @returns {object} - Resultado con array de documentos encontrados
     */
    searchOcrDocuments(searchTerms) {
        try {
            if (!searchTerms || searchTerms.length === 0) {
                return { success: true, results: [] };
            }

            // Construir query FTS5
            // Los términos se buscan en cascada (AND logic)
            const query = searchTerms.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND ');

            const stmt = this.db.prepare(`
                SELECT
                    d.id,
                    d.file_path,
                    d.file_name,
                    d.doc_type,
                    d.ocr_text,
                    d.timestamp,
                    snippet(ocr_documents_fts, 2, '<mark>', '</mark>', '...', 64) as snippet
                FROM ocr_documents d
                INNER JOIN ocr_documents_fts fts ON d.id = fts.rowid
                WHERE ocr_documents_fts MATCH ?
                ORDER BY d.timestamp DESC
            `);

            const results = stmt.all(query);

            console.log(`[DB] Busqueda completada: ${results.length} resultados para "${query}"`);
            return { success: true, results };
        } catch (error) {
            console.error('[DB ERROR] Error en busqueda:', error);
            return { success: false, error: error.message, results: [] };
        }
    }

    /**
     * Obtiene todos los documentos indexados
     * @returns {object} - Resultado con array de todos los documentos
     */
    getAllOcrDocuments() {
        try {
            const stmt = this.db.prepare(`
                SELECT * FROM ocr_documents
                ORDER BY timestamp DESC
            `);

            const results = stmt.all();

            console.log(`[DB] Documentos indexados: ${results.length}`);
            return { success: true, results };
        } catch (error) {
            console.error('[DB ERROR] Error al obtener documentos:', error);
            return { success: false, error: error.message, results: [] };
        }
    }

    /**
     * Obtiene el número total de documentos indexados
     * @returns {number} - Número de documentos
     */
    getOcrDocumentCount() {
        try {
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM ocr_documents');
            const result = stmt.get();
            return result.count;
        } catch (error) {
            console.error('[DB ERROR] Error al contar documentos:', error);
            return 0;
        }
    }

    // =========================================================================
    // MÉTODOS PARA BACKUPS
    // =========================================================================

    /**
     * Crea un registro de backup
     * @param {object} backupData - Datos del backup
     * @returns {object} - Resultado con el ID del backup
     */
    createBackup(backupData) {
        try {
            const stmt = this.db.prepare(`
                INSERT INTO backups (id, original_path, backup_path, processed_file_name,
                                    processed_file_path, destination_folder, document_type, mode, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            stmt.run(
                backupData.id,
                backupData.originalPath,
                backupData.backupPath,
                backupData.processedFileName,
                backupData.processedFilePath || null,
                backupData.destinationFolder,
                backupData.documentType || null,
                backupData.mode || null,
                backupData.timestamp
            );

            console.log(`[DB] Backup creado: ${backupData.id}`);
            return { success: true, id: backupData.id };
        } catch (error) {
            console.error('[DB ERROR] Error al crear backup:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Añade una entrada al historial de operaciones
     * @param {string} backupId - ID del backup
     * @param {string} operation - Tipo de operación (move, rename, restore)
     * @returns {object} - Resultado de la operación
     */
    addBackupHistory(backupId, operation) {
        try {
            const stmt = this.db.prepare(`
                INSERT INTO backup_history (backup_id, operation, timestamp)
                VALUES (?, ?, ?)
            `);

            const timestamp = new Date().toISOString();
            stmt.run(backupId, operation, timestamp);

            return { success: true };
        } catch (error) {
            console.error('[DB ERROR] Error al añadir historial:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Obtiene un backup por su ID
     * @param {string} backupId - ID del backup
     * @returns {object|null} - Datos del backup o null si no existe
     */
    getBackupById(backupId) {
        try {
            const stmt = this.db.prepare('SELECT * FROM backups WHERE id = ?');
            const result = stmt.get(backupId);
            return result || null;
        } catch (error) {
            console.error('[DB ERROR] Error al obtener backup:', error);
            return null;
        }
    }

    /**
     * Obtiene todos los backups ordenados por fecha
     * @param {number} limit - Límite de resultados (opcional)
     * @returns {array} - Array de backups
     */
    getAllBackups(limit = null) {
        try {
            let query = 'SELECT * FROM backups ORDER BY timestamp DESC';
            if (limit) {
                query += ` LIMIT ${limit}`;
            }

            const stmt = this.db.prepare(query);
            const results = stmt.all();

            return results;
        } catch (error) {
            console.error('[DB ERROR] Error al obtener backups:', error);
            return [];
        }
    }

    /**
     * Elimina un backup por su ID
     * @param {string} backupId - ID del backup
     * @returns {object} - Resultado de la operación
     */
    deleteBackup(backupId) {
        try {
            const stmt = this.db.prepare('DELETE FROM backups WHERE id = ?');
            const result = stmt.run(backupId);

            console.log(`[DB] Backup eliminado: ${backupId}`);
            return { success: true, changes: result.changes };
        } catch (error) {
            console.error('[DB ERROR] Error al eliminar backup:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Elimina todos los backups
     * @returns {object} - Resultado de la operación
     */
    clearAllBackups() {
        try {
            const stmt = this.db.prepare('DELETE FROM backups');
            const result = stmt.run();

            console.log(`[DB] Todos los backups eliminados: ${result.changes} registros`);
            return { success: true, changes: result.changes };
        } catch (error) {
            console.error('[DB ERROR] Error al limpiar backups:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Elimina backups más antiguos que una fecha específica
     * @param {Date} beforeDate - Fecha límite
     * @returns {object} - Resultado de la operación
     */
    deleteBackupsOlderThan(beforeDate) {
        try {
            const stmt = this.db.prepare('DELETE FROM backups WHERE timestamp < ?');
            const result = stmt.run(beforeDate.toISOString());

            console.log(`[DB] Backups antiguos eliminados: ${result.changes} registros`);
            return { success: true, changes: result.changes };
        } catch (error) {
            console.error('[DB ERROR] Error al limpiar backups antiguos:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Obtiene estadísticas de backups
     * @returns {object} - Estadísticas
     */
    getBackupStats() {
        try {
            const stmt = this.db.prepare(`
                SELECT
                    COUNT(*) as total,
                    MIN(timestamp) as oldest,
                    MAX(timestamp) as newest
                FROM backups
            `);

            const result = stmt.get();
            return {
                total: result.total,
                oldest: result.oldest,
                newest: result.newest
            };
        } catch (error) {
            console.error('[DB ERROR] Error al obtener estadísticas:', error);
            return { total: 0, oldest: null, newest: null };
        }
    }

    // =========================================================================
    // UTILIDADES
    // =========================================================================

    /**
     * Ejecuta una transacción
     * @param {Function} callback - Función que contiene las operaciones de la transacción
     * @returns {any} - Resultado de la transacción
     */
    transaction(callback) {
        return this.db.transaction(callback)();
    }

    /**
     * Cierra la conexión a la base de datos
     */
    close() {
        if (this.db) {
            this.db.close();
            console.log('[DB] Conexion cerrada');
        }
    }

    /**
     * Realiza un backup de la base de datos
     * @param {string} backupPath - Ruta donde guardar el backup
     * @returns {object} - Resultado de la operación
     */
    backupDatabase(backupPath) {
        try {
            const backup = this.db.backup(backupPath);
            backup.close();

            console.log(`[DB] Backup de base de datos creado en: ${backupPath}`);
            return { success: true, path: backupPath };
        } catch (error) {
            console.error('[DB ERROR] Error al hacer backup de la base de datos:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Optimiza la base de datos (VACUUM)
     */
    optimize() {
        try {
            this.db.exec('VACUUM');
            console.log('[DB] Base de datos optimizada');
            return { success: true };
        } catch (error) {
            console.error('[DB ERROR] Error al optimizar base de datos:', error);
            return { success: false, error: error.message };
        }
    }

    // =========================================================================
    // APRENDIZAJE DE PATRONES DE RENOMBRADO
    // =========================================================================

    /** Elimina acentos y normaliza espacios para comparacion robusta con OCR. */
    _normalizeForSearch(text) {
        return text
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/\s+/g, ' ')
            .toLowerCase()
            .trim();
    }

    /**
     * Aprende donde esta el texto de renombrado dentro del OCR a partir de
     * un ejemplo manual. Guarda la(s) palabra(s) clave que preceden al numero;
     * en futuros documentos se usan para localizar el dato automaticamente.
     *
     * @param {string} typeName  - Nombre del tipo (ej: "ALBARAN")
     * @param {string} ocrText   - Texto OCR completo del documento
     * @param {string} finalName - Nombre final dado por el usuario (ej: "1-13770 ALBARAN.pdf")
     */
    learnRenamePattern(typeName, ocrText, finalName) {
        try {
            if (!typeName?.trim() || !ocrText?.trim() || !finalName?.trim()) return { success: false };

            // 1. Extraer la parte de renombrado del nombre de archivo
            const baseName = finalName.replace(/\.pdf$/i, '').trim();

            // Prioridad: detectar directamente el patrón numérico de documento
            // (serie-codigo, como "1-13770", "2024/00123", "DUA-2024/001")
            // Esto es más robusto que quitar el nombre del tipo, porque el usuario
            // podría escribir el nombre en cualquier orden.
            const numMatch = baseName.match(/\b([A-Z0-9][\w\-\/\.]*\d[\w\-\/\.]*\d[\w\-\/\.]*)\b/);
            let renamePart = '';
            if (numMatch) {
                renamePart = numMatch[1].trim();
            } else {
                // Fallback: quitar el nombre del tipo y quedarse con lo que sobra
                const escapedType = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                renamePart = baseName.replace(new RegExp(`\\s*${escapedType}\\s*`, 'gi'), '').trim();
            }
            if (!renamePart || renamePart.length < 2) return { success: false, reason: 'no_rename_part' };

            // 2. Normalizar OCR para busqueda robusta
            const normOcr    = this._normalizeForSearch(ocrText);
            const normRename = this._normalizeForSearch(renamePart);

            // 3. Candidatos de busqueda (varias formas del numero en el OCR)
            const digits = renamePart.replace(/\D/g, '');
            const candidates = [normRename];
            if (digits.length >= 4) {
                const s = digits.charAt(0), c = digits.slice(1);
                candidates.push(digits, `${s} ${c}`, `${s}/${c}`, `${s} 0${c}`, `${s}0${c}`);
            }

            // 4. Localizar en el OCR normalizado
            let foundPos = -1, matchedLen = normRename.length;
            for (const cand of candidates) {
                const pos = normOcr.indexOf(cand);
                if (pos !== -1) { foundPos = pos; matchedLen = cand.length; break; }
            }

            // 4b. Regex flexible como ultimo recurso
            if (foundPos === -1 && digits.length >= 4) {
                const regStr = digits.split('').join('[\\s\\-\\/]?0{0,1}');
                try {
                    const m = normOcr.match(new RegExp(regStr, 'i'));
                    if (m) { foundPos = m.index; matchedLen = m[0].length; }
                } catch (_) {}
            }

            if (foundPos === -1) return { success: false, reason: 'not_found_in_ocr' };

            // 5. Keyword ANTES del numero (ultimas 2 palabras no numericas)
            const beforeCtx   = normOcr.slice(Math.max(0, foundPos - 80), foundPos).trim();
            const beforeWords = beforeCtx.split(/\s+/).filter(w => w.length >= 3 && /[a-z]/.test(w));
            const beforeKw    = beforeWords.slice(-2).join(' ').trim();
            if (!beforeKw) return { success: false, reason: 'no_before_keyword' };

            // 6. Keyword DESPUES (primera palabra no numerica, opcional)
            const afterCtx   = normOcr.slice(foundPos + matchedLen, foundPos + matchedLen + 60).replace(/^[\s:]+/, '');
            const afterWords = afterCtx.split(/\s+/).filter(w => w.length >= 3 && /[a-z]/.test(w));
            const afterKw    = (afterWords[0] || '').trim();

            // 7. Guardar o incrementar confirmaciones
            const existing = this.db.prepare(
                'SELECT id, confirmations FROM learned_patterns WHERE type_name=? AND before_kw=?'
            ).get(typeName, beforeKw);

            if (existing) {
                this.db.prepare(
                    `UPDATE learned_patterns
                     SET confirmations=confirmations+1, after_kw=?, last_confirmed=CURRENT_TIMESTAMP
                     WHERE id=?`
                ).run(afterKw, existing.id);
                const newCount = existing.confirmations + 1;
                console.log(`[Pattern] "${typeName}" confirmado: "${beforeKw}" (x${newCount})`);
                return { success: true, action: 'confirmed', id: existing.id, confirmations: newCount };
            } else {
                const r = this.db.prepare(
                    'INSERT INTO learned_patterns (type_name, before_kw, after_kw) VALUES (?, ?, ?)'
                ).run(typeName, beforeKw, afterKw);
                console.log(`[Pattern] "${typeName}" nuevo: "${beforeKw}" -> "${afterKw}"`);
                return { success: true, action: 'created', id: r.lastInsertRowid, confirmations: 1 };
            }
        } catch (e) {
            console.error('[DB] Error en learnRenamePattern:', e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * Devuelve patrones aprendidos para un tipo (>=2 confirmaciones),
     * ordenados por numero de confirmaciones descendente.
     */
    getLearnedPatterns(typeName) {
        try {
            return this.db.prepare(
                `SELECT * FROM learned_patterns
                 WHERE type_name=? AND confirmations >= 2
                 ORDER BY confirmations DESC`
            ).all(typeName || '');
        } catch (e) {
            console.error('[DB] Error en getLearnedPatterns:', e.message);
            return [];
        }
    }

    // =========================================================================
    // PLANTILLAS OCR
    // =========================================================================

    getAllTemplates() {
        const rows = this.db.prepare('SELECT * FROM ocr_templates ORDER BY created_at ASC').all();
        return rows.map(r => {
            let parts = [];
            try { parts = JSON.parse(r.rename_parts || '[]'); } catch (_) { parts = []; }
            // Migración en caliente: las plantillas antiguas guardaron partes sin
            // `id`. Asignamos uno estable y determinista por índice para que el
            // aprendizaje por corrección use una clave consistente.
            parts = parts.map((p, idx) => (p && p.id) ? p : { ...(p || {}), id: `ocr-${idx}` });
            return {
                id:             r.id,
                nombre:         r.nombre,
                identification: JSON.parse(r.identification || '{}'),
                renameParts:    parts,
                confirmations:  r.confirmations,
                knownCifs:      (() => { try { return JSON.parse(r.known_cifs || '[]'); } catch { return []; } })(),
                createdAt:      r.created_at,
            };
        });
    }

    /**
     * Aprende que un CIF/NIF pertenece a esta plantilla (desde una confirmación
     * del usuario). Así, aunque la captura inicial del CIF fuera mala, Zilo
     * acumula los CIF reales de los documentos que el usuario asigna.
     */
    addTemplateCif(templateId, cif) {
        try {
            const clean = (cif || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            if (clean.replace(/[^0-9]/g, '').length < 7) return { success: false };
            const row = this.db.prepare('SELECT known_cifs FROM ocr_templates WHERE id=?').get(templateId);
            if (!row) return { success: false };
            let list = [];
            try { list = JSON.parse(row.known_cifs || '[]'); } catch (_) { list = []; }
            if (!list.includes(clean)) {
                list.push(clean);
                if (list.length > 30) list = list.slice(-30);
                this.db.prepare('UPDATE ocr_templates SET known_cifs=? WHERE id=?').run(JSON.stringify(list), templateId);
                return { success: true, learned: true, cif: clean };
            }
            return { success: true, learned: false };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    saveTemplate(data) {
        const id  = data.id || `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const existing = this.db.prepare('SELECT confirmations, created_at FROM ocr_templates WHERE id = ?').get(id);
        this.db.prepare(`
            INSERT INTO ocr_templates(id, nombre, identification, rename_parts, confirmations, created_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                nombre         = excluded.nombre,
                identification = excluded.identification,
                rename_parts   = excluded.rename_parts
        `).run(
            id,
            data.nombre || '',
            JSON.stringify(data.identification || {}),
            JSON.stringify(data.renameParts    || []),
            existing?.confirmations || 0,
            existing?.created_at    || new Date().toISOString()
        );
        console.log(`[OCR-ZONAL] Plantilla guardada: "${data.nombre}" (${id})`);
        return { success: true, id };
    }

    deleteTemplate(id) {
        const r = this.db.prepare('DELETE FROM ocr_templates WHERE id = ?').run(id);
        console.log(`[OCR-ZONAL] Plantilla eliminada: ${id}`);
        return { success: true, deleted: r.changes > 0 };
    }

    incrementTemplateConfirmations(id) {
        const r = this.db.prepare(
            'UPDATE ocr_templates SET confirmations = confirmations + 1 WHERE id = ?'
        ).run(id);
        if (!r.changes) return { success: false };
        const tpl = this.db.prepare('SELECT confirmations FROM ocr_templates WHERE id = ?').get(id);
        return { success: true, confirmations: tpl?.confirmations || 0 };
    }

    // =========================================================================
    // PATRONES PENDIENTES
    // =========================================================================

    getPendingPatterns() {
        const rows = this.db.prepare('SELECT * FROM pending_patterns ORDER BY created_at ASC').all();
        return rows.map(r => ({
            id:          r.id,
            fingerprint: JSON.parse(r.fingerprint || '[]'),
            typeName:    r.type_name,
            typeId:      r.type_id,
            renames:     JSON.parse(r.renames || '[]'),
            count:       r.count,
            promoted:    r.promoted === 1,
            createdAt:   r.created_at,
        }));
    }

    addPendingPattern({ fingerprint, typeName, typeId, finalName }) {
        // Cargar todos los no-promovidos para buscar similitud
        const existing = this.getPendingPatterns().filter(p => !p.promoted);
        const entry    = { finalName, date: new Date().toISOString() };

        const match = existing.find(p =>
            _fingerprintSimilarity(p.fingerprint, fingerprint) >= 0.4
        );

        if (match) {
            const newFp      = [...new Set([...match.fingerprint, ...fingerprint])].slice(0, 30);
            const newRenames = [entry, ...match.renames].slice(0, 10);
            this.db.prepare(`
                UPDATE pending_patterns
                SET fingerprint = ?, renames = ?, count = count + 1,
                    type_name = COALESCE(NULLIF(type_name,''), ?),
                    type_id   = COALESCE(type_id, ?)
                WHERE id = ?
            `).run(JSON.stringify(newFp), JSON.stringify(newRenames), typeName || '', typeId || null, match.id);
        } else {
            this.db.prepare(`
                INSERT INTO pending_patterns(id, fingerprint, type_name, type_id, renames, count, promoted, created_at)
                VALUES (?,?,?,?,?,1,0,?)
            `).run(
                `pp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                JSON.stringify((fingerprint || []).slice(0, 30)),
                typeName  || '',
                typeId    || null,
                JSON.stringify([entry]),
                new Date().toISOString()
            );
        }
        return { success: true };
    }

    deletePendingPattern(id) {
        this.db.prepare('DELETE FROM pending_patterns WHERE id = ?').run(id);
        return { success: true };
    }

    promotePendingPattern(id) {
        this.db.prepare('UPDATE pending_patterns SET promoted = 1 WHERE id = ?').run(id);
        return { success: true };
    }

    // =========================================================================
    // MODELO ML (persistencia incremental)
    // =========================================================================

    /**
     * Carga el modelo ML completo desde SQLite en la estructura en memoria
     * que espera MLEngine. Devuelve null si no hay datos.
     */
    mlLoad() {
        const meta = this.db.prepare('SELECT * FROM ml_metadata WHERE id = 1').get();
        if (!meta) return null;

        const model = {
            version:     meta.version,
            totalDocs:   meta.total_docs,
            lastTrained: meta.last_trained,
            classes:     {},
            docFreq:     {},
            corpus:      [],
        };

        // Clases y word counts — un solo JOIN en vez de N queries
        const classes = this.db.prepare('SELECT * FROM ml_classes').all();
        for (const cls of classes) {
            model.classes[cls.class_name] = {
                wordCounts: {},
                totalWords: cls.total_words,
                docCount:   cls.doc_count,
            };
        }
        const allWords = this.db.prepare(
            'SELECT c.class_name, wc.word, wc.count FROM ml_word_counts wc JOIN ml_classes c ON wc.class_id = c.id'
        ).all();
        for (const w of allWords) {
            if (model.classes[w.class_name]) {
                model.classes[w.class_name].wordCounts[w.word] = w.count;
            }
        }

        // Document frequency
        const docFreqs = this.db.prepare('SELECT word, doc_frequency FROM ml_doc_freq').all();
        for (const d of docFreqs) model.docFreq[d.word] = d.doc_frequency;

        // Corpus
        const corpus = this.db.prepare('SELECT class_name, tokens FROM ml_corpus ORDER BY id ASC').all();
        model.corpus = corpus.map(c => ({ className: c.class_name, tokens: c.tokens }));

        return model;
    }

    /**
     * Prepara los statements de entrenamiento ML una sola vez (llamado desde initialize).
     */
    _prepareMlStatements() {
        this._mlStmt = {
            upsertClass:  this.db.prepare(`INSERT INTO ml_classes(class_name, total_words, doc_count) VALUES (?,0,0) ON CONFLICT(class_name) DO NOTHING`),
            updateClass:  this.db.prepare(`UPDATE ml_classes SET total_words = total_words + ?, doc_count = doc_count + 1 WHERE class_name = ?`),
            getClassId:   this.db.prepare(`SELECT id FROM ml_classes WHERE class_name = ?`),
            upsertWord:   this.db.prepare(`INSERT INTO ml_word_counts(class_id, word, count) VALUES (?,?,?) ON CONFLICT(class_id, word) DO UPDATE SET count = count + excluded.count`),
            upsertFreq:   this.db.prepare(`INSERT INTO ml_doc_freq(word, doc_frequency) VALUES (?,1) ON CONFLICT(word) DO UPDATE SET doc_frequency = doc_frequency + 1`),
            insertCorpus: this.db.prepare(`INSERT INTO ml_corpus(class_name, tokens) VALUES (?,?)`),
            countCorpus:  this.db.prepare(`SELECT COUNT(*) as n FROM ml_corpus`),
            getOldest:    this.db.prepare(`
                SELECT mc.id FROM ml_corpus mc
                JOIN (SELECT class_name FROM ml_corpus GROUP BY class_name ORDER BY COUNT(*) DESC LIMIT 1) top
                  ON mc.class_name = top.class_name
                ORDER BY mc.id ASC LIMIT 1
            `),
            deleteCorpus: this.db.prepare(`DELETE FROM ml_corpus WHERE id = ?`),
            upsertMeta:   this.db.prepare(`INSERT OR REPLACE INTO ml_metadata(id, total_docs, version, last_trained) VALUES (1,?,2,?)`),
        };
    }

    /**
     * Persiste una sesión de entrenamiento de forma incremental.
     * Recibe los deltas exactos para no reescribir todo el modelo.
     */
    mlSaveTrain({ className, tf, uniqueTokens, totalDocs, lastTrained, corpusEntry, maxCorpusSize }) {
        if (!this._mlStmt) this._prepareMlStatements();
        const s = this._mlStmt;
        const totalTfWords = Object.values(tf).reduce((a, v) => a + v, 0);

        this.db.transaction(() => {
            s.upsertClass.run(className);
            s.updateClass.run(totalTfWords, className);
            const classId = s.getClassId.get(className)?.id;
            if (classId) {
                for (const [word, count] of Object.entries(tf)) {
                    s.upsertWord.run(classId, word, count);
                }
            }
            for (const word of uniqueTokens) s.upsertFreq.run(word);

            s.insertCorpus.run(corpusEntry.className, corpusEntry.tokens);
            if (s.countCorpus.get().n > maxCorpusSize) {
                const old = s.getOldest.get();
                if (old) s.deleteCorpus.run(old.id);
            }

            s.upsertMeta.run(totalDocs, lastTrained);
        })();
    }

    mlGetStats() {
        const meta = this.db.prepare('SELECT * FROM ml_metadata WHERE id = 1').get();
        if (!meta) return { totalDocs: 0, classCount: 0, vocabSize: 0, classes: {} };

        const classes   = this.db.prepare('SELECT * FROM ml_classes').all();
        const vocabSize = this.db.prepare('SELECT COUNT(*) as n FROM ml_doc_freq').get().n;
        const result    = {
            totalDocs:  meta.total_docs,
            classCount: classes.length,
            vocabSize,
            lastTrained: meta.last_trained,
            classes: {},
        };
        for (const c of classes) {
            const q = Math.min(100, Math.round((c.doc_count / 50) * 100));
            result.classes[c.class_name] = {
                docCount:    c.doc_count,
                wordCount:   c.total_words,
                quality:     c.doc_count >= 50 ? 'excelente' : c.doc_count >= 15 ? 'buena' : c.doc_count >= 5 ? 'mejorando' : 'insuficiente',
                qualityPct:  q,
                qualityIcon: c.doc_count >= 50 ? '⭐' : c.doc_count >= 15 ? '🎓' : c.doc_count >= 5 ? '📈' : '🌱',
            };
        }
        return result;
    }

    mlDeleteClass(className) {
        const cls = this.db.prepare('SELECT id FROM ml_classes WHERE class_name = ?').get(className);
        if (!cls) return { success: false };
        this.db.prepare('DELETE FROM ml_classes WHERE id = ?').run(cls.id);
        this.db.prepare('DELETE FROM ml_corpus WHERE class_name = ?').run(className);
        // Recalcular totalDocs
        const total = this.db.prepare('SELECT SUM(doc_count) as n FROM ml_classes').get().n || 0;
        this.db.prepare('UPDATE ml_metadata SET total_docs = ? WHERE id = 1').run(total);
        return { success: true };
    }

    mlReset() {
        this.db.transaction(() => {
            this.db.exec('DELETE FROM ml_word_counts');
            this.db.exec('DELETE FROM ml_classes');
            this.db.exec('DELETE FROM ml_doc_freq');
            this.db.exec('DELETE FROM ml_corpus');
            this.db.exec('DELETE FROM ml_metadata');
        })();
        return { success: true };
    }

    // =========================================================================
    // APRENDIZAJE ADAPTATIVO DE POSICIONES OCR
    // =========================================================================

    /**
     * Registra dónde se encontró realmente el texto en el documento.
     * Mantiene un buffer de máximo MAX_POS_HISTORY posiciones por (template, part, page).
     *
     * @param {string} templateId
     * @param {string} partLabel    - Etiqueta o ID de la parte OCR
     * @param {number} page         - Página 0-indexed
     * @param {{x,y,w,h}} rect      - Posición normalizada (0-1) donde se encontró el texto
     * @param {string} source       - 'ocr' | 'text_layer' | 'adaptive'
     */
    recordPartPosition(templateId, partLabel, page, rect, source = 'ocr') {
        if (!templateId || !partLabel || !rect) return { success: false };
        const MAX_POS_HISTORY = 50;

        // Si es una corrección del usuario, OLVIDAR las posiciones automáticas
        // erróneas: así Zilo entiende que lo hacía mal y deja de repetir el fallo.
        if (source === 'user_drawn' || source === 'text_layer_manual') {
            this.clearAutoPositions(templateId, partLabel, page);
        }

        // Mantener solo las últimas MAX_POS_HISTORY por (template, part, page)
        const n = this.db.prepare(
            `SELECT COUNT(*) as n FROM ocr_position_history
             WHERE template_id=? AND part_label=? AND page=?`
        ).get(templateId, partLabel, page).n;

        if (n >= MAX_POS_HISTORY) {
            const oldest = this.db.prepare(
                `SELECT id FROM ocr_position_history
                 WHERE template_id=? AND part_label=? AND page=?
                 ORDER BY confirmed_at ASC LIMIT 1`
            ).get(templateId, partLabel, page);
            if (oldest) this.db.prepare('DELETE FROM ocr_position_history WHERE id=?').run(oldest.id);
        }

        this.db.prepare(
            `INSERT INTO ocr_position_history
             (template_id, part_label, page, norm_x, norm_y, norm_w, norm_h, source)
             VALUES (?,?,?,?,?,?,?,?)`
        ).run(templateId, partLabel, page,
              Math.max(0, rect.x || 0),
              Math.max(0, rect.y || 0),
              Math.max(0.005, rect.w || 0.05),
              Math.max(0.003, rect.h || 0.02),
              source);

        return { success: true };
    }

    /**
     * Calcula la zona adaptativa para (templateId, partLabel, page) basándose
     * en el historial de posiciones confirmadas.
     *
     * Algoritmo:
     *  - Media ponderada con decaimiento exponencial (el más reciente pesa más)
     *  - Zona final = centro aprendido ± max(mitad_original, 1.5 * desviación_típica)
     *  - Retorna null si hay menos de MIN_HISTORY confirmaciones
     *
     * @returns {{ x, y, w, h, confidence, spreadX, spreadY } | null}
     */
    getAdaptiveZone(templateId, partLabel, page, originalRect) {
        const allHistory = this.db.prepare(
            `SELECT norm_x, norm_y, norm_w, norm_h, source
             FROM ocr_position_history
             WHERE template_id=? AND part_label=? AND page=?
             ORDER BY confirmed_at DESC LIMIT 25`
        ).all(templateId, partLabel, page);

        if (!allHistory.length) return null;

        // ── MEDIA PONDERADA de TODAS las posiciones ────────────────────────────
        // Las correcciones del usuario pesan mucho (PESO_USUARIO), las lecturas
        // automáticas afinan poco a poco. Así la zona converge a la posición real
        // sin que un único punto la reemplace de golpe ni que las lecturas malas
        // la arruinen. (Las posiciones automáticas erróneas previas ya se han
        // borrado al corregir, así que aquí solo quedan datos buenos.)
        const USER_SOURCES   = new Set(['user_drawn', 'text_layer_manual']);
        const PESO_USUARIO   = 25;   // una corrección tuya pesa como 25 lecturas auto
        const userConfirmed  = allHistory.some(h => USER_SOURCES.has(h.source));
        const MIN_HISTORY    = userConfirmed ? 1 : 3;

        if (allHistory.length < MIN_HISTORY) return null;

        const history = allHistory;
        const n       = history.length;
        const decay   = 0.10;   // decaimiento por antigüedad
        const weights = history.map((h, i) => {
            const recency = Math.exp(-i * decay);
            const src     = USER_SOURCES.has(h.source) ? PESO_USUARIO : 1;
            return recency * src;
        });
        const wSum = weights.reduce((a, b) => a + b, 0);

        const cx = history.map(h => h.norm_x + h.norm_w / 2);
        const cy = history.map(h => h.norm_y + h.norm_h / 2);
        const wcx = cx.reduce((s, v, i) => s + weights[i] * v, 0) / wSum;
        const wcy = cy.reduce((s, v, i) => s + weights[i] * v, 0) / wSum;

        const sx = Math.sqrt(cx.reduce((s, v, i) => s + weights[i] * (v - wcx) ** 2, 0) / wSum);
        const sy = Math.sqrt(cy.reduce((s, v, i) => s + weights[i] * (v - wcy) ** 2, 0) / wSum);

        // Tamaño de la zona: media ponderada del ancho/alto observados
        const avgW = history.reduce((s, h, i) => s + weights[i] * h.norm_w, 0) / wSum;
        const avgH = history.reduce((s, h, i) => s + weights[i] * h.norm_h, 0) / wSum;
        const or   = originalRect || {};

        let padX, padY;
        if (userConfirmed) {
            padX = Math.max(avgW / 2, 1.2 * sx) + 0.008;
            padY = Math.max(avgH / 2, 1.2 * sy) + 0.005;
        } else {
            padX = Math.max((or.w || 0.05) / 2 + 0.01,  1.5 * sx + 0.01);
            padY = Math.max((or.h || 0.02) / 2 + 0.005, 1.5 * sy + 0.005);
        }

        const ax = Math.max(0,     wcx - padX);
        const ay = Math.max(0,     wcy - padY);
        const aw = Math.min(1 - ax, 2 * padX);
        const ah = Math.min(1 - ay, 2 * padY);

        return {
            x: ax, y: ay, w: aw, h: ah,
            confidence:    n,
            userConfirmed,                       // true = corrección explícita del usuario
            spreadX:    Math.round(sx * 1000) / 1000,
            spreadY:    Math.round(sy * 1000) / 1000,
            centerX:    Math.round(wcx * 1000) / 1000,
            centerY:    Math.round(wcy * 1000) / 1000,
            topSource:  history[0]?.source || 'ocr',
        };
    }

    /**
     * Estadísticas de aprendizaje para una plantilla (para mostrar en UI).
     * Retorna por cuántas partes hay historial y cuánto han convergido.
     */
    getPositionLearningStats(templateId) {
        const rows = this.db.prepare(
            `SELECT part_label, page, COUNT(*) as confirmations,
                    AVG(norm_x) as avg_x, AVG(norm_y) as avg_y,
                    AVG(norm_w) as avg_w, AVG(norm_h) as avg_h
             FROM ocr_position_history
             WHERE template_id = ?
             GROUP BY part_label, page`
        ).all(templateId);

        return rows.map(r => ({
            partLabel:     r.part_label,
            page:          r.page,
            confirmations: r.confirmations,
            learnedRect:   { x: r.avg_x, y: r.avg_y, w: r.avg_w, h: r.avg_h },
            isReliable:    r.confirmations >= 3,
            isExpert:      r.confirmations >= 10,
        }));
    }

    // =========================================================================
    // APRENDIZAJE POR CAMPO (ancla / lado / patrón) + CONFIANZA DE AUTO
    // =========================================================================

    /**
     * Suma un voto para un campo. kind ∈ {anchor, side, pattern}. Acumulativo:
     * el valor efectivo de cada kind será el de mayor 'count'.
     */
    recordFieldVote(templateId, partLabel, kind, value) {
        if (!templateId || !partLabel || !kind || !value) return { success: false };
        try {
            this.db.prepare(`
                INSERT INTO ocr_field_votes (template_id, part_label, kind, value, count, updated_at)
                VALUES (?,?,?,?,1,strftime('%s','now'))
                ON CONFLICT(template_id, part_label, kind, value) DO UPDATE SET
                    count = count + 1,
                    updated_at = strftime('%s','now')
            `).run(templateId, partLabel, kind, String(value));
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Aprendizaje por campo de una plantilla: por cada part_label, el ancla, el
     * lado y el patrón más votados. → { partLabel: { anchor, side, pattern } }
     */
    getFieldLearning(templateId) {
        const out = {};
        if (!templateId) return out;
        try {
            const rows = this.db.prepare(
                `SELECT part_label, kind, value, count FROM ocr_field_votes
                 WHERE template_id=? ORDER BY count DESC`
            ).all(templateId);
            for (const r of rows) {
                if (!out[r.part_label]) out[r.part_label] = {};
                // como vienen ordenados por count DESC, el primero de cada kind gana
                if (out[r.part_label][r.kind] == null) out[r.part_label][r.kind] = r.value;
            }
        } catch (_) {}
        return out;
    }

    /** Registra el resultado de un documento (all_ok) para la confianza de auto. */
    recordTemplateOutcome(templateId, allOk) {
        if (!templateId) return { success: false };
        try {
            this.db.prepare(
                `INSERT INTO ocr_template_outcomes (template_id, all_ok) VALUES (?,?)`
            ).run(templateId, allOk ? 1 : 0);
            // Conservar solo los últimos 30 por plantilla
            const ids = this.db.prepare(
                `SELECT id FROM ocr_template_outcomes WHERE template_id=? ORDER BY ts DESC LIMIT -1 OFFSET 30`
            ).all(templateId);
            for (const row of ids) this.db.prepare('DELETE FROM ocr_template_outcomes WHERE id=?').run(row.id);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    /**
     * ¿La plantilla es de fiar para AUTO? True si los últimos K resultados existen
     * y TODOS fueron all_ok=1 (acuerdo de señales + patrón válido + sin corrección).
     */
    isTemplateTrusted(templateId, K = 5) {
        if (!templateId) return { trusted: false, recentOk: 0, needed: K };
        try {
            const rows = this.db.prepare(
                `SELECT all_ok FROM ocr_template_outcomes WHERE template_id=? ORDER BY ts DESC LIMIT ?`
            ).all(templateId, K);
            const recentOk = rows.filter(r => r.all_ok === 1).length;
            const trusted  = rows.length >= K && recentOk === K;
            return { trusted, recentOk, total: rows.length, needed: K };
        } catch (e) {
            return { trusted: false, recentOk: 0, needed: K, error: e.message };
        }
    }

} // ── fin clase ZiloDatabase ───────────────────────────────────────────────

/** Similitud de dos arrays de palabras (usada para patrones pendientes). */
function _fingerprintSimilarity(fp1, fp2) {
    if (!fp1?.length || !fp2?.length) return 0;
    const set2 = new Set(fp2);
    return fp1.filter(w => set2.has(w)).length / Math.max(fp1.length, fp2.length);
}

module.exports = ZiloDatabase;
