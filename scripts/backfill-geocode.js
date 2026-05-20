const { openDatabase } = require('../src/server/db');
const https = require('https');

function geocode(text) {
  return new Promise((resolve) => {
    if (!text) return resolve(null);
    const query = encodeURIComponent(`${text}, Cali, Colombia`);
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${query}&limit=1`;
    try {
      const req = https.request(url, { headers: { 'User-Agent': 'ShaddayWok/1.0 (contact@shadday.local)' } }, (res) => {
        let raw = '';
        res.on('data', (c) => raw += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length) {
              resolve({ lat: Number(parsed[0].lat), lon: Number(parsed[0].lon) });
            } else resolve(null);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    } catch (e) { resolve(null); }
  });
}

async function run() {
  const db = await openDatabase();

  const addresses = db.prepare('SELECT id, address, barrio FROM client_addresses WHERE (latitude IS NULL OR longitude IS NULL) AND address <> ""').all();
  console.log(`Addresses to geocode: ${addresses.length}`);
  for (const a of addresses) {
    const text = `${a.address} ${a.barrio}`.trim();
    const geo = await geocode(text);
    if (geo) {
      db.prepare('UPDATE client_addresses SET latitude = ?, longitude = ? WHERE id = ?').run(geo.lat, geo.lon, a.id);
      db.save();
      console.log(`Geocoded address ${a.id} -> ${geo.lat}, ${geo.lon}`);
    } else {
      console.log(`No geocode for address ${a.id}`);
    }
  }

  const orders = db.prepare('SELECT id, address, barrio FROM orders WHERE (latitude IS NULL OR longitude IS NULL) AND address <> ""').all();
  console.log(`Orders to geocode: ${orders.length}`);
  for (const o of orders) {
    const text = `${o.address} ${o.barrio}`.trim();
    const geo = await geocode(text);
    if (geo) {
      db.prepare('UPDATE orders SET latitude = ?, longitude = ? WHERE id = ?').run(geo.lat, geo.lon, o.id);
      db.save();
      console.log(`Geocoded order ${o.id} -> ${geo.lat}, ${geo.lon}`);
    } else {
      console.log(`No geocode for order ${o.id}`);
    }
  }

  console.log('Backfill geocoding complete');
}

run().catch(err => { console.error('Backfill error', err); process.exit(1); });
