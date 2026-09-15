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

            -- Índices para mejorar el rendimiento
            CREATE INDEX IF NOT EXISTS idx_ocr_doc_type ON ocr_documents(doc_type);
            CREATE INDEX IF NOT EXISTS idx_ocr_timestamp ON ocr_documents(timestamp);
            CREATE INDEX IF NOT EXISTS idx_backup_timestamp ON backups(timestamp);
            CREATE INDEX IF NOT EXISTS idx_backup_history_backup_id ON backup_history(backup_id);
        `);

        console.log('[DB] Tablas creadas/verificadas correctamente');
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
    addOcrDocument(filePath, fileName, ocrText, docType) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO ocr_documents (file_path, file_name, doc_type, ocr_text, timestamp)
                VALUES (?, ?, ?, ?, ?)
            `);

            const timestamp = new Date().toISOString();
            stmt.run(filePath, fileName, docType, ocrText, timestamp);

            console.log(`[DB] Documento aniadido al indice: ${fileName}`);
            return { success: true };
        } catch (error) {
            console.error('[DB ERROR] Error al aniadir documento:', error);
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
}

module.exports = ZiloDatabase;
