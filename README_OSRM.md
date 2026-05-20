OSRM local (despliegue con Docker)
=================================

Este documento explica cómo levantar una instancia local de OSRM (Routing) usando Docker y el `docker-compose.osrm.yml` incluido.

Requisitos
- Docker y docker-compose instalados en la máquina.
- Un archivo PBF de OpenStreetMap para la región deseada (ej. Colombia) — recomendado: Geofabrik https://download.geofabrik.de/

Pasos rápidos

1. Crear carpeta de datos:

```powershell
mkdir osrm-data
```

2. Descargar el PBF (ejemplo Colombia, archivo grande):

```powershell
# Descarga desde Geofabrik (ejemplo)
Invoke-WebRequest -Uri https://download.geofabrik.de/south-america/colombia-latest.osm.pbf -OutFile .\osrm-data\region.osm.pbf
```

3. Preparar los archivos `.osrm` usando la imagen oficial (ejecutar desde el directorio del proyecto):

```powershell
# Extraer usando el perfil de conducción por defecto
docker run --rm -v ${PWD}\osrm-data:/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/region.osm.pbf
# Contraccionar para acelerar consultas (opcional pero recomendado)
docker run --rm -v ${PWD}\osrm-data:/data osrm/osrm-backend osrm-contract /data/region.osrm
```

4. Iniciar el servicio OSRM con docker-compose:

```powershell
docker-compose -f docker-compose.osrm.yml up -d
```

5. Probar el servicio:

```
# ejemplo: status
curl "http://localhost:5000/health"
# ejemplo: ruta simple (route)
curl "http://localhost:5000/route/v1/driving/-76.5320,3.4516;-76.5300,3.4520?overview=false"
```

Integración con la app
- El servidor de la app (archivo `src/server/app.js`) puede usar la variable de entorno `OSRM_BASE_URL` para apuntar a la instancia local (por defecto usa el servicio público `https://router.project-osrm.org`).
- Para ejecutar la app apuntando a la instancia local:

```powershell
$env:OSRM_BASE_URL = 'http://127.0.0.1:5000'
npm start
```

Notas
- El PBF para países completos puede ser grande (>100MB). Considera usar extractos por región si sólo necesitas una ciudad.
- Si prefieres GraphHopper en vez de OSRM, puedo preparar un `docker-compose` alternativo.
