const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dataDir = path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'shadday-wok.sqlite');

function ensureDirectory() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function getWasmPath() {
  return path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
}

function toArray(params) {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0];
  }
  return params;
}

async function createSqlDatabase() {
  ensureDirectory();

  const SQL = await initSqlJs({
    locateFile: (file) => path.join(getWasmPath(), file)
  });

  let database;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    database = new SQL.Database(new Uint8Array(fileBuffer));
  } else {
    database = new SQL.Database();
  }

  database.exec('PRAGMA foreign_keys = ON;');

  function persist() {
    const data = database.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  function runStatement(sql, params = []) {
    const statement = database.prepare(sql);
    statement.bind(params);
    try {
      statement.step();
    } catch (err) {
      statement.free();
      throw err;
    }
    const changes = database.getRowsModified();
    const lastIdRow = database.exec('SELECT last_insert_rowid() AS id;');
    statement.free();
    return {
      changes,
      lastInsertRowid: lastIdRow.length ? lastIdRow[0].values[0][0] : 0
    };
  }

  const db = {
    exec(sql) {
      const result = database.exec(sql);
      return result;
    },
    save() {
      persist();
    },
    prepare(sql) {
      return {
        get(...params) {
          const statement = database.prepare(sql);
          statement.bind(toArray(params));
          const row = statement.step() ? statement.getAsObject() : undefined;
          statement.free();
          return row;
        },
        all(...params) {
          const statement = database.prepare(sql);
          statement.bind(toArray(params));
          const rows = [];
          while (statement.step()) {
            rows.push(statement.getAsObject());
          }
          statement.free();
          return rows;
        },
        run(...params) {
          return runStatement(sql, toArray(params));
        }
      };
    },
    transaction(callback) {
      return (...args) => {
        try {
          database.exec('BEGIN TRANSACTION;');
          const result = callback(...args);
          database.exec('COMMIT;');
          db.save();
          return result;
        } catch (error) {
          try { database.exec('ROLLBACK;'); } catch (e) { /* Transacción ya cerrada */ }
          throw error;
        }
      };
    },
    close() {
      db.save();
      database.close();
    }
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      notes TEXT DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS client_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT 'principal',
      address TEXT NOT NULL,
      barrio TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      price REAL NOT NULL DEFAULT 0,
      combo_items TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      vehicle TEXT NOT NULL DEFAULT 'Moto',
      zone TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      current_status TEXT NOT NULL DEFAULT 'disponible',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      driver_id INTEGER,
      status TEXT NOT NULL DEFAULT 'nuevo',
      payment_method TEXT NOT NULL,
      barrio TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      cancelled_reason TEXT NOT NULL DEFAULT '',
      total REAL NOT NULL DEFAULT 0,
      route_zone TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      picked_up_at TEXT,
      delivered_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (driver_id) REFERENCES drivers(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS route_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      driver_id INTEGER,
      barrio_group TEXT NOT NULL DEFAULT '',
      route_json TEXT NOT NULL DEFAULT '[]',
      distance_km REAL NOT NULL DEFAULT 0,
      eta_minutes REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (driver_id) REFERENCES drivers(id)
    );

    -- Nueva tabla para el historial de rutas de domicilios
    CREATE TABLE IF NOT EXISTS delivery_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER, -- Referencia al primer pedido en la ruta, puede ser NULL si la ruta está vacía o no está ligada a un solo pedido
      driver_id INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'completed', -- 'pending', 'active', 'completed', 'cancelled'
      total_distance_km REAL,
      total_eta_minutes INTEGER,
      start_latitude REAL,
      start_longitude REAL,
      route_json TEXT, -- JSON de la secuencia de paradas optimizada
      optimization_params_json TEXT, -- JSON de los parámetros usados para esta optimización
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (driver_id) REFERENCES drivers(id)
    );

    CREATE TABLE IF NOT EXISTS dangerous_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      risk_score INTEGER DEFAULT 5,
      color TEXT DEFAULT '#ff0000',
      polygon_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      items TEXT NOT NULL DEFAULT '[]',
      payment_type TEXT DEFAULT '',
      payment_amount REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_closures (
      day_key TEXT PRIMARY KEY,
      orders_archived INTEGER NOT NULL DEFAULT 0,
      total_orders INTEGER NOT NULL DEFAULT 0,
      delivered_orders INTEGER NOT NULL DEFAULT 0,
      cancelled_orders INTEGER NOT NULL DEFAULT 0,
      total_sales REAL NOT NULL DEFAULT 0,
      average_ticket REAL NOT NULL DEFAULT 0,
      average_delivery_time_minutes REAL NOT NULL DEFAULT 0,
      top_product TEXT NOT NULL DEFAULT '',
      top_driver TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Asegurar columnas de lat/lng en tablas existentes (para migraciones en caliente)
  try {
    db.exec(`ALTER TABLE client_addresses ADD COLUMN latitude REAL;`);
  } catch (e) { /* columna ya existe o no soportado */ }

  try {
    db.exec(`ALTER TABLE client_addresses ADD COLUMN longitude REAL;`);
  } catch (e) { /* columna ya existe o no soportado */ }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN latitude REAL;`);
  } catch (e) { /* columna ya existe o no soportado */ }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN longitude REAL;`);
  } catch (e) { /* columna ya existe o no soportado */ }

  // Nuevas columnas para optimización y auditoría
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN urgency_level TEXT DEFAULT 'low';`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_buffer_minutes INTEGER DEFAULT 0;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN geocoding_source TEXT;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE client_addresses ADD COLUMN geocoding_source TEXT;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE clients ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE clients ADD COLUMN archived_at TEXT;`);
  } catch (e) { }

  // Migraciones para campos de pago y cambio
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN payment_type TEXT DEFAULT 'exact';`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN payment_amount REAL;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN change REAL DEFAULT 0;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN archived_at TEXT;`);
  } catch (e) { }

  // Migraciones para delivery_routes (asegurar compatibilidad con el historial avanzado)
  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN assigned_at TEXT;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN status TEXT DEFAULT 'completed';`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN total_distance_km REAL;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN total_eta_minutes INTEGER;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN start_latitude REAL;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN start_longitude REAL;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN optimization_params_json TEXT;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`);
  } catch (e) { }

  try {
    db.exec(`ALTER TABLE delivery_routes ADD COLUMN archived_at TEXT;`);
  } catch (e) { }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS daily_closures (
      day_key TEXT PRIMARY KEY,
      orders_archived INTEGER NOT NULL DEFAULT 0,
      total_orders INTEGER NOT NULL DEFAULT 0,
      delivered_orders INTEGER NOT NULL DEFAULT 0,
      cancelled_orders INTEGER NOT NULL DEFAULT 0,
      total_sales REAL NOT NULL DEFAULT 0,
      average_ticket REAL NOT NULL DEFAULT 0,
      average_delivery_time_minutes REAL NOT NULL DEFAULT 0,
      top_product TEXT NOT NULL DEFAULT '',
      top_driver TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  } catch (e) { }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  } catch (e) { }

  const productCount = db.prepare('SELECT COUNT(*) AS total FROM products').get();
  if ((productCount && Number(productCount.total)) === 0) {
    db.transaction(() => { // Wrap demo data insertion in a transaction
      const insertClient = db.prepare('INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)');
      const insertAddress = db.prepare('INSERT INTO client_addresses (client_id, label, address, barrio, reference, is_primary) VALUES (?, ?, ?, ?, ?, ?)');
      const insertProduct = db.prepare('INSERT INTO products (name, category, price, combo_items, active) VALUES (?, ?, ?, ?, ?)');
      const insertDriver = db.prepare('INSERT INTO drivers (name, phone, vehicle, zone, active, current_status) VALUES (?, ?, ?, ?, ?, ?)');
      const insertOrder = db.prepare('INSERT INTO orders (client_id, driver_id, status, payment_method, barrio, address, reference, notes, total, route_zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, name_snapshot, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)');

      const clientOne = insertClient.run('Andres Lopez', '3001112233', 'Cliente frecuente').lastInsertRowid;
      const clientTwo = insertClient.run('Maria Perez', '3012223344', 'Pide sin cebolla').lastInsertRowid;
      const clientThree = insertClient.run('Juan Rojas', '3023334455', 'Pago por transferencia').lastInsertRowid;

      insertAddress.run(clientOne, 'casa', 'Calle 5 # 23-18', 'San Fernando', 'Cerca al parque', 1);
      insertAddress.run(clientTwo, 'principal', 'Carrera 34 # 7-80', 'Tequendama', 'Torre 2 apto 301', 1);
      insertAddress.run(clientThree, 'trabajo', 'Avenida 6 # 11-25', 'Granada', 'Oficina 403', 1);

      const productOne = insertProduct.run('Arroz wok pollo', 'Platos fuertes', 26000, JSON.stringify([]), 1).lastInsertRowid;
      const productTwo = insertProduct.run('Arroz wok cerdo', 'Platos fuertes', 27000, JSON.stringify([]), 1).lastInsertRowid;
      const productThree = insertProduct.run('Ramen especial', 'Especiales', 32000, JSON.stringify([]), 1).lastInsertRowid;
      const productFour = insertProduct.run('Combo familiar', 'Combos', 58000, JSON.stringify(['2 arroces + 2 bebidas']), 1).lastInsertRowid;
      const productFive = insertProduct.run('Gaseosa personal', 'Bebidas', 5000, JSON.stringify([]), 1).lastInsertRowid;

      const driverOne = insertDriver.run('Carlos Gomez', '3205551001', 'Moto', 'Sur', 1, 'disponible').lastInsertRowid;
      const driverTwo = insertDriver.run('Diego Torres', '3205551002', 'Moto', 'Centro', 1, 'disponible').lastInsertRowid;
      const driverThree = insertDriver.run('Luis Perez', '3205551003', 'Moto', 'Norte', 1, 'disponible').lastInsertRowid;
      const driverFour = insertDriver.run('Miguel Ruiz', '3205551004', 'Moto', 'Oeste', 0, 'inactivo').lastInsertRowid;

      const orderOne = insertOrder.run(clientOne, driverOne, 'en ruta', 'Efectivo', 'San Fernando', 'Calle 5 # 23-18', 'Porteria 2', 'Sin cebolla', 26000, 'Sur').lastInsertRowid;
      const orderTwo = insertOrder.run(clientTwo, driverTwo, 'listo para salir', 'Nequi/Daviplata', 'Tequendama', 'Carrera 34 # 7-80', 'Apto 301', 'Extra salsa', 32000, 'Centro').lastInsertRowid;
      const orderThree = insertOrder.run(clientThree, null, 'nuevo', 'Transferencia', 'Granada', 'Avenida 6 # 11-25', 'Oficina 403', 'Entregar antes de las 7', 58000, 'Norte').lastInsertRowid;

      insertItem.run(orderOne, productOne, 'Arroz wok pollo', 1, 26000, 26000);
      insertItem.run(orderTwo, productThree, 'Ramen especial', 1, 32000, 32000);
      insertItem.run(orderThree, productFour, 'Combo familiar', 1, 58000, 58000);
    })(); // Execute the transaction immediately
  }

  persist();
  return db;
}

function openDatabase() {
  if (!global.__shaddayDbPromise) {
    global.__shaddayDbPromise = createSqlDatabase();
  }

  return global.__shaddayDbPromise;
}

module.exports = {
  dbPath,
  openDatabase
};
