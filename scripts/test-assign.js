const { openDatabase } = require('../src/server/db');

async function run() {
  const db = await openDatabase();

  // Buscar un domiciliario activo
  const driver = db.prepare('SELECT * FROM drivers WHERE active = 1 LIMIT 1').get();
  if (!driver) {
    console.error('No hay domiciliarios activos para la prueba.');
    process.exit(1);
  }

  // Buscar pedidos disponibles (incluir 'nuevo' para pruebas locales)
  const orders = db.prepare(`
    SELECT o.* FROM orders o
    WHERE o.status IN ('nuevo', 'listo para salir', 'en ruta')
    ORDER BY datetime(o.created_at) ASC
    LIMIT 5
  `).all();

  if (!orders || orders.length === 0) {
    console.error('No hay pedidos "listo para salir" ni "en ruta" para asignar.');
    process.exit(1);
  }

  const orderIds = orders.map(o => o.id);
  console.log('Driver seleccionado:', driver.id, driver.name);
  console.log('Pedidos a asignar:', orderIds.join(', '));

  const route = orders.map(o => ({ id: o.id, barrio: o.barrio, address: o.address }));

  const result = db.transaction(() => {
    // Actualizar pedidos
    orderIds.forEach((oid) => {
      db.prepare('UPDATE orders SET driver_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(driver.id, 'en ruta', oid);
    });

    // Actualizar estado del domiciliario
    db.prepare('UPDATE drivers SET current_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('en ruta', driver.id);

    // Insertar sugerencia de ruta usando el primer pedido como referencia
    const insert = db.prepare('INSERT INTO route_suggestions (order_id, driver_id, barrio_group, route_json, distance_km, eta_minutes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(orderIds[0], driver.id, '', JSON.stringify(route), Math.max(orderIds.length,1)*2.4, Math.max(orderIds.length,1)*8);

    return { insertedId: insert.lastInsertRowid };
  })();

  console.log('Asignación completada. Route suggestion id:', result.insertedId);
}

run().catch(err => {
  console.error('Error en script de prueba:', err);
});
