# Sisped

Aplicación de escritorio para la gestión de pedidos, clientes, domiciliarios, rutas y estadísticas.

## Descripción
Sisped es una aplicación local construida con Electron, Node.js y SQLite. Incluye un servidor HTTP embebido que sirve la interfaz y una API REST para administrar clientes, productos y pedidos.

## Requisitos
- Node.js 18 o superior
- npm (v9+)
- Windows 10/11 (funciona también en Linux/macOS con Node/Electron instalados)
- Docker (opcional, solo si quieres levantar OSRM localmente)

## Instalación
1. Clona el repositorio y entra en la carpeta del proyecto.
2. Instala dependencias:

```bash
npm install
```

## Ejecutar en modo desarrollo

- Iniciar solo el servidor (útil para depurar la API):

```bash
npm run server
```

Al ejecutarlo el servidor se enlaza a `127.0.0.1` en un puerto libre y mostrará en consola la URL, por ejemplo:

```
Servidor listo en http://127.0.0.1:12345
```

- Iniciar la aplicación de escritorio (Electron). Esto arranca el servidor y abre la UI:

```bash
npm start
```

## Salud y comprobaciones rápidas
- Endpoint de salud: `GET /api/health` (devolverá `{ ok: true }`).
- Comprobar sintaxis de archivos principales:

```bash
npm run check
```

## OSRM (ruteo) — opcional

La app puede usar una instancia de OSRM para optimización de rutas. Dos opciones:

- Usar el servicio público (por defecto): `https://router.project-osrm.org`.
- Levantar una instancia local con Docker usando el archivo `docker-compose.osrm.yml`:

```bash
docker compose -f docker-compose.osrm.yml up -d
```

O con `docker-compose` si lo prefieres:

```bash
docker-compose -f docker-compose.osrm.yml up -d
```

Después, exporta la variable de entorno para que la app use la instancia local:

Windows PowerShell:

```powershell
$env:OSRM_BASE_URL = 'http://127.0.0.1:5000'
npm start
```

Nota: el script `scripts/setup-osrm.ps1` facilita descargar y preparar el PBF en el volumen Docker. Léelo antes de ejecutar si trabajas con datos OSRM locales.

## Scripts útiles
- `npm install` — instala dependencias.
- `npm run server` — arranca solo el servidor Node/Express.
- `npm start` — arranca Electron (inicia el servidor y abre la UI).
- `npm run check` — valida la sintaxis de archivos principales.
- `npm run build` — empaqueta la app usando `electron-builder`.

## Datos y base de datos
- La base de datos SQLite se crea en el directorio `data/` (p. ej. `data/shadday-wok.sqlite`).
- No incluyas archivos de datos pesados en el repositorio (p. ej. `osrm-data/region.osm.pbf`).

## Scripts de mantenimiento
- Normalizar timestamps históricos (zona Bogotá UTC-5):

```bash
node scripts/backfill-bogota-time.js
```

- Preparar OSRM y copiar PBF al volumen Docker (PowerShell helper):

```powershell
.\\scripts\\setup-osrm.ps1 -PbfUrl '<URL_DEL_PBF>'
```

## Verificación mínima manual
1. `npm install`
2. `npm run server` → acceder a `http://127.0.0.1:PORT/api/health`
3. `npm start` → la UI debe abrirse y conectarse automáticamente al servidor interno

## Empaquetado / Distribución
Generar instaladores para Windows (NSIS) con:

```bash
npm run build
```

Los artefactos quedan en `dist/` según la configuración de `electron-builder`.

## Estructura del proyecto
- `electron/` — proceso principal de Electron (`main.js`).
- `src/server/` — API y lógica de negocio.
- `src/renderer/` — cliente web servido por el servidor.
- `scripts/` — utilidades (setup OSRM, backfill, etc.).

## Contribuir
- Abre issues y pull requests.
- Usa commits pequeños y descriptivos.

Si quieres, puedo añadir comprobaciones automáticas, ejemplos de variables de entorno o un script `start:dev` con `concurrently` para desarrollo más cómodo. ¿Lo agrego?
