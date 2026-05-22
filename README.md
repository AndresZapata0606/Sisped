# Sisped

Aplicación de escritorio para comandas de domicilio, clientes, productos, domiciliarios, rutas y estadísticas.

## Descripción
Sisped es una app local construida con Electron, Node.js y SQLite para gestionar pedidos, clientes, repartidores y rutas con estadísticas en tiempo real.

## Requisitos
- Node.js 18 o superior
- Windows 10/11
- Conexión a internet solo para instalar dependencias y subir al repositorio

## Instalación
```bash
npm install
```

## Ejecución
```bash
npm start
```

## Empaquetado
```bash
npm run build
```

Esto generará los archivos de salida en `dist/`.

## Scripts útiles
- `npm install`: instala dependencias
- `npm start`: inicia la aplicación Electron
- `npm run build`: crea el paquete instalable
- `npm run check`: valida la sintaxis de los archivos principales

## Notas de datos
- La base de datos local se crea en `data/shadday-wok.sqlite`.
- El directorio `data/` y los archivos SQLite están excluidos del repositorio.
- El archivo `osrm-data/region.osm.pbf` es demasiado grande para GitHub (>100 MB) y no se incluye en el repositorio. Si necesitas trabajar con OSRM, coloca manualmente el archivo `.pbf` en `osrm-data/`.

## Backfill horario
Para normalizar timestamps históricos en UTC-5 (Bogotá), existe el script:
```bash
node scripts/backfill-bogota-time.js
```

## Estructura del proyecto
- `electron/` - proceso principal de Electron
- `src/server/` - servidor local y lógica de datos
- `src/renderer/` - interfaz gráfica y vistas
- `scripts/` - utilidades y migraciones

## Repositorio remoto
- `https://github.com/AndresZapata0606/Sisped`

## Verificación rápida
1. Instalar dependencias con `npm install`
2. Ejecutar `npm start`
3. Crear clientes, productos y pedidos
4. Verificar que las estadísticas se actualicen

## Contribuir
- Usa commits claros y descriptivos
- Abre issues o pull requests en el repositorio remoto
