/* global L, DATA_URL */
(() => {
  const DEFAULT_VIEW = [20, 0];
  const DEFAULT_ZOOM = 2;
  const status = document.querySelector('#status');
  const map = L.map('map', { zoomControl: false, preferCanvas: true, zoomSnap: 0 }).setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
  }).addTo(map);

  const mapActions = L.control({ position: 'topright' });
  mapActions.onAdd = () => {
    const container = L.DomUtil.create('div', 'leaflet-bar atlas-map-actions');
    const addButton = (label, tooltip, icon, action) => {
      const button = L.DomUtil.create('a', '', container);
      button.href = '#';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.dataset.tooltip = tooltip;
      button.textContent = icon;
      L.DomEvent.on(button, 'click', L.DomEvent.stop)
        .on(button, 'click', action);
    };
    addButton('Toggle fullscreen', 'Enter or exit fullscreen', '⛶', () => {
      const fullscreenTarget = map.getContainer();
      const request = document.fullscreenElement ? document.exitFullscreen() : fullscreenTarget.requestFullscreen();
      request?.catch(error => console.warn('Fullscreen is unavailable.', error));
    });
    addButton('Reset map view', 'Reset map to the world view', '↺', () => map.setView(DEFAULT_VIEW, DEFAULT_ZOOM));
    return container;
  };
  mapActions.addTo(map);
  document.addEventListener('fullscreenchange', () => map.invalidateSize());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') map.setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  });

  const markers = L.layerGroup().addTo(map);

  // Kept separate from the map layer so future UI filters can re-render markers only.
  let archive = [];
  let countryGroups = new Map();
  let renderToken = 0;
  const normalizeKey = (key) => String(key || '').trim().toLowerCase();
  const FIELD_ALIASES = {
    thumbnailurl: 'thumbnail',
    imageurl: 'image',
    datetaken: 'date',
    closestsong: 'song',
    mapslink: 'maps'
  };
  const canonicalKey = (key) => FIELD_ALIASES[normalizeKey(key)] || normalizeKey(key);
  const normalizeRow = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [canonicalKey(key), value]));
  const validCoordinate = (value, min, max) => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const formatDate = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const dateText = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
    const timeText = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
    return `${dateText} at ${timeText}`;
  };
  const dateTimestamp = (value) => {
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
  };

  function parseCsv(text) {
    const lines = []; let row = []; let field = ''; let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c === '"') { if (quoted && text[i + 1] === '"') { field += c; i += 1; } else quoted = !quoted; }
      else if (c === ',' && !quoted) { row.push(field); field = ''; }
      else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i += 1; row.push(field); if (row.some(cell => cell.trim())) lines.push(row); row = []; field = ''; }
      else field += c;
    }
    row.push(field); if (row.some(cell => cell.trim())) lines.push(row);
    const [headers = [], ...records] = lines;
    return records.map(record => Object.fromEntries(headers.map((header, index) => [canonicalKey(header), (record[index] || '').trim()])));
  }

  async function getRows(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`The data source returned ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    const payload = await response.text();
    if (type.includes('json') || /^[\s\[{]/.test(payload)) {
      const json = JSON.parse(payload);
      return Array.isArray(json) ? json : (json.data || json.rows || []);
    }
    return parseCsv(payload);
  }

  function popupContent(item) {
    const place = [item.city, item.state, item.country].filter(Boolean).map(escapeHtml).join(', ') || 'Untitled location';
    const details = [['Camera', item.camera]].filter(([, value]) => value);
    return `<article class="popup-card">${item.image || item.thumbnail ? `<img class="popup-photo" src="${escapeHtml(item.image || item.thumbnail)}" alt="" loading="lazy">` : ''}<div class="popup-body">${item.date ? `<p class="popup-date">${escapeHtml(formatDate(item.date))}</p>` : ''}<h2 class="popup-place">${place}</h2>${details.length ? `<dl class="popup-meta">${details.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}</div></article>`;
  }

  function photoIcon(item, ratio = item.previewRatio || 1) {
    const thumbnail = item.thumbnail || item.image;
    const height = 40;
    const width = Math.round(Math.max(24, Math.min(64, height * ratio)));
    return L.divIcon({ className: 'photo-marker', html: `<span class="photo-marker__frame" style="width:${width}px;height:${height}px"><img class="photo-marker__image" src="${escapeHtml(thumbnail)}" alt="" loading="lazy" style="width:${width}px;height:${height}px"><span class="photo-marker__shine" aria-hidden="true"></span></span>`, iconSize: [width, height], iconAnchor: [width / 2, height / 2], popupAnchor: [0, -21] });
  }

  function keepPopupInView(marker) {
    const popup = marker.getPopup();
    popup.update();
    window.requestAnimationFrame(() => {
      const popupElement = popup.getElement();
      if (!popupElement) return;
      const mapRect = map.getContainer().getBoundingClientRect();
      const popupRect = popupElement.getBoundingClientRect();
      const padding = 12;
      const topOverflow = (mapRect.top + padding) - popupRect.top;
      const bottomOverflow = popupRect.bottom - (mapRect.bottom - padding);
      const offset = topOverflow > 0 ? -topOverflow : (bottomOverflow > 0 ? bottomOverflow : 0);
      if (offset) map.panBy([0, offset], { animate: true, duration: 0.25 });
    });
  }

  function makeMarker(item) {
    const icon = photoIcon(item);
    const marker = L.marker([Number(item.latitude), Number(item.longitude)], { icon, keyboard: true, title: [item.countryflag, item.city, item.country].filter(Boolean).join(' ') || 'Film photograph', item });
    marker.on('add', () => {
      const image = marker.getElement()?.querySelector('.photo-marker__image');
      const updateAspect = () => {
        if (!image?.naturalWidth || !image.naturalHeight || item.previewRatio) return;
        item.previewRatio = image.naturalWidth / image.naturalHeight;
        marker.setIcon(photoIcon(item));
      };
      if (image?.complete) updateAspect(); else image?.addEventListener('load', updateAspect, { once: true });
    });
    marker.bindPopup(popupContent(item), { maxWidth: 300, minWidth: 250, closeButton: true, keepInView: true });
    if (item.countryflag) marker.bindTooltip(escapeHtml(item.countryflag), { className: 'country-flag-tooltip', direction: 'top', offset: [0, -22], opacity: 1 });
    marker.on('click', () => {
      const zoom = Math.max(map.getZoom() + 2, 7);
      const offset = map.getSize().y * 0.25;
      const center = map.unproject(map.project(marker.getLatLng(), zoom).subtract([0, offset]), zoom);
      marker.closePopup();
      map.once('moveend', () => marker.openPopup());
      map.flyTo(center, zoom, { duration: 0.45 });
    });
    marker.on('mouseover', () => marker.setZIndexOffset(1000));
    marker.on('mouseout', () => { if (!marker.isPopupOpen()) marker.setZIndexOffset(0); });
    marker.on('popupopen', () => {
      marker.setZIndexOffset(1000);
      marker.getElement()?.classList.add('is-active');
      const photo = marker.getPopup().getElement()?.querySelector('.popup-photo');
      if (photo?.complete) keepPopupInView(marker); else photo?.addEventListener('load', () => keepPopupInView(marker), { once: true });
    });
    marker.on('popupclose', () => { marker.setZIndexOffset(0); marker.getElement()?.classList.remove('is-active'); });
    return marker;
  }

  function clearMarkers() {
    markers.clearLayers();
    countryGroups = new Map();
  }

  function addMarker(item) {
    const flag = item.countryflag || 'other';
    if (!countryGroups.has(flag)) {
      countryGroups.set(flag, L.layerGroup().addTo(markers));
    }
    const marker = makeMarker(item);
    countryGroups.get(flag).addLayer(marker);
  }

  function render(filter = () => true) {
    renderToken += 1;
    clearMarkers();
    const visible = archive.filter(filter);
    visible.forEach(addMarker);
    return visible;
  }

  function shineMarkers() {
    countryGroups.forEach(group => group.eachLayer(marker => {
      const element = marker.getElement();
      if (!element) return;
      element.classList.add('is-shining');
    }));
  }

  async function renderChronologically(items) {
    const token = ++renderToken;
    const ordered = [...items].sort((a, b) => dateTimestamp(a.date) - dateTimestamp(b.date));
    const delay = Math.max(18, Math.min(50, 6500 / ordered.length));
    clearMarkers();
    for (let index = 0; index < ordered.length; index += 1) {
      if (token !== renderToken) return false;
      addMarker(ordered[index]);
      status.textContent = `Plotting ${index + 1} of ${ordered.length} photographs…`;
      await new Promise(resolve => window.setTimeout(resolve, delay));
    }
    shineMarkers();
    return true;
  }

  async function init() {
    if (!DATA_URL) { status.textContent = 'Add your public Google Sheet endpoint to config.js to load the archive.'; return; }
    try {
      const rows = await getRows(DATA_URL);
      archive = rows.map(normalizeRow)
        .filter(row => validCoordinate(row.latitude, -90, 90) && validCoordinate(row.longitude, -180, 180) && (row.thumbnail || row.image));
      if (!archive.length) { status.textContent = 'No valid photo locations were found in the sheet.'; return; }
      const bounds = L.latLngBounds(archive.map(item => [Number(item.latitude), Number(item.longitude)]));
      if (archive.length === 1) map.setView(bounds.getCenter(), 11); else map.fitBounds(bounds.pad(0.12), { maxZoom: 12 });
      const completed = await renderChronologically(archive);
      if (!completed) return;
      status.textContent = `${archive.length} photograph${archive.length === 1 ? '' : 's'} mapped`;
      window.FilmAtlas = { filter: predicate => render(predicate), clearFilter: () => render(), data: () => [...archive] };
    } catch (error) { console.error(error); status.textContent = `Could not load the archive. ${error.message}`; }
  }
  init();
})();
