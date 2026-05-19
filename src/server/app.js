const express = require('express');
const cors = require('cors');
const path = require('path');
const { openDatabase } = require('./db');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

async function startServer() {
  const db = await openDatabase();
  const app = express();

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
          SELECT c.*, COUNT(a.id) AS address_count
          FROM clients c
          LEFT JOIN client_addresses a ON a.client_id = c.id
          WHERE c.name LIKE ? OR c.phone LIKE ?
          GROUP BY c.id
          ORDER BY c.updated_at DESC
        `).all(`%${search}%`, `%${normalizePhone(search)}%`)
      : db.prepare(`
          SELECT c.*, COUNT(a.id) AS address_count
          FROM clients c
          LEFT JOIN client_addresses a ON a.client_id = c.id
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT 20
        `).all();

    response.json(clients.map((client) => ({
      ...client,
      primaryAddress: db.prepare(`
        SELECT * FROM client_addresses
        WHERE client_id = ?
        ORDER BY is_primary DESC, created_at DESC
        LIMIT 1
      `).get(client.id) || null
    })));
  });

  app.get('/api/clients/:id/addresses', (request, response) => {
    const addresses = db.prepare('SELECT * FROM client_addresses WHERE client_id = ? ORDER BY is_primary DESC, created_at DESC').all(request.params.id);
    response.json(addresses);
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

  app.post('/api/clients/resolve', (request, response) => { // Wrap client resolution in a transaction
    try {
      const result = db.transaction(() => {
        const name = String(request.body.name || '').trim();
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

        if (address) {
          if (request.body.setPrimaryAddress !== false) {
            db.prepare('UPDATE client_addresses SET is_primary = 0 WHERE client_id = ?').run(clientId);
          }

          db.prepare(`
            INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(clientId, request.body.label || 'principal', address, barrio, reference, request.body.setPrimaryAddress === false ? 0 : 1);
        }

        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
        const primaryAddress = db.prepare(`
          SELECT * FROM client_addresses WHERE client_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 1
        `).get(clientId) || null;

        return { client, primaryAddress };
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

  app.post('/api/orders', (request, response) => {
    try {
      const createdOrder = db.transaction(() => {
        const clientData = request.body.client || {};
        const items = Array.isArray(request.body.items) ? request.body.items : [];
        const paymentMethod = String(request.body.paymentMethod || 'Efectivo').trim();
        const status = String(request.body.status || 'nuevo').trim();
        const driverId = request.body.driverId ? Number(request.body.driverId) : null;

        // 1. Resolver Cliente
        let client = db.prepare('SELECT * FROM clients WHERE phone = ?').get(normalizePhone(clientData.phone));
        let clientId;

        if (client) {
          db.prepare('UPDATE clients SET name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(String(clientData.name || '').trim() || client.name, String(clientData.notes || '').trim(), client.id);
          clientId = client.id;
        } else {
          const insertClient = db.prepare('INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)');
          const clientResult = insertClient.run(String(clientData.name || '').trim(), normalizePhone(clientData.phone), String(clientData.notes || '').trim());
          clientId = clientResult.lastInsertRowid;

          if (clientData.address) {
            db.prepare('INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary) VALUES (?, ?, ?, ?, ?, ?)')
              .run(clientId, 'principal', String(clientData.address || '').trim(), String(clientData.barrio || '').trim(), String(clientData.reference || '').trim(), 1);
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
        const orderResult = db.prepare(`
          INSERT INTO orders (client_id, driver_id, status, payment_method, barrio, address, reference, notes, total, route_zone)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          String(clientData.barrio || '').trim()
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
          db.prepare('UPDATE drivers SET current_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('en ruta', driverId);
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

  app.patch('/api/orders/:id/status', (request, response) => {
    const orderId = request.params.id;
    const newStatus = String(request.body.status || '').toLowerCase();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    let updateSql = 'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP';
    const params = [newStatus];

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

  app.get('/api/routes/suggest', (request, response) => {
    const driverId = request.query.driverId ? Number(request.query.driverId) : null;
    const orders = db.prepare(`
      SELECT o.id, o.barrio, o.address, o.status, o.total, c.name AS client_name
      FROM orders o
      INNER JOIN clients c ON c.id = o.client_id
      WHERE o.status IN ('listo para salir', 'en ruta')
      ORDER BY o.barrio ASC, datetime(o.created_at) ASC
    `).all();

    const grouped = orders.reduce((accumulator, order) => {
      const key = order.barrio || 'Sin barrio';
      if (!accumulator[key]) {
        accumulator[key] = [];
      }
      accumulator[key].push(order);
      return accumulator;
    }, {});

    response.json({
      driverId,
      grouped,
      sequence: Object.entries(grouped).flatMap(([barrio, barrioOrders]) => barrioOrders.map((order) => ({ ...order, barrio })))
    });
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

      if (!driverId || !orderIds.length) {
        return response.status(400).json({ message: 'driverId y orderIds son requeridos para asignar una ruta.' });
      }

      const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
      if (!driver) return response.status(404).json({ message: 'Domiciliario no encontrado.' });

      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

      const result = db.transaction(() => {
        // Actualizar cada pedido: asignar driver y marcar como 'en ruta'
        orderIds.forEach((oid) => {
          db.prepare('UPDATE orders SET driver_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(driverId, 'en ruta', oid);
        });

        // Actualizar estado del domiciliario
        db.prepare('UPDATE drivers SET current_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('en ruta', driverId);

        // Persistir una sugerencia de ruta (referencia al primer pedido)
        const firstOrderId = orderIds[0] || 0;
        const distanceKm = Math.max(orderIds.length, 1) * 2.4;
        const etaMinutes = Math.max(orderIds.length, 1) * 8;

        const insert = db.prepare(`
          INSERT INTO route_suggestions (order_id, driver_id, barrio_group, route_json, distance_km, eta_minutes)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(firstOrderId, driverId, '', JSON.stringify(route), distanceKm, etaMinutes);

        return {
          routeSuggestionId: insert.lastInsertRowid,
          assignedOrders: orderIds,
          driverId
        };
      })();

      response.json({ ok: true, result });
    } catch (error) {
      console.error('Error asignando ruta:', error);
      response.status(500).json({ message: 'Error interno al asignar la ruta.' });
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
