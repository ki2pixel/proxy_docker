// =============================================================================
// build-assets.mjs — cache-busting par hash de contenu pour le dashboard
// -----------------------------------------------------------------------------
// Hache app.js / style.css / fonts.css et les copie dans public/dist/ avec un
// nom immuable (app.<sha256>.js), puis réécrit les références dans index.html.
// Le montage express /static/dist sert ces fichiers avec max-age=1y, immutable.
// Exécution : npm run build:assets (ou dans le Dockerfile).
// =============================================================================
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'controller', 'public');
const DIST_DIR = path.join(PUBLIC_DIR, 'dist');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

// Fichiers sources → nom final dans dist (en plus des fonts déjà copiées)
const ASSETS = ['app.js', 'style.css', 'fonts.css'];

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Réécrit les références "asset" (ex: app.js) → "asset.<hash>.ext" dans le HTML
function replaceAssetRef(html, srcName, hashedName) {
  const base = srcName.replace(/\.[^.]+$/, ''); // app.js -> app
  const ext = path.extname(srcName);             // .js
  // Remplace src="app.js" / href="style.css" (avec ou sans chemin dist déjà présent)
  const re = new RegExp(`(src|href)="(?:/static/dist/)?${base}\\.(?:js|css)"`, 'g');
  return html.replace(re, `$1="/static/dist/${hashedName}"`);
}

function main() {
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // Copie des polices (présentes dans public/fonts/ si self-hosting activé)
  const fontsDir = path.join(PUBLIC_DIR, 'fonts');
  const fontsDest = path.join(DIST_DIR, 'fonts');
  if (fs.existsSync(fontsDir)) {
    fs.mkdirSync(fontsDest, { recursive: true });
    for (const f of fs.readdirSync(fontsDir)) {
      if (f.endsWith('.woff2')) {
        fs.copyFileSync(path.join(fontsDir, f), path.join(fontsDest, f));
      }
    }
  }

  let html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const built = [];

  for (const srcName of ASSETS) {
    const srcPath = path.join(PUBLIC_DIR, srcName);
    if (!fs.existsSync(srcPath)) continue;
    const content = fs.readFileSync(srcPath);
    const hashed = `${srcName.replace(/\.[^.]+$/, '')}.${sha256(content)}${path.extname(srcName)}`;
    fs.writeFileSync(path.join(DIST_DIR, hashed), content);
    built.push(hashed);
    html = replaceAssetRef(html, srcName, hashed);
  }

  fs.writeFileSync(INDEX_HTML, html);
  console.log(`[build-assets] dist/ : ${built.join(', ') || '(aucun)'}`);
  console.log(`[build-assets] index.html références mises à jour`);
}

main();
