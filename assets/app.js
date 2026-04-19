/* ================================================================
 * AR Band Merch — app.js
 *
 * Single-page state machine. No framework, no router.
 * Handles: compatibility checks, camera permission, MindAR scene
 * construction, detection debouncing, and fullscreen content overlays.
 * ================================================================ */

(function () {
  'use strict';

  // ---------- Configuration -------------------------------------------------
  const DETECTION_DEBOUNCE_MS = 1000;   // Spec §2.5 — must be stable for ~1s
  const CONFIG_PATH = 'config.json';
  const MIND_FILE   = 'targets.mind';

  // In-app browser UA fragments. Spec §2.2 — block known problem wrappers.
  const IN_APP_UA_FRAGMENTS = [
    'Instagram', 'FBAN', 'FBAV', 'FB_IAB',             // Facebook / Instagram
    'TikTok', 'musical_ly',                             // TikTok
    'Twitter', 'TwitterAndroid',                        // X / Twitter
    'Line/', 'MicroMessenger', 'Snapchat'               // extras, same problem class
  ];

  // Views
  const VIEWS = [
    'view-landing',
    'view-unsupported',
    'view-permission-denied',
    'view-scanner',
    'view-content',
    'view-desktop'
  ];

  // ---------- Lightweight DOM helpers --------------------------------------
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function showView(id) {
    VIEWS.forEach(v => {
      const el = document.getElementById(v);
      if (!el) return;
      el.classList.toggle('view--active', v === id);
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Compatibility check -------------------------------------------
  function detectIncompatibility() {
    // HTTPS (or localhost) — camera API requires secure context
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return 'This site must be served over HTTPS for camera access.';
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return 'Your browser doesn\'t support AR. Please open in Chrome or Safari.';
    }
    // WebGL check
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return 'Your browser doesn\'t support AR. Please open in Chrome or Safari.';
    } catch (_) {
      return 'Your browser doesn\'t support AR. Please open in Chrome or Safari.';
    }
    // In-app browser detection
    const ua = navigator.userAgent || '';
    for (const frag of IN_APP_UA_FRAGMENTS) {
      if (ua.indexOf(frag) !== -1) {
        return 'This in-app browser blocks camera access. Please open this page in Chrome or Safari.';
      }
    }
    return null;
  }

  // Rough mobile detection for desktop-fallback routing. Spec §4.
  function isLikelyDesktop() {
    const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const ua = (navigator.userAgent || '').toLowerCase();
    const mobileUA = /android|iphone|ipad|ipod|mobile|phone/.test(ua);
    return !hasTouch && !mobileUA;
  }

  // ---------- Config loading ------------------------------------------------
  async function loadConfig() {
    try {
      const res = await fetch(CONFIG_PATH, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      console.error('[AR] Failed to load config.json:', err);
      return {
        site: { title: 'AR', howItWorks: [] },
        targets: []
      };
    }
  }

  function applySiteConfig(cfg) {
    const site = (cfg && cfg.site) || {};
    const title = site.title || 'AR';
    document.title = title;
    $$('[data-site-title]').forEach(el => { el.textContent = title; });

    // Optional accent color override
    if (site.accentColor && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(site.accentColor)) {
      document.documentElement.style.setProperty('--accent', site.accentColor);
      // Simple contrast pick: if the accent is very light, use black text; else white.
      const hex = site.accentColor.replace('#', '');
      const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      document.documentElement.style.setProperty(
        '--accent-contrast',
        luminance > 0.6 ? '#000000' : '#ffffff'
      );
    }

    // How-it-works steps
    const steps = Array.isArray(site.howItWorks) ? site.howItWorks : [];
    if (steps.length) {
      $$('[data-how-it-works]').forEach(list => {
        list.innerHTML = steps
          .map((s, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span>${escapeHtml(s)}</li>`)
          .join('');
      });
    }
  }

  // ---------- Scanner -------------------------------------------------------
  let sceneEl = null;           // active <a-scene>
  let debounceTimers = {};      // { targetIndex: timeoutId }
  let visibleTargets = {};      // { targetIndex: true }
  let contentOpen = false;
  let targetsForScene = [];     // ordered list of config targets matching .mind
  let mindStarted = false;

  async function startScanning(cfg) {
    const targets = (cfg && Array.isArray(cfg.targets)) ? cfg.targets : [];
    if (targets.length === 0) {
      showMessage('view-unsupported', 'No targets configured', 'Add reference images to /targets/ and entries to config.json.');
      return;
    }
    targetsForScene = targets;

    // Request permission up front. On success, we build the A-Frame scene.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
    } catch (err) {
      console.warn('[AR] Camera permission denied or unavailable:', err);
      showView('view-permission-denied');
      return;
    }
    // Release this probe stream — MindAR will acquire its own.
    stream.getTracks().forEach(t => t.stop());

    showView('view-scanner');
    buildScene(targets);
  }

  function buildScene(targets) {
    const mount = document.getElementById('scanner-mount');
    mount.innerHTML = '';   // clear any previous scene

    // Build <a-scene> with mindar-image configured to our .mind file.
    // maxTrack: 1 — only track one image at a time; sufficient for this UX.
    const scene = document.createElement('a-scene');
    scene.setAttribute('mindar-image', `imageTargetSrc: ./${MIND_FILE}; maxTrack: 1; uiLoading: no; uiScanning: no; uiError: no;`);
    scene.setAttribute('embedded', '');
    scene.setAttribute('color-space', 'sRGB');
    scene.setAttribute('renderer', 'colorManagement: true, physicallyCorrectLights');
    scene.setAttribute('vr-mode-ui', 'enabled: false');
    scene.setAttribute('device-orientation-permission-ui', 'enabled: false');

    // Default camera
    const cam = document.createElement('a-camera');
    cam.setAttribute('position', '0 0 0');
    cam.setAttribute('look-controls', 'enabled: false');
    scene.appendChild(cam);

    // One empty anchor per target — we don't render 3D overlays, we just need
    // the MindAR events (targetFound / targetLost).
    targets.forEach((t, i) => {
      const anchor = document.createElement('a-entity');
      anchor.setAttribute('mindar-image-target', `targetIndex: ${i}`);
      anchor.dataset.targetId = t.id;
      anchor.dataset.targetIndex = String(i);
      anchor.addEventListener('targetFound', () => onTargetFound(i));
      anchor.addEventListener('targetLost',  () => onTargetLost(i));
      scene.appendChild(anchor);
    });

    scene.addEventListener('arError', (e) => {
      console.error('[AR] MindAR error:', e);
      showMessage('view-unsupported',
        'Scanner couldn\'t start',
        'There was a problem starting the AR scanner. Try reloading, or make sure camera permissions are allowed.'
      );
    });

    mount.appendChild(scene);
    sceneEl = scene;
    mindStarted = true;
  }

  function onTargetFound(index) {
    if (contentOpen) return;                  // don't retrigger while content is open
    visibleTargets[index] = true;
    setScannerHint('Hold steady…');
    // Debounce: must remain visible continuously for DETECTION_DEBOUNCE_MS
    clearTimeout(debounceTimers[index]);
    debounceTimers[index] = setTimeout(() => {
      if (visibleTargets[index] && !contentOpen) {
        triggerContent(index);
      }
    }, DETECTION_DEBOUNCE_MS);
  }

  function onTargetLost(index) {
    visibleTargets[index] = false;
    clearTimeout(debounceTimers[index]);
    debounceTimers[index] = null;
    if (Object.values(visibleTargets).every(v => !v)) {
      setScannerHint('');
    }
  }

  function setScannerHint(text) {
    const el = document.getElementById('scanner-hint');
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.classList.add('scanner__hint--active');
    } else {
      el.classList.remove('scanner__hint--active');
    }
  }

  // ---------- Content overlay ----------------------------------------------
  function triggerContent(index) {
    const target = targetsForScene[index];
    if (!target || !target.content) {
      console.warn('[AR] No content defined for target index', index);
      return;
    }
    contentOpen = true;
    setScannerHint('');
    renderContent(target);
    // Layer content *on top of* the scanner so the blurred backdrop shows
    // the live camera feed (Spec §2.6). Don't toggle off the scanner view.
    const contentView = document.getElementById('view-content');
    if (contentView) contentView.classList.add('view--active');
  }

  function renderContent(target) {
    const meta = document.getElementById('content-meta');
    const body = document.getElementById('content-body');
    meta.innerHTML = '';
    body.innerHTML = '';

    // Optional metadata header (Spec §2.7)
    const hasMeta = target.title || target.artist || target.description;
    if (hasMeta) {
      const parts = [];
      if (target.artist) {
        parts.push(`<p class="meta__artist">${escapeHtml(target.artist)}</p>`);
      }
      if (target.title) {
        parts.push(`<h2 class="meta__title">${escapeHtml(target.title)}</h2>`);
      }
      if (target.description) {
        parts.push(`<p class="meta__description">${escapeHtml(target.description)}</p>`);
      }
      meta.innerHTML = parts.join('');
    }

    const content = target.content || {};
    switch (content.type) {
      case 'video':  body.appendChild(renderVideo(content));  break;
      case 'audio':  body.appendChild(renderAudio(content));  break;
      case 'link':   body.appendChild(renderLink(content));   break;
      default:
        body.innerHTML = `<p class="message__body">Unknown content type: ${escapeHtml(content.type)}</p>`;
    }
  }

  // Video: YouTube or Vimeo embed
  function renderVideo(content) {
    const wrap = document.createElement('div');
    wrap.className = 'media-frame';
    const embed = toVideoEmbedUrl(content.url);
    if (!embed) {
      wrap.innerHTML = `<div class="link-card"><p class="link-card__description">Couldn't recognize this video URL.</p></div>`;
      return wrap;
    }
    const iframe = document.createElement('iframe');
    iframe.src = embed;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('playsinline', '');
    iframe.title = content.title || 'Video';
    wrap.appendChild(iframe);
    return wrap;
  }

  function toVideoEmbedUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');

      // YouTube variants
      if (host === 'youtube.com' || host === 'm.youtube.com') {
        const id = u.searchParams.get('v');
        if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
        // /embed/ID already
        const m = u.pathname.match(/^\/embed\/([^/?]+)/);
        if (m) return `https://www.youtube.com/embed/${m[1]}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
        // /shorts/ID
        const s = u.pathname.match(/^\/shorts\/([^/?]+)/);
        if (s) return `https://www.youtube.com/embed/${s[1]}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
      }
      if (host === 'youtu.be') {
        const id = u.pathname.replace(/^\//, '');
        if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
      }

      // Vimeo
      if (host === 'vimeo.com') {
        const id = u.pathname.match(/^\/(\d+)/);
        if (id) return `https://player.vimeo.com/video/${id[1]}?autoplay=1&playsinline=1`;
      }
      if (host === 'player.vimeo.com') {
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'autoplay=1&playsinline=1';
      }

      // Unknown — return original; browser may refuse to embed it
      return url;
    } catch (_) {
      return null;
    }
  }

  // Audio: SoundCloud or Spotify embed
  function renderAudio(content) {
    const wrap = document.createElement('div');
    wrap.className = 'media-frame media-frame--audio';
    const embed = toAudioEmbedUrl(content.url);
    if (!embed) {
      wrap.innerHTML = `<div class="link-card"><p class="link-card__description">Couldn't recognize this audio URL.</p></div>`;
      return wrap;
    }
    const iframe = document.createElement('iframe');
    iframe.src = embed;
    iframe.allow = 'autoplay; encrypted-media; clipboard-write';
    iframe.setAttribute('allowtransparency', 'true');
    iframe.title = content.title || 'Audio';
    wrap.appendChild(iframe);
    return wrap;
  }

  function toAudioEmbedUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');

      // SoundCloud — use their widget player
      if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
        const encoded = encodeURIComponent(url);
        return `https://w.soundcloud.com/player/?url=${encoded}&auto_play=true&color=%23ffffff&hide_related=true&show_comments=false&show_user=true`;
      }

      // Spotify — they provide /embed/ paths for track/album/playlist
      if (host === 'open.spotify.com') {
        const m = u.pathname.match(/^\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
        if (m) return `https://open.spotify.com/embed/${m[1]}/${m[2]}`;
        // If it's already an embed URL
        if (u.pathname.startsWith('/embed/')) return url;
      }
      return url;
    } catch (_) {
      return null;
    }
  }

  // External link card
  function renderLink(content) {
    const wrap = document.createElement('div');
    wrap.className = 'link-card';
    if (content.thumbnail) {
      const thumb = document.createElement('div');
      thumb.className = 'link-card__thumb';
      thumb.style.backgroundImage = `url("${encodeURI('targets/' + content.thumbnail)}")`;
      wrap.appendChild(thumb);
    }
    if (content.title) {
      const h = document.createElement('h3');
      h.className = 'link-card__title';
      h.textContent = content.title;
      wrap.appendChild(h);
    }
    if (content.description) {
      const p = document.createElement('p');
      p.className = 'link-card__description';
      p.textContent = content.description;
      wrap.appendChild(p);
    }
    const a = document.createElement('a');
    a.className = 'btn btn--primary';
    a.href = content.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = content.buttonText || 'Open link';
    wrap.appendChild(a);
    return wrap;
  }

  function closeContent() {
    if (!contentOpen) return;
    contentOpen = false;
    // Tear down iframes so autoplaying video/audio actually stops.
    const body = document.getElementById('content-body');
    if (body) body.innerHTML = '';
    const meta = document.getElementById('content-meta');
    if (meta) meta.innerHTML = '';
    // Just hide the content overlay. The scanner view underneath stays
    // active, so the camera feed is already live — no re-initialization.
    const contentView = document.getElementById('view-content');
    if (contentView) contentView.classList.remove('view--active');
    // If the scanner has been torn down (e.g. user hit home), fall back.
    if (!mindStarted) {
      showView('view-landing');
    }
    // Reset debounce state so a re-detection of the same image can fire again
    // after the user has manually closed the previous content.
    visibleTargets = {};
    Object.values(debounceTimers).forEach(id => clearTimeout(id));
    debounceTimers = {};
  }

  // ---------- Message shortcut ---------------------------------------------
  function showMessage(viewId, title, body) {
    // Only #view-unsupported has a title+body structure we can mutate reliably.
    if (viewId === 'view-unsupported') {
      const t = $('#view-unsupported .message__title');
      const b = $('#view-unsupported .message__body');
      if (t) t.textContent = title || 'Not supported here';
      if (b) b.textContent = body || '';
    }
    showView(viewId);
  }

  // ---------- Teardown ------------------------------------------------------
  async function stopScanning() {
    if (!mindStarted) return;
    try {
      const system = sceneEl && sceneEl.systems && sceneEl.systems['mindar-image-system'];
      if (system && typeof system.stop === 'function') {
        system.stop();
      }
    } catch (e) { /* no-op */ }

    // Remove the scene entirely — this also releases the <video> + canvas MindAR created.
    const mount = document.getElementById('scanner-mount');
    if (mount) mount.innerHTML = '';
    sceneEl = null;
    mindStarted = false;
    visibleTargets = {};
    Object.values(debounceTimers).forEach(id => clearTimeout(id));
    debounceTimers = {};
    setScannerHint('');
  }

  function goHome() {
    closeContent();
    stopScanning();
    showView('view-landing');
  }

  // ---------- Wire-up -------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    const cfg = await loadConfig();
    applySiteConfig(cfg);
    window.__ARCONFIG__ = cfg;   // shared with fallback-desktop.js

    // Desktop fallback — do this before compatibility check so desktop users
    // with incompatible camera setups still land on the desktop view.
    if (isLikelyDesktop()) {
      showView('view-desktop');
      document.dispatchEvent(new CustomEvent('ar:desktop-ready', { detail: { config: cfg } }));
      return;
    }

    const incompat = detectIncompatibility();
    if (incompat) {
      showMessage('view-unsupported', 'Not supported here', incompat);
      return;
    }

    // Start button
    const startBtn = document.getElementById('start-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => startScanning(cfg));
    }

    // Retry permission
    const retryBtn = document.getElementById('retry-permission-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => startScanning(cfg));
    }

    // Home/close buttons (scanner & permission-denied)
    $$('[data-go-home]').forEach(btn => {
      btn.addEventListener('click', goHome);
    });

    // Close content (X button + backdrop + tap outside shell)
    $$('[data-close-content]').forEach(el => {
      el.addEventListener('click', closeContent);
    });

    // Escape key closes content / scanner
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (contentOpen) return closeContent();
        if (mindStarted)  return goHome();
      }
    });
  });

})();
