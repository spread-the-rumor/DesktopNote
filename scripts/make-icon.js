// One-off: build assets/icon.ico (multi-res) from assets/logo.png.
// Run once after the logo changes: `node scripts/make-icon.js`. Commit the .ico.
// ponytail: png-to-ico downscales the 1024² master itself; no separate sizes needed.
const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico').default;

const src = path.join(__dirname, '..', 'assets', 'logo.png');
const out = path.join(__dirname, '..', 'assets', 'icon.ico');

pngToIco(src)
  .then((buf) => {
    fs.writeFileSync(out, buf);
    console.log(`Wrote ${out} (${buf.length} bytes)`);
  })
  .catch((err) => {
    console.error('Icon build failed:', err);
    process.exit(1);
  });
