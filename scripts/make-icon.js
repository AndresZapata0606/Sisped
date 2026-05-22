const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico');

const src = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'logo.png');
const outDir = path.join(__dirname, '..', 'build');
const out = path.join(outDir, 'icon.ico');

if (!fs.existsSync(src)) {
  console.error('Logo fuente no encontrado:', src);
  process.exit(2);
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

pngToIco(src)
  .then(buf => {
    fs.writeFileSync(out, buf);
    console.log('Icono generado en', out);
  })
  .catch(err => {
    console.error('Error generando icono:', err);
    process.exit(1);
  });
