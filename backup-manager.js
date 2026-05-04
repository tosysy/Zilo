// ============================================================================
// BACKUP MANAGER - Sistema de Respaldo y Restauración (SQLite-based)
// ============================================================================

const fs = require('fs').promises;
const path = require('path');

class BackupManager {
    constructor(app, db) {
        this.app = app;
        this.db = db; // Instancia de ZiloDatabase
        this.backupDir = null;
        this.initialized = false;
        this.cleanupInterval = null;
    }

    // Inicializar carpeta de backup
    async initialize() {
        if (this.initialized) return;

        // Inicializar rutas solo cuando se necesiten (después de que app esté listo)
        if (!this.backupDir) {
            this.backupDir = path.join(this.app.getPath('userData'), 'backup');
        }

        try {
            await fs.mkdir(this.backupDir, { recursive: true });

            this.initialized = true;
            console.log('[BACKUP] Backup manager initialized:', this.backupDir);
        } catch (error) {
            console.error('[BACKUP] Error initializing backup manager:', error);
            throw error;
        }
    }

    // Iniciar auto-limpieza basada en minutos configurados
    startAutoCleanup(cleanupMinutes) {
        // Detener limpieza anterior si existe
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        if (!cleanupMinutes || cleanupMinutes <= 0) {
            console.log('[BACKUP] Auto-cleanup disabled');
            return;
        }

        // Ejecutar limpieza cada minuto
        this.cleanupInterval = setInterval(async () => {
            await this.cleanupOldBackups(cleanupMinutes);
        }, 60000); // Cada 60 segundos

        console.log(`[BACKUP] Auto-cleanup started: ${cleanupMinutes} minutes`);

        // Ejecutar limpieza inmediatamente también
        this.cleanupOldBackups(cleanupMinutes);
    }

    // Detener auto-limpieza
    stopAutoCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            console.log('[BACKUP] Auto-cleanup stopped');
        }
    }

    // Limpiar backups antiguos basados en minutos
    async cleanupOldBackups(cleanupMinutes) {
        await this.initialize();

        try {
            const backups = this.db.getAllBackups();

            const now = Date.now();
            const maxAge = cleanupMinutes * 60 * 1000; // Convertir minutos a milisegundos
            let deletedCount = 0;

            for (const backup of backups) {
                const backupDate = new Date(backup.timestamp);
                const age = now - backupDate.getTime();

                if (age > maxAge) {
                    // Eliminar archivo de backup
                    try {
                        await fs.unlink(backup.backup_path);
                        // Eliminar registro de la base de datos
                        this.db.deleteBackup(backup.id);
                        deletedCount++;
                        console.log(`[BACKUP] Auto-deleted old backup: ${backup.processed_file_name} (age: ${Math.round(age / 60000)} min)`);
                    } catch (error) {
                        console.warn('[BACKUP] Could not delete:', backup.processed_file_name);
                    }
                }
            }

            if (deletedCount > 0) {
                console.log(`[BACKUP] Auto-cleanup completed: ${deletedCount} backups deleted`);
            }

            return { deletedCount };
        } catch (error) {
            console.error('[BACKUP] Error during auto-cleanup:', error);
            return { deletedCount: 0 };
        }
    }

    // Crear backup de un archivo antes de moverlo/renombrarlo
    async createBackup(originalPath, destinationPath, newName, documentType, mode) {
        await this.initialize();

        try {
            const timestamp = Date.now();
            const originalFileName = path.basename(originalPath);
            const backupFileName = `${timestamp}_${originalFileName}`;
            const backupPath = path.join(this.backupDir, backupFileName);

            // Copiar archivo al directorio de backup
            await fs.copyFile(originalPath, backupPath);

            // Crear entrada en la base de datos
            const backupData = {
                id: timestamp.toString(),
                originalPath: originalPath,
                backupPath: backupPath,
                processedFileName: newName,
                processedFilePath: path.join(destinationPath, newName),
                destinationFolder: destinationPath,
                documentType: documentType,
                mode: mode,
                timestamp: new Date().toISOString()
            };

            const result = this.db.createBackup(backupData);

            if (!result.success) {
                throw new Error(result.error);
            }

            console.log('[BACKUP] Backup created:', backupFileName);
            return { id: timestamp, ...backupData };
        } catch (error) {
            console.error('[BACKUP] Error creating backup:', error);
            throw error;
        }
    }

    // Agregar operación exitosa al historial
    async addToHistory(backupId, operation = 'process') {
        try {
            this.db.addBackupHistory(backupId.toString(), operation);
        } catch (error) {
            console.error('[BACKUP] Error adding to history:', error);
        }
    }

    // Deshacer última operación
    async undoLast() {
        await this.initialize();

        try {
            const backups = this.db.getAllBackups(1);

            if (backups.length === 0) {
                return { success: false, error: 'No hay operaciones para deshacer' };
            }

            // Obtener última entrada
            const lastBackup = backups[0];

            // Verificar que el backup existe
            try {
                await fs.access(lastBackup.backup_path);
            } catch {
                return { success: false, error: 'Archivo de backup no encontrado' };
            }

            // Eliminar archivo procesado del destino
            const processedFilePath = lastBackup.processed_file_path;
            try {
                await fs.unlink(processedFilePath);
            } catch (error) {
                console.warn('[BACKUP] Could not delete processed file:', error.message);
            }

            // Restaurar archivo original
            await fs.copyFile(lastBackup.backup_path, lastBackup.original_path);

            // Eliminar backup físico
            await fs.unlink(lastBackup.backup_path);

            // Eliminar registro de la base de datos
            this.db.deleteBackup(lastBackup.id);

            const originalFileName = path.basename(lastBackup.original_path);
            console.log('[BACKUP] Undo successful:', originalFileName);
            return {
                success: true,
                fileName: originalFileName,
                restoredTo: lastBackup.original_path,
                processedFilePath: processedFilePath
            };
        } catch (error) {
            console.error('[BACKUP] Error during undo:', error);
            return { success: false, error: error.message };
        }
    }

    // Restaurar un archivo específico por ID
    async restoreById(backupId) {
        await this.initialize();

        try {
            const backupEntry = this.db.getBackupById(backupId.toString());

            if (!backupEntry) {
                return { success: false, error: 'Backup no encontrado' };
            }

            // Verificar que el backup existe
            try {
                await fs.access(backupEntry.backup_path);
            } catch {
                return { success: false, error: 'Archivo de backup no encontrado' };
            }

            // Eliminar archivo procesado del destino
            const processedFilePath = backupEntry.processed_file_path;
            try {
                await fs.unlink(processedFilePath);
            } catch (error) {
                console.warn('[BACKUP] Could not delete processed file:', error.message);
            }

            // Restaurar archivo original
            await fs.copyFile(backupEntry.backup_path, backupEntry.original_path);

            // Eliminar backup físico
            await fs.unlink(backupEntry.backup_path);

            // Eliminar registro de la base de datos
            this.db.deleteBackup(backupEntry.id);

            const originalFileName = path.basename(backupEntry.original_path);
            console.log('[BACKUP] Restore successful:', originalFileName);
            return {
                success: true,
                fileName: originalFileName,
                restoredTo: backupEntry.original_path,
                processedFilePath: processedFilePath
            };
        } catch (error) {
            console.error('[BACKUP] Error during restore:', error);
            return { success: false, error: error.message };
        }
    }

    // Obtener lista de backups
    async getBackups() {
        await this.initialize();

        try {
            const backups = this.db.getAllBackups();

            // Transformar los campos de SQLite al formato esperado por el frontend
            const transformedBackups = backups.map(backup => ({
                id: backup.id,
                originalName: backup.original_path ? backup.original_path.split('\\').pop().split('/').pop() : 'Unknown',
                originalPath: backup.original_path,
                backupPath: backup.backup_path,
                destinationPath: backup.destination_folder,
                newName: backup.processed_file_name,
                documentType: backup.document_type || 'unknown',
                mode: backup.mode,
                timestamp: backup.timestamp,
                timestampMs: new Date(backup.timestamp).getTime()
            }));

            return transformedBackups;
        } catch (error) {
            console.error('[BACKUP] Error getting backups:', error);
            return [];
        }
    }

    // Limpiar backups manualmente (todo)
    async clearAllBackups() {
        await this.initialize();

        try {
            const backups = this.db.getAllBackups();
            let deletedCount = 0;

            // Eliminar todos los archivos de backup
            for (const backup of backups) {
                try {
                    await fs.unlink(backup.backup_path);
                    deletedCount++;
                } catch (error) {
                    console.warn('[BACKUP] Could not delete:', backup.processed_file_name);
                }
            }

            // Limpiar registros de la base de datos
            this.db.clearAllBackups();

            console.log('[BACKUP] Cleared all backups:', deletedCount);
            return { success: true, deletedCount };
        } catch (error) {
            console.error('[BACKUP] Error clearing backups:', error);
            return { success: false, error: error.message };
        }
    }

    // Obtener estadísticas de backup
    async getStats() {
        await this.initialize();

        try {
            const backups = this.db.getAllBackups();
            const stats = this.db.getBackupStats();

            let totalSize = 0;

            for (const backup of backups) {
                try {
                    const fileStats = await fs.stat(backup.backup_path);
                    totalSize += fileStats.size;
                } catch {
                    // Archivo no existe
                }
            }

            return {
                totalBackups: stats.total,
                totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
                oldestBackup: stats.oldest,
                backupDir: this.backupDir
            };
        } catch (error) {
            console.error('[BACKUP] Error getting stats:', error);
            return {
                totalBackups: 0,
                totalSizeMB: '0.00',
                oldestBackup: null,
                backupDir: this.backupDir
            };
        }
    }

    // Obtener historial de operaciones
    async getHistory() {
        await this.initialize();

        try {
            // El historial ahora se gestiona con la tabla backup_history en SQLite
            const backups = this.db.getAllBackups();
            return backups;
        } catch (error) {
            console.error('[BACKUP] Error getting history:', error);
            return [];
        }
    }

    // Eliminar un backup específico
    async deleteBackup(backupId) {
        await this.initialize();

        try {
            const backupEntry = this.db.getBackupById(backupId.toString());

            if (!backupEntry) {
                return { success: false, error: 'Backup no encontrado' };
            }

            // Eliminar archivo de backup
            try {
                await fs.unlink(backupEntry.backup_path);
            } catch (error) {
                console.warn('[BACKUP] Could not delete file:', error.message);
            }

            // Eliminar registro de la base de datos
            this.db.deleteBackup(backupEntry.id);

            console.log('[BACKUP] Backup deleted:', backupId);
            return { success: true };
        } catch (error) {
            console.error('[BACKUP] Error deleting backup:', error);
            return { success: false, error: error.message };
        }
    }
}

// Exportar instancia única
module.exports = BackupManager;
