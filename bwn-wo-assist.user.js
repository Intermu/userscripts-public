// ==UserScript==
// @name         BWN WO Assist (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.3.1
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-assist.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-assist.user.js
// @description  Escalate a work order to management from inside Umbrava, and round-trip its state back onto the page. Pick why and say what you need; it POSTs to the broadway-internal-ops SWA proxy (x-bwn-key gated) which proves your Umbrava session token, injects your verified email as the requester, works out WHO it goes to from your rank (a coordinator escalates to a supervisor, a supervisor to management, a director owns the call), sets a due clock scaled by the job's priority, records the item in the shared assist queue, and only then sends the notify. Escalating the same work order twice while the first is still open is rejected server-side, so two tabs cannot double-fire. While an escalation is open, this script also reads its state back (op:'status') and publishes it on the suite bus, so the WO Assist checklist shows "Escalated - awaiting mgmt" and the drawer becomes an acknowledge/resolve panel instead of a duplicate form. Registers one "Escalate" entry in the shared dock tab and adds an Escalate button to the WO Assist checklist's escalation step; a Tampermonkey menu item opens it too, so it is never stranded. The flow's secret URL stays server-side; nothing sensitive lives in this script.
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

  var VER = '0.3.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/wo-assist';
  var GREEN = '#0d3d26';
  console.info('[BWN WO ASSIST] v' + VER + ' - escalation modal -> SWA proxy (server vouches you, derives tier/recipient/due, records then notifies); round-trips queue state onto the checklist (bwn:assist:state) with an ack/resolve panel; registers the Escalate launcher into the shared dock (bwn:dock:*)');

  // The canonical reason set. It MUST match VALID_REASONS in api/wo-assist - the server rejects
  // anything else, so the dashboard can group on a known vocabulary instead of free text.
  var REASONS = ['SLA breach', 'vendor no-show', 'client dispute', 'cost-GP decision', 'above-my-authority', 'safety-emergency'];

  // ---- BWN Ops Suite bus (read-only consumer of the suite data contract v1) ----
  // bwn-suite-core (WO Assist) PUBLISHES the current WO's facts to sessionStorage key
  // `bwn:wo:{id}`. We only READ it, so there is no coupling. Absent -> the fields just blank
  // out and the server still has everything it strictly needs (woNumber, reason, ask).
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
  // NON-Umbrava tokens. Sent ONLY to the declared @connect host, in the JSON BODY (the SWA
  // edge overwrites the Authorization header).
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
  // `json` is null when the body was not JSON. That distinction is load-bearing here: an
  // /api/* path that is NOT deployed does not 404 on this SWA - the route falls through to
  // the SPA fallback and returns 200 with an HTML page. A caller that only checks 2xx would
  // read that as a successful escalation that never happened (proven 2026-07-29 while
  // verifying this route's own deploy). Every success path below therefore requires JSON.
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

  // ---- Suite bus ------------------------------------------------------------
  var DOCK_KEY = 'assist';
  var _pendingSev = 0;      // set by bwn:assist:due, consumed by the next open
  var _pendingSource = 'button';
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail; if (!d) return;
    // The host ping doubles as the state-refresh tick: queryState is TTL-cached per WO,
    // so this re-queries only on an SPA nav to a different WO or every ~5 minutes.
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') { dockRegister(); queryState(woIdFromUrl()); queryCrState(woIdFromUrl()); }
    if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) openAssist();
    // Another tool took the drawer slot - close ours (a half-typed reason is dropped, same
    // as Escape). Matches every other drawer in the suite.
    if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) closeModal();
    // Core's playbook says this WO is past its escalate clock. Carry the severity so the
    // server can bump supervisor -> management, and open prefilled if asked to.
    // (Core does not emit this yet - the listener is the seam so it works the day it does.)
    if (d.id === 'bwn:assist:due') {
      if (typeof d.escSev === 'number') _pendingSev = d.escSev;
      _pendingSource = 'next-actions';
      if (d.open) openAssist();
    }
    // Step 4: Drop Upload marked a dropped inbound client email as owing a reply. It has no
    // egress of its own, so the POST and the ack are ours.
    if (d.id === 'bwn:assist:track') trackClientResponse(d);
    // Step 4 convergence: an outbound client reply was seen, so the item it answers is done.
    if (d.id === 'bwn:assist:resolve' && d.recordId) resolveById(String(d.recordId), d.wo ? String(d.wo) : '');
  });

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // ONE entry. detail.key carries the entry id (detail.id is the bwn:evt event name - the
  // documented deviation in the dock contract). Weight 25 sits between WO Audit (20) and
  // Ask BWN (30). No self-drawn fallback button: the dock tab and the Tampermonkey menu are
  // the two launchers, matching the post-v2.0.4 suite where nothing floats.
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Escalate', icon: '🚩', weight: 25,
        title: 'Escalate this work order to management'
      } }));
    } catch (e) { }
  }

  // ---- Assist state round-trip (queue-spec step 3) ---------------------------
  // The WO Assist checklist (bwn-suite-core, @grant none) cannot ask the server
  // anything, so THIS script owns the read side: query the queue for the current
  // WO's ACTIVE escalation (op:'status') and publish it two ways - sessionStorage
  // bwn:assist:state:<woId> for render-time reads, plus a bwn:assist:state bus
  // event for live re-render. Core renders "Escalated - awaiting mgmt" from it and
  // relabels the checklist button; this drawer renders the ack/resolve panel.
  // Freshness: re-queried when the WO changes or every 5 minutes (dock ping tick),
  // forced on drawer open and after every submit or verb - so a dashboard-side
  // resolve clears the strip within minutes, never sessions.
  var SS_STATE = 'bwn:assist:state:';
  var QUERY_TTL_MS = 5 * 60000;
  var _lastQ = { wo: null, ts: 0 };
  function publishState(woId, found, record) {
    if (!woId) return;
    try { sessionStorage.setItem(SS_STATE + woId, JSON.stringify({ v: 1, ts: Date.now(), found: !!found, record: record || null })); } catch (e) { }
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:assist:state', wo: woId, found: !!found, record: record || null } })); } catch (e) { }
  }
  function queryState(woId, force) {
    if (!woId) return;
    var key = GM_getValue('ingest_key', '');
    if (!key) return;                       // unset key = no read; the drawer nags on open
    var tok = authToken();
    if (!tok) return;
    if (!force && _lastQ.wo === woId && (Date.now() - _lastQ.ts) < QUERY_TTL_MS) return;
    _lastQ = { wo: woId, ts: Date.now() };
    gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { op: 'status', userToken: tok, woNumber: woId, client: 'pilot' }, 20000)
      .then(function (r) {
        // A route that predates step 3 400s the op: publish NOTHING, so the checklist
        // simply looks the way it did before the round-trip existed.
        if (r.json && r.json.ok) publishState(woId, !!r.json.found, r.json.record || null);
      })
      .catch(function () { });
  }
  // POST a lifecycle verb against a record. applied:false is a SYNC, not an error -
  // somebody else (usually the dashboard) got there first; re-publish what the server
  // says and let the open drawer re-render from its own bus listener.
  function verbPost(op, rec, msg, btns) {
    var woId = rec.woNumber || woIdFromUrl();
    var key = GM_getValue('ingest_key', '');
    if (!key) { msg.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }
    var userToken = authToken();
    if (!userToken) { msg.textContent = 'No usable Umbrava session token right now - reload the tab, then try again.'; return; }
    msg.textContent = '';
    btns.forEach(function (b) { b.disabled = true; });
    gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { op: op, userToken: userToken, id: rec.id, client: 'pilot' }, 30000)
      .then(function (r) {
        var j = r.json;
        if (r.status >= 200 && r.status < 300 && !j) {
          btns.forEach(function (b) { b.disabled = false; });
          msg.textContent = 'The escalation route did not answer (the server returned a page, not a result).';
          return;
        }
        if (r.status >= 200 && r.status < 300 && j && j.ok) {
          var rec2 = j.record || null;
          var active = rec2 && (rec2.status === 'open' || rec2.status === 'ack');
          publishState(woId, !!active, active ? rec2 : null);   // the open drawer re-renders off this
          if (!j.applied) { toast('Already ' + ((rec2 && rec2.status) || 'changed') + ' - view refreshed.', 6000, '#8a5a00'); return; }
          if (op === 'resolve') { closeModal(); toast('Resolved ✓  This WO can be escalated again if it comes back.', 8000); return; }
          toast('Acknowledged - marked as being handled.', 7000);
          return;
        }
        btns.forEach(function (b) { b.disabled = false; });
        var code = (j && j.code) || '';
        if (r.status === 404) {
          publishState(woId, false, null);
          toast('That escalation is no longer in the queue - view refreshed.', 7000, '#8a5a00');
        } else if (r.status === 400 && j && /woNumber/.test(j.error || '')) {
          // A route that predates step 3 validates CREATE fields against a verb body and
          // complains about woNumber - a diagnostic fingerprint worth naming.
          msg.textContent = 'The escalation server does not know ack/resolve yet (route update not deployed) - tell Mike.';
        } else if (r.status === 401) {
          msg.textContent = 'Umbrava could not verify your session (' + (code || '401') + ') - reload the tab and try again.';
        } else if (r.status === 403) {
          msg.textContent = 'Rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.';
        } else if (r.status === 503) {
          msg.textContent = 'The queue is busy (' + ((j && j.error) || '503') + ') - try again in a moment.';
        } else {
          msg.textContent = 'Failed (' + r.status + ')' + (j && j.error ? ': ' + j.error : '') + '.';
        }
      })
      .catch(function (err) {
        btns.forEach(function (b) { b.disabled = false; });
        msg.textContent = (err && err.message ? err.message : 'could not reach the proxy') + '.';
      });
  }

  // ---- Client-response tracking (queue-spec step 4) --------------------------
  // THE ZERO-EGRESS SPLIT. Drop Upload is @grant none - it cannot POST anywhere - so when a
  // coordinator marks a dropped inbound email as owing a reply, it EMITS bwn:assist:track and
  // this script does the network. The handshake is two-way on purpose: every track is answered
  // with bwn:assist:tracked, success or failure, so the drop side can say "not tracked" instead
  // of leaving the coordinator believing a queue item exists. Silence is the one outcome the
  // drop side cannot interpret, so this function never returns without acking.
  var TRACK_KIND = 'client-response';
  var _trackSeen = {};        // reqId -> ts; a re-broadcast bus event must not post twice
  function trackAck(reqId, ok, why, recordId) {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:assist:tracked', reqId: reqId || '', ok: !!ok, why: why || '', recordId: recordId || ''
      } }));
    } catch (e) { }
  }
  function trackClientResponse(d) {
    var reqId = String(d.reqId || '');
    // Dedup on the request id. Two tabs on the same WO both hear the bus event, and the
    // server would dedup the second anyway - but a duplicate POST also burns the per-actor
    // rate limit and races its own ack.
    if (reqId && _trackSeen[reqId]) return;
    if (reqId) _trackSeen[reqId] = Date.now();
    var woId = String(d.woNumber || woIdFromUrl() || '');
    if (!woId) { trackAck(reqId, false, 'no work order in view'); return; }
    var key = GM_getValue('ingest_key', '');
    if (!key) { trackAck(reqId, false, 'the SWA ingest key is not set (Tampermonkey menu -> "Set SWA ingest key")'); return; }
    var tok = authToken();
    if (!tok) { trackAck(reqId, false, 'no usable Umbrava session token - reload the tab'); return; }
    var emailFrom = String(d.emailFrom || '').slice(0, 200);
    if (!emailFrom) { trackAck(reqId, false, 'that email has no sender to track it by'); return; }
    var bus = busGet(woId, 12 * 3600 * 1000) || {};
    gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, {
      userToken: tok, client: 'pilot', kind: TRACK_KIND, woNumber: woId,
      emailFrom: emailFrom,
      emailSubject: String(d.emailSubject || '').slice(0, 300),
      ask: String(d.ask || '').slice(0, 4000),
      docRef: String(d.docRef || '').slice(0, 300),
      location: bus.location || '', trade: bus.trade || '',
      priority: bus.priority || '', woStatus: bus.status || '',
      source: 'drop'
    }, 30000)
      .then(function (r) {
        var j = r.json;
        // 2xx with a non-JSON body means the SPA fallback answered, i.e. the route is not
        // deployed. Same trap the escalate path guards; a bare 2xx is not proof of anything.
        if (r.status >= 200 && r.status < 300 && !j) { trackAck(reqId, false, 'the assist route did not answer (a page came back, not a result)'); return; }
        if (r.status >= 200 && r.status < 300 && j && j.ok) {
          // Refresh the published client-response state either way - the queue now holds an
          // item for this WO, and anything rendering off bwn:assist:cr should know now rather
          // than up to five minutes later.
          queryCrState(woId, true);
          if (j.duplicate) { trackAck(reqId, true, 'already tracked - opened ' + shortWhen(j.openedAt), j.id); return; }
          // 502-with-recorded is handled below; here the record and the confirmation both landed.
          trackAck(reqId, true, '', j.id);
          return;
        }
        if (r.status === 502 && j && j.recorded) {
          // The item IS in the queue; only the confirmation email failed. Reporting this as a
          // failure would invite a re-drop that the server would dedup-refuse, so it acks OK
          // and says what did not happen.
          queryCrState(woId, true);
          trackAck(reqId, true, 'tracked, but the confirmation email did not send', j.id);
          return;
        }
        if (r.status === 400 && j && /kind must be one of/.test(j.error || '')) {
          // A route that predates step 4 rejects the kind outright - a diagnostic fingerprint,
          // the same shape step 3 used for its own not-yet-deployed case.
          trackAck(reqId, false, 'the assist server does not know client-response yet (route update not deployed)');
          return;
        }
        var msg = (j && j.error) ? j.error : ('failed (' + r.status + ')');
        if (r.status === 403) msg = 'rejected (403): the SWA ingest key is missing or wrong';
        if (r.status === 401) msg = 'Umbrava could not verify your session - reload the tab';
        if (r.status === 429) msg = 'too many requests in a row - wait a moment';
        trackAck(reqId, false, msg);
      })
      .catch(function (err) { trackAck(reqId, false, (err && err.message) || 'could not reach the assist proxy'); });
  }
  // The client-response side of the state round-trip, kept in its OWN sessionStorage key and
  // its own bus event. Sharing `bwn:assist:state` would make Core's escalation strip flicker
  // between two records that mean different things.
  var SS_CR = 'bwn:assist:cr:';
  var _lastCrQ = { wo: null, ts: 0 };
  var _crAutoTried = {};   // record id -> 1: convergence fires ONCE per item per page session
  function publishCr(woId, found, record) {
    if (!woId) return;
    try { sessionStorage.setItem(SS_CR + woId, JSON.stringify({ v: 1, ts: Date.now(), found: !!found, record: record || null })); } catch (e) { }
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:assist:cr', wo: woId, found: !!found, record: record || null } })); } catch (e) { }
  }
  function queryCrState(woId, force) {
    if (!woId) return;
    var key = GM_getValue('ingest_key', ''); if (!key) return;
    var tok = authToken(); if (!tok) return;
    if (!force && _lastCrQ.wo === woId && (Date.now() - _lastCrQ.ts) < QUERY_TTL_MS) return;
    _lastCrQ = { wo: woId, ts: Date.now() };
    gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { op: 'status', userToken: tok, woNumber: woId, client: 'pilot', kind: TRACK_KIND }, 20000)
      .then(function (r) {
        // A route that predates step 4 400s the kind: publish NOTHING, exactly as step 3 does
        // for its own not-yet-deployed case, so the page looks as it did before.
        if (!(r.json && r.json.ok)) return;
        var rec = r.json.found ? (r.json.record || null) : null;
        publishCr(woId, !!rec, rec);
        if (rec) maybeConverge(woId, rec);
      })
      .catch(function () { });
  }
  // CONVERGENCE. The item closes on an OUTBOUND client reply, and the signal is Core's newest
  // client-typed note being newer than the item's openedAt. That test is only sound because the
  // drop re-types its own inbound log note to Internal - otherwise logging the question would
  // instantly answer it. Bounded to one attempt per item per page session: a server that says
  // "already resolved" must not be asked again on every 5-minute tick.
  function maybeConverge(woId, rec) {
    if (!rec || !rec.id || _crAutoTried[rec.id]) return;
    if (rec.status !== 'open' && rec.status !== 'ack') return;
    var bus = busGet(woId, 12 * 3600 * 1000) || {};
    var lastClient = bus.lastClientNote || '';
    // String compare is correct here and cheap: both are ISO-8601 UTC from the same clock.
    if (!lastClient || !rec.openedAt || lastClient <= rec.openedAt) return;
    _crAutoTried[rec.id] = 1;
    resolveById(rec.id, woId);
  }
  // Convergence: something in the page (Core's note reader) decided this item is answered.
  // Fire the same resolve verb the drawer uses. No UI here - the emitter owns the telling -
  // but the state is republished so the checklist strip clears on the next render.
  function resolveById(id, woId) {
    var key = GM_getValue('ingest_key', ''), tok = authToken();
    if (!id || !key || !tok) return;
    gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { op: 'resolve', userToken: tok, id: id, client: 'pilot' }, 30000)
      .then(function (r) {
        if (r.json && r.json.ok) {
          var rec = r.json.record || null;
          var active = rec && (rec.status === 'open' || rec.status === 'ack');
          publishState(woId || woIdFromUrl(), !!active, active ? rec : null);
          if (r.json.applied) toast('Client response logged - that item is closed ✓', 7000);
        }
      })
      .catch(function () { });
  }

  // ---- Drawer ---------------------------------------------------------------
  var openEl = null;
  var openStateEvt = null;   // the open drawer's bwn:assist:state listener, removed on close
  function closeModal() {
    if (openEl) {
      openEl.remove(); openEl = null;
      document.removeEventListener('keydown', onKey);
      if (openStateEvt) { document.removeEventListener('bwn:evt', openStateEvt); openStateEvt = null; }
    }
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  function openAssist() {
    if (openEl) return;
    var woId = woIdFromUrl();
    if (!woId) { toast('Open a work order first - Escalate needs a WO to escalate.', 5000, '#8a5a00'); return; }
    var bus = busGet(woId, 12 * 3600 * 1000) || {};
    var me = actor();
    var sev = _pendingSev; _pendingSev = 0;
    var source = _pendingSource; _pendingSource = 'button';

    var back = document.createElement('aside');
    back.id = 'bwn-drawer-assist'; back.className = 'bwn-drawer';
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-label', 'Escalate this work order');
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }

    var card = document.createElement('div');
    card.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;color:#12241b;font:400 14px ' + FONT + ';';

    var head = document.createElement('div');
    head.className = 'bwn-drawer-hd';
    head.innerHTML = '<div><div class="t">Escalate</div><div class="s">ask management to step in</div></div>';
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'bwn-drawer-x'; x.textContent = '×';
    x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeModal);
    head.appendChild(x);

    card.appendChild(head);

    // Content area: the escalation FORM, or - when the queue already holds an ACTIVE
    // item for this WO - the state PANEL (acknowledge/resolve). Swapped live: the
    // drawer listens for bwn:assist:state while open, so a verb, a background refresh,
    // or a dashboard-side flip re-renders it in place.
    var content = null;
    function setContent(node) { if (content) content.remove(); content = node; card.appendChild(node); }
    function activeRec(d) { return (d && d.found && d.record && (d.record.status === 'open' || d.record.status === 'ack')) ? d.record : null; }
    function renderContent(rec) { setContent(rec ? buildPanel(rec) : buildForm()); }
    openStateEvt = function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:assist:state' && d.wo === woId && openEl === back) renderContent(activeRec(d));
    };
    document.addEventListener('bwn:evt', openStateEvt);

    function buildForm() {
    var form = document.createElement('form');
    form.className = 'bwn-drawer-body';
    form.setAttribute('autocomplete', 'off');

    // Who it comes from and who decides where it goes. The server derives BOTH the tier and
    // the recipient from the vouched rank - deliberately not shown as a choice, because a
    // client-picked recipient would be spoofable and would drift from Core's own wording.
    var who = document.createElement('div');
    who.style.cssText = 'font-size:12.5px;color:#33473d;background:#eef4f0;border:1px solid #cfe0d7;border-radius:8px;padding:8px 11px;margin-bottom:14px;line-height:1.45;';
    who.textContent = (me.email ? 'Escalating as ' + me.email + '. ' : '')
      + 'Who it goes to is worked out from your role - you do not pick it.';
    form.appendChild(who);

    // Context snapshot, read-only. It is what the manager sees in the notify, so show exactly
    // what will be sent rather than asking the coordinator to retype any of it.
    var ctxLines = [];
    ctxLines.push('WO ' + woId + (bus.client ? '  ' + bus.client : ''));
    if (bus.location) ctxLines.push(bus.location);
    if (bus.status) ctxLines.push('Status: ' + bus.status);
    if (bus.priority) ctxLines.push('Priority: ' + bus.priority);
    var ctxBox = document.createElement('div');
    ctxBox.style.cssText = 'font:500 11.5px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:#33473d;background:#f6f9f7;border:1px solid #dbe7e1;border-radius:8px;padding:8px 11px;margin-bottom:14px;line-height:1.5;white-space:pre-line;';
    ctxBox.textContent = ctxLines.join('\n');
    form.appendChild(ctxBox);

    var lblCss = 'display:block;font-weight:600;font-size:12px;margin:0 0 4px;color:#33473d;';
    var inCss = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #c6d2cc;border-radius:8px;font:400 14px ' + FONT + ';background:#fff;color:#12241b;';

    var wrapR = document.createElement('div'); wrapR.style.cssText = 'margin-bottom:13px;';
    var lblR = document.createElement('label'); lblR.style.cssText = lblCss; lblR.textContent = 'Why does this need management? *';
    var sel = document.createElement('select'); sel.style.cssText = inCss;
    var ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Pick a reason...'; sel.appendChild(ph);
    REASONS.forEach(function (r) { var o = document.createElement('option'); o.value = r; o.textContent = r; sel.appendChild(o); });
    wrapR.appendChild(lblR); wrapR.appendChild(sel); form.appendChild(wrapR);

    var wrapA = document.createElement('div'); wrapA.style.cssText = 'margin-bottom:13px;';
    var lblA = document.createElement('label'); lblA.style.cssText = lblCss; lblA.textContent = 'What do you need from them? *';
    var ta = document.createElement('textarea'); ta.rows = 5; ta.style.cssText = inCss + 'resize:vertical;';
    ta.placeholder = 'What you have already tried, and the decision or action you need.';
    wrapA.appendChild(lblA); wrapA.appendChild(ta); form.appendChild(wrapA);

    var msg = document.createElement('div');
    msg.style.cssText = 'font-size:12.5px;color:#8a1c1c;margin:2px 0 10px;line-height:1.45;min-height:1em;';
    form.appendChild(msg);

    var foot = document.createElement('div');
    foot.className = 'bwn-drawer-ft';
    var submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = 'Escalate';
    submit.style.cssText = 'padding:9px 16px;border:none;border-radius:8px;background:' + GREEN + ';color:#fff;font:600 13px ' + FONT + ';cursor:pointer;';
    foot.appendChild(submit);
    form.appendChild(foot);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';

      var key = GM_getValue('ingest_key', '');
      if (!key) { msg.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }
      var userToken = authToken();
      if (!userToken) { msg.textContent = 'No usable Umbrava session token right now - reload the tab, then try again.'; return; }
      var reason = sel.value;
      var ask = (ta.value || '').trim();
      if (!reason) { msg.textContent = 'Pick a reason.'; return; }
      if (!ask) { msg.textContent = 'Say what you need from them.'; return; }

      var payload = {
        userToken: userToken,
        woNumber: woId,
        client: 'pilot',
        location: bus.location || '',
        trade: bus.trade || '',
        priority: bus.priority || '',
        woStatus: bus.status || '',
        reason: reason,
        ask: ask,
        escSev: sev,
        source: source
      };

      var reenable = function () { submit.disabled = false; submit.textContent = 'Escalate'; };
      submit.disabled = true;
      submit.textContent = 'Escalating…';

      gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 30000)
        .then(function (r) {
          var j = r.json;
          var code = (j && j.code) || '';
          // A 2xx with no JSON body is the SPA fallback page, not this route - treat it as a
          // failure, never as a sent escalation.
          if (r.status >= 200 && r.status < 300 && !j) {
            reenable();
            msg.textContent = 'The escalation route did not answer (the server returned a page, not a result). Tell Mike the /api/wo-assist route may not be deployed.';
            return;
          }
          if (r.status >= 200 && r.status < 300 && j && j.ok) {
            closeModal();
            if (j.duplicate) {
              // The queue already holds the open item - publish what the response carries
              // (requester unknown here), then force a status read to backfill the rest.
              publishState(woId, true, { id: j.id, kind: 'mgmt-assist', woNumber: woId, requester: '', tier: j.tier || '', recipient: j.recipient || '', reason: '', ask: '', status: j.status || 'open', openedAt: j.openedAt || '', dueAt: j.dueAt || '', ackAt: '', assignee: '' });
              queryState(woId, true);
              toast('Already escalated and still open - nobody was notified twice. Opened ' + shortWhen(j.openedAt) + '.', 8000, '#8a5a00');
              return;
            }
            // A fresh record: synthesize the published state from the response + the form
            // (that IS the record the server just wrote), so the checklist strip appears
            // immediately without a second round trip.
            publishState(woId, true, {
              id: j.id, kind: 'mgmt-assist', woNumber: woId, requester: me.email || '',
              tier: j.tier || '', recipient: j.recipient || '', reason: reason, ask: ask,
              status: 'open', openedAt: j.openedAt || new Date().toISOString(),
              dueAt: j.dueAt || '', ackAt: '', assignee: ''
            });
            _lastQ = { wo: woId, ts: Date.now() };
            if (j.tier === 'own-call') {
              toast('Recorded - but there is nobody above you to escalate to, so this one is yours to decide. It is in the queue.', 9000, '#8a5a00');
            } else if (j.notified === false) {
              toast('Escalation recorded, but the notify did not send. It is in the queue - follow up directly.', 9000, '#8a5a00');
            } else {
              toast('Escalated to ' + (j.tier || 'management') + ' ✓  Due ' + shortWhen(j.dueAt) + '.', 8000);
            }
          } else if (r.status === 401) {
            reenable(); msg.textContent = 'Umbrava could not verify your session (' + (code || '401') + ') - reload the tab and try again.';
          } else if (r.status === 403 && code === 'WRONG_TENANT') {
            reenable(); msg.textContent = 'Your account is not on the Broadway tenant, so the escalation was rejected.';
          } else if (r.status === 403) {
            reenable(); msg.textContent = 'Rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.';
          } else if (r.status === 429) {
            reenable(); msg.textContent = 'Too many submissions in a row - wait a moment and try again.';
          } else if (r.status === 502 && j && j.recorded) {
            // The record IS durable; only the notify failed. Do not invite a resubmit -
            // and publish the state, because the queue really does hold an open item now.
            closeModal();
            publishState(woId, true, {
              id: j.id, kind: 'mgmt-assist', woNumber: woId, requester: me.email || '',
              tier: j.tier || '', recipient: '', reason: reason, ask: ask, status: 'open',
              openedAt: j.openedAt || new Date().toISOString(), dueAt: j.dueAt || '', ackAt: '', assignee: ''
            });
            toast('Escalation recorded, but the notify could not be sent. It is in the queue - follow up directly.', 9000, '#8a5a00');
          } else if (r.status === 503) {
            reenable(); msg.textContent = 'Escalation is not switched on yet' + (j && j.error ? ' (' + j.error + ')' : '') + ' - tell Mike.';
          } else {
            reenable(); msg.textContent = 'Escalate failed (' + r.status + ')' + (j && j.error ? ': ' + j.error : '') + '.';
          }
        })
        .catch(function (err) {
          reenable(); msg.textContent = (err && err.message ? err.message : 'could not reach the proxy') + '.';
        });
    });

    setTimeout(function () { try { sel.focus(); } catch (e2) { } }, 30);
    return form;
    }

    // The state panel: what is already escalated, who has it, and the two verbs. Shown
    // instead of the form whenever the queue holds an ACTIVE item - the server would
    // dedup-refuse a second submit anyway, so offer the truth and the next moves.
    function buildPanel(rec) {
      var box = document.createElement('div');
      box.className = 'bwn-drawer-body';

      var note = document.createElement('div');
      note.style.cssText = 'font-size:12.5px;color:#7a4d00;background:#fdf3e2;border:1px solid #ecd9b0;border-radius:8px;padding:8px 11px;margin-bottom:14px;line-height:1.45;';
      note.textContent = rec.status === 'ack'
        ? 'This work order is escalated and management has acknowledged it.'
        : 'This work order already has an open escalation - nobody gets notified twice while it is open.';
      box.appendChild(note);

      var lines = [];
      lines.push('WO ' + (rec.woNumber || woId));
      if (rec.requester) lines.push('Escalated by ' + rec.requester);
      lines.push('Opened ' + shortWhen(rec.openedAt) + (rec.dueAt ? ' · due ' + shortWhen(rec.dueAt) : ''));
      if (rec.tier) lines.push('Routed to: ' + rec.tier + (rec.recipient ? ' (' + rec.recipient + ')' : ''));
      if (rec.reason) lines.push('Reason: ' + rec.reason);
      if (rec.status === 'ack') lines.push('Acknowledged by ' + (rec.assignee || 'management') + (rec.ackAt ? ' ' + shortWhen(rec.ackAt) : ''));
      var ctx = document.createElement('div');
      ctx.style.cssText = 'font:500 11.5px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:#33473d;background:#f6f9f7;border:1px solid #dbe7e1;border-radius:8px;padding:8px 11px;margin-bottom:13px;line-height:1.55;white-space:pre-line;';
      ctx.textContent = lines.join('\n');
      box.appendChild(ctx);

      if (rec.ask) {
        var lblQ = document.createElement('div');
        lblQ.style.cssText = 'font-weight:600;font-size:12px;margin:0 0 4px;color:#33473d;';
        lblQ.textContent = 'What they asked for';
        var askEl = document.createElement('div');
        askEl.style.cssText = 'font-size:13px;color:#12241b;background:#fff;border:1px solid #c6d2cc;border-radius:8px;padding:9px 11px;margin-bottom:13px;line-height:1.5;max-height:180px;overflow:auto;white-space:pre-wrap;';
        askEl.textContent = rec.ask;
        box.appendChild(lblQ); box.appendChild(askEl);
      }

      var msg = document.createElement('div');
      msg.style.cssText = 'font-size:12.5px;color:#8a1c1c;margin:2px 0 10px;line-height:1.45;min-height:1em;';
      box.appendChild(msg);

      var foot = document.createElement('div');
      foot.className = 'bwn-drawer-ft';
      var btns = [];
      function mkBtn(label, ghost) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.style.cssText = ghost
          ? 'padding:9px 16px;border:1px solid #c6d2cc;border-radius:8px;background:#fff;color:' + GREEN + ';font:600 13px ' + FONT + ';cursor:pointer;'
          : 'padding:9px 16px;border:none;border-radius:8px;background:' + GREEN + ';color:#fff;font:600 13px ' + FONT + ';cursor:pointer;';
        btns.push(b); foot.appendChild(b); return b;
      }
      if (rec.status === 'open') {
        mkBtn('Mgmt has it - acknowledge', true).addEventListener('click', function () { verbPost('ack', rec, msg, btns); });
      }
      mkBtn('Mark resolved', false).addEventListener('click', function () { verbPost('resolve', rec, msg, btns); });
      box.appendChild(foot);
      return box;
    }

    // Decide from the last published state (fresh enough for UI - the server still
    // gates), then force a re-query; if anything changed, openStateEvt re-renders.
    var cached = null;
    try {
      var c0 = JSON.parse(sessionStorage.getItem(SS_STATE + woId) || 'null');
      if (c0 && c0.v === 1) cached = activeRec(c0);
    } catch (e) { }
    renderContent(cached);
    queryState(woId, true);

    back.appendChild(card);
    document.body.appendChild(back);
    openEl = back;
    document.addEventListener('keydown', onKey);
  }

  function shortWhen(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(+d)) return 'shortly';
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return 'shortly'; }
  }

  // ---- Tampermonkey menu (always-present launcher, dock or no dock) --------
  try {
    GM_registerMenuCommand('Escalate this work order', openAssist);
    GM_registerMenuCommand('Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', GM_getValue('ingest_key', '') || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { }

  dockRegister();
  queryState(woIdFromUrl());   // page may load straight onto a WO; the ping tick keeps it fresh after
})();
