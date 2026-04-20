/*
 * compile-targets.js
 *
 * Runs MindAR's official image compiler inside headless Chromium
 * (via Puppeteer) and writes the resulting targets.mind buffer to
 * the repo root.
 *
 * IMPORTANT NOTES ON VERSIONING:
 *
 * - We use the /gh/ path on jsDelivr (not /npm/). The GitHub-hosted
 *   bundle is a plain UMD script that registers window.MINDAR. The
 *   npm-hosted bundle with the same filename is an ES module, which
 *   can't be loaded with a plain <script> tag.
 *
 * - We pin to @1.1.4 because later tags (1.2.x) don't commit the
 *   `dist/` folder to the GitHub repo, so their /gh/ URLs 404.
 *   1.1.4 produces .mind files that are fully forward-compatible
 *   with the 1.2.5 runtime we load in the frontend.
 *
 * - The compiler class lives at window.MINDAR.Compiler in 1.1.4
 *   and window.MINDAR.IMAGE.Compiler in 1.2.x, so we probe both.
 *
 * Inputs:  config.json targets[].imageFile  ->  targets/<n>
 * Output:  ./targets.mind
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT       = process.cwd();
const CONFIG     = path.join(ROOT, 'config.json');
const TARGETS    = path.join(ROOT, 'targets');
const OUT_FILE   = path.join(ROOT, 'targets.mind');

// Known-good UMD bundle served from the GitHub repo on jsDelivr.
const MINDAR_CDN = 'https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.1.4/dist/mindar-image.prod.js';

(async () => {
  if (!fs.existsSync(CONFIG)) {
    console.error('config.json not found'); process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const targets = Array.isArray(cfg.targets) ? cfg.targets : [];

  if (targets.length === 0) {
    console.log('No targets configured. Skipping compilation.');
    if (fs.existsSync(OUT_FILE)) fs.unlinkSync(OUT_FILE);
    process.exit(0);
  }

  // Validate all files exist and collect them as data URLs
  const images = [];
  for (const t of targets) {
    if (!t.imageFile) {
      console.error(`Target "${t.id}" missing imageFile`); process.exit(1);
    }
    const p = path.join(TARGETS, t.imageFile);
    if (!fs.existsSync(p)) {
      console.error(`Missing target image: targets/${t.imageFile}`); process.exit(1);
    }
    const buf = fs.readFileSync(p);
    const mime = inferMime(t.imageFile);
    images.push({
      id: t.id,
      name: t.imageFile,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`
    });
  }

  // ---- Launch headless Chromium -------------------------------------------
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    page.on('console', msg => {
      try { console.log('[browser]', msg.text()); } catch (_) {}
    });
    page.on('pageerror', err => console.error('[browser error]', err.message));

    console.log('Fetching MindAR bundle from', MINDAR_CDN);
    const mindarJs = await fetchText(MINDAR_CDN);
    console.log(`Fetched MindAR bundle (${mindarJs.length} bytes).`);

    // Minimal HTML host
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      { waitUntil: 'load' }
    );

    // Inject the bundle source directly.
    await page.addScriptTag({ content: mindarJs });

    // Probe both API shapes.
    const apiShape = await page.evaluate(() => {
      if (!window.MINDAR) return { shape: 'none' };
      if (window.MINDAR.IMAGE && typeof window.MINDAR.IMAGE.Compiler === 'function') {
        return { shape: 'v2', keys: Object.keys(window.MINDAR) };
      }
      if (typeof window.MINDAR.Compiler === 'function') {
        return { shape: 'v1', keys: Object.keys(window.MINDAR) };
      }
      return { shape: 'unknown', keys: Object.keys(window.MINDAR) };
    });

    if (apiShape.shape === 'none') {
      throw new Error('window.MINDAR is undefined after injecting the bundle.');
    }
    if (apiShape.shape === 'unknown') {
      throw new Error(
        'Compiler not found. window.MINDAR keys: ' + apiShape.keys.join(', ')
      );
    }
    console.log(`MindAR compiler loaded (API shape: ${apiShape.shape}).`);

    // Run the compiler in the page context.
    const base64 = await page.evaluate(async (images, shape) => {
      const loadImage = (dataUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = dataUrl;
      });

      const loaded = [];
      for (const spec of images) {
        const img = await loadImage(spec.dataUrl);
        loaded.push(img);
      }

      const CompilerCtor = (shape === 'v2')
        ? window.MINDAR.IMAGE.Compiler
        : window.MINDAR.Compiler;

      const compiler = new CompilerCtor();
      await compiler.compileImageTargets(loaded, (progress) => {
        if (typeof progress === 'number') {
          console.log('compile progress ' + progress.toFixed(1) + '%');
        }
      });
      const buffer = await compiler.exportData();

      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }, images, apiShape.shape);

    const outBytes = Buffer.from(base64, 'base64');
    fs.writeFileSync(OUT_FILE, outBytes);
    console.log(`Wrote targets.mind (${outBytes.length} bytes) for ${images.length} image(s).`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Compilation failed:', err);
  process.exit(1);
});

// ---- Helpers -------------------------------------------------------------

function inferMime(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    default:     return 'application/octet-stream';
  }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const doGet = (u, redirectsLeft) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          return doGet(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    doGet(url, 5);
  });
}
