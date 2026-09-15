# Zilo — Intelligent PDF Processor

> Desktop application for automated classification, OCR extraction and organization of commercial PDF documents.

![Platform](https://img.shields.io/badge/platform-Windows-blue?logo=windows)
![Electron](https://img.shields.io/badge/Electron-38-47848F?logo=electron)
![License](https://img.shields.io/badge/license-ISC-green)
![Version](https://img.shields.io/badge/version-1.0.0-brightgreen)

## Overview

Zilo is an Electron-based desktop application designed to automate the processing of scanned commercial documents. It uses OCR technology (Tesseract.js) to extract text, automatically detect document types, rename files following standardized conventions, and organize them into the appropriate folders.

**Primary use case:** Automated processing of Spanish commercial documents — delivery notes (*albaranes*), purchase orders (*pedidos*), customs declarations (*DUAs*), invoices (*facturas*) and incoming goods receipts (*entradas*).

## Features

### OCR Processing
- **Automatic text extraction** from scanned PDFs using Tesseract.js
- **Full-text indexing** for instant document search across your entire archive
- **Automatic document type detection** by analyzing extracted content
- **Batch processing** with configurable concurrency limits to avoid system overload

### Intelligent Renaming
- **Automatic renaming** — extracts document numbers and formats filenames to the standard: `S-NNNNNN TYPE.pdf` (e.g. `1-13770 ALBARAN.pdf`)
- **Manual rename window** — when OCR extraction fails, an interactive window with integrated PDF viewer opens for manual validation with real-time preview

### Organization & Classification
- **6 operation modes:** Auto (beta), Albaranes, Pedidos, DUAs, Facturas, Entradas
- **Automatic subfolder creation** for purchase orders based on order number
- **Cross-device file moving** — robust support for moving files across different drives and partitions

### Interface
- **Light / Dark theme** with persistent preference
- **Integrated search window** with full-text search across processed documents
- **Settings window** with configurable folder paths and concurrency limits

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) v16 or higher
- [Git](https://git-scm.com/)

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/tosysy/Zilo.git
cd Zilo

# 2. Install dependencies
npm install

# 3. Start the application
npm start
```

### Build (Windows Installer)

```bash
npm run build
```

The installer will be generated in the `dist-build/` folder.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Electron](https://www.electronjs.org/) |
| PDF Rendering | [PDF.js](https://mozilla.github.io/pdf.js/) (via CDN) |
| OCR Engine | [Tesseract.js](https://tesseract.projectnaptha.com/) (via CDN) |
| Database | SQLite (via `better-sqlite3`) |
| Packaging | [electron-builder](https://www.electron.build/) |

## Architecture

```
Zilo/
├── main.js                  # Main process — window management & file system operations
├── preload.js               # Security bridge (IPC) for the main window
├── db.js                    # SQLite database layer for document indexing
├── renderer/
│   ├── index.html           # Main window UI
│   ├── app.js               # Main window renderer logic
│   ├── search-window.html   # Search window UI
│   ├── manual-rename-*.html # Manual rename window UI
│   └── settings-window.html # Settings window UI
├── *-preload.js             # IPC bridges for each secondary window
└── build/                   # Build assets (icons)
```

**Process model:**
- **Main Process** (`main.js`) — manages the app lifecycle, Electron windows, all file system operations (move, rename, mkdir) and IPC handlers
- **Renderer Processes** (`renderer/`) — UI logic running in isolated browser contexts
- **Preload Scripts** — secure context bridges exposing only the necessary IPC methods to each renderer

## File Naming Convention

Documents are renamed following the format:

```
{SERIE}-{CODE} {TYPE}.pdf
```

Where `SERIE` is the first digit and `CODE` is the 6-digit document number (zero-padded).

| Input | Output |
|---|---|
| Scanned albarán with number 1013770 | `1-13770 ALBARAN.pdf` |
| Scanned pedido with number 1025088 | `1-25088 PEDIDO ALMACEN.pdf` → moved to `1-25088 PEDIDO/` |

## License

ISC — © 2026 Pablo Couse Pena
