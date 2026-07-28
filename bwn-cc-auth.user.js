// ==UserScript==
// @name         BWN CC Request (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.4.1
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-cc-auth.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-cc-auth.user.js
// @description  Replaces the "CC Authorization Form" Microsoft Form with an in-page CC Request modal. Requesting a card purchase is a coordinator action (any vouched Broadway Umbrava user): fill the fields and submit; it POSTs to the broadway-internal-ops SWA proxy (x-bwn-key gated) which proves your Umbrava session token with Umbrava's own current-user API, injects your verified email as the Requester, and forwards to the HTTP-triggered Power Automate flow "CC Authorization (HTTP)". That flow starts an approval (mnajarro@, GKohlmann@, LPorzelt@) and, on approve, emails you back that the order will be placed. This script OWNS the single Credit Card entry in the shared dock tab: coordinators and leads see just "CC Request"; supervisors and above get a dropdown that also opens the Supervisor-only "Log CC Purchase" modal (provided by bwn-cc-purchase, driven over the bwn:evt bus so there is only ever one button). Opened on a work order it prefills the Tracking # and drops the client/location into the description, and defaults Supplier to whichever PO line you flipped to "Supplier" in the BWN Ops Suite. The flow's secret URL stays server-side; nothing sensitive lives in this script.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.4.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/cc-auth';
  var ROLE_URL = SWA_BASE + '/api/user-role';
  var GREEN = '#0d3d26';          // BWN Ops Suite brand green - one launcher, matches CC Purchase
  var MIN_SUPER = 3;              // supervisor - matches api/shared/umbrava-auth.js RANK.SUPERVISOR
  console.info('[BWN CC REQUEST] v' + VER + ' - coordinator CC Request modal -> SWA proxy (server vouches you + injects your email) -> Power Automate approval flow; registers the single Credit Card launcher into the shared dock (bwn:dock:*), supervisor+ chooser adds Log CC Purchase, no floating fallback button');

  // ---- BWN Ops Suite bus (read-only consumer of the suite data contract v1) ----
  // bwn-suite-core (WO Assist) PUBLISHES the current WO's facts to sessionStorage
  // key `bwn:wo:{id}`. We only READ it, so there is no coupling. Absent -> graceful blank.
  function woIdFromUrl() {
    var m = location.pathname.match(/work-orders\/(\d+)/);
    return m ? m[1] : null;
  }
  function busGet(id, maxAgeMs) {
    if (!id) return null;
    try {
      var raw = sessionStorage.getItem('bwn:wo:' + id);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d.v !== 1 || (maxAgeMs && Date.now() - d.ts > maxAgeMs)) return null;
      return d;
    } catch (e) { return null; }
  }
  // Per-WO Vendor/Supplier classification published by bwn-suite-core's PO grouping
  // (localStorage `bwn:po:cls:{id}` = {items:[{vendor,sup}]}). Absent -> [].
  function poCls(id) {
    if (!id) return [];
    try {
      var raw = localStorage.getItem('bwn:po:cls:' + id);
      if (!raw) return [];
      var d = JSON.parse(raw);
      return Array.isArray(d.items) ? d.items : [];
    } catch (e) { return []; }
  }

  // ---- Toast --------------------------------------------------------------
  function toast(msg, ms, bg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%);background:' + (bg || GREEN) + ';color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:74vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.5;';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 420); }, ms || 6000);
  }

  // ---- Who's signed in (Umbrava Auth0 session) ----------------------------
  function actor() {
    try {
      var k = Object.keys(localStorage).find(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); });
      var u = k ? ((JSON.parse(localStorage.getItem(k)) || {}).decodedToken || {}).user : null;
      return { name: (u && u.name) || '', email: (u && u.email) || '' };
    } catch (e) { return { name: '', email: '' }; }
  }

  // ---- Umbrava access token (for the server-side vouch) --------------------
  // Picked by CONTENT, not first key: the audience-keyed Auth0 cache slot transiently holds
  // NON-Umbrava tokens. Only an unexpired token whose iss is an Umbrava issuer is usable.
  // Same pattern as bwn-cc-purchase / bwn-suite-ai. The token is sent ONLY to the declared SWA
  // @connect host, in the JSON BODY (the SWA edge overwrites the Authorization header).
  function isUmbravaToken(t) {
    try {
      var p = JSON.parse(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function authToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var t = (body && body.access_token) || '';
        if (t && isUmbravaToken(t)) return t;
      }
      return '';
    } catch (e) { return ''; }
  }

  // ---- SWA POST (GM_xmlhttpRequest bypasses same-origin; @connect authorizes) ----
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 30000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  // ---- Role rank (drives dropdown-vs-single ONLY; the server is the boundary) ----
  // The launcher shows CC Request to EVERYONE (any vouched user may request). The rank only
  // decides whether the supervisor-only "Log CC Purchase" item is added to a dropdown. This is
  // UX show/hide; api/cc-purchase re-enforces supervisor+ on submit. Rank is SERVER-computed
  // (api/user-role returns rank 1 staff..5 director from the same module the endpoints use).
  // Sources, cheapest first: the live bwn:role bus event + persisted bwn:role:last record from
  // bwn-suite-ai, our own GM cache, then one direct /api/user-role fetch.
  var ROLE_TTL_MS = 6 * 3600 * 1000;
  var _rank = null;                 // number when known, null while unknown (-> single button)
  var _ccPurchaseAvail = false;     // set true when bwn-cc-purchase announces over the bus
  function meEmail() { return String((actor().email || '')).toLowerCase(); }
  function sharedRoleRank() {
    // bwn-suite-ai's persisted verdict - trusted only for the SAME signed-in user + fresh.
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) {
        var em = meEmail();
        if (em && r.email && String(r.email).toLowerCase() === em) return r.rank;
      }
    } catch (e) { }
    return null;
  }
  function cachedRank() {
    try {
      var c = JSON.parse(GM_getValue('cca_role_cache', 'null'));
      if (c && typeof c.rank === 'number' && c.ts && (Date.now() - c.ts) < ROLE_TTL_MS &&
          c.email && c.email === meEmail()) return c.rank;
    } catch (e) { }
    return null;
  }
  function fetchRank(cb) {
    var key = GM_getValue('ingest_key', '');
    var t = authToken();
    if (!key || !t) { cb(null); return; }
    gmPost(ROLE_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { token: t }, 15000)
      .then(function (r) {
        if (r.status >= 200 && r.status < 300 && r.json && r.json.ok && typeof r.json.rank === 'number') {
          try { GM_setValue('cca_role_cache', JSON.stringify({ rank: r.json.rank, tier: r.json.tier || null, role: r.json.role || null, email: String(r.json.email || '').toLowerCase(), ts: Date.now() })); } catch (e) { }
          cb(r.json.rank);
        } else cb(null);
      })
      .catch(function () { cb(null); });
  }
  function applyRank(rank) {
    if (typeof rank !== 'number') return;
    _rank = rank;
  }
  function resolveRank() {
    var r = sharedRoleRank();
    if (r == null) r = cachedRank();
    if (r != null) { applyRank(r); return; }
    fetchRank(function (fr) { if (fr != null) applyRank(fr); });
  }

  // ---- Cross-script bus: own the single launcher, drive CC Purchase --------
  // bwn-cc-purchase no longer renders its own button. It ANNOUNCES itself with
  // bwn:evt {id:'bwn:cc:register', tool:'purchase'} (on its load and in reply to our ping) and
  // opens its modal on bwn:evt {id:'bwn:cc:open', tool:'purchase'}. We ping on load + at the
  // first render so the handshake works regardless of which script loads first.
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail; if (!d) return;
    if (d.id === 'bwn:cc:register' && d.tool === 'purchase') { _ccPurchaseAvail = true; }
    if (d.id === 'bwn:role' && typeof d.rank === 'number') applyRank(d.rank);   // live sign-in changes
    // Shared launcher dock ([[bwn-launcher-dock]]): bwn-suite-core's Launcher hosts it.
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') onDockHost();
    if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) openCc();
    // Another tool took the drawer slot - close ours (a half-filled form is dropped,
    // same as the old modal's Escape).
    if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) closeModal();
  });
  function pingCcPurchase() { try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:cc:ping' } })); } catch (e) { } }
  function openCcPurchase() { try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:cc:open', tool: 'purchase' } })); } catch (e) { } }

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // We OWN the CC launcher, so in the dock we register ONE entry ('cc') and keep
  // our internal bwn:cc:* request/purchase split behind the centered chooser below
  // (the dock never learns about it). detail.key carries the entry id (detail.id is
  // the bwn:evt event name). If no host announces within a few seconds of load we
  // fall back to the old self-drawn floating button so CC is never stranded.
  var DOCK_KEY = 'cc';
  var _hostSeen = false;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'CC Request', icon: '🧾', weight: 10,
        title: 'Request a credit card purchase'
      } }));
    } catch (e) { }
  }
  function onDockHost() {
    _hostSeen = true;
    dockRegister();
  }
  function showDropdown() { return (typeof _rank === 'number' && _rank >= MIN_SUPER && _ccPurchaseAvail); }
  function openCc() { if (showDropdown()) openCcChooser(); else buildModal(); }
  // Supervisors+ with CC Purchase present pick request-vs-purchase here (the dock owns
  // only the launcher button, so the two-way split can't live on an anchored dropdown).
  function openCcChooser() {
    if (document.getElementById('bwn-cc-chooser')) return;
    var back = document.createElement('div');
    back.id = 'bwn-cc-chooser';
    back.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;';
    function close() { back.remove(); document.removeEventListener('keydown', onK, true); }
    function onK(e) { if (e.key === 'Escape') close(); }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden;min-width:260px;font:400 14px ' + FONT + ';';
    var hd = document.createElement('div');
    hd.textContent = 'Credit Card';
    hd.style.cssText = 'background:' + GREEN + ';color:#fff;padding:13px 16px;font-weight:600;';
    card.appendChild(hd);
    [
      { label: '🧾  New CC Request', fn: function () { close(); buildModal(); } },
      { label: '💳  Log CC Purchase', fn: function () { close(); openCcPurchase(); } }
    ].forEach(function (it, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = it.label;
      b.style.cssText = 'display:block;width:100%;text-align:left;background:#fff;border:none;' + (i ? 'border-top:1px solid #eef2ef;' : '') + 'padding:14px 18px;font:600 13px ' + FONT + ';color:#12241b;cursor:pointer;';
      b.addEventListener('mouseenter', function () { b.style.background = '#f2f7f4'; });
      b.addEventListener('mouseleave', function () { b.style.background = '#fff'; });
      b.addEventListener('click', it.fn);
      card.appendChild(b);
    });
    back.appendChild(card);
    document.body.appendChild(back);
    document.addEventListener('keydown', onK, true);
  }

  // ---- Field spec (order = modal layout). Mirrors the flow's body ----------
  // key = the JSON prop the flow / proxy expect (RequesterEmail is injected server-side).
  var FIELDS = [
    { key: 'Date', label: 'Date Ordered / Requested', type: 'date', required: true },
    { key: 'Tracking', label: 'Work Order / Tracking #', type: 'text', required: true, ph: 'digits only, e.g. 371126' },
    { key: 'SupplierName', label: 'Supplier Name', type: 'text', required: true, list: true, ph: 'Vendor / merchant / store' },
    { key: 'LineItemDescription', label: 'Line Item Description', type: 'textarea', required: true, ph: 'What needs to be purchased' },
    { key: 'TotalCost', label: 'Total Cost', type: 'money', required: true, ph: '0.00' },
    { key: 'PurchaseLink', label: 'Link for Purchase', type: 'url', ph: 'https:// (optional)' },
    { key: 'ShippingAddress', label: 'Shipping Address', type: 'textarea', ph: 'Where it ships (optional)' }
  ];

  function todayISO() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function cleanMoney(v) { return String(v || '').replace(/[^0-9.\-]/g, ''); }

  var openEl = null;

  function closeModal() { if (openEl) { openEl.remove(); openEl = null; document.removeEventListener('keydown', onKey); } }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  function buildModal() {
    if (openEl) return;   // one at a time
    var me = actor();

    // Current WO context from the suite bus (may be null - degrade gracefully).
    var woId = woIdFromUrl();
    var bus = busGet(woId, 12 * 3600000);
    var cls = poCls(woId);   // [{vendor, sup}] from Core's PO grouping (if the user opened the PO list)

    // Supplier suggestion order: lines flipped to "Supplier" first, then the WO's other vendors.
    var busVendorNames = (bus && Array.isArray(bus.pos))
      ? bus.pos.map(function (p) { return (p && p.vendor) ? String(p.vendor).trim() : ''; }).filter(Boolean)
      : [];
    var suppliers = cls.filter(function (c) { return c && c.sup && c.vendor; }).map(function (c) { return c.vendor; });
    var nonSuppliers = cls.filter(function (c) { return c && !c.sup && c.vendor; }).map(function (c) { return c.vendor; });
    var woVendors = [];
    suppliers.concat(nonSuppliers).concat(busVendorNames).forEach(function (v) { if (v && woVendors.indexOf(v) === -1) woVendors.push(v); });
    var flippedSupplier = (suppliers.length === 1) ? suppliers[0] : '';

    // Suite drawer: slides out from the dock rail, styled by Core's page-wide sheet so
    // every tool looks the same when you click into it.
    var back = document.createElement('aside');
    back.id = 'bwn-drawer-cc'; back.className = 'bwn-drawer';
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-label', 'New CC Request');
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }

    var card = document.createElement('div');
    card.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;color:#12241b;font:400 14px ' + FONT + ';';

    var head = document.createElement('div');
    head.className = 'bwn-drawer-hd';
    head.innerHTML = '<div><div class="t">New CC Request</div><div class="s">card purchase approval</div></div>';
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'bwn-drawer-x'; x.textContent = '×';
    x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeModal);
    head.appendChild(x);

    var form = document.createElement('form');
    form.className = 'bwn-drawer-body';
    form.setAttribute('autocomplete', 'off');

    // Who the approval reply goes to = the verified account (server derives it; we only show it).
    var who = document.createElement('div');
    who.style.cssText = 'font-size:12.5px;color:#33473d;background:#eef4f0;border:1px solid #cfe0d7;border-radius:8px;padding:8px 11px;margin-bottom:14px;line-height:1.45;';
    who.textContent = me.email
      ? ('Requesting as ' + me.email + '. The approval reply is sent to this account.')
      : 'The approval reply is sent to your signed-in Umbrava account.';
    form.appendChild(who);

    var inputs = {};
    var lblCss = 'display:block;font-weight:600;font-size:12px;margin:0 0 4px;color:#33473d;';
    var inCss = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #c6d2cc;border-radius:8px;font:400 14px ' + FONT + ';background:#fff;color:#12241b;';

    FIELDS.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:13px;';
      var lbl = document.createElement('label');
      lbl.style.cssText = lblCss;
      lbl.textContent = f.label + (f.required ? ' *' : '');
      var el;
      if (f.type === 'textarea') {
        el = document.createElement('textarea');
        el.rows = 3; el.style.cssText = inCss + 'resize:vertical;';
      } else {
        el = document.createElement('input');
        el.type = (f.type === 'date') ? 'date' : (f.type === 'url' ? 'url' : 'text');
        if (f.type === 'money') { el.inputMode = 'decimal'; }
        el.style.cssText = inCss;
        // Supplier: offer the WO's vendors as type-ahead suggestions (still free text).
        if (f.list && woVendors.length) {
          var dl = document.createElement('datalist');
          dl.id = 'cca_dl_' + f.key;
          woVendors.forEach(function (v) { var o = document.createElement('option'); o.value = v; dl.appendChild(o); });
          el.setAttribute('list', dl.id);
          wrap.appendChild(dl);
        }
      }
      if (f.ph) el.placeholder = f.ph;
      // Sensible defaults / job prefill
      if (f.key === 'Date') el.value = todayISO();
      if (f.key === 'Tracking' && woId) el.value = woId;   // digits from the URL = the WO tracking #
      if (f.key === 'SupplierName' && flippedSupplier) el.value = flippedSupplier;
      if (f.key === 'LineItemDescription' && (bus && (bus.client || bus.location))) {
        var ctx = 'For W-' + (woId || (bus.wo || '').replace(/^W-?/i, ''));
        if (bus.client) ctx += ' - ' + bus.client;
        if (bus.location) ctx += ', ' + bus.location;
        el.value = ctx + ': ';
      }
      lbl.setAttribute('for', 'cca_' + f.key);
      el.id = 'cca_' + f.key;
      inputs[f.key] = el;
      wrap.appendChild(lbl); wrap.appendChild(el);
      form.appendChild(wrap);
    });

    var msg = document.createElement('div');
    msg.style.cssText = 'min-height:18px;color:#b4231f;font-size:12.5px;margin:2px 0 10px;';

    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding:6px 0 2px;';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:9px 16px;border:1px solid #c6d2cc;background:#fff;color:#33473d;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    cancel.addEventListener('click', closeModal);
    var submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = 'Submit request';
    submit.style.cssText = 'padding:9px 18px;border:none;background:' + GREEN + ';color:#fff;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    foot.appendChild(cancel); foot.appendChild(submit);

    form.appendChild(msg);
    form.appendChild(foot);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';

      var key = GM_getValue('ingest_key', '');
      if (!key) { msg.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }
      // The server proves this token with Umbrava and injects the verified email as Requester.
      var userToken = authToken();
      if (!userToken) { msg.textContent = 'No usable Umbrava session token right now - reload the tab, then try again.'; return; }

      // Gather + validate. RequesterEmail is NOT sent - the server derives it from the token.
      var payload = {};
      var missing = [];
      FIELDS.forEach(function (f) {
        var v = (inputs[f.key].value || '').trim();
        if (f.type === 'money') v = cleanMoney(v);
        if (f.required && !v) missing.push(f.label);
        payload[f.key] = v;
      });
      if (missing.length) { msg.textContent = 'Required: ' + missing.join(', '); return; }
      if (payload.PurchaseLink && !/^https?:\/\//i.test(payload.PurchaseLink)) {
        msg.textContent = 'Link for Purchase must start with http:// or https:// (or leave it blank).'; return;
      }

      var reenable = function () { submit.disabled = false; submit.textContent = 'Submit request'; };
      submit.disabled = true;
      submit.textContent = 'Submitting…';
      payload.userToken = userToken;   // body-carried (the SWA edge overwrites Authorization)

      gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 30000)
        .then(function (r) {
          var code = (r.json && r.json.code) || '';
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
            closeModal();
            toast('CC Request submitted ✓  (' + (payload.SupplierName || '') + ' - $' + (payload.TotalCost || '0') + ') - watch your email for the approval.', 7000);
          } else if (r.status === 401) {
            reenable(); msg.textContent = 'Umbrava could not verify your session (' + (code || '401') + ') - reload the tab and try again.';
          } else if (r.status === 403 && code === 'WRONG_TENANT') {
            reenable(); msg.textContent = 'Your account is not on the Broadway tenant, so the request was rejected.';
          } else if (r.status === 403) {
            reenable(); msg.textContent = 'Rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.';
          } else if (r.status === 429) {
            reenable(); msg.textContent = 'Too many submissions in a row - wait a moment and try again.';
          } else {
            reenable(); msg.textContent = 'Submit failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : '') + '.';
          }
        })
        .catch(function (err) {
          reenable(); msg.textContent = (err && err.message ? err.message : 'could not reach the proxy') + '.';
        });
    });

    card.appendChild(head); card.appendChild(form);
    back.appendChild(card);
    document.body.appendChild(back);
    openEl = back;
    document.addEventListener('keydown', onKey);
    var first = inputs.SupplierName && !inputs.SupplierName.value ? inputs.SupplierName : inputs.LineItemDescription;
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  // ---- The single floating launcher (this script owns it) ------------------
  // Everyone gets CC Request. Supervisors+ with bwn-cc-purchase present get a dropdown that also
  // opens Log CC Purchase. Re-rendered whenever the rank or CC-Purchase availability changes.
  // No self-drawn launcher: CC Request is reached from the dock tab only. The chooser
  // between Request and Purchase still lives in openCc().

  // ---- Tampermonkey menu --------------------------------------------------
  try {
    GM_registerMenuCommand('New CC Request', buildModal);
    GM_registerMenuCommand('Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', GM_getValue('ingest_key', '') || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); resolveRank(); }
    });
  } catch (e) { /* menu API absent - launcher button still works */ }

  // Register into the shared dock (covers a host already up); the host's heartbeat/ping
  // re-registers us for a host that starts later. Ping CC Purchase + resolve rank as before.
  // No dock host means Core is off or failed to load - warn instead of drawing a corner button.
  setTimeout(function () {
    dockRegister(); pingCcPurchase(); resolveRank();
    setTimeout(function () {
      if (!_hostSeen) console.warn('[BWN CC REQUEST] no dock host - install/enable BWN Suite Core to reach CC Request.');
    }, 4000);
  }, 1500);
})();
