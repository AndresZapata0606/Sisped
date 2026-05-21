const fs = require('fs');
const path = require('path');
const { openDatabase, dbPath } = require('../src/server/db');

function getBogotaTimestamp(date) {
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

function parseTimestamp(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return new Date(`${text.replace(' ', 'T')}Z`);
  }

  if (/Z$|[+-]\d{2}:\d{2}$/.test(text)) {
    return new Date(text.replace(' ', 'T'));
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return new Date(text);
  }

  return new Date(`${text}Z`);
}

function convertToBogota(value) {
  const parsed = parseTimestamp(value);
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return getBogotaTimestamp(parsed);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function main() {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No existe la base de datos en ${dbPath}`);
  }

  const backupPath = path.join(
    path.dirname(dbPath),
    `shadday-wok.sqlite.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );

  fs.copyFileSync(dbPath, backupPath);

  const db = await openDatabase();
  const tables = db
    .exec(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `)
    .flatMap((result) => result.values.map((row) => row[0]));

  const report = [];
  let totalChanges = 0;

  const runBackfill = db.transaction(() => {
    for (const table of tables) {
      const columns = db
        .exec(`PRAGMA table_info(${quoteIdentifier(table)});`)
        .flatMap((result) => result.values.map((row) => ({ name: row[1] })));

      const timestampColumns = columns
        .map((column) => column.name)
        .filter((name) => /(_at)$/.test(name));

      if (!timestampColumns.length) continue;

      for (const column of timestampColumns) {
        const rows = db.prepare(`SELECT id, ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`).all();
        let changed = 0;

        for (const row of rows) {
          const converted = convertToBogota(row.value);
          if (!converted || converted === row.value) continue;
          db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE id = ?`).run(converted, row.id);
          changed += 1;
        }

        if (changed > 0) {
          report.push(`${table}.${column}: ${changed}`);
          totalChanges += changed;
        }
      }
    }
  });

  runBackfill();

  console.log(`Respaldo creado: ${backupPath}`);
  console.log(`Filas actualizadas: ${totalChanges}`);
  report.forEach((line) => console.log(line));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});