/**
 * @file license-manager.js
 * @description Sistema de licencias B2B con RBAC y machine fingerprinting para Zilo.
 * Gestiona activación, validación, roles (admin / usuario_estandar) y periodo de prueba.
 */

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

// Importación lazy de node-machine-id para no bloquear el inicio si falla
let machineIdSync;
try {
    machineIdSync = require('node-machine-id').machineIdSync;
} catch (e) {
    console.warn('[LICENSE] node-machine-id no disponible, usando fallback.');
    machineIdSync = null;
}

// ─── Constantes ──────────────────────────────────────────────────────────────
const LICENSE_KEY_REGEX = /^ZILO-[A-Z0-9]{4,6}-[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/;
const TRIAL_DAYS        = 15;
const DEFAULT_MAX_SEATS = 10;
const ROLES             = Object.freeze({ ADMIN: 'admin', STANDARD: 'usuario_estandar' });

// ─── Clase principal ──────────────────────────────────────────────────────────
class LicenseManager {
    /**
     * @param {Electron.App} app - Instancia de la app Electron para obtener userData.
     */
    constructor(app) {
        this.app    = app;
        this.db     = null;
        this.dbPath = null;
    }

    // =========================================================================
    // INICIALIZACIÓN
    // =========================================================================

    /**
     * Abre (o crea) la base de datos de licencias.
     */
    initialize() {
        this.dbPath = path.join(this.app.getPath('userData'), 'zilo-license.db');

        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this._createTables();
        console.log('[LICENSE] Base de datos de licencias inicializada:', this.dbPath);
    }

    _createTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS licencias (
                id_licencia     TEXT PRIMARY KEY,
                fecha_inicio    TEXT NOT NULL,
                fecha_fin       TEXT NOT NULL,
                max_puestos     INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_SEATS},
                estado          TEXT NOT NULL DEFAULT 'trial'
            );

            CREATE TABLE IF NOT EXISTS dispositivos (
                id_dispositivo  TEXT PRIMARY KEY,
                id_licencia     TEXT NOT NULL,
                hostname        TEXT NOT NULL,
                rol             TEXT NOT NULL DEFAULT '${ROLES.STANDARD}',
                fecha_registro  TEXT NOT NULL,
                FOREIGN KEY (id_licencia) REFERENCES licencias(id_licencia) ON DELETE CASCADE
            );
        `);
    }

    // =========================================================================
    // MACHINE ID
    // =========================================================================

    /**
     * Devuelve el identificador único del hardware de esta máquina.
     * @returns {string}
     */
    getMachineId() {
        if (machineIdSync) {
            try {
                return machineIdSync({ original: true });
            } catch (e) {
                console.warn('[LICENSE] machineIdSync falló, usando fallback:', e.message);
            }
        }
        // Fallback: combinar hostname + platform + arch
        return Buffer.from(`${os.hostname()}-${os.platform()}-${os.arch()}`).toString('hex');
    }

    // =========================================================================
    // VALIDACIÓN Y ACTIVACIÓN
    // =========================================================================

    /**
     * Valida el formato de una clave de licencia.
     * @param {string} key
     * @returns {boolean}
     */
    validateKeyFormat(key) {
        return LICENSE_KEY_REGEX.test((key || '').trim().toUpperCase());
    }

    /**
     * Activa (o re-valida) la licencia en este dispositivo.
     * Lógica "primer llegado":
     *   - Primer dispositivo  → rol admin
     *   - Siguientes         → rol usuario_estandar
     *   - Si supera max_puestos → error
     * @param {string} rawKey - Clave introducida por el usuario
     * @returns {{ success: boolean, role?: string, daysLeft?: number, error?: string }}
     */
    activate(rawKey) {
        const key = (rawKey || '').trim().toUpperCase();

        if (!this.validateKeyFormat(key)) {
            return { success: false, error: 'Formato de clave inválido. Usa: ZILO-XXXX-XXXX-XXXX' };
        }

        const machineId = this.getMachineId();
        const hostname  = os.hostname();
        const now       = new Date();

        // ── ¿Ya existe la licencia en la BD? ──────────────────────────────────
        let licencia = this.db.prepare('SELECT * FROM licencias WHERE id_licencia = ?').get(key);

        if (!licencia) {
            // Primera activación de esta clave en este PC → crear registro
            const inicio = now.toISOString();
            const fin    = new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString();
            this.db.prepare(`
                INSERT INTO licencias (id_licencia, fecha_inicio, fecha_fin, max_puestos, estado)
                VALUES (?, ?, ?, ?, 'trial')
            `).run(key, inicio, fin, DEFAULT_MAX_SEATS);
            licencia = this.db.prepare('SELECT * FROM licencias WHERE id_licencia = ?').get(key);
        }

        // ── Verificar caducidad ───────────────────────────────────────────────
        const fechaFin  = new Date(licencia.fecha_fin);
        const daysLeft  = Math.ceil((fechaFin - now) / 86_400_000);

        if (licencia.estado !== 'activa' && daysLeft <= 0) {
            return { success: false, error: 'El periodo de prueba ha caducado. Contacta con soporte.' };
        }

        // ── ¿Este dispositivo ya está registrado? ─────────────────────────────
        const dispositivo = this.db.prepare(
            'SELECT * FROM dispositivos WHERE id_dispositivo = ?'
        ).get(machineId);

        if (dispositivo) {
            // Dispositivo conocido → simplemente devolver su rol
            return { success: true, role: dispositivo.rol, daysLeft, hostname };
        }

        // ── Dispositivo nuevo: asignar rol ────────────────────────────────────
        const totalRegistrados = this.db.prepare(
            'SELECT COUNT(*) AS cnt FROM dispositivos WHERE id_licencia = ?'
        ).get(key).cnt;

        if (totalRegistrados === 0) {
            // Primer dispositivo → ADMIN
            this._registerDevice(machineId, key, hostname, ROLES.ADMIN);
            return { success: true, role: ROLES.ADMIN, daysLeft, hostname };
        }

        if (totalRegistrados >= licencia.max_puestos) {
            return {
                success: false,
                error: `Límite de puestos alcanzado (${licencia.max_puestos}/${licencia.max_puestos}). Contacta con el administrador.`
            };
        }

        // Dispositivo estándar
        this._registerDevice(machineId, key, hostname, ROLES.STANDARD);
        return { success: true, role: ROLES.STANDARD, daysLeft, hostname };
    }

    _registerDevice(machineId, licenciaId, hostname, rol) {
        this.db.prepare(`
            INSERT OR REPLACE INTO dispositivos (id_dispositivo, id_licencia, hostname, rol, fecha_registro)
            VALUES (?, ?, ?, ?, ?)
        `).run(machineId, licenciaId, hostname, rol, new Date().toISOString());
        console.log(`[LICENSE] Dispositivo registrado: ${hostname} → ${rol}`);
    }

    // =========================================================================
    // ESTADO ACTUAL
    // =========================================================================

    /**
     * Devuelve el estado de licencia del dispositivo actual (sin clave).
     * @returns {{ activated: boolean, role?: string, daysLeft?: number, licenseKey?: string }}
     */
    getStatus() {
        const machineId = this.getMachineId();
        const disp = this.db.prepare('SELECT * FROM dispositivos WHERE id_dispositivo = ?').get(machineId);
        if (!disp) return { activated: false };

        const lic = this.db.prepare('SELECT * FROM licencias WHERE id_licencia = ?').get(disp.id_licencia);
        if (!lic) return { activated: false };

        const daysLeft = Math.ceil((new Date(lic.fecha_fin) - new Date()) / 86_400_000);
        return {
            activated:  true,
            role:       disp.rol,
            daysLeft:   Math.max(0, daysLeft),
            licenseKey: lic.id_licencia,
            maxSeats:   lic.max_puestos,
            estado:     lic.estado
        };
    }

    // =========================================================================
    // PANEL DE ADMINISTRACIÓN
    // =========================================================================

    /**
     * Devuelve todos los dispositivos de una licencia (solo admin).
     */
    getDevices(licenseKey) {
        return this.db.prepare(
            'SELECT * FROM dispositivos WHERE id_licencia = ? ORDER BY fecha_registro ASC'
        ).all(licenseKey);
    }

    /**
     * Desvincula un dispositivo (revoca su machine_id).
     * @param {string} callerMachineId - Quien llama (debe ser admin)
     * @param {string} targetMachineId - A quién revocar
     */
    revokeDevice(callerMachineId, targetMachineId) {
        const caller = this.db.prepare(
            'SELECT * FROM dispositivos WHERE id_dispositivo = ?'
        ).get(callerMachineId);

        if (!caller || caller.rol !== ROLES.ADMIN) {
            return { success: false, error: 'Solo el administrador puede revocar puestos.' };
        }
        if (callerMachineId === targetMachineId) {
            return { success: false, error: 'No puedes revocar tu propio dispositivo.' };
        }

        const changes = this.db.prepare(
            'DELETE FROM dispositivos WHERE id_dispositivo = ?'
        ).run(targetMachineId).changes;

        return changes > 0
            ? { success: true }
            : { success: false, error: 'Dispositivo no encontrado.' };
    }

    /**
     * Transfiere el rol de admin a otro dispositivo.
     * @param {string} callerMachineId
     * @param {string} targetMachineId
     */
    transferAdmin(callerMachineId, targetMachineId) {
        const caller = this.db.prepare(
            'SELECT * FROM dispositivos WHERE id_dispositivo = ?'
        ).get(callerMachineId);

        if (!caller || caller.rol !== ROLES.ADMIN) {
            return { success: false, error: 'Solo el administrador puede transferir el rol.' };
        }
        if (callerMachineId === targetMachineId) {
            return { success: false, error: 'Ya eres el administrador.' };
        }

        const transfer = this.db.transaction(() => {
            this.db.prepare(
                "UPDATE dispositivos SET rol = ? WHERE id_dispositivo = ?"
            ).run(ROLES.STANDARD, callerMachineId);
            this.db.prepare(
                "UPDATE dispositivos SET rol = ? WHERE id_dispositivo = ?"
            ).run(ROLES.ADMIN, targetMachineId);
        });
        transfer();

        return { success: true };
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = { LicenseManager, ROLES };
