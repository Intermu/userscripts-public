// ==UserScript==
// @name         BWN Ask (Coordinator Copilot)
// @namespace    https://broadwaynational.com/bwn
// @version      0.6.1
// @description  Ask questions about the work order you're viewing. Reads the WO live from Umbrava via same-origin GraphQL (details + full note / site-visit history) AND a summary roster of the other work orders at the same location, plus the team knowledge doc, and answers through the Broadway AI proxy with dates and references. Phase 1.5 = page-scoped + location roster (Path A); no data leaves the trusted Broadway path.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-ask.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-ask.user.js
// ==/UserScript==

/* eslint-disable */
(function () {
  'use strict';

  // ---- Config ---------------------------------------------------------------
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var ASK_URL = SWA_BASE + '/api/ask';
  var ROLE_TTL_MS = 6 * 3600 * 1000;

  // Context budget. The server caps at ~120k chars; stay under it so the notes
  // history can't get truncated mid-record.
  var CTX_TOTAL_MAX = 100000;

  // ---- Umbrava token (content-picked, mirrors bwn-suite-ai authToken) --------
  function isUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
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
        var tok = (body && body.access_token) || '';
        if (tok && isUmbravaToken(tok)) return tok;
      }
      return '';
    } catch (e) { return ''; }
  }

  // ---- Rank read (grant-none-safe, mirrors bwnEscRank) -----------------------
  // UX only - the server is the real gate. Default floor is staff, so the panel
  // shows for everyone; kept here in case BWN_ASK_MIN_RANK is ever raised.
  var _liveRank = null;
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _liveRank = d.rank;
    });
  } catch (e) { }
  function rank() {
    if (typeof _liveRank === 'number') return _liveRank;
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank;
    } catch (e2) { }
    return null;
  }

  // ---- Same-origin GraphQL (mirrors bwn-suite-ai / bwn-wo-audit gql) ----------
  // The page's own Umbrava bearer, passed explicitly, so this works from the grant
  // sandbox (a passive fetch/XHR hook does NOT - the sandbox's window.fetch is not the
  // page's, which is why capture was pulling nothing). app.umbrava.com is same-origin,
  // so no @connect is needed for these reads.
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

  function stripHtml(s) {
    var t = String(s == null ? '' : s);
    if (/[<&]/.test(t)) {
      t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '');
      t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    }
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function ts(d) { var n = Date.parse(d); return isNaN(n) ? 0 : n; }
  function fmtDate(d) { var n = Date.parse(d); if (isNaN(n)) return String(d || ''); try { return new Date(n).toLocaleString(); } catch (e) { return String(d); } }
  // Anchored to a path segment so a substring route (e.g. /client-work-orders/<id> or a
  // nested /work-orders/<year>/<n>) can't capture the wrong number.
  function woNumberFromUrl() { var m = location.pathname.match(/(?:^|\/)work-orders\/(\d+)(?:\/|$|\?|#)/); return m ? parseInt(m[1], 10) : null; }

  // Proven selectors. CORE + notes are CONFIRMED against live Umbrava (bwn-wo-audit
  // v0.3.0 / bwn-suite-ai woToJob). Notes come from the ROOT jobNotes(workOrderNumber)
  // field - the older workOrderNotes(workOrderId) does NOT exist. Each group is its OWN
  // query so one drifted/unproven selector nulls only that group (GraphQL fails the WHOLE
  // operation on any bad selection). statusName is isolated from the unproven priority-date
  // fields ON PURPOSE - it is the most load-bearing field for a "what next" answer, so a
  // drifted date selector must not be able to take it down with it.
  var CORE_Q =
    'query($n:Int!){ workOrder(workOrderNumber:$n){ ' +
    '  number trackingNumber scopeOfWork serviceInstructions locationId locationName ' +
    '  address{ addressLine1 city state postalCode } trades{ id name } priority{ label } doNotExceed{ amount } ' +
    '} }';
  var STATUS_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ statusName } }';
  var DATES_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ creationDate workOrderDate priority{ expectedCompletionDate firstTripDate } } }';
  var COORD_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ assignedToMemberName vendorNames } }';
  var NOTES_Q =
    'query($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content contentHtml createdDate isPinned isCompletion workOrderNoteSource createdBy { firstName lastName } } }';

  // ---- Location-wide WO roster (Phase 1.5) ----------------------------------
  // Umbrava's SPA has a "work orders at a location" query, but its field/arg NAME is not
  // known from source (the WO-list query is captured opaque). Rather than guess arg names,
  // DISCOVER the schema via GraphQL introspection: find the root field that returns work
  // orders AND takes a location arg, resolve its return shape (list vs relay connection),
  // then fetch a compact roster of the location's OTHER work orders. Everything here is
  // best-effort and isolated - any miss (introspection disabled, no matching field, query
  // error) leaves the per-WO answer intact and the roster simply marked unavailable, never
  // fabricated. Discovery + roster are cached for the session so it runs at most once/location.
  var _locField;             // undefined=unqueried, null=none found, else {field,locArg,argType,container}
  var _locRoster = {};       // locationId -> { ok, wos:[...] } | { ok:false }
  var ROSTER_MAX = 40, ROSTER_SEL = 'number statusName priority{ label } trades{ name } workOrderDate creationDate';

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
      if (pick.retIsList) { pick.container = null; _locField = pick; return pick; }   // field returns [WorkOrder] directly
      // Connection object: introspect it to find the list container (nodes/items/edges).
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
    if (locationId == null) return Promise.resolve({ ok: false });
    var key = String(locationId);
    if (_locRoster[key]) return Promise.resolve(_locRoster[key]);
    return discoverLocField().then(function (fld) {
      if (!fld) { _locRoster[key] = { ok: false }; return _locRoster[key]; }
      var vtype = /int/i.test(fld.argType) ? 'Int!' : 'ID!';
      var inner = fld.container === 'edges' ? ('edges{ node{ ' + ROSTER_SEL + ' } }') : (fld.container ? (fld.container + '{ ' + ROSTER_SEL + ' }') : ROSTER_SEL);
      var Q = 'query($loc:' + vtype + '){ ' + fld.field + '(' + fld.locArg + ':$loc){ ' + inner + ' } }';
      return gql(Q, { loc: locationId }).then(function (d) {
        var root = d && d[fld.field];
        var arr = !fld.container ? root : (fld.container === 'edges' ? (root && root.edges || []).map(function (e) { return e && e.node; }) : (root && root[fld.container]));
        arr = Array.isArray(arr) ? arr.filter(Boolean) : [];
        _locRoster[key] = { ok: true, wos: arr };
        return _locRoster[key];
      }, function () { _locRoster[key] = { ok: false }; return _locRoster[key]; });
    });
  }

  // Run a query and DISTINGUISH failure from empty: { ok:true, wo } or { ok:false }.
  // A silent []/{} on error is how the copilot could turn a fetch failure into a confident
  // "this WO has no history" - the worst failure mode for a grounded tool, so never do it.
  function qWO(query, n) {
    return gql(query, { n: n }).then(function (d) { return { ok: true, wo: (d && d.workOrder) || null }; }, function () { return { ok: false }; });
  }
  function qNotes(n) {
    return gql(NOTES_Q, { n: n }).then(function (d) { return { ok: true, notes: (d && d.jobNotes) || [] }; }, function () { return { ok: false }; });
  }

  // Gather the RECORDS block by ACTIVELY querying the WO in view. Returns
  // { text, records, shown, omitted, wo, degraded, notesFailed, error? }.
  function gatherContext() {
    var n = woNumberFromUrl();
    if (!n) return Promise.resolve({ text: '', records: 0, error: 'Open a specific work order (a /work-orders/<number> page) so I can read it, then ask.' });

    return Promise.all([qWO(CORE_Q, n), qWO(STATUS_Q, n), qWO(DATES_Q, n), qWO(COORD_Q, n), qNotes(n)]).then(function (res) {
      var coreR = res[0], statusR = res[1], datesR = res[2], coordR = res[3], notesR = res[4];
      var wo = coreR.ok ? (coreR.wo || {}) : {};
      var stat = (statusR.ok && statusR.wo) ? statusR.wo : {};
      var dts = (datesR.ok && datesR.wo) ? datesR.wo : {};
      var coord = (coordR.ok && coordR.wo) ? coordR.wo : {};

      // Hard failures: don't answer blind.
      if (!coreR.ok && !notesR.ok) return { text: '', records: 0, error: 'I could not read work order ' + n + ' from Umbrava (the queries failed). Reload the page and try again.' };
      if (coreR.ok && !coreR.wo && !notesR.ok) return { text: '', records: 0, error: 'Work order ' + n + ' was not found in Umbrava. Check the number and try again.' };

      var degraded = [];
      var L = [];
      L.push('WORK ORDER #' + (wo.number || n) + (wo.trackingNumber ? ' (Tracking #' + wo.trackingNumber + ')' : ''));
      if (stat.statusName) L.push('Status: ' + stat.statusName); else if (!statusR.ok) degraded.push('status');
      if (wo.locationName || wo.locationId != null) L.push('Location: ' + (wo.locationName || '') + (wo.locationId != null ? ' (id ' + wo.locationId + ')' : ''));
      var addr = wo.address || null;
      if (addr) L.push('Address: ' + [addr.addressLine1, [addr.city, addr.state].filter(Boolean).join(', '), addr.postalCode].filter(Boolean).join(' '));
      if (wo.trades && wo.trades.length) L.push('Trade(s): ' + wo.trades.map(function (t) { return t && t.name; }).filter(Boolean).join(', '));
      if (wo.priority && wo.priority.label) L.push('Priority: ' + wo.priority.label);
      if (wo.doNotExceed && wo.doNotExceed.amount != null) L.push('NTE: $' + wo.doNotExceed.amount);
      if (coord.assignedToMemberName) L.push('Coordinator: ' + coord.assignedToMemberName);
      if (coord.vendorNames && coord.vendorNames.length) L.push('Vendor(s): ' + coord.vendorNames.join(', '));
      if (dts.workOrderDate || dts.creationDate) L.push('Created: ' + fmtDate(dts.workOrderDate || dts.creationDate));
      var pr = dts.priority || {};
      if (pr.firstTripDate) L.push('First trip: ' + fmtDate(pr.firstTripDate));
      if (pr.expectedCompletionDate) L.push('Expected completion: ' + fmtDate(pr.expectedCompletionDate));
      if (wo.scopeOfWork) L.push('Scope of work: ' + stripHtml(wo.scopeOfWork));
      if (wo.serviceInstructions) L.push('Service instructions: ' + stripHtml(wo.serviceInstructions));

      var parts = [];
      if (!coreR.ok) { parts.push('(WORK ORDER DETAILS UNAVAILABLE - the details query failed; only note history was read.)'); degraded.push('details'); }
      parts.push(L.join('\n'), '');

      // Fetch the location roster, prepend a roster-aware SCOPE line so the model knows
      // exactly what it has (full notes for THIS WO + a summary of sibling WOs, or single-WO
      // only when the roster is unavailable), append the "other WOs at this location" block,
      // and return. Roster is best-effort - a miss just marks the site read unavailable.
      function finalize(extra) {
        return fetchLocationRoster(wo.locationId).then(function (roster) {
          var body = parts.slice();
          var siteWOs = 0;
          if (roster && roster.ok) {
            var cur = String(wo.number || n);
            var list = (roster.wos || []).filter(function (w) { return w && String(w.number) !== cur; })
              .sort(function (a, b) { return ts(b && (b.workOrderDate || b.creationDate)) - ts(a && (a.workOrderDate || a.creationDate)); });
            siteWOs = list.length;
            if (!siteWOs) { body.push('', 'OTHER WORK ORDERS AT THIS LOCATION: none - this appears to be the only work order at this location.'); }
            else {
              var cap = Math.min(siteWOs, ROSTER_MAX);
              body.push('', 'OTHER WORK ORDERS AT THIS LOCATION (' + siteWOs + (siteWOs > ROSTER_MAX ? ', showing ' + ROSTER_MAX + ' most recent' : '') + ') - summary rows only, NOT full notes; open a WO for its notes:');
              for (var i = 0; i < cap; i++) {
                var w = list[i], tr = (w.trades || []).map(function (t) { return t && t.name; }).filter(Boolean).join('/');
                body.push('- WO #' + (w.number || '?') + ' | ' + (w.statusName || '?') + (w.priority && w.priority.label ? ' | ' + w.priority.label : '') + (tr ? ' | ' + tr : '') + ((w.workOrderDate || w.creationDate) ? ' | ' + fmtDate(w.workOrderDate || w.creationDate) : ''));
              }
            }
          } else {
            body.push('', 'OTHER WORK ORDERS AT THIS LOCATION: could not be read. Answer only about WO #' + (wo.number || n) + ' and say other work orders at the site could not be loaded.');
            degraded.push('site-roster');
          }
          var scope = (roster && roster.ok && siteWOs)
            ? 'SCOPE: You have the FULL notes/history for WO #' + (wo.number || n) + (wo.locationName ? ' at ' + wo.locationName : '') + ', PLUS a summary roster of ' + siteWOs + ' other work order(s) at this location (roster = status/trade/date only, NOT their notes). For detail on another WO the coordinator must open it. Do not invent notes for roster WOs.'
            : 'SCOPE: This is ONE work order (#' + (wo.number || n) + ')' + (wo.locationName ? ' at ' + wo.locationName : '') + '. ' + ((roster && roster.ok) ? 'It is the only work order at this location.' : 'Other work orders at this location could NOT be loaded - do not claim completeness across the site.');
          var text = scope + '\n\n' + body.join('\n');
          return Object.assign({ text: text, wo: wo.number || n, degraded: degraded, siteWOs: siteWOs, siteOk: !!(roster && roster.ok) }, extra);
        });
      }

      // Notes query FAILED (not merely empty): tell the model so it never denies history.
      if (!notesR.ok) {
        parts.push('NOTE / SITE-VISIT HISTORY for this WO: UNAVAILABLE - the notes query failed. Do NOT state whether this work order has notes or history; tell the user the history could not be read and to retry.');
        degraded.push('notes');
        return finalize({ records: 0, shown: 0, omitted: 0, notesFailed: true });
      }

      var notes = notesR.notes || [];
      var sorted = notes.slice().sort(function (a, b) { return ts(b && b.createdDate) - ts(a && a.createdDate); });
      var noteLines = [], shown = 0, omitted = 0;
      var used = parts.join('\n').length;
      for (var i = 0; i < sorted.length; i++) {
        var nt = sorted[i];
        var nbody = stripHtml(nt.content || nt.contentHtml || '');
        if (!nbody) continue;
        var who = nt.createdBy ? [nt.createdBy.firstName, nt.createdBy.lastName].filter(Boolean).join(' ') : '';
        var tags = [nt.type, nt.workOrderNoteSource, nt.isPinned ? 'pinned' : '', nt.isCompletion ? 'completion' : ''].filter(Boolean).join(', ');
        var block = '\n[' + fmtDate(nt.createdDate) + ']' + (who ? ' ' + who : '') + (tags ? ' (' + tags + ')' : '') + '\n' + nbody + '\n';
        if (used + block.length > CTX_TOTAL_MAX) { omitted = sorted.length - i; break; }
        noteLines.push(block); used += block.length; shown++;
      }
      parts.push('NOTES for THIS work order (newest first, ' + notes.length + ' total' +
        (omitted ? '; ' + shown + ' shown, ' + omitted + ' OLDEST omitted for size - say so if asked for the complete history' : '') + '):');
      if (!notes.length) parts.push('\n(no notes on this work order)');
      else parts = parts.concat(noteLines);
      return finalize({ records: notes.length, shown: shown, omitted: omitted });
    });
  }

  // ---- SWA call (mirrors cc-auth gmPost) ------------------------------------
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 60000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  function askServer(question, model, history) {
    var key = GM_getValue('ingest_key', '');
    if (!key) return Promise.resolve({ clientError: 'Set the SWA ingest key first (Tampermonkey menu -> "BWN Ask: set ingest key"). Same key as the rest of the suite.' });
    var userToken = authToken();
    if (!userToken) return Promise.resolve({ clientError: 'No usable Umbrava session token right now. Reload the Umbrava page and try again.' });
    return gatherContext().then(function (ctx) {
      if (ctx.error) return { clientError: ctx.error };   // hard failure (no WO / not found / all queries down)
      var payload = { userToken: userToken, question: question, context: ctx.text, model: model || 'claude-haiku-4-5' };
      if (history && history.length) payload.history = history;   // bounded last-few-turns, so follow-ups referencing the prior answer resolve
      return gmPost(ASK_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 60000)
        .then(function (r) { r._records = ctx.records; r._shown = ctx.shown; r._omitted = ctx.omitted; r._wo = ctx.wo; r._degraded = ctx.degraded; r._notesFailed = ctx.notesFailed; r._siteWOs = ctx.siteWOs; r._siteOk = ctx.siteOk; return r; });
    });
  }

  function errorFor(r) {
    if (!r) return 'No response from the server.';
    if (r.clientError) return r.clientError;
    var j = r.json || {};
    if (r.status === 200 && j.ok) return null;
    if (r.status === 401) return 'Your Umbrava session token was not accepted (' + (j.code || 'auth') + '). Reload the Umbrava page and try again.';
    if (r.status === 403 && j.code === 'WRONG_TENANT') return 'This account is not in the Broadway tenant.';
    if (r.status === 403 && j.code === 'ROLE_REQUIRED') return 'Your role (' + (j.tier || 'unknown') + ') is below the level required for this tool.';
    if (r.status === 403) return 'The SWA ingest key is missing or wrong. Re-set it from the Tampermonkey menu.';
    if (r.status === 429) return 'Slow down - too many questions in a row. Try again in a moment.';
    if (r.status === 503) return 'The copilot is not fully configured on the server yet (' + (j.error || 'unavailable') + ').';
    return (j && (j.error || j.detail)) ? ('Server error: ' + (j.error || j.detail)) : ('Server error (' + r.status + ').');
  }

  // ---- Panel UI -------------------------------------------------------------
  var panelEl = null, msgsEl = null, inputEl = null, sendBtn = null, modelSel = null, busy = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function addMsg(role, text) {
    if (!msgsEl) return null;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin:8px 0;display:flex;' + (role === 'user' ? 'justify-content:flex-end;' : 'justify-content:flex-start;');
    var b = document.createElement('div');
    if (role === 'meta') {
      wrap.style.cssText = 'margin:2px 0 8px;display:flex;justify-content:center;';
      b.style.cssText = 'font:11px -apple-system,Segoe UI,Roboto,sans-serif;color:#8a9a92;text-align:center;';
    } else {
      b.style.cssText = 'max-width:85%;padding:8px 11px;border-radius:12px;font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap;word-wrap:break-word;' +
        (role === 'user' ? 'background:#1A5F3E;color:#fff;border-bottom-right-radius:3px;'
          : role === 'error' ? 'background:#fdecea;color:#8a1c12;border:1px solid #f5c2bd;'
            : 'background:#eef2f0;color:#1c2b24;border-bottom-left-radius:3px;');
    }
    b.innerHTML = esc(text);
    wrap.appendChild(b);
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return b;
  }

  var convo = [];   // {q,a} of recent exchanges, so answer-referential follow-ups resolve
  function doAsk() {
    if (busy) return;
    var q = (inputEl.value || '').trim();
    if (!q) return;
    addMsg('user', q);
    inputEl.value = '';
    busy = true; sendBtn.disabled = true; sendBtn.textContent = '...';
    var thinking = addMsg('assistant', 'Thinking...');
    var hist = convo.slice(-3).map(function (t) { return { q: t.q, a: (t.a || '').slice(0, 1500) }; });
    askServer(q, modelSel ? modelSel.value : 'claude-haiku-4-5', hist).then(function (r) {
      var err = errorFor(r);
      if (thinking && thinking.parentNode) thinking.parentNode.remove();
      if (err) { addMsg('error', err); return; }
      var ans = (r.json && r.json.answer) || '(no answer returned)';
      addMsg('assistant', ans);
      convo.push({ q: q, a: ans });
      if (r._notesFailed) {
        addMsg('error', 'Heads up: I could not read this WO\'s note history, so that answer is from the WO details only. Reload and retry for the full history.');
      } else {
        var foot = 'Grounded on WO #' + (r._wo || '?') + ' - ' + (r._records || 0) + ' note' + (r._records === 1 ? '' : 's');
        if (r._omitted) foot += ' (' + r._shown + ' shown, ' + r._omitted + ' oldest omitted)';
        if (r._siteOk && r._siteWOs) foot += ' + ' + r._siteWOs + ' other WO' + (r._siteWOs === 1 ? '' : 's') + ' at this site';
        if (r._degraded && r._degraded.length) foot += '; unavailable: ' + r._degraded.join(', ');
        addMsg('meta', foot);
      }
    }).catch(function (e) {
      if (thinking && thinking.parentNode) thinking.parentNode.remove();
      addMsg('error', 'Request failed: ' + (e && e.message ? e.message : 'unknown error'));
    }).then(function () {
      busy = false; sendBtn.disabled = false; sendBtn.textContent = 'Send';
      inputEl.focus();
    });
  }

  // The panel is a suite drawer: it slides out from the dock rail and is styled by
  // Core's page-wide .bwn-drawer sheet, so every tool in the suite looks the same when
  // you click into it. Hiding detaches the node instead of destroying it, which keeps
  // the conversation thread across open/close.
  function hidePanel() { if (panelEl && panelEl.parentNode) panelEl.remove(); }
  function buildPanel() {
    if (panelEl && panelEl.isConnected) { hidePanel(); return; }   // dock entry toggles
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } }));
    } catch (e) { }
    if (panelEl) { document.body.appendChild(panelEl); inputEl && inputEl.focus(); return; }

    panelEl = document.createElement('aside');
    panelEl.id = 'bwn-drawer-ask'; panelEl.className = 'bwn-drawer';
    panelEl.setAttribute('role', 'dialog'); panelEl.setAttribute('aria-label', 'Ask BWN');

    var head = document.createElement('div');
    head.className = 'bwn-drawer-hd';
    head.innerHTML = '<div><div class="t">Ask BWN</div><div class="s">reads this WO live</div></div>';

    modelSel = document.createElement('select');
    modelSel.style.cssText = 'all:unset;cursor:pointer;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:rgba(255,255,255,.15);padding:3px 6px;border-radius:6px;margin-right:6px;';
    modelSel.innerHTML = '<option value="claude-haiku-4-5" style="color:#000">Fast</option><option value="claude-sonnet-5" style="color:#000">Deep</option>';
    modelSel.title = 'Fast = Haiku (cheap). Deep = Sonnet (harder synthesis).';
    head.appendChild(modelSel);

    var x = document.createElement('button');
    x.type = 'button'; x.className = 'bwn-drawer-x'; x.textContent = '×';
    x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', hidePanel);
    head.appendChild(x);
    panelEl.appendChild(head);

    msgsEl = document.createElement('div');
    msgsEl.className = 'bwn-drawer-body';
    panelEl.appendChild(msgsEl);

    var foot = document.createElement('div');
    foot.className = 'bwn-drawer-ft';
    foot.style.cssText = 'align-items:flex-end;gap:6px;';
    inputEl = document.createElement('textarea');
    inputEl.rows = 2;
    inputEl.placeholder = 'Ask about the work order you\'re viewing...';
    inputEl.style.cssText = 'flex:1;resize:none;font:13px -apple-system,Segoe UI,Roboto,sans-serif;padding:7px 9px;border:1px solid #cdd6d1;border-radius:9px;outline:none;';
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAsk(); } });
    sendBtn = document.createElement('button');
    sendBtn.type = 'button'; sendBtn.className = 'bwn-ops-btn primary';
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('click', doAsk);
    foot.appendChild(inputEl);
    foot.appendChild(sendBtn);
    panelEl.appendChild(foot);

    document.body.appendChild(panelEl);
    addMsg('assistant', 'Hi. Open a work order, then ask - I read that WO live from Umbrava (details + full note / site-visit history) and a summary of the other work orders at the same location, plus Broadway\'s knowledge doc, and answer with dates and references. I never guess; if it\'s not in the record I\'ll say so.');
    inputEl.focus();
  }

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // bwn-suite-core's Launcher hosts the shared dock ([[bwn-launcher-dock]]); we
  // register one entry ('ask') instead of hand-placing a left-edge button. The
  // host also re-mounts the entry across SPA repaints. detail.key carries the entry
  // id (detail.id is the bwn:evt event name). There is no self-drawn fallback button
  // any more: the dock tab is the only launcher this tool has on the page.
  var DOCK_KEY = 'ask';
  var _hostSeen = false;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Ask BWN', icon: '💬', weight: 30,
        title: 'Ask about the work order you are viewing'
      } }));
    } catch (e) { }
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail; if (!d) return;
      if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') {
        _hostSeen = true;
        dockRegister();
      }
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildPanel();
      // Another tool took the drawer slot - fold ours away (thread is kept in memory).
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) hidePanel();
    });
  } catch (e) { }

  // ---- Menu: set the shared ingest key (same key as the rest of the suite) ---
  try {
    GM_registerMenuCommand('BWN Ask: set ingest key', function () {
      var cur = GM_getValue('ingest_key', '');
      var v = window.prompt('Shared SWA ingest key (same key the rest of the BWN suite uses):', cur);
      if (v != null) { GM_setValue('ingest_key', v.trim()); }
    });
  } catch (e) { }

  // ---- Boot -----------------------------------------------------------------
  // Register into the shared dock (covers a host already up); the host heartbeat
  // re-registers us later. No host means BWN Suite Core is off or failed to load -
  // say so in the console rather than drawing a stray corner button on the page.
  dockRegister();
  setTimeout(function () {
    if (!_hostSeen) console.warn('[BWN ASK] no dock host - install/enable BWN Suite Core to reach Ask BWN.');
  }, 4000);
})();
