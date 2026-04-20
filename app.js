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

    // Assets: pre-declare all spatial media so A-Frame loads them once.
    const assets = document.createElement('a-assets');
    assets.setAttribute('timeout', '10000');
    let assetsHaveItems = false;
    targets.forEach((t, i) => {
      if (resolveDisplayMode(t) !== 'spatial') return;
      const c = t.content || {};
      if (c.type === 'video' && isDirectVideoUrl(c.url)) {
        const v = document.createElement('video');
        v.id = `asset-video-${i}`;
        v.setAttribute('src', c.url);
        v.setAttribute('loop', '');
        v.setAttribute('muted', '');                // iOS requires muted for autoplay
        v.setAttribute('playsinline', '');
        v.setAttribute('webkit-playsinline', '');
        v.setAttribute('crossorigin', 'anonymous');
        v.setAttribute('preload', 'auto');
        assets.appendChild(v);
        assetsHaveItems = true;
      }
      if (c.type === 'link' && c.thumbnail) {
        const img = document.createElement('img');
        img.id = `asset-thumb-${i}`;
        img.setAttribute('src', `targets/${c.thumbnail}`);
        img.setAttribute('crossorigin', 'anonymous');
        assets.appendChild(img);
        assetsHaveItems = true;
      }
    });
    if (assetsHaveItems) scene.appendChild(assets);

    // Default camera
    const cam = document.createElement('a-camera');
    cam.setAttribute('position', '0 0 0');
    cam.setAttribute('look-controls', 'enabled: false');
    // Enable raycaster for tap-to-play / tap-to-open behavior on spatial elements
    cam.setAttribute('raycaster', 'objects: .clickable; far: 20');
    cam.setAttribute('cursor', 'fuse: false; rayOrigin: mouse');
    scene.appendChild(cam);

    // One anchor per target. Spatial targets get 3D content; fullscreen targets
    // are just empty anchors that fire detection events for the overlay flow.
    targets.forEach((t, i) => {
      const anchor = document.createElement('a-entity');
      anchor.setAttribute('mindar-image-target', `targetIndex: ${i}`);
      anchor.dataset.targetId = t.id;
      anchor.dataset.targetIndex = String(i);

      const mode = resolveDisplayMode(t);
      if (mode === 'spatial') {
        const spatial = buildSpatialContent(t, i);
        if (spatial) anchor.appendChild(spatial);
      }

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

    // After the scene is ready, warm up spatial videos so they're ready to play
    // immediately on first detection (iOS needs a user-gesture kick first).
    scene.addEventListener('loaded', () => {
      primeSpatialVideos(targets);
    });

    // Tap handling for spatial elements. We listen on the scene and dispatch
    // based on the clicked element's role dataset.
    scene.addEventListener('click', (ev) => {
      const el = ev.target;
      if (!el || !el.dataset) return;
      const idx = parseInt(el.dataset.targetIndex, 10);
      if (isNaN(idx)) return;
      const target = targetsForScene[idx];
      if (!target) return;
      handleSpatialTap(target, idx, el.dataset.role);
    });

    mount.appendChild(scene);
    sceneEl = scene;
    mindStarted = true;
  }

  /**
   * Called when the user taps a spatial element (a-video, a-plane, etc.)
   * Behavior depends on the element's role:
   *  - spatial-video → toggle mute (since first play was muted)
   *  - spatial-audio → manually trigger playback (needed for iOS)
   *  - spatial-link  → open the configured URL in a new tab
   */
  function handleSpatialTap(target, index, role) {
    const c = target.content || {};
    if (role === 'spatial-video') {
      const v = document.getElementById(`asset-video-${index}`);
      if (!v) return;
      v.muted = !v.muted;
      if (v.paused) v.play().catch(() => {});
      return;
    }
    if (role === 'spatial-audio') {
      playSpatialAudio(target, index);
      return;
    }
    if (role === 'spatial-link') {
      if (c.url) {
        window.open(c.url, '_blank', 'noopener');
      }
      return;
    }
  }

  /**
   * Determine whether a target should render spatially or take over the screen.
   * - Explicit `content.displayMode` wins if set to "spatial" or "fullscreen".
   * - Otherwise, video with a direct file URL defaults to spatial; everything
   *   else defaults to fullscreen (preserves old behavior).
   * - YouTube/Vimeo can't render spatially (iframes can't be WebGL textures),
   *   so they're force-downgraded to fullscreen with a console warning.
   */
  function resolveDisplayMode(target) {
    const c = (target && target.content) || {};
    const requested = c.displayMode;
    const type = c.type;

    if (type === 'video') {
      const direct = isDirectVideoUrl(c.url);
      if (requested === 'spatial' && !direct) {
        console.warn(`[AR] Target "${target.id}" requested spatial mode but has a YouTube/Vimeo URL. Falling back to fullscreen.`);
        return 'fullscreen';
      }
      if (requested === 'fullscreen') return 'fullscreen';
      if (requested === 'spatial' || direct) return 'spatial';
      return 'fullscreen';
    }
    if (type === 'audio' || type === 'link') {
      if (requested === 'spatial')   return 'spatial';
      if (requested === 'fullscreen') return 'fullscreen';
      return 'fullscreen';  // default: preserve old behavior
    }
    return 'fullscreen';
  }

  function isDirectVideoUrl(url) {
    if (!url) return false;
    return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
  }

  /**
   * Build the A-Frame subtree that sits on top of the detected image.
   * Returns the root entity to append to the mindar-image-target anchor.
   *
   * Coordinate system: the mindar-image-target anchor's local space is sized
   * so that `width: 1` roughly fills the image's width. Height is
   * `imageHeight / imageWidth` of that. We use 1 for the plane width so
   * content fills the physical image.
   */
  function buildSpatialContent(target, index) {
    const c = target.content || {};
    const root = document.createElement('a-entity');
    root.setAttribute('position', '0 0 0');

    if (c.type === 'video' && isDirectVideoUrl(c.url)) {
      const h = (typeof c.spatialHeight === 'number' && c.spatialHeight > 0) ? c.spatialHeight : 0.5625;
      const v = document.createElement('a-video');
      v.setAttribute('src', `#asset-video-${index}`);
      v.setAttribute('width', '1');
      v.setAttribute('height', String(h));    // 0.5625 = 16:9, override per-target if needed
      v.setAttribute('position', '0 0 0.01'); // slight lift to avoid z-fighting
      v.setAttribute('class', 'clickable');
      v.dataset.targetIndex = String(index);
      v.dataset.role = 'spatial-video';
      root.appendChild(v);
      return root;
    }

    if (c.type === 'audio') {
      // Floating card: a dark plane with a centered "play" triangle.
      const plane = document.createElement('a-plane');
      plane.setAttribute('width', '1');
      plane.setAttribute('height', '0.3');
      plane.setAttribute('color', '#000000');
      plane.setAttribute('opacity', '0.82');
      plane.setAttribute('position', '0 0 0.01');
      plane.setAttribute('class', 'clickable');
      plane.dataset.targetIndex = String(index);
      plane.dataset.role = 'spatial-audio';
      root.appendChild(plane);

      // Play triangle (rotated plane as a stand-in — keeps deps minimal)
      const tri = document.createElement('a-triangle');
      tri.setAttribute('vertex-a', '0.04 0.06 0');
      tri.setAttribute('vertex-b', '0.04 -0.06 0');
      tri.setAttribute('vertex-c', '0.14 0 0');
      tri.setAttribute('color', '#ffffff');
      tri.setAttribute('position', '-0.05 0 0.02');
      tri.setAttribute('class', 'clickable');
      tri.dataset.targetIndex = String(index);
      tri.dataset.role = 'spatial-audio';
      root.appendChild(tri);

      // Label
      if (target.title) {
        const label = document.createElement('a-text');
        label.setAttribute('value', target.title);
        label.setAttribute('color', '#ffffff');
        label.setAttribute('align', 'center');
        label.setAttribute('width', '1.5');
        label.setAttribute('position', '0.12 0.02 0.02');
        label.setAttribute('anchor', 'align');
        root.appendChild(label);
      }
      return root;
    }

    if (c.type === 'link') {
      // Floating card: optional thumbnail + title + subtle "tap" hint.
      const plane = document.createElement('a-plane');
      plane.setAttribute('width', '1');
      plane.setAttribute('height', '0.6');
      plane.setAttribute('color', '#000000');
      plane.setAttribute('opacity', '0.82');
      plane.setAttribute('position', '0 0 0.01');
      plane.setAttribute('class', 'clickable');
      plane.dataset.targetIndex = String(index);
      plane.dataset.role = 'spatial-link';
      root.appendChild(plane);

      if (c.thumbnail) {
        const thumb = document.createElement('a-image');
        thumb.setAttribute('src', `#asset-thumb-${index}`);
        thumb.setAttribute('width', '0.9');
        thumb.setAttribute('height', '0.35');
        thumb.setAttribute('position', '0 0.1 0.02');
        thumb.setAttribute('class', 'clickable');
        thumb.dataset.targetIndex = String(index);
        thumb.dataset.role = 'spatial-link';
        root.appendChild(thumb);
      }

      if (target.title) {
        const label = document.createElement('a-text');
        label.setAttribute('value', target.title);
        label.setAttribute('color', '#ffffff');
        label.setAttribute('align', 'center');
        label.setAttribute('width', '1.4');
        label.setAttribute('position', `0 ${c.thumbnail ? -0.14 : 0.02} 0.02`);
        root.appendChild(label);
      }

      const hint = document.createElement('a-text');
      hint.setAttribute('value', (c.buttonText || 'Tap to open').toUpperCase());
      hint.setAttribute('color', '#999999');
      hint.setAttribute('align', 'center');
      hint.setAttribute('width', '1.8');
      hint.setAttribute('position', `0 ${c.thumbnail ? -0.23 : -0.08} 0.02`);
      root.appendChild(hint);
      return root;
    }

    return null;
  }

  /**
   * Try to start spatial videos so they're ready to show immediately.
   * Muted+playsinline makes this safe on iOS inside a user-gesture context
   * (the Start Scanning tap already covers that).
   */
  function primeSpatialVideos(targets) {
    targets.forEach((t, i) => {
      if (resolveDisplayMode(t) !== 'spatial') return;
      if (!(t.content && t.content.type === 'video' && isDirectVideoUrl(t.content.url))) return;
      const v = document.getElementById(`asset-video-${i}`);
      if (!v) return;
      v.muted = true;
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {/* will retry on detection */});
    });
  }

  function onTargetFound(index) {
    const target = targetsForScene[index];
    const mode = resolveDisplayMode(target);

    visibleTargets[index] = true;

    if (mode === 'spatial') {
      // Spatial: start the video (unmuted once we've detected — user has engaged).
      // No debounce needed, no fullscreen takeover. Any previous content overlay
      // should close so the spatial view isn't obscured.
      if (contentOpen) closeContent();
      startSpatialPlayback(target, index);
      setScannerHint('');
      return;
    }

    // Fullscreen path (original behavior): debounce before taking over.
    if (contentOpen) return;
    setScannerHint('Hold steady…');
    clearTimeout(debounceTimers[index]);
    debounceTimers[index] = setTimeout(() => {
      if (visibleTargets[index] && !contentOpen) {
        triggerContent(index);
      }
    }, DETECTION_DEBOUNCE_MS);
  }

  function onTargetLost(index) {
    const target = targetsForScene[index];
    const mode = resolveDisplayMode(target);

    visibleTargets[index] = false;
    clearTimeout(debounceTimers[index]);
    debounceTimers[index] = null;

    // Spatial videos: per user spec, keep playing invisibly so re-detection
    // resumes instantly. A-Frame will hide the plane automatically when the
    // mindar-image-target anchor is not visible.
    // Spatial audio plays via HTML <audio>, also continues in the background.

    if (Object.values(visibleTargets).every(v => !v)) {
      setScannerHint('');
    }
  }

  /**
   * Start playback for a spatial target. Called on targetFound.
   * - Videos: unmute (if not already) and play. If play() rejects (iOS
   *   autoplay quirks), we leave them muted — user sees the video muted,
   *   which is still a useful experience.
   * - Audio: create or reuse an <audio> element playing the source URL.
   * - Links: no playback; tap handling is wired separately via raycaster.
   */
  function startSpatialPlayback(target, index) {
    const c = target.content || {};
    if (c.type === 'video' && isDirectVideoUrl(c.url)) {
      const v = document.getElementById(`asset-video-${index}`);
      if (!v) return;
      // First detection: unmute. Subsequent ones: just ensure it's playing.
      v.muted = false;
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // Browser blocked unmuted autoplay — revert to muted playback.
          v.muted = true;
          v.play().catch(() => {});
        });
      }
      return;
    }
    if (c.type === 'audio') {
      playSpatialAudio(target, index);
      return;
    }
    // Link targets: nothing to do on detection; user must tap.
  }

  // Holds the currently-playing spatial audio so we can swap between targets
  // without stacking simultaneous streams.
  let spatialAudioEl = null;
  let spatialAudioTargetIndex = -1;

  function playSpatialAudio(target, index) {
    const c = target.content || {};
    // Re-use existing element if we're resuming the same target.
    if (spatialAudioEl && spatialAudioTargetIndex === index) {
      const p = spatialAudioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return;
    }
    // Different target (or first play): tear down previous.
    stopSpatialAudio();

    // If the URL is a SoundCloud/Spotify link, we can't stream it directly —
    // fall back to fullscreen player for this one detection.
    if (!isDirectAudioUrl(c.url)) {
      console.warn(`[AR] Spatial audio for "${target.id}" requires a direct .mp3/.ogg/.m4a URL. Falling back to fullscreen.`);
      triggerContent(index);
      return;
    }

    const a = new Audio();
    a.src = c.url;
    a.loop = false;
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    a.play().catch(err => {
      console.warn('[AR] Spatial audio play failed:', err);
    });
    spatialAudioEl = a;
    spatialAudioTargetIndex = index;
  }

  function stopSpatialAudio() {
    if (spatialAudioEl) {
      try { spatialAudioEl.pause(); } catch (_) {}
      spatialAudioEl.src = '';
      spatialAudioEl = null;
      spatialAudioTargetIndex = -1;
    }
  }

  function isDirectAudioUrl(url) {
    if (!url) return false;
    return /\.(mp3|ogg|m4a|wav|aac)(\?|#|$)/i.test(url);
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
    // Stop any spatial audio that's playing
    stopSpatialAudio();
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
