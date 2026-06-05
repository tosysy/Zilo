'use strict';

/**
 * @file ocr-zonal-engine.js
 * @description Motor OCR Zonal Visual — plantillas de zonas + sistema de aprendizaje adaptativo.
 *
 * Persistencia: SQLite (via ZiloDatabase) en lugar de JSON.
 * La migración desde JSON se hace automáticamente en db.js al primer arranque.
 */

// Umbral de confirmaciones por nivel
const LEVEL_LEARNING = 1;   // 🌱 Aprendiendo
const LEVEL_TRAINED  = 3;   // 🎓 Aprendido
const LEVEL_EXPERT   = 10;  // ⭐ Experto

class OcrZonalEngine {
    /**
     * @param {import('./db')} db - Instancia de ZiloDatabase ya inicializada
     */
    constructor(db) {
        this._db = db;
    }

    // ── API: plantillas ───────────────────────────────────────────────────────

    getAllTemplates() {
        return this._db.getAllTemplates();
    }

    saveTemplate(data) {
        return this._db.saveTemplate(data);
    }

    deleteTemplate(id) {
        return this._db.deleteTemplate(id);
    }

    incrementConfirmations(id) {
        return this._db.incrementTemplateConfirmations(id);
    }

    // ── API: patrones pendientes (aprendizaje) ────────────────────────────────

    getPendingPatterns() {
        return this._db.getPendingPatterns();
    }

    addPendingPattern(data) {
        return this._db.addPendingPattern(data);
    }

    deletePendingPattern(id) {
        return this._db.deletePendingPattern(id);
    }

    promotePendingPattern(id) {
        return this._db.promotePendingPattern(id);
    }

    // ── Utilidades estáticas ──────────────────────────────────────────────────

    static confidenceLevel(confirmations) {
        if (!confirmations || confirmations < LEVEL_LEARNING) return { icon: '🌱', label: 'Sin datos',    level: 0 };
        if (confirmations < LEVEL_TRAINED)                    return { icon: '⚡', label: 'Aprendiendo', level: 1 };
        if (confirmations < LEVEL_EXPERT)                     return { icon: '🎓', label: 'Aprendido',   level: 2 };
        return                                                       { icon: '⭐', label: 'Experto',      level: 3 };
    }
}

module.exports = { OcrZonalEngine };
