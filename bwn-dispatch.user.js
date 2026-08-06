// ==UserScript==
// @name         BWN Dispatch (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.9.1
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-dispatch.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-dispatch.user.js
// @description  One-click Dispatch for a work order - replaces manually typing a row into Dispatch_Notifications.xlsx. The Dispatch launcher shows only on a WO that is in "Pending Dispatch". It opens a confirm modal prefilled from the BWN Ops Suite bus (Tracking) and a same-origin Umbrava GraphQL read (Location as the site NUMBER, Priority, and the coordinator to ping): it uses the person this WO is assigned to (whoever a supervisor/manager assigned it to, read live when you open it), and when that is a team or blank it falls back to the coordinator from the most recent work order(s) at the same location. The coordinator name + email are editable before you send. On submit it POSTs the 5 typed fields plus the WO number (read from the URL, never typed - the flow needs it to deep-link the card, because Tracking is the CLIENT's tracking number and points at the wrong record) to the broadway-internal-ops SWA proxy (x-bwn-key gated) which forwards to the HTTP-triggered "Dispatch HTTP" Power Automate flow - the flow adds the row to Dispatch_Notifications.xlsx AND dispatches it (posts a Teams adaptive card to the coordinator and waits for their accept). Dispatching is a coordinator action, so there is no role gate (the x-bwn-key is the boundary). The assignee's email is not on the WO record (Umbrava exposes the coordinator NAME only), so it is resolved from a per-user name->email roster you maintain (seeded with you, and it remembers each coordinator you dispatch to); for a coordinator the roster has never met it falls back to a GUESS derived from the house name pattern and the signed-in user's own domain, shown with a "check it before you send" warning and always editable - never a silent send to an address nobody confirmed. The flow's secret URL stays server-side; nothing sensitive lives in this script. Registers a single "Dispatch" launcher into the shared dock (bwn:dock:*) - the dock tab is the only launcher; no floating fallback button.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

/* eslint-disable */
(function () {
  'use strict';

  var VER = '0.9.1';   // keep in step with @version - this is what the console banner reports
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var GREEN = '#0d3d26';          // BWN Ops Suite brand green - matches CC Request / WO Audit
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/dispatch';
  // The dispatchable status. Live recon 2026-07-24: freshly-created WOs sit in
  // statusName "Pending Dispatch" (statusId 41); that is the state this button is for.
  // Lenient match (substring, case-insensitive) so minor header/API formatting drift
  // does not hide the launcher.
  var DISPATCH_STATUS_RE = /pending\s+dispatch/i;
  console.info('[BWN DISPATCH] v' + VER + ' - Pending-Dispatch-gated launcher -> confirm modal (bus + live GraphQL prefill, name->email roster) -> SWA /api/dispatch (x-bwn-key) -> Dispatch HTTP flow -> Dispatch_Notifications.xlsx + Teams card. Registers into the shared dock (bwn:dock:*); no floating fallback button.');

  // ---- WO id + BWN Ops Suite bus (read-only consumer, suite data contract v1) --
  // bwn-suite-core (WO Assist) PUBLISHES the current WO's facts to sessionStorage
  // key `bwn:wo:{id}` (fields incl. tracking, location, status, coordinator = the WO's
  // "Assigned To"). We only READ it. Priority is NOT on the bus, so it comes from the
  // GraphQL read below. Absent (Core not installed / Job View not opened yet) -> we fall
  // back to a live GraphQL status read for gating, and the modal fields stay editable.
  function woIdFromUrl() {
    var m = location.pathname.match(/(?:^|\/)work-orders\/(\d+)(?:\/|$|\?|#)/);
    return m ? m[1] : null;
  }
  function isWOPage() { return !!woIdFromUrl(); }
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

  // ---- Who's signed in (Umbrava Auth0 session) -----------------------------
  // Used as the telemetry `actor`, and as a known-good name->email seed for the roster
  // (if the WO is assigned to the person doing the dispatching, their email is known).
  function actor() {
    try {
      var k = Object.keys(localStorage).find(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); });
      var u = k ? ((JSON.parse(localStorage.getItem(k)) || {}).decodedToken || {}).user : null;
      return { name: (u && u.name) || '', email: (u && u.email) || '' };
    } catch (e) { return { name: '', email: '' }; }
  }

  // ---- Umbrava access token (for the same-origin GraphQL read) -------------
  // Picked by CONTENT, not first key: the audience-keyed Auth0 cache slot transiently
  // holds NON-Umbrava tokens. Only an unexpired token whose iss is an Umbrava issuer is
  // usable. Same rule as bwn-ask / bwn-suite-ai. The token is only ever attached to the
  // same-origin /api/graphql call (Authorization header); it is NEVER sent to the SWA.
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

  // ---- Same-origin GraphQL (mirrors bwn-ask / bwn-wo-audit gql) ------------
  // app.umbrava.com is same-origin, so a plain fetch needs no @connect; the page's own
  // bearer is passed explicitly so it works from the GM_* sandbox. Best-effort only: any
  // miss leaves gating fail-open and the modal on its bus prefill, never blocks the send.
  function gql(query, variables) {
    var tok = authToken();
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
        return j && j.data;
      });
  }
  // All selectors proven live (bwn-ask CORE_Q / STATUS_Q / COORD_Q). Isolated queries -
  // an error just falls back to the bus / fail-open gating.
  var GATE_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ statusName } }';
  // !! `assignedToMemberName` DOES NOT EXIST on type WorkOrder. It was in this query until
  // 2026-08-03, and because ONE invalid field rejects the WHOLE GraphQL document with a 400, the
  // dispatch modal's live read had never returned - Location, Priority, the coordinator name and
  // the email suggestion were all dead, silently, for the life of the feature. Probed live on
  // W-383472. Every selector below was verified against the running schema the same session.
  //   assignedTo    ID scalar, a USER GUID - resolve it through USER_Q, there is no name here
  //   locationId    ID scalar, a GUID - NOT a site number, never put it in the Location field
  //   locationNumber String, "PFJ 0674"-shaped - siteNumberOf() derives the bare number
  var DISP_WO_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ trackingNumber locationId locationNumber locationName assignedTo priority{ label } } }';
  // The assignee, resolved from the GUID above. `emailAddress` is the WO assignee's REAL address:
  // the 2026-07-24 recon concluded no email was readable anywhere, but that was the REST
  // `search_members` endpoint - GraphQL `user(id:)` carries it. That makes the derived guess a
  // last resort rather than the normal path. `id` is ID! - passing ID gets a type error.
  var USER_Q = 'query($id:ID!){ user(id:$id){ firstName lastName emailAddress isInactive } }';

  // The WO's default assignee is often the CLIENT's team (e.g. "Team J"), not a dispatchable
  // person. Treat a "Team ..." name as not-a-person so we fall back to a real coordinator.
  function isTeamName(name) { return /^\s*team\b/i.test(String(name || '')); }
  function isPerson(name) { name = String(name || '').trim(); return !!name && !isTeamName(name); }

  // ---- Status gate ---------------------------------------------------------
  // Decide, per WO, whether it is dispatchable ("Pending Dispatch"). Bus first (sync,
  // free - the common case when WO Assist has run), live GraphQL as the fallback.
  // Cached per WO for the session; a null (unreadable) result is NOT cached so a later
  // bus publish can retry. isDispatchable fails OPEN on an unknown status (show the
  // launcher; the confirm modal is still the gate) so a read hiccup never hides it.
  var _statusCache = {};
  function resolveStatus(woId) {
    if (!woId) return Promise.resolve(null);
    if (_statusCache[woId]) return Promise.resolve(_statusCache[woId]);
    var bus = busGet(woId, 12 * 3600000);
    if (bus && bus.status) { _statusCache[woId] = String(bus.status); return Promise.resolve(_statusCache[woId]); }
    return gql(GATE_Q, { n: parseInt(woId, 10) }).then(function (d) {
      var s = d && d.workOrder && d.workOrder.statusName ? String(d.workOrder.statusName) : '';
      if (s) { _statusCache[woId] = s; return s; }
      return null;
    }, function () { return null; });
  }
  function isDispatchable(status) {
    if (status == null || status === '') return true;   // unknown -> fail open
    return DISPATCH_STATUS_RE.test(status);
  }

  // ---- Location-history coordinator (Phase 1.5 location roster, reused) -----
  // When the WO's own live assignee is a team / blank, the best default is the coordinator
  // who most recently handled THIS location. Umbrava's "work orders at a location" field/arg
  // name is not known from source, so (like bwn-ask) we DISCOVER it via introspection rather
  // than guess, then read a compact roster and take the most recent PERSON coordinator (skip
  // team-assigned prior WOs - we want a real person to ping). Everything here is best-effort +
  // isolated: any miss leaves the name blank for manual entry, never fabricated. Cached/session.
  var _locField;             // undefined=unqueried, null=none found, else {field,locArg,argType,container}
  var _locRoster = {};       // locationId -> [wo...]  (session cache)
  // Same dead field as DISP_WO_Q carried: `assignedToMemberName` does not exist, so this query
  // 400'd too and the location-history fallback has never produced a name either. Now selects the
  // GUID. STILL UNPROVEN: `listWorkOrders` is a valid query but returned 0 rows for every
  // location and every filter shape tried on 2026-08-03 (by GUID and by locationNumber), so this
  // path is expected to stay inert until someone works out which `statuses` argument it wants.
  // It only runs when the WO's own assignee fails to resolve to a person, which is now rare.
  var ROSTER_SEL = 'number assignedTo workOrderDate creationDate';
  function unwrapType(t) { var isList = false, cur = t; while (cur && cur.ofType) { if (cur.kind === 'LIST') isList = true; cur = cur.ofType; } return { name: cur && cur.name, kind: cur && cur.kind, isList: isList }; }
  function discoverLocField() {
    if (_locField !== undefined) return Promise.resolve(_locField);
    var Q = '{ __schema { queryType { fields { name args { name type { kind name ofType { kind name } } } type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }';
    return gql(Q, {}).then(function (d) {
      var fs = (d && d.__schema && d.__schema.queryType && d.__schema.queryType.fields) || [];
      var pick = null;
      for (var i = 0; i < fs.length && !pick; i++) {
        var f = fs[i], nm = String(f.name || '');
        if (!/work.?orders/i.test(nm)) continue;                 // plural list field, not single workOrder
        var la = null, at = 'ID';
        (f.args || []).forEach(function (a) { if (!la && /location.?id|^location$/i.test(a.name)) { la = a.name; var u = unwrapType(a.type || {}); at = u.name || 'ID'; } });
        if (!la) continue;
        var ret = unwrapType(f.type || {});
        pick = { field: nm, locArg: la, argType: at, retName: ret.name, retKind: ret.kind, retIsList: ret.isList };
      }
      if (!pick) { _locField = null; return null; }
      if (pick.retIsList) { pick.container = null; _locField = pick; return pick; }
      var TQ = 'query($t:String!){ __type(name:$t){ fields { name type { kind name ofType { kind name ofType { kind name } } } } } }';
      return gql(TQ, { t: pick.retName }).then(function (td) {
        var tf = (td && td.__type && td.__type.fields) || [];
        for (var j = 0; j < tf.length; j++) { var u = unwrapType(tf[j].type || {}); if (u.isList && (u.kind === 'OBJECT' || u.kind === 'INTERFACE')) { pick.container = tf[j].name; break; } }
        _locField = pick.container ? pick : null;
        return _locField;
      }, function () { _locField = null; return null; });
    }, function () { _locField = null; return null; });
  }
  function fetchLocationRoster(locationId) {
    if (locationId == null) return Promise.resolve([]);
    var key = String(locationId);
    if (_locRoster[key]) return Promise.resolve(_locRoster[key]);
    return discoverLocField().then(function (fld) {
      if (!fld) { _locRoster[key] = []; return []; }
      var vtype = /int/i.test(fld.argType) ? 'Int!' : 'ID!';
      var inner = fld.container === 'edges' ? ('edges{ node{ ' + ROSTER_SEL + ' } }') : (fld.container ? (fld.container + '{ ' + ROSTER_SEL + ' }') : ROSTER_SEL);
      var Q = 'query($loc:' + vtype + '){ ' + fld.field + '(' + fld.locArg + ':$loc){ ' + inner + ' } }';
      return gql(Q, { loc: locationId }).then(function (d) {
        var root = d && d[fld.field];
        var arr = !fld.container ? root : (fld.container === 'edges' ? (root && root.edges || []).map(function (e) { return e && e.node; }) : (root && root[fld.container]));
        arr = Array.isArray(arr) ? arr.filter(Boolean) : [];
        _locRoster[key] = arr;
        return arr;
      }, function () { _locRoster[key] = []; return []; });
    });
  }
  function ts(d) { var n = Date.parse(d); return isNaN(n) ? 0 : n; }
  // "PFJ 0674" -> "674". The flow's `Lookup site` keys on the bare site number, and Umbrava's
  // `locationNumber` carries a client prefix and zero-padding on some tenants. Conservative on
  // purpose: LAST whitespace-separated token, digits only, non-zero - anything else yields '' and
  // the field is left empty for the coordinator to type. Site codes like "DFW6", "IFM-JAX3" and
  // "091 FM" deliberately do NOT derive: a wrong key makes `Lookup site` miss SILENTLY, which is
  // the failure this whole line of work started from, and an empty required field cannot.
  // "PFJ 0000" (the corporate pseudo-site) yields '' too.
  function siteNumberOf(locNum) {
    var s = String(locNum == null ? '' : locNum).trim();
    if (!s) return '';
    var tok = s.split(/\s+/).pop();
    if (!/^\d+$/.test(tok)) return '';
    var num = parseInt(tok, 10);
    return num > 0 ? String(num) : '';
  }
  // The person who had the last (most recent) work order at this location - skipping the
  // current WO and any team-assigned prior WOs.
  function siteCoordinator(locationId, curNumber) {
    return fetchLocationRoster(locationId).then(function (wos) {
      var cur = String(curNumber == null ? '' : curNumber);
      var people = (wos || [])
        .filter(function (w) { return w && String(w.number) !== cur && isPerson(w.assignedToMemberName); })
        .sort(function (a, b) { return ts(b && (b.workOrderDate || b.creationDate)) - ts(a && (a.workOrderDate || a.creationDate)); });
      return people.length ? String(people[0].assignedToMemberName).trim() : '';
    }, function () { return ''; });
  }

  // ---- Name -> email roster (the AssigneeEmail source) ----------------------
  // The assignee's email is NOT on the WO record and is not exposed by Umbrava's member
  // lookup either (live recon 2026-07-24: WO carries the member GUID + display NAME only;
  // search_members returns no email; first names are ambiguous). So there is no reliable
  // auto-resolve - we keep a per-user name->email map in GM storage. It is seeded with the
  // signed-in user, grows automatically on each successful dispatch, and is editable from
  // the Tampermonkey menu. Team assignees (e.g. "Team J") simply will not resolve, which is
  // correct - the dispatcher picks the actual person. Store work emails only.
  function loadRoster() {
    try { var o = JSON.parse(GM_getValue('dispatch_roster', '{}')); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function saveRoster(o) { try { GM_setValue('dispatch_roster', JSON.stringify(o || {})); } catch (e) { } }
  function rosterKey(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function rosterLookup(name) { var k = rosterKey(name); return k ? (loadRoster()[k] || '') : ''; }
  function rosterRemember(name, email) {
    var k = rosterKey(name); email = String(email || '').trim();
    if (!k || !email) return;
    var o = loadRoster(); if (o[k] === email) return; o[k] = email; saveRoster(o);
  }
  function seedRosterWithMe() {
    var me = actor();
    if (me.name && me.email) rosterRemember(me.name, me.email);
  }
  // Derived-address SUGGESTION - the LAST resort, used only when the roster has never seen this
  // coordinator and they are not the signed-in user. Before this the field was simply blank and
  // the address had to be typed by hand (measured 2026-08-03: a coordinator the roster had never
  // met, typed manually mid-dispatch).
  //
  // It is a GUESS and is labelled as one in the UI, because the evidence is thin: the house
  // pattern is first initial + last name, and only two addresses have ever been observed to
  // confirm it. Anything unusual - a middle name in the display name, a married name, a second
  // person with the same initial and surname, a contractor on another domain - produces a
  // plausible-looking wrong address, and this is a field that decides who gets the Teams card.
  // Hence: never overwrite a roster hit, never overwrite anything typed, always visibly flagged,
  // always editable. A guess only enters the roster if a human sent it (rosterRemember on
  // submit), which is the confirmation step.
  //
  // The domain comes from the SIGNED-IN user, never a literal: this script is published to a
  // public mirror, so no client domain is baked into it, and a coordinator signed in elsewhere
  // gets no guess at all rather than a wrong-domain one.
  function guessEmail(name) {
    if (!isPerson(name)) return '';                       // "Team J" is not a person to guess at
    var dom = String((actor().email || '')).split('@')[1] || '';
    if (!dom) return '';                                  // no signed-in address -> fail closed
    var parts = String(name || '').toLowerCase().replace(/[^a-z\s'-]+/g, ' ').split(/\s+/)
      .map(function (t) { return t.replace(/[^a-z]/g, ''); })   // O'Brien -> obrien, Smith-Jones -> smithjones
      .filter(Boolean);
    if (parts.length < 2) return '';                      // one token is not a first + last name
    var first = parts[0], last = parts[parts.length - 1];
    if (!first || last.length < 2) return '';
    return first.charAt(0) + last + '@' + dom;
  }
  function manageRoster() {
    var o = loadRoster();
    var lines = Object.keys(o).sort().map(function (k) { return k + ' = ' + o[k]; });
    var v = prompt('Dispatch name->email roster (one per line, "Coordinator Name = coordinator@broadwaynational.com"). Used to prefill the Assignee Email from the coordinator name. Edit / add / remove:', lines.join('\n'));
    if (v === null) return;
    var next = {};
    v.split(/\r?\n/).forEach(function (ln) {
      var i = ln.indexOf('=');
      if (i < 0) return;
      var nm = rosterKey(ln.slice(0, i));
      var em = ln.slice(i + 1).trim();
      if (nm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) next[nm] = em;
    });
    saveRoster(next);
    var n = Object.keys(next).length;
    toast(n ? 'Saved ' + n + ' roster entr' + (n === 1 ? 'y' : 'ies') + '.' : 'Roster cleared.');
  }

  // ---- Toast --------------------------------------------------------------
  function toast(msg, ms, bg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%);background:' + (bg || GREEN) + ';color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:74vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.5;';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 420); }, ms || 6000);
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

  // ---- Field spec (order = modal layout). Mirrors the proxy's 5-prop body ---
  // key      = the JSON prop the proxy / flow expect
  // required = enforced client-side (api/dispatch re-checks the same minimum;
  //            Priority is optional - the card's else-branch color-codes a blank).
  var FIELDS = [
    { key: 'AssignedToName', label: 'Assigned To (coordinator)', type: 'text', required: true, ph: 'Coordinator this WO is assigned to' },
    { key: 'AssigneeEmail', label: 'Assignee Email', type: 'email', required: true, ph: 'coordinator@broadwaynational.com' },
    { key: 'Tracking', label: 'Tracking #', type: 'text', required: true, ph: 'WO tracking number' },
    { key: 'Location', label: 'Location', type: 'text', required: true, ph: 'Site / store' },
    { key: 'Priority', label: 'Priority', type: 'text', ph: 'e.g. P2 - Normal (optional)' }
  ];
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var openEl = null;
  function closeModal() { if (openEl) { openEl.remove(); openEl = null; emailGuessEl = null; document.removeEventListener('keydown', onKey); } }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  function buildModal() {
    if (openEl) return;   // one at a time
    seedRosterWithMe();
    var me = actor();
    var woId = woIdFromUrl();
    var bus = busGet(woId, 12 * 3600000);

    // Synchronous prefill from the bus (present immediately). The live GraphQL read below
    // upgrades it - the coordinator name in particular is overwritten from the WO's live
    // assignment, since that is who a supervisor/manager assigned it to "when the button
    // is used". Only fields the user has not typed into are touched.
    // Only seed the name from the bus if it is a PERSON; a team ("Team J") is not a dispatch
    // target, so leave it blank and let the live read / location history fill a real coordinator.
    var busCoord = (bus && bus.coordinator && isPerson(bus.coordinator)) ? String(bus.coordinator).trim() : '';
    // Location is deliberately NOT seeded from the bus. The bus carries the location DISPLAY
    // NAME (Core reads the WO's location dropdown label, e.g. "Flying J PFJ 0722 (865) 531-7400"),
    // but the flow's `Lookup site` keys on the bare site NUMBER - so a name here both made the
    // Teams card unreadable and silently missed the site lookup on every dispatch (measured on
    // the first correctly-targeted card, 2026-08-03). The live read below fills the site number
    // from `locationId`; the name is shown as a hint under the field instead of being sent.
    // Tracking has the SAME hazard one field up, and it bit on 2026-08-03. The bus value is a DOM
    // scrape of the header's tracking-number element; when that is missing or the bus entry is
    // stale, this used to fall back to the WO number IMMEDIATELY - which filled the field, so the
    // live read's `setIfEmpty` could never correct it. Queue row 466 went out as Tracking 383441
    // on a WO whose real client tracking number is 1273641. The fallback now happens only AFTER
    // the live read has had its say (see hydrateFromUmbrava), so a blank here is temporary.
    var pre = {
      AssignedToName: busCoord,
      AssigneeEmail: busCoord ? rosterLookup(busCoord) : '',
      Tracking: (bus && bus.tracking) ? String(bus.tracking).trim() : '',
      Location: '',
      Priority: ''
    };

    // Suite drawer: slides out from the dock rail, styled by Core's page-wide sheet so
    // every tool looks the same when you click into it.
    var back = document.createElement('aside');
    back.id = 'bwn-drawer-dispatch'; back.className = 'bwn-drawer';
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-label', 'Dispatch Work Order');
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }

    var card = document.createElement('div');
    card.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;color:#12241b;font:400 14px ' + FONT + ';';

    var head = document.createElement('div');
    head.className = 'bwn-drawer-hd';
    head.innerHTML = '<div><div class="t">Dispatch Work Order</div><div class="s">notify a coordinator</div></div>';
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'bwn-drawer-x'; x.textContent = '×';
    x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeModal);
    head.appendChild(x);

    var form = document.createElement('form');
    form.className = 'bwn-drawer-body';
    form.setAttribute('autocomplete', 'off');

    // What happens on send (the flow posts a Teams card the coordinator must accept).
    var who = document.createElement('div');
    who.style.cssText = 'font-size:12.5px;color:#33473d;background:#eef4f0;border:1px solid #cfe0d7;border-radius:8px;padding:8px 11px;margin-bottom:14px;line-height:1.45;';
    who.textContent = 'Sends a Teams "New Dispatch Work Order" card to the coordinator below, who accepts it. Prefilled from who this WO is assigned to - if that is a team, set the individual coordinator before sending.';
    form.appendChild(who);

    var inputs = {};
    var touched = {};
    var lblCss = 'display:block;font-weight:600;font-size:12px;margin:0 0 4px;color:#33473d;';
    var inCss = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #c6d2cc;border-radius:8px;font:400 14px ' + FONT + ';background:#fff;color:#12241b;';

    FIELDS.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:13px;';
      var lbl = document.createElement('label');
      lbl.style.cssText = lblCss;
      lbl.textContent = f.label + (f.required ? ' *' : '');
      var el = document.createElement('input');
      el.type = (f.type === 'email') ? 'email' : 'text';
      el.style.cssText = inCss;
      if (f.ph) el.placeholder = f.ph;
      if (pre[f.key]) el.value = pre[f.key];
      el.addEventListener('input', function () { touched[f.key] = true; });
      lbl.setAttribute('for', 'disp_' + f.key);
      el.id = 'disp_' + f.key;
      inputs[f.key] = el;
      wrap.appendChild(lbl); wrap.appendChild(el);
      form.appendChild(wrap);
    });

    // The site NAME is context for the human, never payload: it tells the coordinator which site
    // the bare number belongs to without putting a name back into the field the flow looks up on.
    var siteName = (bus && bus.location) ? String(bus.location).trim() : '';
    if (siteName && inputs.Location && inputs.Location.parentNode) {
      var siteHint = document.createElement('div');
      siteHint.style.cssText = 'font-size:11.5px;color:#5b7367;margin-top:4px;';
      siteHint.textContent = siteName;
      inputs.Location.parentNode.appendChild(siteHint);
    }

    // The "this address was guessed" warning, rendered under the email field. Created before the
    // first fillEmailFor call below so a guess made during hydration has somewhere to announce
    // itself.
    emailGuessEl = document.createElement('div');
    emailGuessEl.style.cssText = 'font-size:11.5px;color:#8a5a00;background:#fdf4e3;border:1px solid #f0dcb4;border-radius:6px;padding:5px 8px;margin-top:4px;display:none;';
    if (inputs.AssigneeEmail && inputs.AssigneeEmail.parentNode) inputs.AssigneeEmail.parentNode.appendChild(emailGuessEl);
    // Typing in the field makes it the operator's value, not a guess.
    inputs.AssigneeEmail.addEventListener('input', function () { markEmailGuess(false); });
    // The bus may have handed us a coordinator the roster has never met - resolve now rather than
    // waiting on the live read, which may never arrive.
    if (inputs.AssignedToName.value.trim() && !inputs.AssigneeEmail.value.trim()) {
      fillEmailFor(inputs, touched, inputs.AssignedToName.value);
    }

    // When the coordinator name is (re)typed, resolve the email the same way hydration does -
    // roster, then self, then a flagged guess. This used to inline a roster-only lookup, which
    // meant a name typed by hand got no suggestion at all.
    // `input`, not `change`: `change` only fires on BLUR, so the warning could not appear while
    // the operator was still typing the name - and blur usually IS the click on Dispatch, which
    // would have shown the warning for the few milliseconds before the form submitted. Debounced
    // so a half-typed name ("Daniel Ru") does not briefly resolve to a wrong-but-plausible
    // address; `change` is kept as a backstop for paste and autofill.
    var nameTimer = null;
    function resolveEmailFromName() {
      fillEmailFor(inputs, touched, inputs.AssignedToName.value, true);
    }
    inputs.AssignedToName.addEventListener('input', function () {
      if (nameTimer) clearTimeout(nameTimer);
      nameTimer = setTimeout(resolveEmailFromName, 400);
    });
    inputs.AssignedToName.addEventListener('change', function () {
      if (nameTimer) { clearTimeout(nameTimer); nameTimer = null; }
      resolveEmailFromName();
    });

    var msg = document.createElement('div');
    msg.style.cssText = 'min-height:18px;color:#b4231f;font-size:12.5px;margin:2px 0 10px;';

    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding:6px 0 14px;';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:9px 16px;border:1px solid #c6d2cc;background:#fff;color:#33473d;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    cancel.addEventListener('click', closeModal);
    var submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = 'Dispatch';
    submit.style.cssText = 'padding:9px 18px;border:none;background:' + GREEN + ';color:#fff;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    foot.appendChild(cancel); foot.appendChild(submit);

    form.appendChild(msg);
    form.appendChild(foot);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';

      var key = GM_getValue('ingest_key', '');
      if (!key) { msg.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }

      var payload = { actor: me.email || me.name || 'unknown' };
      var missing = [];
      FIELDS.forEach(function (f) {
        var v = (inputs[f.key].value || '').trim();
        if (f.required && !v) missing.push(f.label);
        payload[f.key] = v;
      });
      if (missing.length) { msg.textContent = 'Required: ' + missing.join(', '); return; }
      if (!EMAIL_RE.test(payload.AssigneeEmail)) { msg.textContent = 'Assignee Email must be a valid email address.'; return; }

      // The WO number, read from the URL and never typed. It is NOT Tracking: Tracking is the
      // CLIENT's tracking number wherever the WO has one (it only falls back to the WO number
      // when it does not), so the flow's `Tracking Link` column - built from Tracking since
      // 07-27 - deep-links every card to the wrong record. Measured live 2026-08-03:
      // /work-orders/1272451 on WO 383112. The proxy accepts this as an optional 6th prop and
      // forwards it; the link is only actually fixed once the flow maps it, which is Mike's edit.
      payload.WONumber = woId || '';

      var reenable = function () { submit.disabled = false; submit.textContent = 'Dispatch'; };
      submit.disabled = true;
      submit.textContent = 'Dispatching…';

      gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 30000)
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
            rosterRemember(payload.AssignedToName, payload.AssigneeEmail);   // learn this coordinator for next time
            closeModal();
            toast('Dispatched ✓  ' + payload.AssignedToName + ' will get a Teams card to accept (Tracking ' + payload.Tracking + ').', 7000);
          } else if (r.status === 400) {
            reenable(); msg.textContent = 'Rejected (400)' + (r.json && r.json.error ? ': ' + r.json.error : ' - check the fields') + '.';
          } else if (r.status === 403) {
            reenable(); msg.textContent = 'Rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.';
          } else if (r.status === 429) {
            reenable(); msg.textContent = 'Too many dispatches in a row - wait a moment and try again.';
          } else if (r.status === 503) {
            reenable(); msg.textContent = 'Dispatch is not fully configured on the server yet (503) - tell Mike the DISPATCH_FLOW_URL app setting is missing.';
          } else {
            reenable(); msg.textContent = 'Dispatch failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : '') + '.';
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

    // If we are not on a WO page (opened from the TM menu), say so - the fields are then
    // all manual. Otherwise upgrade the prefill from Umbrava (live) in the background.
    if (!woId) {
      msg.style.color = '#7a5b00';
      msg.textContent = 'No work order open - enter the dispatch fields manually.';
    } else {
      hydrateFromUmbrava(woId, inputs, touched);
    }

    var first = inputs.AssignedToName;
    if (first) setTimeout(function () { first.focus(); first.select && first.select(); }, 30);
  }

  // Background prefill upgrade: read the current WO live and patch the fields the user has
  // not typed into. Location / Priority fill only if empty. TRACKING is different: the live read
  // OVERWRITES the bus seed, because the bus value is a DOM scrape and this one is the record.
  // The coordinator NAME resolves to a PERSON: the WO's live assignee if that is a real person
  // (who a supervisor/manager assigned it to), else the coordinator from the most recent work
  // order(s) at the same location; a team assignee is skipped in favour of that history person.
  // Best-effort.
  function hydrateFromUmbrava(woId, inputs, touched) {
    var n = parseInt(woId, 10);
    function setIfEmpty(k, v) {
      v = (v == null) ? '' : String(v).trim();
      if (!v) return;
      var el = inputs[k];
      if (el && !touched[k] && !el.value.trim()) el.value = v;
    }
    // Overwrite the (maybe stale/blank) prefill unless the user typed. `email` is Umbrava's own
    // record for that person, which outranks everything except a value the operator typed: it is
    // the system of record, where the roster only records what someone has sent before (possibly
    // an unverified guess) and the derived guess is a pattern. An address from here is NOT
    // flagged, because it is not a guess.
    function setName(v, email, inactive) {
      v = (v == null) ? '' : String(v).trim();
      if (!v || touched.AssignedToName) return;
      inputs.AssignedToName.value = v;
      if (email && !touched.AssigneeEmail) {
        inputs.AssigneeEmail.value = String(email).trim();
        markEmailGuess(!!inactive, inactive ? 'This person is marked INACTIVE in Umbrava - check before you send.' : '');
      } else {
        fillEmailFor(inputs, touched, v);
      }
    }
    // The WO record beats the header scrape. setIfEmpty cannot do this job: a stale or missing
    // bus entry leaves a non-empty WRONG value behind (the 2026-08-03 row-466 defect), and
    // "only if empty" is exactly what let it stand.
    function setTracking(v) {
      v = (v == null) ? '' : String(v).trim();
      if (!v || touched.Tracking) return;
      inputs.Tracking.value = v;
    }
    // Last resort, and deliberately AFTER the read: a WO with no client tracking number still
    // needs a value in this required field, but the WO number must never pre-empt a real one.
    // Runs on the failure path too, so losing GraphQL degrades to the old behaviour, not a block.
    function trackingFallback() {
      var el = inputs.Tracking;
      if (el && !touched.Tracking && !el.value.trim() && woId) el.value = String(woId);
    }
    gql(DISP_WO_Q, { n: n }).then(function (d) {
      var wo = (d && d.workOrder) || {};
      setTracking(wo.trackingNumber);
      trackingFallback();
      // locationId, NOT locationName: the flow's `Lookup site` keys on the bare site number, and
      // a display name silently resolves to no site at all (see the pre-fill comment above).
      // NOT locationId - that is a GUID. The bare site number is derived from locationNumber,
      // and stays empty when it cannot be derived unambiguously (see siteNumberOf).
      setIfEmpty('Location', siteNumberOf(wo.locationNumber));
      setIfEmpty('Priority', wo.priority && wo.priority.label);
      // The WO carries only the assignee's GUID, so the name costs a second read. Falls back to
      // the location-history person exactly as before when it does not resolve to a real person.
      function historyFallback() {
        if (wo.locationId == null) return;
        siteCoordinator(wo.locationId, wo.number != null ? wo.number : n).then(function (sc) {
          if (sc) setName(sc);
        });
      }
      if (!wo.assignedTo) { historyFallback(); return; }
      gql(USER_Q, { id: wo.assignedTo }).then(function (u) {
        var p = (u && u.user) || null;
        var nm = p ? ((p.firstName || '') + ' ' + (p.lastName || '')).replace(/\s+/g, ' ').trim() : '';
        if (!isPerson(nm)) { historyFallback(); return; }
        setName(nm, p.emailAddress, p.isInactive);
      }, function () { historyFallback(); });
    }, function () { /* GraphQL unavailable - bus prefill stands */ trackingFallback(); });
  }
  // Prefill AssigneeEmail from the roster (or from the signed-in user when the name matches
  // them), only if untouched + empty.
  // Resolution order, best evidence first: the roster (a human sent to this address before) ->
  // the signed-in user's own address -> a derived guess. Only the last one is uncertain, so only
  // the last one is flagged.
  // `reresolve` relaxes the already-has-a-value guard, and ONLY the coordinator-name handler
  // passes it. After the name changes, an address auto-filled for the PREVIOUS name is stale by
  // construction, so refusing to touch it left the old coordinator's address sitting under a new
  // name - and, because the guess never ran, with no amber warning either. That is what "the
  // check-it-before-you-send line never appears" was, reported 2026-08-03. A value the HUMAN
  // typed is still protected: that is what `touched.AssigneeEmail` is for, and it is checked
  // first either way.
  function fillEmailFor(inputs, touched, name, reresolve) {
    if (touched.AssigneeEmail) return;
    if (!reresolve && inputs.AssigneeEmail.value.trim()) return;
    var em = rosterLookup(name);
    if (!em) { var me = actor(); if (me.email && rosterKey(me.name) === rosterKey(name)) em = me.email; }
    var guessed = false;
    if (!em) { em = guessEmail(name); guessed = !!em; }
    if (em) { inputs.AssigneeEmail.value = em; markEmailGuess(guessed); }
  }
  // The guess marker. Held at module scope because only one modal exists at a time (buildModal
  // returns early if one is open) and it is cleared on close.
  var emailGuessEl = null;
  // `text` overrides the wording for warnings that are not about a guess (an inactive assignee),
  // so the amber line never claims an address was guessed when it came from Umbrava's record.
  function markEmailGuess(on, text) {
    if (!emailGuessEl) return;
    emailGuessEl.textContent = on ? (text || 'Guessed from the name - check it before you send.') : '';
    emailGuessEl.style.display = on ? 'block' : 'none';
  }

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // bwn-suite-core's Launcher hosts the shared dock ([[bwn-launcher-dock]]). Dispatch is a
  // WO-level action shown ONLY on a work order in "Pending Dispatch", so we register the
  // 'dispatch' entry when the current WO is dispatchable and unregister otherwise (Umbrava
  // is a SPA - we reconcile on nav, on the host heartbeat, and when the bus updates).
  // detail.key carries the entry id (detail.id is the bwn:evt event name). If no host
  // announces within a few seconds we fall back to a self-drawn floating button (same gate).
  var DOCK_KEY = 'dispatch';
  var _hostSeen = false;
  var _registered = false;
  var _navToken = 0;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Dispatch', icon: '🚚', weight: 15,
        title: 'Dispatch this work order to a coordinator'
      } }));
    } catch (e) { }
  }
  function dockUnregister() {
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:dock:unregister', key: DOCK_KEY } })); } catch (e) { }
  }
  // Apply the desired presence for the current route + status. Registering with no host
  // yet is harmless (no listener); the host picks it up on its next heartbeat.
  function applyPresence(show) {
    if (show && !_registered) { dockRegister(); _registered = true; }
    else if (!show && _registered) { dockUnregister(); _registered = false; }
  }
  // Reconcile: gate on WO page AND dispatchable status (async, race-guarded by _navToken).
  function reeval() {
    var woId = woIdFromUrl();
    if (!woId) { applyPresence(false); return; }
    var myTok = ++_navToken;
    resolveStatus(woId).then(function (st) {
      if (myTok !== _navToken) return;              // navigated away meanwhile
      applyPresence(isDispatchable(st));
    });
  }
  function onDockHost() {
    _hostSeen = true;
    _registered = false;      // force a fresh register for this (possibly newly-elected) host
    reeval();
  }
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail; if (!d) return;
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') onDockHost();
    if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildModal();
    if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) closeModal();   // another tool took the slot
  });
  // The suite bus (bwn:wo:{id}) landing can flip a WO to a known "Pending Dispatch" status
  // after our first (bus-less) check - re-reconcile when it publishes.
  document.addEventListener('bwn:update', function () { reeval(); });
  // Post-WO-Intake / cross-script opener hook: any suite script can request the modal with
  // bwn:cmd {id:'dispatch:open'} (e.g. WO Intake could fire it after Create - see
  // wo-dispatch-button.md). This opener bypasses the status gate on purpose (explicit ask).
  document.addEventListener('bwn:cmd', function (e) {
    var d = e && e.detail; if (d && d.id === 'dispatch:open') buildModal();
  });
  // SPA route changes: re-reconcile on history navigation.
  (function hookNav() {
    function fire() { setTimeout(reeval, 0); }
    try {
      var wrap = function (orig) { return function () { var r = orig.apply(this, arguments); fire(); return r; }; };
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch (e) { }
    window.addEventListener('popstate', fire);
  })();

  // ---- Tampermonkey menu --------------------------------------------------
  try {
    GM_registerMenuCommand('Dispatch this work order', buildModal);
    GM_registerMenuCommand('Manage dispatch roster (name -> email)', manageRoster);
    GM_registerMenuCommand('Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', GM_getValue('ingest_key', '') || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { /* menu API absent - the dock entry still opens the modal */ }

  // Reconcile on load (covers a host already up); the host heartbeat/ping re-registers us
  // later. No host means Core is off or failed to load - warn instead of drawing a button.
  seedRosterWithMe();
  reeval();
  setTimeout(function () {
    if (!_hostSeen) console.warn('[BWN DISPATCH] no dock host - install/enable BWN Suite Core to reach Dispatch.');
  }, 4000);
})();
