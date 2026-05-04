# Zilo v1.0.0 - Procesador Inteligente de PDFs

Zilo es una aplicación de escritorio basada en Electron para la clasificación y procesamiento automatizado de documentos PDF. Utiliza OCR (Tesseract.js) para extraer texto de documentos, detecta automáticamente el tipo de documento, los renombra siguiendo convenciones estandarizadas y los organiza en carpetas apropiadas.

**Caso de uso principal**: Procesamiento de documentos comerciales españoles (albaranes, pedidos, DUAs, facturas, entradas) mediante la extracción de números de documento y su organización automática.

## 🚀 Funcionalidades Principales

### 🔍 Procesamiento OCR Avanzado
Zilo integra tecnología de Reconocimiento Óptico de Caracteres para extraer texto de documentos escaneados.
- **Indexación Automática:** El contenido extraído se indexa para permitir búsquedas instantáneas de documentos.
- **Detección Automática:** Identifica el tipo de documento (albarán, pedido, factura, etc.) analizando su contenido.
- **Procesamiento por Lotes:** Capacidad de procesar grandes volúmenes de archivos con límites de concurrencia configurables para no saturar el sistema.

### ✍️ Renombrado Inteligente y Manual
- **Renombrado Automático:** Extrae números de documento y formatea el nombre según el estándar: `S-NNNNNN TIPO.pdf` (ej. `1-13770 ALBARAN.pdf`).
- **Ventana de Renombrado Manual:** Cuando la extracción falla, se abre una interfaz con visor de PDF integrado que permite:
  - Validación en tiempo real de formatos.
  - Previsualización instantánea del nombre final.
  - Selección rápida del tipo de documento.

### 📂 Organización y Clasificación
- **Modos de Operación:** 6 modos distintos (Auto, Albaranes, Pedidos, DUAs, Facturas, Entradas).
- **Subcarpetas Automáticas:** El modo Pedidos crea automáticamente subcarpetas basadas en el número de pedido.
- **Gestión de Conflictos:** Resolución automática de nombres duplicados añadiendo sufijos numéricos.
- **Soporte Multi-Disco:** Manejo robusto de movimiento de archivos entre diferentes unidades de disco.

### 🖥️ Interfaz y Experiencia de Usuario
- **Modo Oscuro/Claro:** Interfaz moderna y personalizable.
- **Búsqueda Multitérmino:** Motor de búsqueda potente que permite filtrar documentos por hasta 4 términos simultáneos.
- **Sistema de Bloqueo:** Protección de carpetas de destino para evitar cambios accidentales.

## 🛠️ Detalles Técnicos

### Arquitectura
- **Framework:** Electron (Node.js + Chromium).
- **OCR:** Tesseract.js (Modelo de lenguaje en español).
- **Renderizado PDF:** PDF.js.
- **Persistencia:** LocalStorage para configuración e indexación JSON para búsquedas.

### Comandos de Desarrollo
```bash
npm start              # Iniciar la aplicación
npm run build          # Generar instalador para Windows (NSIS)
```

### Estructura del Proyecto
- `main.js`: Proceso principal de Electron, lógica de sistema de archivos e IPC.
- `renderer/`: Interfaz de usuario (HTML, CSS, JS).
- `preload.js`: Puentes de seguridad entre el proceso principal y la interfaz.

## 📦 Instalación
Los instaladores y ejecutables están disponibles en la sección de [Releases](https://github.com/tosysy/Zilo/releases).

---
© 2026 Procesador de PDFs - Desarrollado por Pablo Couse Pena
