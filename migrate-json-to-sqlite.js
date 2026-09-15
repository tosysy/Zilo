/**
 * Script de migración de JSON a SQLite
 * Convierte datos existentes de ocr-index.json y backups JSON a la nueva base de datos SQLite
 */

const fs = require('fs').promises;
const path = require('path');

async function migrateOCRIndex(db, userDataPath) {
    try {
        // Intentar leer el archivo JSON antiguo
        const ocrIndexPath = path.join(userDataPath, 'ocr-index.json');

        try {
            await fs.access(ocrIndexPath);
        } catch {
            console.log('[MIGRATE] No se encontro ocr-index.json, omitiendo migracion de OCR');
            return { migrated: 0 };
        }

        const jsonContent = await fs.readFile(ocrIndexPath, 'utf8');
        const ocrIndex = JSON.parse(jsonContent);

        let migratedCount = 0;

        for (const [filePath, data] of Object.entries(ocrIndex)) {
            const result = db.addOcrDocument(
                data.filePath || filePath,
                data.fileName,
                data.ocrText,
                data.docType
            );

            if (result.success) {
                migratedCount++;
            }
        }

        console.log(`[MIGRATE] ${migratedCount} documentos OCR migrados`);

        // Renombrar el archivo JSON antiguo como backup
        await fs.rename(ocrIndexPath, ocrIndexPath + '.backup');
        console.log('[MIGRATE] Archivo JSON antiguo renombrado a .backup');

        return { migrated: migratedCount };
    } catch (error) {
        console.error('[MIGRATE] Error migrando indice OCR:', error);
        return { migrated: 0, error: error.message };
    }
}

async function migrateBackups(db, userDataPath) {
    try {
        // Intentar leer el archivo de metadata de backups
        const backupDir = path.join(userDataPath, 'backup');
        const metadataPath = path.join(backupDir, 'backup-metadata.json');

        try {
            await fs.access(metadataPath);
        } catch {
            console.log('[MIGRATE] No se encontro backup-metadata.json, omitiendo migracion de backups');
            return { migrated: 0 };
        }

        const jsonContent = await fs.readFile(metadataPath, 'utf8');
        const metadata = JSON.parse(jsonContent);

        let migratedCount = 0;

        for (const backup of metadata) {
            const backupData = {
                id: backup.id.toString(),
                originalPath: backup.originalPath,
                backupPath: backup.backupPath,
                processedFileName: backup.newName,
                processedFilePath: path.join(backup.destinationPath, backup.newName),
                destinationFolder: backup.destinationPath,
                documentType: backup.documentType,
                mode: backup.mode,
                timestamp: backup.timestamp
            };

            const result = db.createBackup(backupData);

            if (result.success) {
                migratedCount++;
            }
        }

        console.log(`[MIGRATE] ${migratedCount} backups migrados`);

        // Renombrar el archivo JSON antiguo como backup
        await fs.rename(metadataPath, metadataPath + '.backup');
        console.log('[MIGRATE] Archivo de metadata antiguo renombrado a .backup');

        return { migrated: migratedCount };
    } catch (error) {
        console.error('[MIGRATE] Error migrando backups:', error);
        return { migrated: 0, error: error.message };
    }
}

async function migrate(db, userDataPath) {
    console.log('[MIGRATE] Iniciando migracion de JSON a SQLite...');

    const ocrResult = await migrateOCRIndex(db, userDataPath);
    const backupResult = await migrateBackups(db, userDataPath);

    console.log('[MIGRATE] Migracion completada:');
    console.log(`  - Documentos OCR: ${ocrResult.migrated}`);
    console.log(`  - Backups: ${backupResult.migrated}`);

    return {
        ocrMigrated: ocrResult.migrated,
        backupsMigrated: backupResult.migrated
    };
}

module.exports = { migrate };
