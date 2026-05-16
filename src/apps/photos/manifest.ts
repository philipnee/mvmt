import { AppManifest } from '../registry.js';

// First real first-party app. It intentionally consumes only the shared
// cookie-authenticated FS API; there is no photos-specific backend.
const PHOTOS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Photos - mvmt</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
:root{--bg:#FAFAF7;--fg:#1A1A18;--muted:#8A8A80;--accent:#C4421A;--border:#E2E2DA;--surface:#F2F2ED;--dot:#D4D4CC;--font-body:Georgia,serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#E8E8E0;--muted:#7A7A70;--accent:#E8693F;--border:#2A2A28;--surface:#1E1E1C;--dot:#222220}}
*{margin:0;padding:0;box-sizing:border-box}
html{font-size:16px;-webkit-font-smoothing:antialiased}
body{font-family:var(--font-body);background:var(--bg);color:var(--fg);line-height:1.7;min-height:100vh;position:relative}
body:before{content:"";position:fixed;inset:0;background-image:radial-gradient(circle,var(--dot) .6px,transparent .6px);background-size:28px 28px;opacity:.45;pointer-events:none;z-index:0}
a,button{font:inherit;color:inherit}
button{cursor:pointer}
.page-wide{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:3rem 2rem 6rem}
.crumbs{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin-bottom:1.25rem;font-family:var(--font-mono);font-size:12px;color:var(--muted)}
.crumbs a{color:var(--muted);text-decoration:none;border-bottom:1px solid transparent}
.crumbs a:hover{color:var(--accent);border-bottom-color:var(--accent)}
.folders{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1.5rem}
.folder{font-family:var(--font-mono);font-size:12px;color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:4px;padding:.35rem .6rem;transition:border-color .2s,color .2s}
.folder:hover{color:var(--accent);border-color:var(--accent)}
.photo-grid{columns:3;column-gap:.75rem}
.photo-tile{display:block;width:100%;margin-bottom:.75rem;border:0;background:var(--surface);border-radius:4px;min-height:160px;overflow:hidden;break-inside:avoid;transition:opacity .2s}
.photo-tile.loaded{min-height:0;background:transparent}
.photo-tile:hover{opacity:.85}
.photo-tile img{display:block;width:100%;border-radius:4px;opacity:0;transition:opacity .18s}
.photo-tile.loaded img{opacity:1}
.lightbox{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:5vw}
.lightbox.hidden{display:none}
.lightbox img{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:4px}
.empty{font-family:var(--font-mono);font-size:12px;color:var(--muted)}
.sentinel{height:1px}
.sentinel.hidden{display:none}
@media(max-width:600px){.page-wide{padding:2rem 1.25rem 4rem}.photo-grid{columns:2}.photo-tile{min-height:120px}}
</style>
</head>
<body>
<main class="page-wide">
  <nav class="crumbs" id="crumbs"></nav>
  <div class="folders" id="folders"></div>
  <div class="photo-grid" id="grid"></div>
  <div class="sentinel hidden" id="sentinel"></div>
</main>
<div class="lightbox hidden" id="lightbox" role="dialog" aria-modal="true"></div>
<script>
(function () {
  var PHOTO_BATCH_SIZE = 60;
  var MAX_IMAGE_LOADS = 4;
  var IMAGE_EXTENSIONS = { '.avif': true, '.gif': true, '.jpg': true, '.jpeg': true, '.png': true, '.webp': true };
  var state = { path: '/', sources: [], entries: [], visiblePhotoCount: PHOTO_BATCH_SIZE };
  var activeImageLoads = 0;
  var pendingImageLoads = [];
  var imageLoadGeneration = 0;
  var sentinelObserver = null;

  function appBase() {
    var p = location.pathname.replace(/\\/+$/, '');
    var marker = '/apps/photos';
    var i = p.indexOf(marker);
    return i >= 0 ? p.slice(0, i) : '';
  }
  function api(path) {
    return fetch(appBase() + path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw new Error(b.error || ('HTTP ' + r.status)); }, function () { throw new Error('HTTP ' + r.status); }); });
  }
  function $(id) { return document.getElementById(id); }
  function fileUrl(path) { return appBase() + '/api/fs/file?path=' + encodeURIComponent(path); }
  function ext(inputPath) {
    var name = (inputPath || '').toLowerCase();
    var dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
  }
  function isImage(entry) { return entry.type === 'file' && !!IMAGE_EXTENSIONS[ext(entry.path || entry.name)]; }
  function resetImageQueue() {
    imageLoadGeneration += 1;
    pendingImageLoads = [];
  }
  function enqueueImage(img, tile, entry) {
    pendingImageLoads.push({ img: img, tile: tile, entry: entry, generation: imageLoadGeneration });
    pumpImageQueue();
  }
  function pumpImageQueue() {
    while (activeImageLoads < MAX_IMAGE_LOADS && pendingImageLoads.length) {
      var task = pendingImageLoads.shift();
      if (!task || task.generation !== imageLoadGeneration) continue;
      activeImageLoads += 1;
      startImageLoad(task);
    }
  }
  function startImageLoad(task) {
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      activeImageLoads = Math.max(0, activeImageLoads - 1);
      if (task.generation === imageLoadGeneration) {
        if (ok) task.tile.classList.add('loaded');
        else task.tile.remove();
      }
      pumpImageQueue();
    }
    task.img.addEventListener('load', function () { finish(true); }, { once: true });
    task.img.addEventListener('error', function () { finish(false); }, { once: true });
    task.img.src = fileUrl(task.entry.path);
  }
  function renderCrumbs() {
    var node = $('crumbs');
    node.innerHTML = '';
    var root = document.createElement('a');
    root.href = '#';
    root.textContent = 'sources';
    root.addEventListener('click', function (event) { event.preventDefault(); navigate('/'); });
    node.appendChild(root);
    if (state.path === '/') return;
    var segs = state.path.split('/').filter(Boolean);
    var acc = '';
    segs.forEach(function (seg) {
      node.appendChild(document.createTextNode('/'));
      acc += '/' + seg;
      var target = acc;
      var link = document.createElement('a');
      link.href = '#';
      link.textContent = seg;
      link.addEventListener('click', function (captured) {
        return function (event) { event.preventDefault(); navigate(captured); };
      }(target));
      node.appendChild(link);
    });
  }
  function renderFolders(entries) {
    var node = $('folders');
    node.innerHTML = '';
    entries.filter(function (entry) { return entry.type === 'directory' && !entry.unavailable; }).forEach(function (entry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'folder';
      button.textContent = (entry.name || entry.path) + '/';
      button.addEventListener('click', function () { navigate(entry.path); });
      node.appendChild(button);
    });
  }
  function renderPhotos(entries) {
    var grid = $('grid');
    grid.innerHTML = '';
    resetImageQueue();
    var photos = entries.filter(isImage);
    var visiblePhotos = photos.slice(0, state.visiblePhotoCount);
    if (!visiblePhotos.length && !entries.some(function (entry) { return entry.type === 'directory' && !entry.unavailable; })) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No photos.';
      grid.appendChild(empty);
    }
    visiblePhotos.forEach(function (entry) {
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'photo-tile';
      var img = document.createElement('img');
      img.decoding = 'async';
      img.loading = 'eager';
      img.alt = '';
      tile.appendChild(img);
      tile.addEventListener('click', function () { openLightbox(entry); });
      grid.appendChild(tile);
      enqueueImage(img, tile, entry);
    });
    observeSentinel(photos);
  }
  function observeSentinel(photos) {
    var sentinel = $('sentinel');
    sentinel.classList.toggle('hidden', state.visiblePhotoCount >= photos.length);
    if (sentinelObserver) sentinelObserver.disconnect();
    if (state.visiblePhotoCount >= photos.length || !('IntersectionObserver' in window)) return;
    sentinelObserver = new IntersectionObserver(function (items) {
      if (!items.some(function (item) { return item.isIntersecting; })) return;
      state.visiblePhotoCount += PHOTO_BATCH_SIZE;
      renderPhotos(state.entries);
    }, { rootMargin: '600px' });
    sentinelObserver.observe(sentinel);
  }
  function openLightbox(entry) {
    var box = $('lightbox');
    box.innerHTML = '';
    var img = document.createElement('img');
    img.src = fileUrl(entry.path);
    img.alt = '';
    box.appendChild(img);
    box.classList.remove('hidden');
  }
  function closeLightbox() {
    var box = $('lightbox');
    box.classList.add('hidden');
    box.innerHTML = '';
  }
  function navigate(nextPath) {
    state.path = nextPath;
    state.visiblePhotoCount = PHOTO_BATCH_SIZE;
    resetImageQueue();
    renderCrumbs();
    renderFolders([]);
    $('grid').innerHTML = '';
    var req = nextPath === '/'
      ? api('/api/fs/sources').then(function (body) { state.sources = body.sources || []; return state.sources; })
      : api('/api/fs/list?path=' + encodeURIComponent(nextPath)).then(function (body) { return body.entries || []; });
    req.then(function (entries) {
      state.entries = entries || [];
      renderFolders(state.entries);
      renderPhotos(state.entries);
    }).catch(function () {
      state.entries = [];
      renderFolders([]);
      renderPhotos([]);
    });
  }

  $('lightbox').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeLightbox(); });
  navigate('/');
})();
</script>
</body>
</html>
`;

export const photosApp: AppManifest = {
  id: 'photos',
  label: 'Photos',
  description: 'Browse image files from mounted sources using the shared filesystem API.',
  html: PHOTOS_HTML,
};
