'use strict';

/* Edit these two lists to match the venue before the day. */
const CATEGORIES = ['phone', 'wallet', 'keys', 'bag', 'documents', 'clothing', 'water bottle', 'other'];
const COLOURS    = ['black', 'blue', 'red', 'green', 'brown', 'white', 'grey', 'multicolour'];
const LOCATIONS  = ['north gate', 'south gate', 'main stair', 'lawn seating', 'queue lane 1',
                    'queue lane 2', 'parking', 'help desk', 'elsewhere'];

const el = (id) => document.getElementById(id);

let category = null, colour = null, photoDataUrl = null;

buildChips('categories', CATEGORIES, (v) => {
  category = v;
  el('category-other').hidden = v !== 'other';
});
buildChips('colours', COLOURS, (v) => { colour = v; });

LOCATIONS.forEach((l) => {
  const o = document.createElement('option');
  o.value = l; o.textContent = l;
  el('location').appendChild(o);
});

function buildChips(hostId, values, onPick) {
  const host = el(hostId);
  values.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = v;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      host.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onPick(v);
    });
    host.appendChild(b);
  });
}

/* ------------------------------------------------------------------ photo */

el('photo-btn').addEventListener('click', () => el('photo').click());
el('photo').addEventListener('change', (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    photoDataUrl = r.result;
    const img = el('preview');
    img.src = photoDataUrl;
    img.hidden = false;
    el('photo-clear').hidden = false;
    el('photo-btn').textContent = 'Retake';
  };
  r.readAsDataURL(f);
});
el('photo-clear').addEventListener('click', clearPhoto);

function clearPhoto() {
  photoDataUrl = null;
  el('photo').value = '';
  el('preview').hidden = true;
  el('preview').removeAttribute('src');
  el('photo-clear').hidden = true;
  el('photo-btn').textContent = 'Take photo';
}

/* ----------------------------------------------------------------- submit */

el('save').addEventListener('click', save);

async function save() {
  const cat = category === 'other' ? (el('category-other').value.trim() || 'other') : category;
  if (!cat) return say('Pick what the item is first.', 'error');

  const body = {
    category: cat,
    colour: colour || '',
    description: el('description').value.trim(),
    location: el('location').value,
    contact: el('contact').value.trim(),
    handed_in_at: API.now(),
    photo_url: null      // no upload endpoint in the contract yet — the photo stays on this device
  };

  const btn = el('save');
  btn.disabled = true;
  btn.textContent = 'Saving';
  try {
    await API.post('/api/handin', body);
    say('Logged ' + cat + ' at ' + body.location + '.');
    reset();
    loadRecent();
  } catch (e) {
    say('Not saved: ' + e.message + '. Try again.', 'error');
  }
  btn.disabled = false;
  btn.textContent = 'Log this item';
}

function reset() {
  category = null; colour = null;
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  el('category-other').hidden = true;
  el('category-other').value = '';
  el('description').value = '';
  el('contact').value = '';
  clearPhoto();
  window.scrollTo({ top: 0 });
}

function say(msg, kind) {
  const s = el('status');
  s.textContent = msg;
  s.dataset.kind = kind || 'ok';
}

/* ----------------------------------------------------------------- recent */

loadRecent();

async function loadRecent() {
  let rows;
  try {
    rows = await API.get('/api/handin');
  } catch (e) {
    el('recent').innerHTML = '<div class="empty">Cannot reach the backend at ' + API.base + '.</div>';
    return;
  }
  if (Array.isArray(rows.items)) rows = rows.items;
  if (!Array.isArray(rows) || !rows.length) {
    el('recent').innerHTML = '<div class="empty">Nothing logged yet.</div>';
    return;
  }
  rows.sort((a, b) => (b.handed_in_at || 0) - (a.handed_in_at || 0));

  const host = document.createElement('div');
  rows.slice(0, 25).forEach((r) => {
    const div = document.createElement('div');
    div.className = 'recent-row';
    div.innerHTML = '<div class="js-title"></div><div class="meta js-meta"></div>';
    div.querySelector('.js-title').textContent =
      [r.colour, r.category].filter(Boolean).join(' ') + (r.description ? ' — ' + r.description : '');
    div.querySelector('.js-meta').textContent =
      (r.location || 'unknown') + ' · ' + fmt.ago(r.handed_in_at);
    host.appendChild(div);
  });
  el('recent').replaceChildren(host);
}
