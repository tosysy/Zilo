# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Zilo v1.0** is an Electron-based desktop application for automated PDF document processing and classification. The application uses OCR (Tesseract.js) to extract text from PDF documents, automatically detects document types, renames files according to standardized naming conventions, and organizes them into appropriate folders.

**Primary Use Case**: Processing Spanish business documents (albaranes/delivery notes, pedidos/orders, DUAs/customs documents, facturas/invoices, entradas/receipts) by extracting document numbers and automatically renaming/organizing them.

**Version**: 1.0.0
**Last Updated**: May 4, 2026

## Commands

### Development
```bash
npm start              # Launch the Electron application
```

### Building
```bash
npm run build          # Build for Windows only (NSIS installer)
npm run build-all      # Build for Windows, macOS, and Linux
```

Build output is placed in the `dist/` directory. Build resources (icons) are in the `build/` directory.

## Recent Changes (v2.0 Optimization)

### Code Optimization Summary
- **main.js**: Reduced from 852 to 515 lines (39% reduction)
- **app.js**: Optimized to ~600 lines (35% reduction)
- **Removed 6 duplicate files**: settings.html/js/css, search.html/js/css
- **Improved code reusability**: Common configurations extracted to constants
- **Updated comments**: Concise and useful, removed verbose documentation
- **Better maintainability**: Functions refactored, duplicated code eliminated

### Key Optimizations
1. **Common Window Configuration**: `commonWindowConfig` and `commonWindowFeatures` constants
2. **Reusable Functions**: `blockKeyboardShortcuts()`, `generateUniquePath()`
3. **Document Type Constants**: `DOC_TYPES` array, `DOC_ICONS` object
4. **Simplified Cross-Device Handling**: Improved `moveFileCrossDevice()`
5. **Cleaner Code Structure**: Better organization and readability

## Architecture

### Electron Process Model

This application follows the standard Electron architecture with three main components:

1. **Main Process** (`main.js`): Node.js process that controls the application lifecycle, creates browser windows, and handles system-level operations (file I/O, folder selection, file moving/renaming). Now optimized with reusable helper functions and constants.

2. **Preload Scripts**: Security bridges that expose limited APIs to renderer processes via `contextBridge`:
   - `preload.js`: Main window API (`electronAPI`)
   - `manual-rename-preload.js`: Manual rename window API (`manualRenameAPI`)
   - `search-preload.js`: Search window API (`electronAPI`)
   - `settings-preload.js`: Settings window API (`electronAPI`)

3. **Renderer Process** (`renderer/`): The frontend UI that users interact with, running in Chromium browser windows with limited Node.js access for security.

### Key IPC Handlers (Main Process)

Defined in `main.js`, these handlers respond to renderer requests:

**File Operations:**
- `select-folder`: Opens a folder selection dialog
- `select-files`: Opens a multi-file selection dialog (PDF only)
- `move-file`: Moves/renames a file with cross-device support and subfolder creation
- `rename-file`: Renames a file in its current location
- `read-pdf-file`: Reads a PDF file as a buffer
- `open-file`: Opens a file with the system's default application

**OCR Index Management:**
- `load-ocr-index`: Loads the OCR search index from userData or custom path
- `save-ocr-index`: Saves the OCR search index to userData or custom path
- `select-ocr-index-location`: Opens dialog to select custom OCR index location
- `get-default-ocr-index-path`: Returns the default OCR index path

**Window Management:**
- `open-search-window`: Opens the search window
- `open-settings-window`: Opens the settings window
- `open-manual-rename-window`: Opens the manual rename modal window
- `close-settings-window`: Closes the settings window

**Events (IPC Send):**
- `settings-saved`: Settings saved from settings window
- `manual-rename-confirmed`: User confirmed manual rename
- `manual-rename-skipped`: User skipped file in manual rename

The OCR index is stored as JSON at: `app.getPath('userData')/ocr-index.json` (or custom path if configured)

### Document Processing Pipeline

The core workflow in `renderer/app.js` follows these steps:

1. **File Input**: User drags/drops PDFs or selects them via native file picker dialog
2. **Validation**: Check that destination folders are configured
3. **Batch Processing**: Files are processed in chunks (default: 50 concurrent, configurable in settings)
4. **OCR Extraction**: First page of PDF is rendered to canvas at 3x scale, then Tesseract.js extracts text (Spanish language model)
5. **Document Detection**: Pattern matching on extracted text to identify document type (only in 'auto' mode)
6. **Number Extraction**: Type-specific regex patterns extract document numbers (e.g., "1 013770" or "1/013770")
7. **Filename Generation**: Format number as "S-NNNNNN TYPE.pdf" (e.g., "1-13770 ALBARAN.pdf")
8. **File Moving**: Move file to destination folder via IPC (pedidos create subfolders automatically)
9. **OCR Indexing**: Store extracted text for full-text search functionality

### Operating Modes

The application has 6 modes that determine processing behavior:

- **auto**: Automatically detects document type from content (experimental), requires configuring 5 destination folders in settings
- **albaranes**: Processes delivery notes (albaranes de venta)
- **pedidos**: Processes customer orders (creates subfolders, detects "RESTO" suffix)
- **duas**: Processes customs documents
- **facturas**: Processes invoices
- **entradas**: Processes receipt/entry documents

In non-auto modes, a single destination folder is configured. The mode determines which regex pattern is used for number extraction and which suffix is applied to the filename.

### Document Type Detection (Auto Mode)

Detection in `detectDocumentType()` uses a hierarchical pattern-matching approach:

1. **Primary patterns**: Specific patterns like `FACTURA\s+\d\/\d{6}` (high confidence)
2. **Fallback patterns**: Keyword presence in the first 400 characters (lower confidence)
3. Returns `null` if no type detected → triggers manual rename window

### Manual Rename Flow

When automatic extraction fails:

1. File is added to `manualRenameQueue`
2. Separate window opens displaying PDF preview (canvas render at 2x scale) and input fields
3. User enters serie (1 digit) and código (6+ digits)
4. In auto mode, user also selects document type from dropdown
5. Preview updates in real-time as user types
6. User can "Omitir archivo" (skip) or "Confirmar y Renombrar" (confirm)
7. On confirmation, file is processed with manual data
8. On skip or window close, file is marked as skipped

The queue processes one file at a time to avoid modal conflicts. Queue count is displayed in window header.

### Search Functionality

The application maintains a persistent OCR index in a separate search window:

- Each successfully processed file has its full OCR text saved to `ocr-index.json`
- Search window supports up to 4 simultaneous search terms (AND logic - all terms must be present)
- Sequential filtering: Each term filters the results from the previous term
- Results show document name, type icon, date indexed, and text context (40 chars before/after)
- Visual feedback: Input fields show green (found) or red (not found) for each term
- Clicking "Abrir archivo" opens the document with the system viewer
- Search statistics show total results and active terms

### Folder Locking System

To prevent accidental folder changes:

- Folders start locked (🔒)
- User clicks lock icon to unlock (🔓)
- Auto-locks after 5 seconds of inactivity
- Auto-locks immediately after folder selection
- All browse buttons are disabled when locked
- Lock state is visual only (not persisted)

### Configuration Persistence

`localStorage` stores:

- `theme`: 'light' or 'dark'
- `concurrentLimit`: Number of files to process simultaneously (default: 50)
- `ocr-index-path`: Custom path for OCR index file (optional)
- `first-time-setup`: Flag indicating if initial setup is complete
- `{mode}-folder`: Destination folder path for each single-folder mode (albaranes, pedidos, duas, facturas, entradas)
- `auto-folder-{type}`: Destination folder paths for each type in auto mode (auto-folder-albaranes, auto-folder-pedidos, etc.)

### First-Time Setup Flow

On first application launch:

1. Main window is created but not shown
2. Settings window opens in modal mode (cannot be closed)
3. User must configure OCR index path and folders for auto mode
4. After saving settings, `first-time-setup` flag is set in localStorage
5. Main window is shown and settings window closes
6. Subsequent launches skip this flow and load saved configuration

## File Structure

```
main.js                     - Main Electron process (515 lines, optimized)
preload.js                  - Main window context bridge
manual-rename-preload.js    - Manual rename window context bridge
search-preload.js           - Search window context bridge
settings-preload.js         - Settings window context bridge
renderer/
  index.html                - Main UI structure
  app.js                    - Main frontend logic (~600 lines, optimized)
  styles.css                - All styling (themes, animations, layout)
  manual-rename-window.html - Manual rename modal UI
  manual-rename-window.js   - Manual rename modal logic
  search-window.html        - Search window UI
  search-window.js          - Search window logic
  settings-window.html      - Settings window UI
  settings-window.js        - Settings window logic
  logo.png                  - Light theme logo
  logo-dark.png             - Dark theme logo
build/
  icon.ico                  - Windows icon
  icon.png                  - Application icon (other platforms)
dist/                       - Build output directory (git-ignored)
CLAUDE.md                   - This file
PLAN_MEJORAS_ZILO.txt       - Roadmap for future improvements
```

## Dependencies

### Production
- `electron`: ^38.3.0 - Desktop application framework
- `pdfjs-dist`: ^5.4.296 - PDF rendering library

### Development
- `electron-builder`: ^24.9.1 - Multi-platform build tooling

### CDN Dependencies (loaded in HTML files)
- **PDF.js**: v3.11.174 (https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/)
- **Tesseract.js**: v4.1.1 (https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/)

If versions need updating, modify:
1. Script src URLs in HTML files
2. Worker URL in `renderer/app.js`: `pdfjsLib.GlobalWorkerOptions.workerSrc`

## Important Implementation Details

### Common Window Configuration (Optimized in v2.0)

```javascript
const commonWindowConfig = {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: false,
    devTools: true,
};

const commonWindowFeatures = {
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build/icon.png'),
};
```

These constants are spread into each window configuration to avoid code duplication.

### Keyboard Shortcuts Blocking

The `blockKeyboardShortcuts()` function prevents users from:
- Reloading (Ctrl+R, F5)
- Opening DevTools (Ctrl+Shift+I, Ctrl+Shift+J, F12)

This is applied to all windows for consistency.

### Cross-Device File Moving

`moveFileCrossDevice()` in main.js handles the EXDEV error when moving files across different drives/partitions:
1. Attempts `fs.rename()` first (fast, atomic, same device)
2. If EXDEV error occurs, falls back to `fs.copyFile()` + `fs.unlink()` (cross-device)
3. Logs the method used for debugging

### File Naming Conflict Resolution

`generateUniquePath()` in main.js handles filename conflicts:
- When a target filename exists, appends " (N)" before the extension
- Increments N until an available name is found
- Used by both `move-file` and `rename-file` handlers
- Example: "1-13770 ALBARAN.pdf" → "1-13770 ALBARAN (1).pdf"

### Subfolder Creation for Pedidos

Only pedidos (orders) create subfolders automatically:
- Subfolder name is extracted from first two parts of filename
- Example: "1-25088 PEDIDO ALMACEN.pdf" → folder "1-25088 PEDIDO"
- Subfolder is created with `fs.mkdir(..., { recursive: true })`
- File is then moved into the subfolder

### Number Formatting

7-digit numbers are formatted as "S-NNNNNN":
- S = serie (first digit)
- NNNNNN = código with leading zeros removed
- Example: "1013770" → "1-13770"
- Implemented in `formatOrderNumber()` function

### Concurrent Processing Limits

The `concurrentLimit` setting (configurable in settings window):
- Prevents system overload when processing large batches
- Files are processed in sequential chunks
- Each chunk uses `Promise.all()` for parallel processing within the chunk
- Default: 50 files per chunk
- Recommended range: 10-50 depending on system resources

### Document Type Constants (v2.0)

```javascript
const DOC_TYPES = ['albaranes', 'pedidos', 'duas', 'facturas', 'entradas'];
const DOC_ICONS = { albaranes: '📋', pedidos: '📦', duas: '📄', facturas: '🧾', entradas: '📥' };
```

These constants are used throughout the application to avoid string repetition and typos.

## Common Patterns

### Adding a New Document Type

1. Add type to `DOC_TYPES` array in app.js
2. Add icon to `DOC_ICONS` object in app.js
3. Add mode to `modeConfig` object in `selectMode()` function
4. Add button to selection screen in index.html with appropriate `data-mode` attribute
5. Add extraction pattern to `extractOrderNumber()` extractors object
6. Add suffix to `generateNewFilename()` suffixes object
7. If auto-detection needed, add patterns to `detectDocumentType()`
8. Add folder input to settings-window.html multi-folder selector
9. Update localStorage keys in settings-window.js

### Modifying OCR Accuracy

OCR quality is controlled by the canvas scale in `extractTextFromPDF()`:
- Current scale: 3.0x for OCR extraction
- Current scale: 2.0x for manual rename preview
- Higher values improve accuracy but increase processing time and memory usage
- Trade-off between speed and accuracy

### Updating Regex Patterns

Document number extraction patterns are in the `extractors` object within `extractOrderNumber()`:
- Each type has a specific regex pattern
- Must return a 7-character string (serie + código)
- Test patterns thoroughly with real documents before deploying

Example pattern:
```javascript
albaranes: text => text.match(/\b(\d)\s+(\d{6})\b/) ?
    text.match(/\b(\d)\s+(\d{6})\b/).slice(1).join('') : null
```

### Creating a New Window

1. Create HTML file in `renderer/` directory
2. Create JS file in `renderer/` directory
3. Create preload script if needed (for IPC communication)
4. Add IPC handler in main.js:
   ```javascript
   ipcMain.handle('open-xxx-window', async () => {
       // Window creation logic using commonWindowConfig and commonWindowFeatures
   });
   ```
5. Call from renderer: `await window.electronAPI.openXxxWindow();`

## Known Behaviors

- **Beta "Auto" Mode**: Document type auto-detection is experimental and marked in UI
- **Spanish Language**: OCR uses 'spa' (Spanish) language model in Tesseract
- **First Page Only**: Only the first page of each PDF is processed for OCR (performance optimization)
- **Manual Queue Processing**: Manual rename modal processes files sequentially, showing queue count in header
- **Theme Persistence**: Theme preference is saved to localStorage and restored on app launch
- **DevTools Enabled**: Development tools are enabled in all windows (`devTools: true`)
- **Cross-Device Support**: Full support for moving files across different drives/partitions
- **Duplicate Detection**: Files already processed (by path) are skipped in new batches
- **Path Corruption Cleanup**: On startup, corrupted paths in localStorage are automatically cleaned

## Code Quality Standards

### Comments Style (v2.0)
- **Concise and useful**: Comments explain WHY, not WHAT
- **Section headers**: Group related functionality
- **No redundant comments**: Avoid obvious comments like `// Create window`
- **Function purpose**: Brief comment above complex functions only

### Variable Naming
- Descriptive camelCase for variables and functions
- UPPER_CASE for constants
- Avoid abbreviations unless widely understood

### Error Handling
- Always use try-catch for async operations
- Log errors with context: `console.error('[ERROR] Description:', error)`
- Return structured error responses: `{ success: false, error: error.message }`

### Code Organization
- Extract repeated code into functions
- Use constants for repeated values
- Group related IPC handlers together
- Separate concerns (UI logic vs business logic)

## Future Improvements

See `PLAN_MEJORAS_ZILO.txt` for detailed roadmap including:
- System de logs y auditoría
- Sistema de respaldo y restauración
- Vista previa de PDF en ventana principal
- Templates de renombrado personalizables
- Procesamiento por lotes mejorado
- Estadísticas y reportes
- Detección mejorada con IA
- Integración con servicios en la nube
- And 15+ more features organized by priority

## Development Guidelines

### Before Making Changes
1. Read relevant sections of this CLAUDE.md
2. Understand the IPC communication flow
3. Test in both light and dark themes
4. Consider cross-device file operations

### When Adding Features
1. Follow existing code structure and naming conventions
2. Update this CLAUDE.md with new IPC handlers, functions, or behaviors
3. Add comments only where necessary (complex logic)
4. Test with various PDF types and edge cases
5. Ensure proper error handling and user feedback

### When Refactoring
1. Maintain backward compatibility with localStorage keys
2. Test OCR accuracy isn't negatively affected
3. Verify all window interactions still work
4. Check that themes apply correctly to new elements

### Testing Checklist
- [ ] First-time setup flow works
- [ ] All 6 modes process files correctly
- [ ] Manual rename window functions properly
- [ ] Search finds documents correctly
- [ ] Settings persist after app restart
- [ ] Cross-device file moves work
- [ ] Folder locking system functions
- [ ] Light and dark themes display correctly
- [ ] Large batches (100+ files) process without crashes

## Troubleshooting

### Common Issues

**OCR Not Working:**
- Check internet connection (CDN dependencies)
- Verify PDF.js and Tesseract.js CDN URLs are accessible
- Check console for worker loading errors

**Files Not Moving:**
- Verify destination folders exist and are accessible
- Check for permission issues on target directory
- Look for EXDEV errors in console (cross-device moves)

**Settings Not Persisting:**
- Check localStorage in DevTools
- Verify `first-time-setup` flag is set
- Clear localStorage and restart for fresh setup

**Manual Rename Window Not Opening:**
- Check if another modal window is open
- Verify IPC communication in console
- Restart application if stuck

## Version History

- **v1.0.0** (May 4, 2026): Initial functional version with all core features and optimized architecture.

---

**Maintainer Note**: This file should be updated whenever significant architectural changes, new features, or important behaviors are added to the application.
