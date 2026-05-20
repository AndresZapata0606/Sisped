const https = require('https');
const { openDatabase } = require('../src/server/db');

const caliNeighborhoodCenters = {
  'san fernando': [3.4392, -76.5486],
  tequendama: [3.4297, -76.5402],
  granada: [3.4512, -76.5331],
  centro: [3.4516, -76.5320],
  sur: [3.4085, -76.5400],
  norte: [3.4870, -76.5280],
  oeste: [3.4590, -76.5530],
  'belen': [3.4024, -76.5426],
  'prados del norte': [3.4868, -76.5178]
};

function hashString(value) {
  return String(value || '').split('').reduce((accumulator, character) => ((accumulator << 5) - accumulator) + character.charCodeAt(0), 0);
}

function getRouteCoordinateFromOrder(order, index = 0) {
  if (order && order.latitude != null && order.longitude != null) {
    const lat = Number(order.latitude);
    const lon = Number(order.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 0.0001 && Math.abs(lon) > 0.0001) {
      return [lat, lon];
    }
  }

  const key = String(order.barrio || order.route_zone || '').toLowerCase().trim();
  const base = caliNeighborhoodCenters[key] || [3.4516, -76.5320];
  const offsetSeed = hashString(`${order.address || ''}-${order.id}-${index}`);
  const latOffset = ((offsetSeed % 7) - 3) * 0.0012;
  const lngOffset = (((offsetSeed >> 3) % 7) - 3) * 0.0012;

  return [base[0] + latOffset, base[1] + lngOffset];
}

async function run() {
  const db = await openDatabase();

  const orders = db.prepare(`
    SELECT o.* FROM orders o
    WHERE o.status IN ('listo para salir', 'nuevo', 'en ruta')
    ORDER BY datetime(o.created_at) ASC
    LIMIT 6
  `).all();

  if (!orders || !orders.length) {
    console.error('No hay pedidos para probar.');
    process.exit(1);
  }

  console.log(`Usando ${orders.length} pedidos para la prueba:`);
  orders.forEach(o => console.log(` - ${o.id}: ${o.address || 'sin dirección'} (${o.barrio || 'sin barrio'})`));

  const depot = { latitude: 3.4516, longitude: -76.5320 };

  const points = orders.map((o, i) => {
    const coord = getRouteCoordinateFromOrder(o, i);
    return { id: o.id, latitude: coord[0], longitude: coord[1] };
  });

  // Build coords string with depot first
  const coords = [ `${depot.longitude},${depot.latitude}` , ...points.map(p => `${p.longitude},${p.latitude}`) ];
  const coordsStr = coords.join(';');
  const url = `https://router.project-osrm.org/trip/v1/driving/${coordsStr}?source=first&roundtrip=false&geometries=geojson&overview=full&annotations=duration,distance`;

  console.log('\nLlamando a OSRM Trip...');

  https.get(url, (res) => {
    let raw = '';
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.trips) || !parsed.trips.length) {
          console.error('OSRM no devolvió trips. Respuesta:', parsed);
          process.exit(1);
        }

        const trip = parsed.trips[0];
        console.log(`\nDistance (km): ${((trip.distance||0)/1000).toFixed(2)}`);
        console.log(`Duration (min): ${Math.round((trip.duration||0)/60)}`);

        // OSRM returns waypoint_order which indexes the input waypoints excluding the depot? We'll show mapping
        const orderIndices = Array.isArray(trip.waypoint_order) ? trip.waypoint_order : (parsed.waypoints || []).map((_,i)=>i);
        console.log('\nOrder of waypoint indices (relative to provided coords):', orderIndices);

        // Map back to input points (skip index 0 which is depot)
        const optimized = orderIndices.map(idx => {
          // idx refers to coords positions (0 = depot) — find corresponding point
          const point = (idx === 0) ? { id: 'depot' } : points[idx-1];
          return point;
        }).filter(p => p && p.id !== 'depot');

        console.log('\nSecuencia optimizada (order ids):', optimized.map(p => p.id));
        console.log('\nGeometry sample (first 60 chars):', JSON.stringify(trip.geometry).slice(0,60));
      } catch (e) {
        console.error('Error parseando respuesta OSRM:', e, raw);
      }
    });
  }).on('error', (err) => {
    console.error('Error contactando OSRM:', err);
  });
}

run().catch(err => {
  console.error('Error en test-optimize:', err);
});
