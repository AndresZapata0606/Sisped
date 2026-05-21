const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const { openDatabase } = require('./db');

const OSRM_BASE_URL = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org';

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getBogotaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((accumulator, part) => {
    if (part.type !== 'literal') accumulator[part.type] = part.value;
    return accumulator;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}-05:00`;
}

function getRangeBounds(range, cutoffHour = 0) { // Default to 0 for safety, will be passed from client
  const now = new Date();
  const end = new Date(now); // 'end' is always the current moment

  const start = new Date(now);

  if (range === 'week') {
    start.setDate(start.getDate() - 7);
    start.setHours(0, 0, 0, 0); // Start of the day 7 days ago
  } else if (range === 'month') {
    start.setMonth(start.getMonth() - 1);
    start.setDate(1); // Start of the month 1 month ago
    start.setHours(0, 0, 0, 0);
  } else { // 'day'
    // If current hour is before cutoff, the "day" started on the previous calendar day at cutoffHour.
    // If current hour is at or after cutoff, the "day" started on the current calendar day at cutoffHour.
    if (now.getHours() < cutoffHour) {
      start.setDate(now.getDate() - 1); // Go to previous day
    }
    start.setHours(cutoffHour, 0, 0, 0); // Set to cutoff hour
  }

  return {
    start: start.toISOString().slice(0, 19).replace('T', ' '),
    end: end.toISOString().slice(0, 19).replace('T', ' ')
  };
}

function buildStats(db, range, cutoffHour = 0) { // Add cutoffHour parameter with default
  const { start, end } = getRangeBounds(range, cutoffHour); // Pass cutoffHour
  const mainQuery = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'entregado' THEN 1 ELSE 0 END) AS delivered_orders,
      SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END) AS cancelled_orders,
      COALESCE(SUM(total), 0) AS total_sales,
      COALESCE(AVG(total), 0) AS average_ticket
    FROM orders
    WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?)
  `).get(start, end);

  // Query para el tiempo promedio de entrega, solo para pedidos con tiempos de recogida y entrega registrados
  const deliveryTimeQuery = db.prepare(`
    SELECT
      COALESCE(AVG(JULIANDAY(delivered_at) - JULIANDAY(picked_up_at)) * 24 * 60, 0) AS average_delivery_time_minutes
    FROM orders
    WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?)
    AND picked_up_at IS NOT NULL AND delivered_at IS NOT NULL
  `).get(start, end);

  const productQuery = db.prepare(`
    SELECT p.name, SUM(oi.quantity) AS qty
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN products p ON p.id = oi.product_id
    WHERE datetime(o.created_at) BETWEEN datetime(?) AND datetime(?)
    GROUP BY p.id
    ORDER BY qty DESC, p.name ASC
    LIMIT 1
  `).get(start, end);

  const driverQuery = db.prepare(`
    SELECT d.name, COUNT(*) AS total_assigned
    FROM orders o
    INNER JOIN drivers d ON d.id = o.driver_id
    WHERE o.driver_id IS NOT NULL AND datetime(o.created_at) BETWEEN datetime(?) AND datetime(?)
    GROUP BY d.id
    ORDER BY total_assigned DESC, d.name ASC
    LIMIT 1
  `).get(start, end);

  return {
    range,
    start,
    end, // Asegúrate de que 'end' también se formatee correctamente si se usa en la UI
    totalOrders: mainQuery.total_orders || 0,
    deliveredOrders: mainQuery.delivered_orders || 0,
    cancelledOrders: mainQuery.cancelled_orders || 0,
    totalSales: mainQuery.total_sales || 0,
    averageTicket: mainQuery.average_ticket || 0,
    averageDeliveryTimeMinutes: deliveryTimeQuery.average_delivery_time_minutes || 0,
    topProduct: productQuery ? productQuery.name : 'Sin datos',
    topDriver: driverQuery ? driverQuery.name : 'Sin datos'
  };
}

function createRouteSuggestion(db, orderId) {
  const order = db.prepare(`
    SELECT o.*, c.name AS client_name, d.name AS driver_name
    FROM orders o
    INNER JOIN clients c ON c.id = o.client_id
    LEFT JOIN drivers d ON d.id = o.driver_id
    WHERE o.id = ?
  `).get(orderId);

  if (!order) {
    return null;
  }

  const siblingOrders = db.prepare(`
    SELECT id, barrio, address, total, status
    FROM orders
    WHERE id != ? AND status IN ('listo para salir', 'en ruta')
    ORDER BY barrio ASC, datetime(created_at) ASC
    LIMIT 5
  `).all(orderId);

  const route = [
    {
      label: 'Restaurante Shadday Wok',
      barrio: 'Punto base'
    },
    ...siblingOrders.map((item) => ({
      label: `Pedido #${item.id}`,
      barrio: item.barrio,
      address: item.address,
      status: item.status
    }))
  ];

  const suggestion = db.prepare(`
    INSERT INTO route_suggestions (order_id, driver_id, barrio_group, route_json, distance_km, eta_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    order.id,
    order.driver_id,
    order.barrio,
    JSON.stringify(route),
    Math.max(route.length - 1, 1) * 2.4,
    Math.max(route.length - 1, 1) * 8
  );

  return {
    id: suggestion.lastInsertRowid,
    orderId: order.id,
    route,
    driver: order.driver_name,
    barrio: order.barrio,
    distanceKm: Math.max(route.length - 1, 1) * 2.4,
    etaMinutes: Math.max(route.length - 1, 1) * 8
  };
}

function normalizeAddressKey(row) {
  return [row?.client_id, row?.address, row?.barrio, row?.reference]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('|');
}

function backfillClientAddressesFromOrders(db) {
  const historicalAddresses = db.prepare(`
    SELECT o.client_id, o.address, o.barrio, o.reference, o.latitude, o.longitude, o.created_at
    FROM orders o
    WHERE TRIM(COALESCE(o.address, '')) <> ''
    ORDER BY o.created_at ASC, o.id ASC
  `).all();

  const existingAddresses = db.prepare(`
    SELECT client_id, address, barrio, reference
    FROM client_addresses
  `).all();

  const seen = new Set(existingAddresses.map(normalizeAddressKey));
  const lastInsertedByClient = new Map();

  db.transaction(() => {
    historicalAddresses.forEach((address) => {
      const key = normalizeAddressKey(address);
      if (seen.has(key)) return;

      const insertResult = db.prepare(`
        INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        address.client_id,
        'principal',
        String(address.address || '').trim(),
        String(address.barrio || '').trim(),
        String(address.reference || '').trim(),
        0,
        address.latitude ? Number(address.latitude) : null,
        address.longitude ? Number(address.longitude) : null
      );

      seen.add(key);
      lastInsertedByClient.set(address.client_id, insertResult.lastInsertRowid);
    });

    lastInsertedByClient.forEach((addressId, clientId) => {
      db.prepare('UPDATE client_addresses SET is_primary = 0 WHERE client_id = ?').run(clientId);
      db.prepare('UPDATE client_addresses SET is_primary = 1 WHERE id = ?').run(addressId);
    });
  })();
}

function requestUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'http:' ? http : https;
      const requestOptions = {
        headers: options.headers || {},
        method: options.method || 'GET'
      };

      const req = client.request(parsedUrl, requestOptions, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: raw }));
      });

      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function startServer() {
  const db = await openDatabase();
  const app = express();

  function getClientAddressSnapshot(clientId) {
    const savedAddresses = db.prepare(`
      SELECT * FROM client_addresses
      WHERE client_id = ?
      ORDER BY is_primary DESC, created_at DESC, id DESC
    `).all(clientId).map((address) => ({
      ...address,
      source: 'saved'
    }));

    const orderAddresses = db.prepare(`
      SELECT o.id AS order_id, o.address, o.barrio, o.reference, o.latitude, o.longitude, o.created_at
      FROM orders o
      WHERE o.client_id = ? AND TRIM(COALESCE(o.address, '')) <> ''
      ORDER BY o.created_at DESC, o.id DESC
    `).all(clientId).map((order) => ({
      client_id: clientId,
      id: `order-${order.order_id}`,
      label: `Pedido #${order.order_id}`,
      address: order.address,
      barrio: order.barrio,
      reference: order.reference,
      latitude: order.latitude,
      longitude: order.longitude,
      is_primary: 0,
      created_at: order.created_at,
      source: 'order'
    }));

    const mergedAddresses = [];
    const seen = new Set();

    [...savedAddresses, ...orderAddresses].forEach((address) => {
      const key = normalizeAddressKey(address);
      if (seen.has(key)) return;
      seen.add(key);
      mergedAddresses.push(address);
    });

    return {
      addresses: mergedAddresses,
      primaryAddress: mergedAddresses.find((address) => address.is_primary) || mergedAddresses[0] || null,
      addressCount: mergedAddresses.length
    };
  }

  backfillClientAddressesFromOrders(db);

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'renderer')));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, app: 'Shadday Wok' });
  });

  app.get('/api/clients', (request, response) => {
    const search = String(request.query.q || '').trim();
    const clients = search
      ? db.prepare(`
          SELECT c.* FROM clients c
          WHERE c.name LIKE ? OR c.phone LIKE ?
          ORDER BY c.updated_at DESC
        `).all(`%${search}%`, `%${normalizePhone(search)}%`)
      : db.prepare(`
          SELECT c.* FROM clients c
          ORDER BY c.updated_at DESC
          LIMIT 20
        `).all();

    response.json(clients.map((client) => ({
      ...client,
      ...getClientAddressSnapshot(client.id)
    })));
  });

  app.delete('/api/clients/:id', (request, response) => {
    try {
      const id = Number(request.params.id);
      // Borramos primero direcciones y pedidos por si fallan las claves foráneas
      db.prepare('DELETE FROM client_addresses WHERE client_id = ?').run(id);
      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
      db.save();
      response.status(204).send();
    } catch (error) {
      response.status(500).json({ message: error.message });
    }
  });

  app.get('/api/clients/:id/addresses', (request, response) => {
    const clientId = Number(request.params.id);
    const snapshot = getClientAddressSnapshot(clientId);
    response.json(snapshot.addresses);
  });

  app.post('/api/clients/:id/addresses', (request, response) => {
    const clientId = request.params.id;
    const { label, address, barrio, reference, latitude, longitude, geocodingSource } = request.body;
    const result = db.prepare(`
      INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary, latitude, longitude, geocoding_source)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(clientId, label || 'otra', address, barrio, reference || '', latitude ? Number(latitude) : null, longitude ? Number(longitude) : null, geocodingSource || null);
    db.save();
    response.status(201).json({ id: result.lastInsertRowid });
  });

  app.patch('/api/addresses/:id', (request, response) => {
    const { label, address, barrio, reference, latitude, longitude, geocodingSource } = request.body;
    db.prepare(`
      UPDATE client_addresses
      SET label = ?, address = ?, barrio = ?, reference = ?, latitude = ?, longitude = ?, geocoding_source = ?
      WHERE id = ?
    `).run(label, address, barrio, reference, latitude ? Number(latitude) : null, longitude ? Number(longitude) : null, geocodingSource || null, request.params.id);
    db.save();
    response.json({ ok: true });
  });

  app.delete('/api/addresses/:id', (request, response) => {
    db.prepare('DELETE FROM client_addresses WHERE id = ? AND is_primary = 0').run(request.params.id);
    db.save();
    response.status(204).send();
  });

  app.patch('/api/addresses/:id/primary', (request, response) => {
    db.transaction(() => {
      const addr = db.prepare('SELECT client_id FROM client_addresses WHERE id = ?').get(request.params.id);
      if (addr) {
        db.prepare('UPDATE client_addresses SET is_primary = 0 WHERE client_id = ?').run(addr.client_id);
        db.prepare('UPDATE client_addresses SET is_primary = 1 WHERE id = ?').run(request.params.id);
      }
    })();
    response.json({ ok: true });
  });

  app.get('/api/clients/:id/orders', (request, response) => {
    const clientId = toNumber(request.params.id);
    if (clientId === 0) { // Asumiendo que los IDs de cliente son siempre positivos
      return response.status(400).json({ message: 'ID de cliente inválido.' });
    }

    try {
      const orders = db.prepare(`
        SELECT o.*, d.name AS driver_name
        FROM orders o
        LEFT JOIN drivers d ON d.id = o.driver_id
        WHERE o.client_id = ?
        ORDER BY datetime(o.created_at) DESC
        LIMIT 50
      `).all(clientId);

      const orderIds = orders.map(o => o.id);
      let itemsByOrder = {};
      if (orderIds.length > 0) {
        itemsByOrder = db.prepare(`
          SELECT oi.* FROM order_items oi 
          WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')})
        `).all(orderIds).reduce((acc, item) => {
          if (!acc[item.order_id]) acc[item.order_id] = [];
          acc[item.order_id].push(item);
          return acc;
        }, {});
      }
      response.json(orders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] })));
    } catch (error) {
      console.error('Error al obtener historial de pedidos:', error);
      response.status(500).json({ message: 'Error interno al cargar el historial de pedidos.' });
    }
  });

  // Optimizar secuencia usando OSRM Trip (router.project-osrm.org)
  app.post('/api/routes/optimize', async (request, response) => {
    try {
      const points = Array.isArray(request.body.points) ? request.body.points : [];
      if (!points.length) return response.status(400).json({ message: 'No se proporcionaron puntos para optimizar.' });

      // Asegurar que cada punto tenga lat y lon
      const coords = [];
      const inputPoints = [];
      for (const p of points) {
        const lat = Number(p.latitude ?? p.lat ?? 0);
        const lon = Number(p.longitude ?? p.lon ?? 0);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        coords.push(`${lon},${lat}`);
        inputPoints.push(Object.assign({}, p, { latitude: lat, longitude: lon }));
      }

      if (!coords.length) return response.status(400).json({ message: 'No hay coordenadas válidas entre los puntos.' });

      // Insertar punto base (restaurante) al inicio si no viene explícito
      const depot = request.body.depot || { latitude: 3.411568, longitude: -76.515763 };
      const depotCoord = `${Number(depot.longitude)},${Number(depot.latitude)}`;
      // Prepend depot to coords/inputPoints
      coords.unshift(depotCoord);
      inputPoints.unshift({ id: 'depot', latitude: Number(depot.latitude), longitude: Number(depot.longitude) });

      const coordsStr = coords.join(';');
      const baseUrl = OSRM_BASE_URL.replace(/\/$/, '');
      const tableUrl = `${baseUrl}/table/v1/driving/${coordsStr}?annotations=duration,distance`;
      const tableResult = await requestUrl(tableUrl);
      const tableParsed = JSON.parse(tableResult.body || '{}');

      if (tableResult.statusCode >= 400) {
        return response.status(502).json({
          message: 'OSRM table respondió con error.',
          statusCode: tableResult.statusCode,
          body: tableResult.body
        });
      }

      if (!tableParsed || !Array.isArray(tableParsed.durations)) {
        return response.status(502).json({
          message: 'OSRM no devolvió matriz de tiempos.',
          body: tableResult.body
        });
      }

      const nodeCount = inputPoints.length;
      const durations = tableParsed.durations;
      const visited = new Set([0]);
      const orderIndices = [0];

      while (orderIndices.length < nodeCount) {
        const currentIndex = orderIndices[orderIndices.length - 1];
        let nextIndex = -1;
        let bestDuration = Number.POSITIVE_INFINITY;

        for (let candidate = 1; candidate < nodeCount; candidate += 1) {
          if (visited.has(candidate)) continue;
          const durationValue = durations[currentIndex] && Number.isFinite(durations[currentIndex][candidate])
            ? durations[currentIndex][candidate]
            : Number.POSITIVE_INFINITY;
          if (durationValue < bestDuration) {
            bestDuration = durationValue;
            nextIndex = candidate;
          }
        }

        if (nextIndex === -1) {
          for (let candidate = 1; candidate < nodeCount; candidate += 1) {
            if (!visited.has(candidate)) {
              nextIndex = candidate;
              break;
            }
          }
        }

        if (nextIndex === -1) break;
        visited.add(nextIndex);
        orderIndices.push(nextIndex);
      }

      const optimizedBase = orderIndices.map(i => inputPoints[i]).filter(p => p && p.id !== 'depot');

      const legCoords = [inputPoints[0], ...optimizedBase].map(p => `${p.longitude},${p.latitude}`);
      let totalDistance = 0;
      let totalDuration = 0;
      let geometryCoordinates = [];
      const optimized = [];

      for (let i = 0; i < legCoords.length - 1; i += 1) {
        const segmentUrl = `${baseUrl}/route/v1/driving/${legCoords[i]};${legCoords[i + 1]}?overview=full&geometries=geojson`;
        const segmentResult = await requestUrl(segmentUrl);
        if (segmentResult.statusCode >= 400) {
          return response.status(502).json({
            message: 'OSRM route respondió con error.',
            statusCode: segmentResult.statusCode,
            body: segmentResult.body
          });
        }

        const segmentParsed = JSON.parse(segmentResult.body || '{}');
        const route = Array.isArray(segmentParsed.routes) ? segmentParsed.routes[0] : null;
        if (!route) {
          return response.status(502).json({
            message: 'OSRM no devolvió un tramo válido.',
            body: segmentResult.body
          });
        }

        totalDistance += Number(route.distance || 0);
        totalDuration += Number(route.duration || 0);

        const currentStop = optimizedBase[i];
        optimized.push({
          ...currentStop,
          segmentDistanceKm: route.distance ? Number(route.distance) / 1000 : 0,
          segmentDurationMin: route.duration ? Number(route.duration) / 60 : 0,
          cumulativeDistanceKm: totalDistance / 1000,
          etaMinutes: totalDuration / 60
        });

        const coords = route.geometry && Array.isArray(route.geometry.coordinates) ? route.geometry.coordinates : [];
        if (coords.length) {
          if (geometryCoordinates.length) coords.shift();
          geometryCoordinates = geometryCoordinates.concat(coords);
        }
      }

      response.json({
        optimized: true,
        distanceKm: totalDistance / 1000,
        durationMin: Math.round(totalDuration / 60),
        geometry: geometryCoordinates.length ? { type: 'LineString', coordinates: geometryCoordinates } : null,
        sequence: optimized,
        source: 'osrm-table+route'
      });
    } catch (e) {
      console.error('Error interno optimizando ruta:', e);
      response.status(500).json({ message: 'Error interno optimizando ruta.', error: e.message });
    }
  });

  app.post('/api/clients/resolve', async (request, response) => { // Wrap client resolution in a transaction
    try {
      const result = db.transaction(() => {
        const name = String(request.body.name || '').trim(); // No need to trim here, already done in client
        const phone = normalizePhone(request.body.phone);
        const address = String(request.body.address || '').trim();
        const barrio = String(request.body.barrio || '').trim();
        const reference = String(request.body.reference || '').trim();
        const notes = String(request.body.notes || '').trim();

        if (!name || !phone) {
          throw new Error('Nombre y telefono son obligatorios.');
        }

        const existing = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
        const saveClient = existing
          ? db.prepare('UPDATE clients SET name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          : db.prepare('INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)');

        let clientId = existing ? existing.id : null;

        if (existing) {
          saveClient.run(name, notes, existing.id);
        } else {
          const insertResult = saveClient.run(name, phone, notes);
          clientId = insertResult.lastInsertRowid;
        }

        let insertedAddressId = null;
        if (address) {
          if (request.body.setPrimaryAddress !== false) {
            db.prepare('UPDATE client_addresses SET is_primary = 0 WHERE client_id = ?').run(clientId);
          }

          const insertAddr = db.prepare(`
            INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary, latitude, longitude, geocoding_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(clientId, request.body.label || 'principal', address, barrio, reference, request.body.setPrimaryAddress === false ? 0 : 1, request.body.latitude ? Number(request.body.latitude) : null, request.body.longitude ? Number(request.body.longitude) : null, request.body.geocodingSource || null);
          insertedAddressId = insertAddr.lastInsertRowid;

        }

        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
        const primaryAddress = db.prepare(`
          SELECT * FROM client_addresses WHERE client_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 1
        `).get(clientId) || null;

        return { client, primaryAddress, insertedAddressId };
      })();
      response.json(result);
    } catch (error) {
      response.status(400).json({ message: error.message });
    }
  });

  app.get('/api/products', (_request, response) => {
    response.json(db.prepare('SELECT * FROM products ORDER BY active DESC, category ASC, name ASC').all());
  });

  app.post('/api/products', (request, response) => {
    const name = String(request.body.name || '').trim();
    const category = String(request.body.category || 'General').trim();
    const price = toNumber(request.body.price);
    const comboItems = JSON.stringify(Array.isArray(request.body.comboItems) ? request.body.comboItems : []);

    if (!name) {
      return response.status(400).json({ message: 'El nombre del producto es obligatorio.' });
    }

    const result = db.prepare(`
      INSERT INTO products (name, category, price, combo_items, active)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, category, price, comboItems, request.body.active === false ? 0 : 1);
    db.save(); // Persist changes
    response.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid));
  });

  app.patch('/api/products/:id', (request, response) => {
    const id = Number(request.params.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);

    if (!product) {
      return response.status(404).json({ message: 'Producto no encontrado.' });
    }

    const name = String(request.body.name || product.name).trim();
    const category = String(request.body.category || product.category).trim();
    const price = request.body.price !== undefined ? toNumber(request.body.price) : product.price;
    const active = request.body.active !== undefined ? (request.body.active ? 1 : 0) : product.active;
    const comboItems = request.body.comboItems !== undefined
      ? JSON.stringify(Array.isArray(request.body.comboItems) ? request.body.comboItems : [])
      : product.combo_items;

    db.prepare(`
      UPDATE products
      SET name = ?, category = ?, price = ?, combo_items = ?, active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, category, price, comboItems, active, id);
    db.save();
    response.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  });

  app.delete('/api/products/:id', (request, response) => {
    const id = Number(request.params.id);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);

    if (!product) {
      return response.status(404).json({ message: 'Producto no encontrado.' });
    }

    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    db.save();
    response.status(204).send();
  });

  app.get('/api/drivers', (_request, response) => {
    response.json(db.prepare('SELECT * FROM drivers ORDER BY active DESC, name ASC').all());
  });

  app.post('/api/drivers', (request, response) => {
    const name = String(request.body.name || '').trim();
    const phone = normalizePhone(request.body.phone);
    const vehicle = String(request.body.vehicle || 'Moto').trim();
    const zone = String(request.body.zone || '').trim();

    if (!name) {
      return response.status(400).json({ message: 'El nombre del domiciliario es obligatorio.' });
    }

    const result = db.prepare(`
      INSERT INTO drivers (name, phone, vehicle, zone, active, current_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, phone, vehicle, zone, request.body.active === false ? 0 : 1, 'disponible');
    db.save(); // Persist changes
    response.status(201).json(db.prepare('SELECT * FROM drivers WHERE id = ?').get(result.lastInsertRowid));
  });

  app.patch('/api/drivers/:id', (request, response) => {
    const id = Number(request.params.id);
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

    if (!driver) {
      return response.status(404).json({ message: 'Domiciliario no encontrado.' });
    }

    const name = String(request.body.name || driver.name).trim();
    const phone = request.body.phone !== undefined ? normalizePhone(request.body.phone) : driver.phone;
    const vehicle = String(request.body.vehicle || driver.vehicle).trim();
    const zone = String(request.body.zone || driver.zone).trim();
    const active = request.body.active !== undefined ? (request.body.active ? 1 : 0) : driver.active;
    const currentStatus = request.body.currentStatus ? String(request.body.currentStatus).trim() : driver.current_status;

    db.prepare(`
      UPDATE drivers
      SET name = ?, phone = ?, vehicle = ?, zone = ?, active = ?, current_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, phone, vehicle, zone, active, currentStatus, id);
    db.save();
    response.json(db.prepare('SELECT * FROM drivers WHERE id = ?').get(id));
  });

  app.patch('/api/drivers/:id/active', (request, response) => {
    const active = request.body.active ? 1 : 0;
    db.prepare('UPDATE drivers SET active = ?, current_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(active, active ? 'disponible' : 'inactivo', request.params.id);
    db.save(); // Persist changes
    response.json(db.prepare('SELECT * FROM drivers WHERE id = ?').get(request.params.id));
  });

  app.delete('/api/drivers/:id', (request, response) => {
    const id = Number(request.params.id);
    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);

    if (!driver) {
      return response.status(404).json({ message: 'Domiciliario no encontrado.' });
    }

    db.prepare('DELETE FROM drivers WHERE id = ?').run(id);
    db.save();
    response.status(204).send();
  });

  app.get('/api/orders', (_request, response) => {
    const orders = db.prepare(`
      SELECT o.*, c.name AS client_name, c.phone AS client_phone, d.name AS driver_name
      FROM orders o
      INNER JOIN clients c ON c.id = o.client_id
      LEFT JOIN drivers d ON d.id = o.driver_id
      ORDER BY datetime(o.created_at) DESC
      LIMIT 100
    `).all();

    const itemsByOrder = db.prepare(`
      SELECT oi.*
      FROM order_items oi
      ORDER BY oi.id DESC
    `).all().reduce((accumulator, item) => {
      if (!accumulator[item.order_id]) {
        accumulator[item.order_id] = [];
      }
      accumulator[item.order_id].push(item);
      return accumulator;
    }, {});

    response.json(orders.map((order) => ({
      ...order,
      items: itemsByOrder[order.id] || []
    })));
  });

  app.post('/api/orders', async (request, response) => {
    try {
      const createdOrder = db.transaction(() => {
        const clientData = request.body.client || {};
        const items = Array.isArray(request.body.items) ? request.body.items : [];
        const paymentMethod = String(request.body.paymentMethod || 'Efectivo').trim();
        const status = String(request.body.status || 'nuevo').trim();
        const driverId = request.body.driverId ? Number(request.body.driverId) : null;
        const geocodingSource = String(request.body.geocodingSource || '').trim();
        const urgencyLevel = String(request.body.urgencyLevel || 'low').trim();
        const deliveryBufferMinutes = Number(request.body.deliveryBufferMinutes || 0);

        // 1. Resolver Cliente
        let client = db.prepare('SELECT * FROM clients WHERE phone = ?').get(normalizePhone(clientData.phone));
        let clientId;

        if (client) {
          db.prepare('UPDATE clients SET name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(String(clientData.name || '').trim() || client.name, String(clientData.notes || '').trim(), client.id);
          clientId = client.id;

          // Si la comanda no trae coordenadas, intentar obtenerlas desde la dirección principal guardada
          try {
            const primaryAddr = db.prepare('SELECT latitude, longitude FROM client_addresses WHERE client_id = ? AND is_primary = 1 LIMIT 1').get(clientId);
            if ((!clientData.latitude || !clientData.longitude) && primaryAddr) {
              if (primaryAddr.latitude != null) clientData.latitude = primaryAddr.latitude;
              if (primaryAddr.longitude != null) clientData.longitude = primaryAddr.longitude;
            }
          } catch (e) { /* ignore */ }

          if (clientData.address) {
            if (request.body.setPrimaryAddress !== false) {
              db.prepare('UPDATE client_addresses SET is_primary = 0 WHERE client_id = ?').run(clientId);
            }

            db.prepare('INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary, latitude, longitude, geocoding_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(clientId, 'principal', String(clientData.address || '').trim(), String(clientData.barrio || '').trim(), String(clientData.reference || '').trim(), request.body.setPrimaryAddress === false ? 0 : 1, clientData.latitude ? Number(clientData.latitude) : null, clientData.longitude ? Number(clientData.longitude) : null, geocodingSource || null);
          }
        } else {
          const insertClient = db.prepare('INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)'); // No need to trim here, already done in client
          const clientResult = insertClient.run(String(clientData.name || '').trim(), normalizePhone(clientData.phone), String(clientData.notes || '').trim());
          clientId = clientResult.lastInsertRowid;

          if (clientData.address) {
            db.prepare('INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary, latitude, longitude, geocoding_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(clientId, 'principal', String(clientData.address || '').trim(), String(clientData.barrio || '').trim(), String(clientData.reference || '').trim(), 1, clientData.latitude ? Number(clientData.latitude) : null, clientData.longitude ? Number(clientData.longitude) : null, geocodingSource || null);
          }
        }

        // 2. Validar Items
        const normalizedItems = items.filter(i => i.productId).map(i => ({
          productId: Number(i.productId),
          quantity: Math.max(1, Number(i.quantity) || 1)
        }));

        if (normalizedItems.length === 0) throw new Error('Debes agregar al menos un producto.');

        // 3. Calcular Total
        const productLookup = db.prepare('SELECT * FROM products WHERE id = ?');
        const total = normalizedItems.reduce((sum, item) => {
          const product = productLookup.get(item.productId);
          if (!product) throw new Error(`Producto no encontrado ID: ${item.productId}`);
          return sum + (Number(product.price) * item.quantity);
        }, 0);

        // 4. Crear Pedido
        const createdAt = getBogotaTimestamp();
        const orderResult = db.prepare(`
          INSERT INTO orders (client_id, driver_id, status, payment_method, barrio, address, reference, notes, total, route_zone, latitude, longitude, geocoding_source, urgency_level, delivery_buffer_minutes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          clientId,
          driverId,
          status,
          paymentMethod,
          String(clientData.barrio || '').trim(),
          String(clientData.address || '').trim(),
          String(clientData.reference || '').trim(),
          String(clientData.notes || '').trim(),
          total,
          String(clientData.barrio || '').trim(),
          clientData.latitude ? Number(clientData.latitude) : null,
          clientData.longitude ? Number(clientData.longitude) : null,
          geocodingSource || null,
          urgencyLevel,
          deliveryBufferMinutes,
          createdAt
        );

        const orderId = orderResult.lastInsertRowid;

        // 5. Crear Items
        normalizedItems.forEach(item => {
          const product = productLookup.get(item.productId);
          db.prepare(`
            INSERT INTO order_items (order_id, product_id, name_snapshot, quantity, unit_price, line_total)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(orderId, product.id, product.name, item.quantity, product.price, product.price * item.quantity);
        });

        // 6. Actualizar Domiciliario si aplica
        if (driverId) {
          db.prepare('UPDATE drivers SET current_status = ?, updated_at = ? WHERE id = ?').run('en ruta', getBogotaTimestamp(), driverId);
        }

        return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      })();

      const routeSuggestion = createRouteSuggestion(db, createdOrder.id);
      response.status(201).json({ order: createdOrder, routeSuggestion });
    } catch (error) {
      console.error('Error creando pedido:', error);
      response.status(400).json({ message: error.message });
    }
  });

  app.delete('/api/orders/:id', (request, response) => {
    const id = Number(request.params.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    db.save();
    response.status(204).send();
  });

  app.patch('/api/orders/:id', async (request, response) => {
    try {
      const orderId = Number(request.params.id);
      db.transaction(() => {
        const clientData = request.body.client || {};
        const items = Array.isArray(request.body.items) ? request.body.items : [];
        const paymentMethod = String(request.body.paymentMethod || 'Efectivo').trim();
        const driverId = request.body.driverId ? Number(request.body.driverId) : null;
        const notes = String(request.body.notes || '').trim();
        const geocodingSource = String(request.body.geocodingSource || '').trim();
        const urgencyLevel = String(request.body.urgencyLevel || 'low').trim();
        const deliveryBufferMinutes = Number(request.body.deliveryBufferMinutes || 0);

        const productLookup = db.prepare('SELECT * FROM products WHERE id = ?');
        const total = items.reduce((sum, item) => {
          const product = productLookup.get(item.productId);
          return sum + (product ? (Number(product.price) * item.quantity) : 0);
        }, 0);

        db.prepare(`
          UPDATE orders
          SET driver_id = ?, payment_method = ?, barrio = ?, address = ?, reference = ?, notes = ?, total = ?, latitude = ?, longitude = ?, geocoding_source = ?, urgency_level = ?, delivery_buffer_minutes = ?, updated_at = ?
          WHERE id = ? 
        `).run(
          driverId,
          paymentMethod,
          clientData.barrio,
          clientData.address,
          clientData.reference,
          notes,
          total,
          clientData.latitude ? Number(clientData.latitude) : null,
          clientData.longitude ? Number(clientData.longitude) : null,
          geocodingSource || null,
          urgencyLevel,
          deliveryBufferMinutes,
          getBogotaTimestamp(),
          orderId
        );

        if (clientData.address) {
          db.prepare('UPDATE client_addresses SET is_primary = 0 WHERE client_id = (SELECT client_id FROM orders WHERE id = ?)').run(orderId);
          const orderClient = db.prepare('SELECT client_id FROM orders WHERE id = ?').get(orderId);
          if (orderClient?.client_id) {
            db.prepare(`
              INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary, latitude, longitude)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              orderClient.client_id,
              'principal',
              String(clientData.address || '').trim(),
              String(clientData.barrio || '').trim(),
              String(clientData.reference || '').trim(),
              1,
              clientData.latitude ? Number(clientData.latitude) : null,
              clientData.longitude ? Number(clientData.longitude) : null
            );
          }
        }

        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
        items.forEach(item => {
          const product = productLookup.get(item.productId);
          if (product) {
            db.prepare(`
              INSERT INTO order_items (order_id, product_id, name_snapshot, quantity, unit_price, line_total)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(orderId, product.id, product.name, item.quantity, product.price, product.price * item.quantity);
          }
        });
      })();
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({ message: error.message });
    }
  });

  app.patch('/api/orders/:id/coords', (request, response) => {
    const { latitude, longitude } = request.body;
    db.prepare('UPDATE orders SET latitude = ?, longitude = ?, updated_at = ? WHERE id = ?')
      .run(Number(latitude), Number(longitude), getBogotaTimestamp(), request.params.id);
    db.save();
    response.json({ ok: true });
  });

  app.patch('/api/orders/:id/status', (request, response) => {
    const orderId = request.params.id;
    const newStatus = String(request.body.status || '').toLowerCase();
    const now = getBogotaTimestamp();

    let updateSql = 'UPDATE orders SET status = ?, updated_at = ?';
    const params = [newStatus, now];

    if (newStatus === 'en ruta') {
      updateSql += ', picked_up_at = ?';
      params.push(now);
    } else if (newStatus === 'entregado') {
      updateSql += ', delivered_at = ?';
      params.push(now);
    } else if (newStatus === 'cancelado') {
      const cancelledReason = String(request.body.cancelledReason || '').trim();
      updateSql += ', cancelled_reason = ?';
      params.push(cancelledReason);
    }

    updateSql += ' WHERE id = ?';
    params.push(orderId);

    db.prepare(updateSql).run(params);
    db.save(); // Persist changes
    response.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  });

  // API para Zonas Peligrosas
  app.get('/api/dangerous-zones', (req, res) => {
    const zones = db.prepare('SELECT * FROM dangerous_zones').all();
    res.json(zones.map(z => ({ ...z, polygon: JSON.parse(z.polygon_json) })));
  });

  app.post('/api/dangerous-zones', (req, res) => {
    const { name, riskScore, color, polygon } = req.body;
    const result = db.prepare('INSERT INTO dangerous_zones (name, risk_score, color, polygon_json) VALUES (?, ?, ?, ?)')
      .run(name, riskScore, color, JSON.stringify(polygon));
    res.status(201).json({ id: result.lastInsertRowid });
  });

  app.delete('/api/dangerous-zones/:id', (req, res) => {
    db.prepare('DELETE FROM dangerous_zones WHERE id = ?').run(req.params.id);
    res.status(204).send();
  });

  // Función auxiliar para detectar cuadrantes y evitar Batching extremo
  function getQuadrant(lat, lon, dLat, dLon) {
    if (lat >= dLat && lon >= dLon) return 'NE';
    if (lat >= dLat && lon < dLon) return 'NW';
    if (lat < dLat && lon >= dLon) return 'SE';
    return 'SW';
  }


  app.get('/api/routes/suggest', async (request, response) => {
    try {
      // Asegurar que si driverId es un string vacío se trate como null
      const driverId = request.query.driverId && request.query.driverId.trim() !== '' ? Number(request.query.driverId) : null;
      const maxPerRoute = toNumber(request.query.maxPerRoute) || 5;

      // Cargar zonas peligrosas
      let dangerousZones = [];
      try {
        dangerousZones = db.prepare('SELECT * FROM dangerous_zones').all().map(z => ({
          ...z, polygon: JSON.parse(z.polygon_json || '[]')
        }));
      } catch (e) {
      }

      // 1. Obtener pedidos base
      const ordersData = db.prepare(`
        SELECT o.id, o.barrio, o.address, o.status, o.total, o.latitude, o.longitude, o.urgency_level, o.delivery_buffer_minutes, o.created_at, c.name AS client_name, o.geocoding_source
        FROM orders o
        INNER JOIN clients c ON c.id = o.client_id
        WHERE o.status IN ('listo para salir', 'en ruta')
        ORDER BY o.barrio ASC, datetime(o.created_at) ASC
        LIMIT 100
      `).all();

      // 2. Obtener ítems de forma segura (evitando LIMIT en subquery de IN)
      const orderIds = ordersData.map(o => o.id);
      let itemsByOrder = {};
      if (orderIds.length > 0) {
        const placeholders = orderIds.map(() => '?').join(',');
        const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`).all(orderIds);
        itemsByOrder = items.reduce((acc, item) => {
          if (!acc[item.order_id]) acc[item.order_id] = [];
          acc[item.order_id].push(item);
          return acc;
        }, {});
      }

      const ordersWithCoords = ordersData.map(o => {
        return {
          ...o,
          items: itemsByOrder[o.id] || [],
          latitude: (o.latitude != null && !isNaN(Number(o.latitude))) ? Number(o.latitude) : null,
          longitude: (o.longitude != null && !isNaN(Number(o.longitude))) ? Number(o.longitude) : null
        };
      });

      const DEPOT_LAT = 3.411568;
      const DEPOT_LON = -76.515763;
      const DEPOT_ID = 'depot';

      const allPoints = [{ id: DEPOT_ID, latitude: DEPOT_LAT, longitude: DEPOT_LON }, ...ordersWithCoords];
      const validPoints = allPoints.filter(p => p.latitude != null && p.longitude != null);
      const osrmCoords = validPoints.map(p => `${p.longitude},${p.latitude}`);

      let osrmDistances = null; // meters
      let osrmDurations = null; // seconds

      if (validPoints.length > 1) { 
        try {
          const baseUrl = OSRM_BASE_URL.replace(/\/$/, '');
          const tableUrl = `${baseUrl}/table/v1/driving/${osrmCoords.join(';')}?annotations=duration,distance`;
          
          const tableResult = await requestUrl(tableUrl);

          if (tableResult.statusCode === 200) {
            try {
              const tableParsed = JSON.parse(tableResult.body);
              osrmDistances = tableParsed.distances || null;
              osrmDurations = tableParsed.durations || null;
            } catch (e) {
            }
          } else {
          }
        } catch (e) {
        }
      } else {
      }

      const ordersWithDepotDistance = ordersWithCoords.map((order) => {
        const orderLat = Number(order.latitude) || DEPOT_LAT;
        const orderLon = Number(order.longitude) || DEPOT_LON;

        let distKm;
        const vIdx = validPoints.findIndex(p => p.id === order.id);
        if (Array.isArray(osrmDistances) && Array.isArray(osrmDistances[0]) && vIdx !== -1 && osrmDistances[0][vIdx] != null) {
          distKm = Number(osrmDistances[0][vIdx]) / 1000;
        } else {
          distKm = Math.sqrt(Math.pow((Number(orderLat) - DEPOT_LAT) * 111, 2) + Math.pow((Number(orderLon) - DEPOT_LON) * 111 * Math.cos(DEPOT_LAT * Math.PI / 180), 2));
        }
        return { ...order, distKm: Number.isFinite(distKm) ? distKm : 0 };
      });

      const ordersWithPriority = ordersWithDepotDistance.map(o => {
        let score = 0;
        try {
          const dateStr = String(o.created_at || '').replace(' ', 'T');
          const waitMin = (new Date() - new Date(dateStr)) / 60000;
          if (Number.isFinite(waitMin)) score += Math.min(Math.max(waitMin, 0), 40);
        } catch (e) {
          // Ignorar error de fecha
        }
        
        if (o.total > 80000) score += 15;
        if (o.urgency_level === 'critical') score += 30;

        const isDangerous = dangerousZones.some(z => {
          try {
            if (!o.latitude) return false;
            const lats = (z.polygon || []).map(p => p[0]).filter(Number.isFinite);
            return lats.length > 0 && o.latitude > Math.min(...lats) && o.latitude < Math.max(...lats);
          } catch (e) { return false; }
        });
        if (isDangerous) score += 15;

        const lat = o.latitude != null ? Number(o.latitude) : DEPOT_LAT;
        const lon = o.longitude != null ? Number(o.longitude) : DEPOT_LON;
        return { ...o, priorityScore: Number.isFinite(score) ? Math.min(score, 100) : 0, quadrant: getQuadrant(lat, lon, DEPOT_LAT, DEPOT_LON) };
      });

      ordersWithPriority.sort((a, b) => b.priorityScore - a.priorityScore);

      const zones = [
        { name: 'Zona Cercana', maxDist: 2, orders: [] },
        { name: 'Zona Media', maxDist: 5, orders: [] },
        { name: 'Zona Lejana (4km+)', maxDist: Infinity, orders: [] }
      ];

      ordersWithPriority.forEach(order => {
        const zone = zones.find(z => order.distKm <= z.maxDist);
        if (zone) zone.orders.push(order);
      });

      let finalSuggestedRoutes = [];

      zones.forEach(zone => {
        let currentZoneOrders = [...zone.orders];
        while (currentZoneOrders.length > 0 && finalSuggestedRoutes.length < 50) {
          const routeOrders = [];
          let currentRouteDistance = 0;
          let currentRouteDuration = 0;

          const firstOrder = currentZoneOrders.shift();
          if (firstOrder) {
            routeOrders.push(firstOrder);
            
            const fIdx = validPoints.findIndex(p => p.id === firstOrder.id);
            if (Array.isArray(osrmDistances) && Array.isArray(osrmDurations) && fIdx !== -1) {
              currentRouteDistance += (Number(osrmDistances[0][fIdx]) || 0) / 1000;
              currentRouteDuration += (Number(osrmDurations[0][fIdx]) || 0) / 60;
            } else {
              currentRouteDistance += Number(firstOrder.distKm) || 0;
              currentRouteDuration += (Number(firstOrder.distKm) || 0) * 3; // 3 min/km
            }
          }

          // Añadir más pedidos a la ruta hasta el límite o capacidad
          for (let i = 0; i < currentZoneOrders.length && routeOrders.length < maxPerRoute; i++) {
            const nextOrder = currentZoneOrders[i];

            const firstQuadrant = routeOrders[0].quadrant;
            const isOpposite = (firstQuadrant === 'NE' && nextOrder.quadrant === 'SW') ||
              (firstQuadrant === 'NW' && nextOrder.quadrant === 'SE') ||
              (firstQuadrant === 'SE' && nextOrder.quadrant === 'NW') ||
              (firstQuadrant === 'SW' && nextOrder.quadrant === 'NE');

            if (isOpposite && nextOrder.distKm > 3) continue;

            const nIdx = validPoints.findIndex(p => p.id === nextOrder.id);
            const lastOrderInRoute = routeOrders[routeOrders.length - 1];
            const lIdx = validPoints.findIndex(p => p.id === lastOrderInRoute.id);

            if (Array.isArray(osrmDistances) && Array.isArray(osrmDurations) && nIdx !== -1 && lIdx !== -1) {
              const segDist = (osrmDistances[lIdx] || [])[nIdx] || 0;
              const segDur = (osrmDurations[lIdx] || [])[nIdx] || 0;
              currentRouteDistance += Number(segDist) / 1000;
              currentRouteDuration += Number(segDur) / 60;
            } else {
              currentRouteDistance += Number(nextOrder.distKm) || 0;
              currentRouteDuration += (Number(nextOrder.distKm) || 0) * 3;
            }
            routeOrders.push(nextOrder);
            currentZoneOrders.splice(i, 1);
            i--;
          }

          if (routeOrders.length > 0) {
            finalSuggestedRoutes.push({
              id: `route-${zone.name}-${finalSuggestedRoutes.length}`,
              zone: zone.name,
              orders: routeOrders,
              estimatedDistanceKm: Number(currentRouteDistance).toFixed(1),
              estimatedEtaMinutes: Math.round(currentRouteDuration + (routeOrders.length * 5))
            });
          }
        }
      });

      if (finalSuggestedRoutes.length === 0 && ordersWithCoords.length > 0) {
        const groupedByBarrio = ordersWithCoords.reduce((acc, order) => {
          const key = order.barrio || 'Sin barrio';
          if (!acc[key]) acc[key] = [];
          acc[key].push(order);
          return acc;
        }, {});
        Object.entries(groupedByBarrio).forEach(([barrio, barrioOrders]) => {
          for (let i = 0; i < barrioOrders.length; i += maxPerRoute) {
            finalSuggestedRoutes.push({
              id: `route-${barrio}-${finalSuggestedRoutes.length}`,
              zone: barrio,
              orders: barrioOrders.slice(i, i + maxPerRoute)
            });
          }
        });
      }

      response.json({
        driverId,
        suggestedRoutes: finalSuggestedRoutes,
        sequence: finalSuggestedRoutes.length > 0 ? finalSuggestedRoutes[0].orders : []
      });
  } catch (error) {
    console.error('[SERVER] >>> ERROR CRÍTICO EN /api/routes/suggest:', error);
    response.status(500).json({
      message: 'Error fatal en el motor logístico',
      error: error.message,
      stack: error.stack
    });
  }
});

app.get('/api/stats', (request, response) => {
  const range = ['day', 'week', 'month'].includes(String(request.query.range || 'day'))
    ? String(request.query.range || 'day')
    : 'day';
  const cutoffHour = toNumber(request.query.cutoffHour || 0); // Get cutoffHour from query parameter
  response.json(buildStats(db, range, cutoffHour)); // Pass cutoffHour to buildStats
});

// Asignar una ruta a un domiciliario y persistir la sugerencia
app.post('/api/routes/assign', (request, response) => {
  try {
    const driverId = request.body.driverId ? Number(request.body.driverId) : null;
    const orderIds = Array.isArray(request.body.orderIds) ? request.body.orderIds.map(Number).filter(Boolean) : [];
    const route = Array.isArray(request.body.route) ? request.body.route : [];
    const DEPOT_LAT = 3.411568;
    const DEPOT_LON = -76.515763;
    const routeSummary = request.body.routeSummary && typeof request.body.routeSummary === 'object' ? request.body.routeSummary : null;

    if (!driverId || !orderIds.length) {
      return response.status(400).json({ message: 'driverId y orderIds son requeridos para asignar una ruta.' });
    }

    const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
    if (!driver) return response.status(404).json({ message: 'Domiciliario no encontrado.' });

    const now = getBogotaTimestamp();

    const result = db.transaction(() => {
      // Actualizar cada pedido: asignar driver y marcar como 'en ruta'
      orderIds.forEach((oid) => {
        db.prepare('UPDATE orders SET driver_id = ?, status = ?, updated_at = ? WHERE id = ?')
          .run(driverId, 'en ruta', now, oid); // No changes here
      });

      // Actualizar estado del domiciliario
      db.prepare('UPDATE drivers SET current_status = ?, updated_at = ? WHERE id = ?')
        .run('en ruta', now, driverId); // No changes here

      // Persistir una sugerencia de ruta (referencia al primer pedido)
      const firstOrderId = orderIds[0] || 0;
      const distanceKm = routeSummary && Number.isFinite(Number(routeSummary.distanceKm))
        ? Number(routeSummary.distanceKm)
        : Math.max(orderIds.length, 1) * 2.4; // Fallback estimate
      const etaMinutes = routeSummary && Number.isFinite(Number(routeSummary.durationMin))
        ? Number(routeSummary.durationMin)
        : Math.max(orderIds.length, 1) * 8;
      const enrichedRoute = route.map((item, index) => ({
        ...item,
        sequenceIndex: index + 1
      })); // The route here is the optimized sequence of orders

      const insert = db.prepare(`
          INSERT INTO delivery_routes (order_id, driver_id, assigned_at, status, total_distance_km, total_eta_minutes, start_latitude, start_longitude, route_json, optimization_params_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(firstOrderId, driverId, now, 'completed', distanceKm, etaMinutes, DEPOT_LAT, DEPOT_LON, JSON.stringify(enrichedRoute), JSON.stringify(request.body.optimizationParams || {}));

      return {
        routeSuggestionId: insert.lastInsertRowid,
        assignedOrders: orderIds,
        driverId,
        distanceKm,
        etaMinutes,
        routeSummary: routeSummary || null
      };
    })();

    response.json({ ok: true, result });
  } catch (error) {
    console.error('Error asignando ruta:', error);
    response.status(500).json({ message: 'Error interno al asignar la ruta.' });
  }
});

app.get('/api/delivery-routes', (request, response) => {
  try {
    const routes = db.prepare(`
        SELECT dr.id, dr.driver_id, dr.assigned_at, dr.status, dr.total_distance_km, dr.total_eta_minutes, dr.route_json, d.name AS driver_name
        FROM delivery_routes dr
        LEFT JOIN drivers d ON d.id = dr.driver_id
        ORDER BY dr.assigned_at DESC
      `).all();

    // Parse route_json for each route
    const parsedRoutes = routes.map(route => {
      let orders = [];
      try {
        orders = JSON.parse(route.route_json);
      } catch (e) {
        console.error(`Error parsing route_json for delivery_route ID ${route.id}:`, e);
      }
      return { ...route, orders };
    });

    response.json(parsedRoutes);
  } catch (error) {
    console.error('Error fetching delivery routes history:', error);
    response.status(500).json({ message: 'Error interno al cargar el historial de rutas.' });
  }
});

// Manejador 404 específico para API (antes del comodín de HTML)
app.use('/api', (request, response) => {
  response.status(404).json({ message: `Ruta de API no encontrada: ${request.method} ${request.url}` });
});

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, '..', 'renderer', 'index.html'));
});

const server = app.listen(0, '127.0.0.1');

return new Promise((resolve) => {
  server.on('listening', () => {
    resolve({
      app,
      db,
      server,
      port: server.address().port
    });
  });
});
}

module.exports = {
  startServer
};

if (require.main === module) {
  startServer().then((info) => {
    console.log(`Servidor listo en http://127.0.0.1:${info.port}`);
  });
}
