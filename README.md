# Shadday Wok

Aplicacion de escritorio para comandas de domicilio, clientes, productos, domiciliarios, rutas y estadisticas para Shadday Wok en Cali.

## Alcance actual
- Comandera de pedidos.
- Busqueda y creacion de clientes por nombre o telefono.
- Catalogo de productos.
- Gestion de domiciliarios activos/inactivos.
- Estadisticas por dia, semana y mes.
- Base local en SQLite.

## Requisitos
- Node.js 18 o superior.
- Windows 10/11.

## Instalacion
```bash
npm install
```

## Ejecucion
```bash
npm start
```

## Empaquetado (instalador)
Instala `electron-builder` y ejecuta:

```bash
npm run build
```

Esto generará instaladores en la carpeta `dist/` para la plataforma donde se ejecute.

## Release y versionado
- Etiqueta la versión y empuja tags: `git tag -a v0.1.0 -m "v0.1.0" && git push --tags`.
- Crea un Release en GitHub desde la etiqueta `v0.1.0`.

## Verificacion rapida
1. Buscar un cliente por nombre o telefono.
2. Crear un producto.
3. Registrar un domiciliario.
4. Crear una comanda con al menos un producto.
5. Revisar las estadisticas del panel.

## Estructura
- `electron/`: proceso principal de Electron.
- `src/server/`: servidor local y SQLite.
- `src/renderer/`: interfaz grafica.
- `data/`: base SQLite generada automaticamente.

## Notas
- La base se crea y se llena con datos demo al primer arranque.
- La app corre localmente y no depende de un servidor externo para operar.

## Contribuir
- Sigue el formato de commits: Conventional Commits.
- Abre issues o pull requests en el repositorio remoto.
