const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');
const proj4 = require('proj4');

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const points = ring.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) {
    points.pop();
  }

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const f = x1 * y2 - x2 * y1;
    twiceArea += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }

  if (twiceArea === 0) {
    const sum = points.reduce((acc, point) => {
      acc.x += point[0];
      acc.y += point[1];
      return acc;
    }, { x: 0, y: 0 });
    return {
      area: 0,
      x: sum.x / points.length,
      y: sum.y / points.length
    };
  }

  return {
    area: twiceArea / 2,
    x: cx / (3 * twiceArea),
    y: cy / (3 * twiceArea)
  };
}

function polygonCentroid(polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return null;
  const outer = ringCentroid(polygon[0]);
  if (!outer) return null;
  const holesArea = polygon.slice(1).reduce((acc, ring) => acc + Math.abs(ringCentroid(ring)?.area || 0), 0);
  return {
    area: Math.abs(outer.area) - holesArea,
    x: outer.x,
    y: outer.y
  };
}

function geometryCentroid(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    return polygonCentroid(geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    const parts = geometry.coordinates
      .map(polygonCentroid)
      .filter(Boolean)
      .filter(item => Number.isFinite(item.x) && Number.isFinite(item.y));
    if (!parts.length) return null;
    const totalArea = parts.reduce((acc, item) => acc + (Math.abs(item.area) || 1), 0);
    if (!totalArea) {
      const first = parts[0];
      return { x: first.x, y: first.y, area: 0 };
    }
    return {
      area: totalArea,
      x: parts.reduce((acc, item) => acc + item.x * (Math.abs(item.area) || 1), 0) / totalArea,
      y: parts.reduce((acc, item) => acc + item.y * (Math.abs(item.area) || 1), 0) / totalArea
    };
  }
  return null;
}

async function main() {
  const root = path.join(__dirname, '..');
  const inputDir = path.join(root, 'osrm-data', 'cali-barrios_extract', 'mc_barrios');
  const shpPath = path.join(inputDir, 'mc_barrios.shp');
  const prjPath = path.join(inputDir, 'mc_barrios.prj');
  const outPath = path.join(root, 'src', 'renderer', 'assets', 'cali-neighborhood-centers.generated.json');

  const prjText = fs.readFileSync(prjPath, 'utf8').trim();
  proj4.defs('MAGNA_Cali_Valle_del_Cauca_2009', prjText);
  const toWgs84 = proj4('MAGNA_Cali_Valle_del_Cauca_2009', 'WGS84');

  const source = await shapefile.open(shpPath);
  const centers = {};
  const comunaBuckets = new Map();
  let processed = 0;

  while (true) {
    const result = await source.read();
    if (result.done) break;

    const { properties, geometry } = result.value;
    const barrio = String(properties.barrio || '').trim();
    const comuna = String(properties.comuna || '').trim();
    const centroid = geometryCentroid(geometry);
    if (!barrio || !centroid) continue;

    const [lon, lat] = toWgs84.forward([centroid.x, centroid.y]);
    const key = normalizeKey(barrio);
    if (key) {
      centers[key] = [Number(lat.toFixed(6)), Number(lon.toFixed(6))];
    }

    if (comuna) {
      const comunaKey = `comuna ${Number(comuna)}`;
      if (!comunaBuckets.has(comunaKey)) comunaBuckets.set(comunaKey, []);
      comunaBuckets.get(comunaKey).push([Number(lat), Number(lon)]);
    }

    processed += 1;
  }

  for (const [comunaKey, points] of comunaBuckets.entries()) {
    const avgLat = points.reduce((acc, point) => acc + point[0], 0) / points.length;
    const avgLon = points.reduce((acc, point) => acc + point[1], 0) / points.length;
    centers[comunaKey] = [Number(avgLat.toFixed(6)), Number(avgLon.toFixed(6))];
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(centers, null, 2), 'utf8');

  console.log(`Generados ${Object.keys(centers).length} centros desde ${processed} barrios.`);
  console.log(`Salida: ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});