#!/usr/bin/env node
/**
 * scripts/import-products.js
 * Lee `data/menu.csv` y crea productos vía POST /api/products.
 * Uso:
 *   node scripts/import-products.js
 * Opciones:
 *   API_BASE_URL env var (por ejemplo http://127.0.0.1:61172)
 * Requisitos: Node 18+ (fetch global) y servidor corriendo.
 */

const fs = require('fs').promises;
const path = require('path');

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:61172';
const CSV_PATH = path.resolve(__dirname, '..', 'data', 'menu.csv');

function splitCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cols.push(cur);
  return cols.map(s => s.trim());
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length === 0) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cols[j] !== undefined ? cols[j] : '';
    }
    rows.push(obj);
  }
  return rows;
}

function safeParseJSON(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  // normalize single quotes to double quotes when safe
  let normalized = trimmed;
  if (trimmed.startsWith("[") || trimmed.startsWith('{')) {
    normalized = trimmed.replace(/'/g, '"');
    try { return JSON.parse(normalized); } catch (e) { return trimmed; }
  }
  return trimmed;
}

async function postProduct(product) {
  const url = `${API_BASE}/api/products`;
  const body = {
    name: product.name,
    category: product.category || 'General',
    price: Number(product.price) || 0,
    comboItems: Array.isArray(product.comboItems) ? product.comboItems : [],
    active: (product.active === '0' || product.active === 0) ? false : true
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=>'<no-body>');
    throw new Error(`POST ${url} failed: ${resp.status} ${resp.statusText} - ${txt}`);
  }
  return resp.json();
}

async function main() {
  console.log('Leyendo', CSV_PATH);
  const raw = await fs.readFile(CSV_PATH, 'utf8');
  const rows = parseCSV(raw);
  if (!rows.length) { console.log('No hay filas en el CSV'); return; }

  // Normalize keys: ensure lower-case header names
  const normalized = rows.map(r => {
    const o = {};
    Object.keys(r).forEach(k => { o[k.trim()] = r[k].trim(); });
    return o;
  });

  // Separate combos (rows with combo_items non-empty) to process after base products
  const baseRows = normalized.filter(r => !(r.combo_items && r.combo_items.trim()));
  const comboRows = normalized.filter(r => r.combo_items && r.combo_items.trim());

  console.log(`Filas totales: ${rows.length}. Productos base: ${baseRows.length}. Combos: ${comboRows.length}`);

  const nameToId = new Map();

  // Create base products
  for (const r of baseRows) {
    try {
      const productPayload = {
        name: r.name || r.Name || r.NOMBRE,
        category: r.category || r.Category || r.categoria || 'General',
        price: Number((r.price || r.Price || '').replace(/[^0-9.-]+/g, '')) || 0,
        comboItems: [],
        active: (String(r.active || '1').trim() !== '0')
      };
      const created = await postProduct(productPayload);
      nameToId.set(String(productPayload.name).toLowerCase(), created.id);
      console.log('Creado:', created.id, created.name);
    } catch (err) {
      console.error('Error creando producto', r.name, err.message);
    }
  }

  // Create combos resolving item names to product IDs when possible
  for (const r of comboRows) {
    try {
      const comboRaw = safeParseJSON(r.combo_items);
      let comboItems = [];
      if (Array.isArray(comboRaw)) {
        comboItems = comboRaw.map(item => {
          if (item && typeof item === 'object') {
            const name = (item.name || item.nombre || item.note || item.noteText || '').toString().trim();
            const qty = Number(item.qty || item.quantity || item.cantidad || 1) || 1;
            const mapped = nameToId.get(name.toLowerCase());
            if (mapped) return { productId: mapped, qty };
            return { name: name || item.note || JSON.stringify(item), qty };
          }
          // if item is a string, try to map by name
          const nameStr = String(item || '').trim();
          const mapped = nameToId.get(nameStr.toLowerCase());
          if (mapped) return { productId: mapped, qty: 1 };
          return { name: nameStr, qty: 1 };
        });
      } else if (typeof comboRaw === 'string') {
        // fallback: keep raw note
        comboItems = [{ name: comboRaw }];
      } else {
        comboItems = [{ name: String(r.combo_items) }];
      }

      const productPayload = {
        name: r.name,
        category: r.category || 'Combos',
        price: Number((r.price || '').replace(/[^0-9.-]+/g, '')) || 0,
        comboItems,
        active: (String(r.active || '1').trim() !== '0')
      };

      const created = await postProduct(productPayload);
      nameToId.set(String(productPayload.name).toLowerCase(), created.id);
      console.log('Creado combo:', created.id, created.name);
    } catch (err) {
      console.error('Error creando combo', r.name, err.message);
    }
  }

  console.log('Importación finalizada. Productos registrados:', nameToId.size);
}

main().catch(err => { console.error('Fallo import:', err); process.exit(1); });
