'use strict';
const API = (function () {
  const FALLBACK = 'http://localhost:8101';
  const override = new URLSearchParams(location.search).get('api');

  let base;
  if (override) base = override;
  else if (location.protocol === 'http:' || location.protocol === 'https:') base = location.origin;
  else base = FALLBACK;
  base = base.replace(/\/+$/, '');

  const wsBase = base.replace(/^http/, 'ws');

  let clockOffset = 0;

  async function req(path, opts) {
    const res = await fetch(base + path, opts);
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.detail || j.message || ''; } catch (e) { /* no body */ }
      const err = new Error(detail || (res.status + ' ' + res.statusText));
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    base: base,
    get: function (path) { return req(path); },
    post: function (path, body) {
      return req(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    },
    url: function (path) {
      if (!path) return null;
      return /^https?:\/\//.test(path) ? path : base + path;
    },
    ws: function (path) { return wsBase + path; },
    setServerTime: function (t) { if (typeof t === 'number') clockOffset = t - Date.now() / 1000; },
    now: function () { return Date.now() / 1000 + clockOffset; }
  };
})();

const fmt = {
  dur: function (s) {
    if (s == null || isNaN(s)) return '—';
    s = Math.max(0, s);
    if (s < 10) return s.toFixed(1) + 's';
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + String(Math.round(s % 60)).padStart(2, '0') + 's';
    return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
  },
  ago: function (ts) {
    if (!ts) return '—';
    return fmt.dur(API.now() - ts) + ' ago';
  },
  num: function (n, d) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(d == null ? 1 : d);
  }
};

function ReconnectingSocket(url, opts) {
  opts = opts || {};
  this.url = url;
  this.binaryType = opts.binaryType || 'blob';
  this.onmessage = opts.onmessage || function () {};
  this.onstate = opts.onstate || function () {};
  this.delay = 2000;
  this.maxDelay = 30000;
  this.stopped = false;
  this.ws = null;
  this.timer = null;
}

ReconnectingSocket.prototype.open = function () {
  if (this.stopped) return;
  this.onstate('connecting');
  let ws;
  try {
    ws = new WebSocket(this.url);
  } catch (e) {
    return this.retry();
  }
  ws.binaryType = this.binaryType;
  this.ws = ws;

  ws.onopen = function () {
    this.delay = 2000;
    this.onstate('open');
  }.bind(this);

  ws.onmessage = function (ev) { this.onmessage(ev); }.bind(this);

  ws.onclose = function (ev) {
    this.ws = null;
    if (this.stopped) return;
    if (ev && ev.code === 4404) {          
      this.stopped = true;
      this.onstate('unknown');
      return;
    }
    this.onstate('closed');
    this.retry();
  }.bind(this);

  ws.onerror = function () { try { ws.close(); } catch (e) {} };
};

ReconnectingSocket.prototype.retry = function () {
  clearTimeout(this.timer);
  this.timer = setTimeout(this.open.bind(this), this.delay);
  this.delay = Math.min(this.delay * 2, this.maxDelay);
};

ReconnectingSocket.prototype.close = function () {
  this.stopped = true;
  clearTimeout(this.timer);
  if (this.ws) { try { this.ws.close(); } catch (e) {} }
  this.ws = null;
};
