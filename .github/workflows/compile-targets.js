/*
 * compile-targets.js
 *
 * Runs MindAR's official image compiler inside headless Chromium
 * (via Puppeteer) and writes the resulting targets.mind buffer to
 * the repo root.
 *
 * We use a headless browser because MindAR's compiler relies on
 * browser-only APIs (Canvas, ImageData) and this is the pattern
 * their own examples recommend.
 *
 * Inputs:  config.json targets[].imageFile  ->  targets/<name>
 * Output:  ./targets.mind
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT       = process.cwd();
const CONFIG     = path.join(ROOT, 'config.json');
const TARGETS    = path.join(ROOT, 'targets');
const OUT_FILE   = path.join(ROOT, 'targets.mind');
const COMPILER   = path.join(ROOT, 'node_modules', 'mind-ar', 'dist', 'mindar-image.prod.js');

(async () => {
  // ---- Read config ---------------------------------------------------------
  if (!fs.existsSync(CONFIG)) {
    console.error('config.json not found'); process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const targets = Array.isArray(cfg.targets) ? cfg.targets : [];

  if (targets.length === 0) {
    console.log('No targets configured. Skipping compilation.');
    // Remove any stale .mind so scanner fails loudly instead of silently
    if (fs.existsSync(OUT_FILE)) fs.unlinkSync(OUT_FILE);
    process.exit(0);
  }

  // Validate all files exist
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

  if (!fs.existsSync(COMPILER)) {
    console.error('mind-ar compiler not found at', COMPILER);
    process.exit(1);
  }
  const compilerScript = fs.readFileSync(COMPILER, 'utf8');

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
      // Surface useful progress messages
      try { console.log('[browser]', msg.text()); } catch (_) {}
    });
    page.on('pageerror', err => console.error('[browser error]', err.message));

    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      { waitUntil: 'load' }
    );

    // Inject the MindAR library as a script (avoids cross-origin fetches)
    await page.evaluate(src => {
      const s = document.createElement('script');
      s.textContent = src;
      document.head.appendChild(s);
    }, compilerScript);

    // Verify the compiler is present
    const hasCompiler = await page.evaluate(() => {
      return !!(window.MINDAR && window.MINDAR.IMAGE && typeof window.MINDAR.IMAGE.Compiler === 'function');
    });
    if (!hasCompiler) {
      throw new Error('window.MINDAR.IMAGE.Compiler not found after injecting mind-ar bundle.');
    }

    // Run the compiler
    const base64 = await page.evaluate(async (images) => {
      const loadImage = (dataUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => resolve(img);
        img.onerror = (e) => reject(new Error('Image load failed: ' + e));
        img.src = dataUrl;
      });

      const loaded = [];
      for (const spec of images) {
        const img = await loadImage(spec.dataUrl);
        loaded.push(img);
      }

      const compiler = new window.MINDAR.IMAGE.Compiler();
      await compiler.compileImageTargets(loaded, (progress) => {
        if (typeof progress === 'number') {
          console.log('compile progress ' + progress.toFixed(1) + '%');
        }
      });
      const buffer = compiler.exportData();  // Uint8Array

      // Return as base64 (structured-clone a TypedArray is fine, but base64
      // survives any transport quirks and keeps the script resilient)
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }, images);

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
