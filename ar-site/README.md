# AR Band Merch

A free, open-source AR site for bands, restaurants, and small businesses.
Point a phone camera at one of your posters, flyers, or menus — it
recognizes the image and shows a fullscreen video, audio player, or link.

No backend. No build server. $0 hosting. Deployed on GitHub Pages.

---

## 5-minute quickstart

1. Click **Use this template** on the GitHub repo page (or fork it).
2. In your new repo, open **Settings → Pages** and set the source to
   **Deploy from a branch → main → / (root)**. Save.
3. Drop a reference image (JPG/PNG) into the `/targets/` folder.
4. Edit `config.json` — replace one of the example entries with:
   ```json
   {
     "id": "my-poster",
     "imageFile": "my-poster.jpg",
     "title": "My First AR Poster",
     "content": {
       "type": "video",
       "url": "https://www.youtube.com/watch?v=YOUR_VIDEO_ID"
     }
   }
   ```
5. Commit and push. A GitHub Action compiles `targets.mind` within ~1 minute.
6. Visit `https://<your-username>.github.io/<your-repo>/` on your phone
   and point the camera at your poster.

That's it.

---

## Config reference

`config.json` is the only file you need to edit.

### `site` (object)

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | no | Shown in the header and browser tab. |
| `accentColor` | string | no | Hex color (`#ffffff`). Affects buttons. |
| `howItWorks` | array of strings | no | 3 short lines shown on the landing page. |

### `targets` (array)

Each entry:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | **yes** | Unique identifier. Kebab-case recommended. |
| `imageFile` | string | **yes** | Filename in `/targets/`. Case-sensitive. |
| `title` | string | no | Shown above the content when triggered. |
| `artist` | string | no | Shown above title as an eyebrow. |
| `description` | string | no | Short text shown with content. |
| `content` | object | **yes** | What plays when detected — see below. |

### `content` (object)

One of three types:

**Video** — YouTube or Vimeo:
```json
{ "type": "video", "url": "https://www.youtube.com/watch?v=..." }
```

Supported URL shapes:
- `https://www.youtube.com/watch?v=ID`
- `https://youtu.be/ID`
- `https://www.youtube.com/shorts/ID`
- `https://vimeo.com/ID`

**Audio** — SoundCloud or Spotify:
```json
{ "type": "audio", "url": "https://open.spotify.com/track/..." }
```

Supported URL shapes:
- `https://soundcloud.com/artist/track`
- `https://open.spotify.com/track/ID`
- `https://open.spotify.com/album/ID`
- `https://open.spotify.com/playlist/ID`

**Link** — any URL:
```json
{
  "type": "link",
  "url": "https://bandcamp.com/tour",
  "buttonText": "See tour dates",
  "thumbnail": "flyer-show-thumb.jpg"
}
```

`buttonText` and `thumbnail` are optional. `thumbnail` must be a file in `/targets/`.

---

## Image quality guidelines

MindAR's tracker works best with images that have:

- **High contrast** — strong dark/light regions, not washed-out.
- **Feature-rich content** — photos, textured illustrations, varied shapes.
  Avoid simple logos on plain backgrounds.
- **Non-repetitive patterns** — grids, stripes, or repeating tiles confuse
  the matcher.
- **At least 500×500 px** — larger source images give the compiler more
  detail to work with.
- **No transparency** — flatten PNGs onto a solid background.

If an image doesn't detect reliably, try adding visible text or an
asymmetric design element.

---

## Troubleshooting

**"Not supported here" on my phone.**
You're probably in an in-app browser (Instagram, TikTok, Facebook,
X/Twitter). These block camera access. Open the page in Chrome or Safari
directly.

**Nothing happens when I point at my poster.**
- Wait a full second with the camera steady — detection requires a ~1s
  stable match to prevent flicker-firing.
- Check that the printed poster has good lighting (no glare).
- Verify `targets.mind` exists in your repo root. The GitHub Action
  creates it automatically on push; check the **Actions** tab for any
  failures.
- Make sure `imageFile` in `config.json` matches the filename in
  `/targets/` exactly, case-sensitive.

**Video plays but no sound (iOS).**
iOS blocks unmuted autoplay. The video starts muted; tap the video to
unmute.

**The GitHub Action failed.**
Open the **Actions** tab in your repo. The most common cause is a
missing image file referenced in `config.json`. Fix the filename and
push again.

**My image is perfect quality, but detection is slow.**
Detection speed depends on the device. On older phones the tracker runs
at lower fps. If you have 20+ images in one deployment, consider
splitting them across multiple repos or waiting for the v2 lazy-loaded
target sets feature.

---

## Custom domain

GitHub has official docs for custom domains on GitHub Pages:
<https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site>.
Once set up, camera APIs will continue to work (GitHub Pages enforces HTTPS).

---

## QR codes

To print a QR code on your merch that opens the AR site:

1. Go to <https://www.qr-code-generator.com/> (or any QR generator).
2. Enter your site URL: `https://<username>.github.io/<repo>/`.
3. Download the PNG and add it to your print layout.

**Optional:** if you later want to jump straight to a specific image's
content, you can use a URL fragment hint (e.g. `?focus=poster-2024`).
This is reserved for a future version but won't break anything today.

---

## Privacy

- No analytics. No cookies. No tracking.
- The camera feed is processed entirely in your browser. Nothing is
  uploaded or stored.
- YouTube, Vimeo, SoundCloud, and Spotify embeds load content from their
  own servers and are subject to their own privacy policies.

---

## How it works (for the curious)

- **MindAR** is an open-source, browser-native image tracker. It runs on
  WebGL and WebAssembly; no app install required.
- **A-Frame** hosts the scene that MindAR hooks into. We don't actually
  render any 3D — we just listen for MindAR's `targetFound` events and
  display a fullscreen HTML overlay.
- A **GitHub Action** runs on every push. It reads the images in
  `/targets/`, runs MindAR's compiler inside headless Chromium, and
  commits the resulting `targets.mind` back to the repo.
- Everything is static HTML + CSS + vanilla JS. You can host it on any
  static host (Netlify, Cloudflare Pages, Vercel) if you prefer.

---

## License

MIT. Use it, fork it, ship it, rip the logos off it.
