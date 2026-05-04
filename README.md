# Zilo - Procesador Inteligente de PDFs

Zilo es una solución avanzada de escritorio para la gestión, clasificación y procesamiento de documentos PDF, diseñada para optimizar flujos de trabajo que requieren precisión y velocidad.

## Funcionalidades Principales

### 🔍 Procesamiento OCR Avanzado
Zilo integra tecnología de Reconocimiento Óptico de Caracteres (OCR) para extraer texto de documentos escaneados.
- **Indexación Automática:** El contenido extraído se indexa para permitir búsquedas instantáneas de documentos.
- **Configuración de Escaneo:** Permite definir cuántas páginas procesar por archivo para optimizar el rendimiento.
- **Procesamiento Concurrente:** Capacidad de procesar múltiples archivos simultáneamente con límites configurables.

### 🏷️ Renombrado Inteligente y Manual
- **Renombrado por OCR:** Capacidad de identificar patrones de texto para sugerir nombres de archivos precisos (Series, Códigos, Tipos de Documento).
- **Ventana de Renombrado Manual:** Interfaz dedicada con visor de PDF integrado que permite:
  - Zoom dinámico y navegación fluida por el documento.
  - Validación en tiempo real de formatos (Series y Códigos numéricos).
  - Previsualización instantánea del nombre final del archivo.
- **Vigilancia de Carpetas (Watch Mode):** Monitoreo en tiempo real de carpetas específicas; los archivos nuevos se detectan y procesan automáticamente.

### 📂 Organización y Clasificación
- **Clasificación por Reglas:** Los documentos pueden moverse automáticamente a carpetas de destino basadas en su contenido o metadatos.
- **Seguridad de Datos:** Sistema integrado de copias de seguridad para prevenir la pérdida de información durante procesos de movimiento o renombrado.
- **Persistencia en SQLite:** Utiliza una base de datos robusta para el seguimiento de archivos procesados y configuración.

### 🖥️ Interfaz y Experiencia de Usuario
- **Modo Oscuro/Claro:** Interfaz personalizable que se adapta a las preferencias visuales del usuario.
- **Búsqueda Multitérmino:** Motor de búsqueda potente que permite filtrar documentos por múltiples términos en cascada.
- **Control de Estado:** Bloqueo de seguridad en carpetas críticas para evitar modificaciones accidentales.

---

*Nota: Los instaladores y ejecutables están disponibles en la sección de [Releases](https://github.com/tosysy/Zilo/releases).*
