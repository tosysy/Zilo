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
- **Ventana de Renombrado Manual:** Cuando la extracción falla, se abre una interfaz con visor de PDF integrado que permite validación en tiempo real y previsualización.

### 📂 Organización y Clasificación
- **Modos de Operación:** 6 modos distintos (Auto, Albaranes, Pedidos, DUAs, Facturas, Entradas).
- **Subcarpetas Automáticas:** El modo Pedidos crea automáticamente subcarpetas basadas en el número de pedido.
- **Soporte Multi-Disco:** Manejo robusto de movimiento de archivos entre diferentes unidades de disco.

## 🛠️ Instalación y Ejecución

### Requisitos Previos
- **Node.js**: Versión 16 o superior recomendada.
- **NPM**: Incluido con Node.js.
- **Git**: Para clonar el repositorio.

### Pasos para Instalar
1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/tosysy/Zilo.git
   cd Zilo
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```
   *Esto instalará Electron y las herramientas de construcción necesarias.*

### Cómo Ejecutar
Para iniciar la aplicación en modo desarrollo:
```bash
npm start
```

### Cómo Construir (Generar Instalador)
Para crear un ejecutable instalable para Windows:
```bash
npm run build
```
El instalador se generará en la carpeta `dist-build/`.

## 📦 Dependencias Principales

### Producción
- **Electron**: Framework para la aplicación de escritorio.
- **PDF.js**: Renderizado de documentos PDF en la interfaz.
- **Tesseract.js**: Motor de OCR para extracción de texto (cargado vía CDN).

### Desarrollo
- **Electron-Builder**: Para la generación de instaladores y empaquetado.

## 🏗️ Arquitectura
- **Main Process (`main.js`)**: Gestiona el ciclo de vida, ventanas y operaciones de sistema de archivos.
- **Renderer Process (`renderer/`)**: Interfaz de usuario moderna con soporte para temas claro/oscuro.
- **Preload Scripts**: Puentes de seguridad para comunicación IPC.

---
© 2026 Procesador de PDFs - Desarrollado por Pablo Couse Pena
