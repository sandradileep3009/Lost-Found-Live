'use strict';

const HEALTH_POLL_MS   = 2500;
const MAX_ALERT_ROWS   = 200;   // an evening's worth of alerts must not grow the DOM without bound
const SEARCH_K         = 24;
const ITEMS_PAGE       = 24;
const STALE_TILE_S     = 6;     // tile shows "no frames" — the health strip stays the authority

const ZONE_COLOUR = {
  corridor: '#c05a4e',
  queue:    '#b8873f',
  deposit:  '#5f9068',
  transit:  '#5b7fa6',
  exclude:  '#616a72'
};
function zoneColour(t) { return ZONE_COLOUR[t] || ZONE_COLOUR.exclude; }


const el = (id) => document.getElementById(id);

let cameras = [];
const tiles  = new Map();   // cam_id -> Tile
const hcells = new Map();   // cam_id -> {root, ...}

let alerts = [];            // newest first, capped
const alertRows = new Map();// id -> element
let hideHandled = false;

let healthAt = 0;           // performance.now() of last health payload
let healthCams = new Map(); // cam_id -> health row

let itemsOffset = 0, itemsTotal = 0, mode = 'items', currentQuery = '';
let searchTimer = null, buildingTimer = null;


boot();

async function boot() {
  try {
    cameras = await API.get('/api/cameras');
  } catch (e) {
    el('grid').innerHTML = '<div class="empty">Cannot reach the backend at ' + API.base +
      '.<br>Start the mock with <code>tools/mock_api.py</code> on port 8101, ' +
      'or pass a different host with <code>?api=http://host:8101</code>.</div>';
    backendOk = false; paintConn();
    return;
  }

  buildGrid();
  buildHealth();
  buildSweepPicker();

  pollHealth();
  setInterval(pollHealth, HEALTH_POLL_MS);
  setInterval(tick, 1000);

  loadAlertHistory();
  openAlertSocket();
  loadItems(0);
  wireUI();
}


function buildGrid() {
  const grid = el('grid');
  const n = cameras.length;
  grid.dataset.cols = n <= 1 ? '1' : (n <= 4 ? '2' : '3');
  grid.innerHTML = '';
  cameras.forEach((cam) => {
    const t = new Tile(cam);
    tiles.set(cam.cam_id, t);
    grid.appendChild(t.root);
    t.start();
  });
}

class Tile {
  constructor(cam) {
    this.cam = cam;
    this.lastFrame = 0;

    const root = document.createElement('div');
    root.className = 'tile';
    root.innerHTML =
      '<div class="tile-head">' +
        '<span class="tile-id"></span>' +
        '<span class="tile-label"></span>' +
        '<span class="tile-state"></span>' +
      '</div>' +
      '<div class="tile-body"><canvas></canvas><div class="tile-empty"></div></div>';

    root.querySelector('.tile-id').textContent = cam.cam_id;
    root.querySelector('.tile-label').textContent = cam.label || '';

    this.root   = root;
    this.state  = root.querySelector('.tile-state');
    this.canvas = root.querySelector('canvas');
    this.ctx    = this.canvas.getContext('2d');
    this.empty  = root.querySelector('.tile-empty');

    this.canvas.width = 960;
    this.canvas.height = 540;
  }

  setState(text, kind) {
    this.state.textContent = text;
    this.state.dataset.state = kind;
  }

  showOverlay(text) {
    this.empty.textContent = text;
    this.empty.hidden = !text;
  }

  start() {
    if (this.cam.enabled === false) {
      this.setState('disabled', 'down');
      this.showOverlay('Disabled in configuration — no stream expected');
      return;
    }
    this.setState('connecting', '');
    this.showOverlay('Waiting for first frame');

    this.sock = new ReconnectingSocket(API.ws('/ws/frames/' + this.cam.cam_id), {
      binaryType: 'blob',
      onmessage: (ev) => this.onFrame(ev.data),
      onstate: (s) => {
        if (s === 'open') this.setState('live', 'live');
        else if (s === 'unknown') { this.setState('unknown camera', 'down'); this.showOverlay('Backend does not know this camera id'); }
        else if (s === 'connecting') this.setState('connecting', '');
        else { this.setState('reconnecting', 'stale'); this.showOverlay('Stream dropped — reconnecting'); }
      }
    });
    this.sock.open();
  }

  async onFrame(blob) {
    this.lastFrame = performance.now();
    // Don't decode frames nobody is looking at; the socket stays open.
    if (document.hidden) return;

    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch (e) {
      return;
    }
    if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
      this.canvas.width = bmp.width;
      this.canvas.height = bmp.height;
    }
    this.ctx.drawImage(bmp, 0, 0);
    bmp.close();                      // retained ImageBitmaps are how these dashboards die

    drawZones(this.ctx, this.cam, this.canvas);
    this.showOverlay('');
    if (this.state.dataset.state !== 'live') this.setState('live', 'live');
  }

  tick() {
    if (this.cam.enabled === false || !this.sock) return;
    if (!this.lastFrame) return;
    const age = (performance.now() - this.lastFrame) / 1000;
    if (age > STALE_TILE_S && this.state.dataset.state === 'live') {
      this.setState('no frames', 'stale');
    }
  }

  destroy() { if (this.sock) this.sock.close(); }
}

function drawZones(ctx, cam, canvas) {
  const src = cam.frame_size || [cam.width, cam.height];
  if (!src || !src[0] || !src[1]) return;

  const sx = canvas.width / src[0];
  const sy = canvas.height / src[1];
  const zones = cam.zones || [];

  for (const zone of zones) {
    const pts = (zone.polygon || []).map(([x, y]) => [x * sx, y * sy]);
    if (pts.length < 3) continue;

    const colour = zoneColour(zone.type);

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();

    ctx.fillStyle = colour + (zone.type === 'exclude' ? '1f' : '2e');
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, canvas.width / 640);
    ctx.strokeStyle = colour;
    ctx.stroke();

    // label at the centroid
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;

    const size = Math.max(11, Math.round(canvas.width / 62));
    ctx.font = '500 ' + size + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeText(zone.name, cx, cy);
    ctx.fillStyle = '#f4f6f7';
    ctx.fillText(zone.name, cx, cy);
  }
}


function buildHealth() {
  const strip = el('health');
  strip.innerHTML = '';
  cameras.forEach((cam) => {
    const cell = document.createElement('div');
    cell.className = 'hcell';
    cell.dataset.status = 'off';
    cell.innerHTML =
      '<div class="hcell-top"><span class="hcell-id"></span><span class="hcell-label"></span></div>' +
      '<div class="hcell-metrics">' +
        '<span><i>fps</i> <b class="fps">—</b></span>' +
        '<span><i>age</i> <b class="age">—</b></span>' +
        '<span><i>restarts</i> <b class="rs">—</b></span>' +
      '</div>' +
      '<div class="hcell-err"></div>';
    cell.querySelector('.hcell-id').textContent = cam.cam_id;
    cell.querySelector('.hcell-label').textContent =
      cam.enabled === false ? 'disabled in config' : (cam.label || '');
    strip.appendChild(cell);
    hcells.set(cam.cam_id, {
      root: cell,
      fps: cell.querySelector('.fps'),
      age: cell.querySelector('.age'),
      rs:  cell.querySelector('.rs'),
      err: cell.querySelector('.hcell-err')
    });
  });
}

async function pollHealth() {
  let h;
  try {
    h = await API.get('/api/health');
  } catch (e) {
    backendOk = false; paintConn();
    return;
  }
  backendOk = true; paintConn();

  API.setServerTime(h.server_time);
  healthAt = performance.now();
  healthCams = new Map((h.cameras || []).map((c) => [c.cam_id, c]));

  el('stat-indexed').textContent = h.items_indexed != null ? h.items_indexed : '—';
  el('stat-unacked').textContent = h.alerts_unacked != null ? h.alerts_unacked : '—';
  el('stat-uptime').textContent  = fmt.dur(h.uptime_s);

  for (const [id, cell] of hcells) {
    const c = healthCams.get(id);
    if (!c) { cell.root.dataset.status = 'off'; continue; }
    cell.root.dataset.status = c.status || 'off';   // server decides, we never recompute
    cell.fps.textContent = fmt.num(c.fps_avg, 1);
    cell.rs.textContent  = c.restarts != null ? c.restarts : '—';   // restarts are normal; a climbing count is not
    cell.err.textContent = c.last_error || '';
  }
  renderAges();
}

/* Ages tick between polls off a monotonic clock, so a skewed laptop clock
   can't make every camera look dead. */
function renderAges() {
  const since = (performance.now() - healthAt) / 1000;
  for (const [id, cell] of hcells) {
    const c = healthCams.get(id);
    if (!c) { cell.age.textContent = '—'; continue; }
    cell.age.textContent = fmt.dur((c.last_frame_age_s || 0) + since);
  }
}

function tick() {
  renderAges();
  for (const t of tiles.values()) t.tick();
  for (const a of alerts) {
    const row = alertRows.get(a.id);
    if (row) {
      const ago = row.querySelector('.js-ago');
      if (ago) ago.textContent = fmt.ago(a.raised_at);
    }
  }
}

/* ------------------------------------------------------------- connection */

let backendOk = false;   // /api/health answering
let wsOk = false;        // /ws/alerts open

function paintConn() {
  const c = el('conn');
  if (!backendOk)      { c.dataset.state = 'dead';       el('conn-text').textContent = 'backend unreachable'; }
  else if (!wsOk)      { c.dataset.state = 'connecting'; el('conn-text').textContent = 'alerts reconnecting'; }
  else                 { c.dataset.state = 'up';         el('conn-text').textContent = 'live'; }
}

/* alerts feed */

async function loadAlertHistory() {
  try {
    const rows = await API.get('/api/alerts?unacked_only=false&limit=100');
    rows.sort((a, b) => b.raised_at - a.raised_at);
    alerts = rows;
    alertRows.clear();
    el('alerts').querySelectorAll('.alert').forEach((n) => n.remove());
    for (const a of alerts) el('alerts').appendChild(alertRow(a));
    refreshAlertChrome();
  } catch (e) {  }
}

function openAlertSocket() {
  const sock = new ReconnectingSocket(API.ws('/ws/alerts'), {
    binaryType: 'blob',
    onmessage: (ev) => {
      let a;
      try { a = JSON.parse(ev.data); } catch (e) { return; }
      addAlert(a);
    },
    onstate: (s) => { wsOk = (s === 'open'); paintConn(); }
  });
  sock.open();
}

function addAlert(a) {
  if (alertRows.has(a.id)) return;
  alerts.unshift(a);
  el('alerts').insertBefore(alertRow(a), el('alerts').firstChild);

  while (alerts.length > MAX_ALERT_ROWS) {
    const old = alerts.pop();
    const row = alertRows.get(old.id);
    if (row) row.remove();
    alertRows.delete(old.id);
  }
  refreshAlertChrome();
}

function alertRow(a) {
  const row = document.createElement('article');
  row.className = 'alert';
  row.dataset.zone = a.zone_type || 'corridor';
  row.dataset.acked = a.ack_at ? 'true' : 'false';

  const thumb = a.crop_url
    ? '<a href="' + API.url(a.crop_url) + '" target="_blank" rel="noopener">' +
      '<img class="alert-thumb" alt="" src="' + API.url(a.crop_url) + '"></a>'
    : '<div class="thumb-none">no crop</div>';

  row.innerHTML =
    thumb +
    '<div class="alert-main">' +
      '<b></b>' +
      '<div class="alert-meta"></div>' +
      '<div class="alert-note js-note"></div>' +
    '</div>' +
    '<button class="alert-ack">Acknowledge</button>';

  row.querySelector('b').textContent = (a.cls || 'Object') + ' in ' + (a.zone_name || 'zone');
  row.querySelector('.alert-meta').innerHTML =
    (a.cam_id || '') + ' · static ' + fmt.dur(a.static_for_s) +
    ' · <span class="js-ago">' + fmt.ago(a.raised_at) + '</span>';

  const btn = row.querySelector('.alert-ack');
  btn.addEventListener('click', () => ack(a, row, btn));
  paintAck(a, row);

  alertRows.set(a.id, row);
  return row;
}

function paintAck(a, row) {
  const btn = row.querySelector('.alert-ack');
  const note = row.querySelector('.js-note');
  if (a.ack_at) {
    row.dataset.acked = 'true';
    btn.disabled = true;
    btn.textContent = 'Handled';
    note.textContent = 'Handled by ' + (a.ack_by || 'someone') + ', ' + fmt.ago(a.ack_at);
  } else {
    row.dataset.acked = 'false';
    btn.disabled = false;
    btn.textContent = 'Acknowledge';
    note.textContent = '';
  }
  row.hidden = hideHandled && !!a.ack_at;
}

async function ack(a, row, btn) {
  btn.disabled = true;
  btn.textContent = 'Sending';
  try {
    const updated = await API.post('/api/alerts/' + a.id + '/ack', { by: ackBy() });
    Object.assign(a, updated);
    paintAck(a, row);
  } catch (e) {
    if (e.status === 409) {
      // somebody else got there first — reconcile with the server, don't guess
      try {
        const rows = await API.get('/api/alerts?unacked_only=false&limit=100');
        const fresh = rows.find((r) => r.id === a.id);
        if (fresh) Object.assign(a, fresh);
      } catch (e2) { a.ack_at = a.ack_at || API.now(); }
      paintAck(a, row);
      row.querySelector('.js-note').textContent =
        'Already handled by ' + (a.ack_by || 'another operator');
    } else {
      btn.disabled = false;
      btn.textContent = 'Retry';
      row.querySelector('.js-note').textContent = 'Could not send: ' + e.message;
    }
  }
  refreshAlertChrome();
}

function ackBy() {
  return new URLSearchParams(location.search).get('operator') || 'demo-owner';
}

function refreshAlertChrome() {
  const open = alerts.filter((a) => !a.ack_at).length;
  el('alerts-count').textContent = open + ' open / ' + alerts.length + ' total';
  el('alerts-empty').hidden = alerts.length > 0;
}

/* search */

function wireUI() {
  const q = el('q');
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runQuery, 250);
  });
  el('q-clear').addEventListener('click', () => { q.value = ''; runQuery(); q.focus(); });

  el('page-prev').addEventListener('click', () => loadItems(Math.max(0, itemsOffset - ITEMS_PAGE)));
  el('page-next').addEventListener('click', () => loadItems(itemsOffset + ITEMS_PAGE));

  el('alerts-toggle').addEventListener('click', (e) => {
    hideHandled = !hideHandled;
    e.currentTarget.setAttribute('aria-pressed', String(hideHandled));
    e.currentTarget.textContent = hideHandled ? 'Show handled' : 'Hide handled';
    for (const a of alerts) {
      const row = alertRows.get(a.id);
      if (row) row.hidden = hideHandled && !!a.ack_at;
    }
  });

  el('view-live').addEventListener('click', () => showView('live'));
  el('view-sweep').addEventListener('click', () => showView('sweep'));
  el('sweep-run').addEventListener('click', runSweep);
  el('sweep-print').addEventListener('click', () => window.print());

  // ack the top open alert with "a" — confirm on the day whether the operator wants this
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'a' || ev.metaKey || ev.ctrlKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const next = alerts.find((a) => !a.ack_at);
    if (next) alertRows.get(next.id).querySelector('.alert-ack').click();
  });
}

function runQuery() {
  clearTimeout(buildingTimer);
  const q = el('q').value.trim();
  currentQuery = q;
  if (!q) { mode = 'items'; loadItems(0); return; }
  mode = 'search';
  doSearch(q);
}

async function doSearch(q) {
  let r;
  try {
    r = await API.get('/api/search?q=' + encodeURIComponent(q) + '&k=' + SEARCH_K);
  } catch (e) {
    el('results').innerHTML = '<div class="empty">Search failed: ' + e.message + '</div>';
    return;
  }
  if (currentQuery !== q) return;  
  el('pager').hidden = true;

  if (r.index_ready === false) {
    el('search-count').textContent = '';
    el('results').innerHTML =
      '<div class="building"><b>Search index still building</b>' +
      'The index is not ready yet, so this is not a result. Retrying automatically.</div>';
    buildingTimer = setTimeout(() => doSearch(q), 2500);
    return;
  }

  const results = r.results || [];
  el('search-count').textContent = results.length + ' results · ' + fmt.num(r.took_ms, 1) + ' ms';

  if (!results.length) {
    el('results').innerHTML =
      '<div class="empty">Nothing matched “' + escapeHtml(q) + '”. ' +
      'Try a different description — colour plus object usually works best.</div>';
    return;
  }
  renderResults(results.map((x) => ({ item: x.item, score: x.score })));
}

async function loadItems(offset) {
  let r;
  try {
    r = await API.get('/api/items?limit=' + ITEMS_PAGE + '&offset=' + offset);
  } catch (e) {
    el('results').innerHTML = '<div class="empty">Could not load items: ' + e.message + '</div>';
    return;
  }
  if (mode !== 'items') return;

  itemsOffset = r.offset || 0;
  itemsTotal = r.total || 0;
  const items = r.items || [];

  el('search-count').textContent = itemsTotal + ' indexed';
  if (!items.length) {
    el('results').innerHTML = '<div class="empty">No items indexed yet.</div>';
    el('pager').hidden = true;
    return;
  }
  renderResults(items.map((it) => ({ item: it, score: null })));

  el('pager').hidden = false;
  el('page-prev').disabled = itemsOffset <= 0;
  el('page-next').disabled = itemsOffset + ITEMS_PAGE >= itemsTotal;
  el('page-info').textContent =
    (itemsOffset + 1) + '–' + Math.min(itemsOffset + ITEMS_PAGE, itemsTotal) + ' of ' + itemsTotal;
}

function renderResults(rows) {
  const box = el('results');
  const frag = document.createDocumentFragment();
  const grid = document.createElement('div');
  grid.className = 'results';

  for (const row of rows) {
    const it = row.item || {};
    const card = document.createElement('div');
    card.className = 'result';

    const crop = it.crop_url ? API.url(it.crop_url) : null;
    const thumb = crop
      ? '<a href="' + crop + '" target="_blank" rel="noopener"><img loading="lazy" alt="" src="' + crop + '"></a>'
      : '<div class="thumb-ph">no crop stored</div>';

    const score = row.score == null ? '' :
      '<span class="score">' + fmt.num(row.score, 2) + '</span>';

    card.innerHTML =
      thumb +
      '<div class="result-meta"><span></span>' + score + '</div>' +
      '<div class="scorebar"' + (row.score == null ? ' hidden' : '') + '><i></i></div>' +
      '<div class="result-zone" style="--sw:' + zoneColour(it.zone_type) + '">' +
        '<span class="zone-chip"></span><span class="js-zone"></span></div>';

    card.querySelector('.result-meta span').textContent = (it.cls || 'item') + ' · ' + (it.cam_id || '');
    card.querySelector('.js-zone').textContent =
      (it.zone_name || 'unzoned') + ' · ' + (it.state || '');
    if (row.score != null) {
      card.querySelector('.scorebar i').style.width =
        Math.round(Math.max(0, Math.min(1, row.score)) * 100) + '%';
    }
    grid.appendChild(card);
  }

  frag.appendChild(grid);
  box.replaceChildren(frag);   // replace, never append — the DOM must not grow with use
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* sweep */

function showView(v) {
  const live = v === 'live';
  el('view-main').hidden = !live;
  el('view-sweep-panel').hidden = live;
  el('view-live').setAttribute('aria-pressed', String(live));
  el('view-sweep').setAttribute('aria-pressed', String(!live));
}

function buildSweepPicker() {
  const sel = el('sweep-cam');
  sel.innerHTML = '';
  cameras.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.cam_id;
    o.textContent = c.cam_id + ' — ' + (c.label || '');
    sel.appendChild(o);
  });
}

async function runSweep() {
  const cam = el('sweep-cam').value;
  const btn = el('sweep-run');
  btn.disabled = true;
  btn.textContent = 'Sweeping';
  el('sweep-out').innerHTML = '<div class="empty">Running a tiled high-resolution pass over ' + cam + '…</div>';

  let r;
  try {
    r = await API.post('/api/sweep/' + cam, {});
  } catch (e) {
    el('sweep-out').innerHTML = '<div class="empty">Sweep failed: ' + escapeHtml(e.message) + '</div>';
    btn.disabled = false; btn.textContent = 'Run sweep';
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Run sweep';
  renderSweep(r, cam);
}

function renderSweep(r, cam) {
  // field names vary; schemas.py is the source of truth if this disagrees
  const before = r.before_url || r.before_image || r.before || null;
  const after  = r.after_url  || r.after_image  || r.after  || null;
  const found  = r.detections || r.items || r.found || [];

  const out = el('sweep-out');
  out.innerHTML =
    '<div class="sweep-pair">' +
      '<figure><figcaption>Before — during the event</figcaption>' +
        (before ? '<img alt="scene before the sweep" src="' + API.url(before) + '">' : '<div class="empty">no image returned</div>') +
      '</figure>' +
      '<figure><figcaption>After — venue empty, occlusion gone</figcaption>' +
        (after ? '<img alt="scene after the sweep, items numbered" src="' + API.url(after) + '">' : '<div class="empty">no image returned</div>') +
      '</figure>' +
    '</div>' +
    '<div class="sweep-list"><h2>' + found.length + ' items left behind on ' + escapeHtml(cam) + '</h2>' +
      '<table><thead><tr><th>#</th><th>Item</th><th>Where</th></tr></thead><tbody></tbody></table></div>';

  const tb = out.querySelector('tbody');
  found.forEach((d, i) => {
    const tr = document.createElement('tr');
    const n = d.n || d.number || (i + 1);
    tr.innerHTML = '<td class="n"></td><td></td><td></td>';
    tr.children[0].textContent = n;
    tr.children[1].textContent = d.cls || d.label || 'object';
    tr.children[2].textContent = d.zone_name || d.zone || (d.bbox ? 'bbox ' + d.bbox.join(', ') : '—');
    tb.appendChild(tr);
  });

  el('sweep-print').disabled = found.length === 0;
}
