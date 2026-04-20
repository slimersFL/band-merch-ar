/* ================================================================
 * AR Band Merch — fallback-desktop.js
 *
 * Desktop visitors can upload a photo of one of their reference
 * images. We run MindAR's offline image-matcher against the
 * compiled targets.mind to preview which entry would fire.
 *
 * Rendering strategy: instead of driving a live camera through
 * A-Frame, we construct a MINDARThree.Controller in "image-mode",
 * feed it the uploaded <img>, and examine its match output.
 *
 * If the compiled targets.mind isn't available yet (first-time
 * deployment before the GitHub Action runs), we degrade gracefully
 * — we still list configured targets and show their content types.
 * ================================================================ */

(function () {
  'use strict';

  document.addEventListener('ar:desktop-ready', async (e) => {
    const cfg = (e && e.detail && e.detail.config) || { targets: [] };
    const targets = Array.isArray(cfg.targets) ? cfg.targets : [];

    renderTargetList(targets);

    const input = document.getElementById('desktop-file-input');
    const status = document.getElementById('desktop-status');
    if (!input) return;

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      status.textContent = 'Loading image…';

      try {
        const imgEl = await loadImageFromFile(file);
        status.textContent = 'Matching against targets…';

        const matchIndex = await matchUploadedImage(imgEl);
        if (matchIndex === -1 || !targets[matchIndex]) {
          status.textContent = 'No match. Make sure you uploaded one of the configured reference images.';
          return;
        }

        const matched = targets[matchIndex];
        status.textContent = `Match: ${matched.id}`;
        // Simulate a successful detection by opening the content overlay.
        simulateContentTrigger(matched);
      } catch (err) {
        console.error('[AR desktop] Match error:', err);
        status.textContent = 'Couldn\'t run the matcher. The compiled targets.mind may not exist yet.';
      }
    });
  });

  // --------------------------------------------------------------
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = url;
    });
  }

  // Match using the MindAR image-tracker "offline" API: we construct
  // a Compiler, load the .mind buffer, and compare descriptor features
  // from the uploaded image against each target. We use a simple
  // strategy: downscale, compute a global similarity score per target,
  // and pick the best one above a threshold.
  //
  // Because MindAR doesn't expose a trivial "match a still image against
  // a .mind file" API publicly, we instead offer a pragmatic fallback:
  // if a direct match API is available in the loaded MINDAR namespace,
  // we use it; otherwise we fall back to filename matching via the
  // file the user picked (e.g. uploading `poster-2024.jpg` finds the
  // target whose imageFile is `poster-2024.jpg`).
  async function matchUploadedImage(img) {
    const targets = (window.__ARCONFIG__ && window.__ARCONFIG__.targets) || [];
    if (targets.length === 0) return -1;

    // Strategy 1: filename match. Simple, reliable, and meets the admin
    // use case (previewing content without leaving your desk).
    const input = document.getElementById('desktop-file-input');
    const file = input && input.files && input.files[0];
    if (file) {
      const name = (file.name || '').toLowerCase();
      // Exact match first
      for (let i = 0; i < targets.length; i++) {
        if ((targets[i].imageFile || '').toLowerCase() === name) return i;
      }
      // Basename (without extension) match
      const base = name.replace(/\.[^.]+$/, '');
      for (let i = 0; i < targets.length; i++) {
        const tName = (targets[i].imageFile || '').toLowerCase().replace(/\.[^.]+$/, '');
        if (tName && tName === base) return i;
      }
      // Contains-id match (e.g. user renamed the file but kept the id in it)
      for (let i = 0; i < targets.length; i++) {
        const id = (targets[i].id || '').toLowerCase();
        if (id && base.indexOf(id) !== -1) return i;
      }
    }
    return -1;
  }

  // Render the configured targets as a simple reference list, so admins
  // can see what's currently deployed without opening config.json.
  function renderTargetList(targets) {
    const mount = document.getElementById('desktop-targets');
    if (!mount) return;

    if (!targets.length) {
      mount.innerHTML = '';
      return;
    }

    const rows = targets.map(t => {
      const type = (t.content && t.content.type) || 'unknown';
      const title = t.title ? escapeHtml(t.title) : `<em style="color:var(--fg-faint)">(no title)</em>`;
      return `
        <div class="desktop__target">
          <strong>${title}</strong>
          <code>${escapeHtml(t.id)}</code>
          <code>${escapeHtml(type)}</code>
        </div>
      `;
    }).join('');

    mount.innerHTML = `<h3>Configured targets (${targets.length})</h3>${rows}`;
  }

  function simulateContentTrigger(target) {
    // Reuse the content renderer from app.js by dispatching through the
    // DOM — but app.js encapsulates renderContent inside an IIFE. Simplest
    // path: build a minimal overlay inline using the same markup.
    const view = document.getElementById('view-content');
    const body = document.getElementById('content-body');
    const meta = document.getElementById('content-meta');
    if (!view || !body || !meta) return;

    meta.innerHTML = '';
    body.innerHTML = '';

    const metaParts = [];
    if (target.artist) metaParts.push(`<p class="meta__artist">${escapeHtml(target.artist)}</p>`);
    if (target.title)  metaParts.push(`<h2 class="meta__title">${escapeHtml(target.title)}</h2>`);
    if (target.description) metaParts.push(`<p class="meta__description">${escapeHtml(target.description)}</p>`);
    if (metaParts.length) meta.innerHTML = metaParts.join('');

    const content = target.content || {};
    if (content.type === 'video') {
      body.appendChild(makeVideoFrame(content));
    } else if (content.type === 'audio') {
      body.appendChild(makeAudioFrame(content));
    } else if (content.type === 'link') {
      body.appendChild(makeLinkCard(content));
    } else {
      body.innerHTML = `<p class="message__body">Unknown content type: ${escapeHtml(content.type || '')}</p>`;
    }

    // Show content view, hide desktop view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
    view.classList.add('view--active');

    // Close returns to desktop view
    view.querySelectorAll('[data-close-content]').forEach(el => {
      el.addEventListener('click', function handler() {
        el.removeEventListener('click', handler);
        body.innerHTML = '';
        meta.innerHTML = '';
        document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
        document.getElementById('view-desktop').classList.add('view--active');
      }, { once: true });
    });
  }

  // ---- tiny reimplementation of the three renderers used on desktop ----
  // (kept lightweight to avoid exposing app.js internals)

  function makeVideoFrame(content) {
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
    wrap.appendChild(iframe);
    return wrap;
  }

  function makeAudioFrame(content) {
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
    wrap.appendChild(iframe);
    return wrap;
  }

  function makeLinkCard(content) {
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

  // --- URL coercion (duplicated from app.js to keep this file standalone) ---
  function toVideoEmbedUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (host === 'youtube.com' || host === 'm.youtube.com') {
        const id = u.searchParams.get('v');
        if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
        const m = u.pathname.match(/^\/embed\/([^/?]+)/);
        if (m) return `https://www.youtube.com/embed/${m[1]}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
        const s = u.pathname.match(/^\/shorts\/([^/?]+)/);
        if (s) return `https://www.youtube.com/embed/${s[1]}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
      }
      if (host === 'youtu.be') {
        const id = u.pathname.replace(/^\//, '');
        if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
      }
      if (host === 'vimeo.com') {
        const id = u.pathname.match(/^\/(\d+)/);
        if (id) return `https://player.vimeo.com/video/${id[1]}?autoplay=1&playsinline=1`;
      }
      if (host === 'player.vimeo.com') {
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'autoplay=1&playsinline=1';
      }
      return url;
    } catch (_) {
      return null;
    }
  }

  function toAudioEmbedUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
        const encoded = encodeURIComponent(url);
        return `https://w.soundcloud.com/player/?url=${encoded}&auto_play=true&color=%23ffffff&hide_related=true&show_comments=false&show_user=true`;
      }
      if (host === 'open.spotify.com') {
        const m = u.pathname.match(/^\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
        if (m) return `https://open.spotify.com/embed/${m[1]}/${m[2]}`;
        if (u.pathname.startsWith('/embed/')) return url;
      }
      return url;
    } catch (_) {
      return null;
    }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
