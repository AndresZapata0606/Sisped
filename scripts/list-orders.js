const { openDatabase } = require('../src/server/db');

async function run() {
  const db = await openDatabase();
  const orders = db.prepare('SELECT id, status, driver_id, barrio, address, created_at FROM orders ORDER BY id ASC').all();
  console.log('Pedidos en la BD:');
  orders.forEach(o => console.log(`#${o.id}: status='${o.status}', driver=${o.driver_id}, barrio='${o.barrio}'`));
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(2); });
