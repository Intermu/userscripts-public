// ==UserScript==
// @name         BWN WO Assist (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-wo-assist.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-wo-assist.user.js
// @description  Escalate a work order to management from inside Umbrava. Pick why and say what you need; it POSTs to the broadway-internal-ops SWA proxy (x-bwn-key gated) which proves your Umbrava session token, injects your verified email as the requester, works out WHO it goes to from your rank (a coordinator escalates to a supervisor, a supervisor to management, a director owns the call), sets a due clock scaled by the job's priority, records the item in the shared assist queue, and only then sends the notify. Escalating the same work order twice while the first is still open is rejected server-side, so two tabs cannot double-fire. Registers one "Escalate" entry in the shared dock tab and adds an Escalate button to the WO Assist checklist's escalation step; a Tampermonkey menu item opens it too, so it is never stranded. The flow's secret URL stays server-side; nothing sensitive lives in this script.
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

  var VER = '0.1.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/wo-assist';
  var GREEN = '#0d3d26';
  console.info('[BWN WO ASSIST] v' + VER + ' - escalation modal -> SWA proxy (server vouches you, derives tier/recipient/due, records then notifies); registers the Escalate launcher into the shared dock (bwn:dock:*)');

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
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') dockRegister();
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

  // ---- Drawer ---------------------------------------------------------------
  var openEl = null;
  function closeModal() {
    if (openEl) { openEl.remove(); openEl = null; document.removeEventListener('keydown', onKey); }
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
              toast('Already escalated and still open - nobody was notified twice. Opened ' + shortWhen(j.openedAt) + '.', 8000, '#8a5a00');
            } else if (j.tier === 'own-call') {
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
            // The record IS durable; only the notify failed. Do not invite a resubmit.
            closeModal();
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

    card.appendChild(head); card.appendChild(form);
    back.appendChild(card);
    document.body.appendChild(back);
    openEl = back;
    document.addEventListener('keydown', onKey);
    setTimeout(function () { sel.focus(); }, 30);
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
})();
