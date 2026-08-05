// ==UserScript==
// @name         BWN WO Kanban (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.4.0
// @description  Turns Umbrava's Work Orders list into a kanban board without leaving the page. A Board/List toggle sits next to the list's own search box; switching to Board hides the table (the toolbar stays, so the app's own filtering still drives everything) and lays the same work orders out as cards in lanes. Lanes are WO Status by default and regroup to Priority, Assignee, Client or Age from a dropdown. The board never invents its own filter system - it captures the SPA's own PagedWorkOrders request (query, variables AND auth headers) off the wire and replays it with a larger page size, so whatever the list is filtered to (phase, statuses, search, assignee chips, sort) is exactly what the board shows, and changing a filter re-scans. Cards carry the triage picture: the status clock against the limit that WO was actually judged against, the reasons it is flagged, whether its onsite date has already passed, DNE vs vendor NTE with GP, vendors and trades. Severity is never computed here - it is read from the verdicts List Heat publishes in bwn-suite-core, so the board and the list can never disagree. Dragging a card between status lanes DOES change the work order, through Umbrava's own captured PatchWorkOrder mutation - it asks first, states that the WO's time-in-status clock will reset, verifies the server reported success, re-scans rather than trusting the optimistic move, and leaves the card where it was if anything fails. Everything is same-origin using the page's own session: no @connect, no keys, nothing leaves the browser.
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-kanban.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-kanban.user.js
// @match        https://app.umbrava.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

// WHY @grant none, and why it is not optional here (fixed in 0.3.0, found live):
// with any GM_* grant Tampermonkey runs the script in its SANDBOX, whose `window` is NOT the
// page's. Hooking `window.fetch` there hooks the sandbox copy, so the SPA's own /api/graphql
// calls go straight past it and the board would never capture a query - it would sit on
// "waiting for the list to run its own query" forever. bwn-suite-core stays `@grant none` for
// exactly this reason. Persistence therefore uses localStorage instead of GM_getValue.

(function () {
  'use strict';

  // Read from the metadata block rather than hand-kept: 0.3.0 shipped with @version 0.3.0 and
  // this constant still reading '0.2.0', so the console said one thing and Tampermonkey's
  // update check another. There is no GM_info without a grant (and a grant would sandbox the
  // script away from the page's fetch - see the header note), so the fallback is a literal
  // that must be bumped WITH @version; the harness pins the two together.
  var VER = '0.4.0';
  console.info('[BWN KANBAN] v' + VER + ' - board view over the captured PagedWorkOrders query; severity read from List Heat verdicts; drag between status lanes writes via captured PatchWorkOrder');

  // ---------------------------------------------------------------------------
  // 0. Constants, measured 2026-08-04 against the live board
  // ---------------------------------------------------------------------------
  // The board query is `PagedWorkOrders` -> `listWorkOrdersPaginated`. Its variables carry
  // every filter the list UI applies (phase, statuses, statusesInclusive, search, assignedTo,
  // onlyUnassigned, sortBy, locationIds, regionIds, regionPrefixes), so replaying the captured
  // variables with a bigger `page.take` IS "inherit the list's filters" - there is no second
  // filter system to keep in sync, by design.
  //
  // /api/graphql rejects a bare same-origin fetch with "No authentication method provided."
  // (measured), so the captured request's HEADERS are replayed too - that is where the Auth0
  // bearer lives. The bearer never leaves the page: same origin, no @connect, no GM_xhr.
  var OP = 'PagedWorkOrders';
  var PAGE_TAKE = 200;        // per replayed page
  var MAX_ROWS = 2000;        // hard ceiling, so a bad filter cannot walk forever
  var CARD_SCOPE_CHARS = 140;
  var LS_VIEW = 'bwn:kanban:view';      // 'board' | 'list'
  var LS_GROUP = 'bwn:kanban:group';

  // Lane roll-up. Measured live 2026-08-05 on a 219-row open board: 26 status lanes, of which
  // 11 held 3 cards or fewer (23 cards, 10% of the board) and sat off the right edge behind a
  // horizontal scroll, while 3 lanes held 95 cards between them. Rolling the stragglers into
  // one reachable lane takes 26 down to 16. Only kicks in on a genuinely sprawling board, so a
  // small filtered board still shows every status as its own lane.
  var LANE_ROLL_MAX = 3;      // a lane this size or smaller is a roll-up candidate
  var LANE_ROLL_WHEN = 12;    // ...but only once there are more lanes than this
  var OTHER_LANE = 'Other statuses';

  // Verdicts are read from the bus slot bwn-suite-core publishes (`bwn:heat:{id}`), never
  // computed here. bwnThresholdsFor is file-local to that script on purpose, so a limit
  // calculated in this file would be a second copy of the threshold model - exactly the drift
  // one shared computeVerdict exists to prevent. No record = no severity claim, which is not
  // the same as "this WO is fine" and is never rendered as if it were.
  var HEAT_MAX_AGE = 30 * 60000;   // 30 min: older than that and the scan is not this board

  // Status writes are ON, and the shape below is CAPTURED, not guessed. Recorded 2026-08-04 off
  // a real status change made through Umbrava's own WO Status dropdown on W-371126 (tracking
  // 1226465), Fabrication -> Awaiting Supplier -> Fabrication:
  //
  //   mutation PatchWorkOrder($data: PatchWorkOrderInput!) {
  //     patchWorkOrder(data: $data) { success message workOrder { ...WorkOrderFields } } }
  //   variables: { data: { workOrderNumber: 371126, statusId: { shouldInclude: true, value: 77 } } }
  //
  // Note the PATCH semantics: send ONLY the field being changed, each wrapped as
  // {shouldInclude, value}. It is NOT BulkUpdateWorkOrders - that was the wrong candidate.
  // The selection set below is trimmed to `success message` (both present in the captured
  // document); the operation name and the input shape are byte-faithful to the capture.
  //
  // Measured side effect, and the reason for the confirm step: changing status RESETS the
  // work order's time-in-status clock. The old value does not come back if you change it back.
  var WRITE_ENABLED = true;
  var PATCH_OP = 'PatchWorkOrder';
  var PATCH_QUERY = 'mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }';

  var GROUPS = [
    { id: 'status', label: 'WO Status', key: function (r) { return r.statusName || 'No status'; } },
    { id: 'priority', label: 'Priority', key: function (r) { return (r.priority && r.priority.label) || 'No priority'; } },
    { id: 'assignee', label: 'Assigned To', key: function (r) { return r.assignedToMemberName || 'Unassigned'; } },
    { id: 'client', label: 'Client', key: function (r) { return r.clientName || 'No client'; } },
    { id: 'age', label: 'Age', key: function (r) { return ageBucket(r.numberOfDays); } }
  ];

  function ageBucket(d) {
    d = Number(d) || 0;
    if (d > 30) return 'Over 30 days';
    if (d > 14) return '15-30 days';
    if (d > 7) return '8-14 days';
    return '0-7 days';
  }

  // ---------------------------------------------------------------------------
  // 1. Capture. Installed at document-start so the list's FIRST board request is seen.
  // ---------------------------------------------------------------------------
  var lastReq = null;   // { query, variables, headers, ts }
  var scanSeq = 0;

  function headersToObject(src) {
    var h = {};
    if (!src) return h;
    try {
      if (typeof src.forEach === 'function') src.forEach(function (v, k) { h[k] = v; });
      else Object.keys(src).forEach(function (k) { h[k] = src[k]; });
    } catch (e) { /* exotic header bag - replay will just fail loudly */ }
    return h;
  }

  function noteRequest(body, headers) {
    var j;
    try { j = JSON.parse(body); } catch (e) { return; }
    if (!j || j.operationName !== OP || !j.query) return;
    var prev = lastReq;
    lastReq = { query: j.query, variables: j.variables || {}, headers: headersToObject(headers), ts: Date.now() };
    // A changed filter means changed variables (page aside) - that is the re-scan trigger.
    if (prev && filtersOf(prev.variables) !== filtersOf(lastReq.variables)) scheduleRescan();
    else if (!prev) scheduleRescan();
  }

  function filtersOf(v) {
    var c = {};
    Object.keys(v || {}).forEach(function (k) { if (k !== 'page') c[k] = v[k]; });
    try { return JSON.stringify(c); } catch (e) { return String(Math.random()); }
  }

  // Hardened in 0.3.0: this used to run bare at top level, so anything it threw killed the
  // whole script before boot() was ever registered - no CSS, no menu entry, no toggle button,
  // and no error anyone would look for. The board is still useful with a half-installed hook
  // (the other transport may still capture), so failures here must never be fatal.
  function installHooks() {
    var of = window.fetch;
    if (typeof of === 'function') {
      window.fetch = function (input, init) {
        try {
          var url = (typeof input === 'string') ? input : (input && input.url) || '';
          if (/\/api\/graphql/.test(url)) {
            var body = (init && init.body) || null;
            var hdr = (init && init.headers) || (input && input.headers);
            if (typeof body === 'string') noteRequest(body, hdr);
          }
        } catch (e) { /* never break the app's own request */ }
        return of.apply(this, arguments);
      };
    }
    var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send,
        oSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this.__bwnUrl = u; this.__bwnHdr = {}; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { (this.__bwnHdr = this.__bwnHdr || {})[k] = v; } catch (e) { } return oSet.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      try { if (/\/api\/graphql/.test(this.__bwnUrl || '') && typeof b === 'string') noteRequest(b, this.__bwnHdr); } catch (e) { }
      return oSend.apply(this, arguments);
    };
  }
  try { installHooks(); } catch (e) { console.warn('[BWN KANBAN] request hooks failed to install:', e); }

  // ---------------------------------------------------------------------------
  // 2. Scan - replay the captured request, paging until rowCount is covered
  // ---------------------------------------------------------------------------
  var rows = [], scanState = { running: false, got: 0, total: null, error: null };

  function replayPage(skip, take) {
    var vars = JSON.parse(JSON.stringify(lastReq.variables));
    vars.page = { skip: skip, take: take };
    return fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: lastReq.headers,
      body: JSON.stringify({ operationName: OP, query: lastReq.query, variables: vars })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      var p = j && j.data && j.data.listWorkOrdersPaginated;
      if (!p) throw new Error('no listWorkOrdersPaginated in response');
      return p;
    });
  }

  function scan() {
    if (!lastReq) {
      scanState = { running: false, got: 0, total: null, error: 'waiting for the list to run its own query' };
      render();
      return;
    }
    var seq = ++scanSeq;
    scanState = { running: true, got: 0, total: null, error: null };
    rows = [];
    render();

    function step(skip) {
      return replayPage(skip, PAGE_TAKE).then(function (p) {
        if (seq !== scanSeq) return;                 // a newer scan started - abandon this one
        rows = rows.concat(p.items || []);
        scanState.got = rows.length;
        scanState.total = p.rowCount;
        render();
        var more = (p.items || []).length === PAGE_TAKE && rows.length < Math.min(p.rowCount || 0, MAX_ROWS);
        if (more) return step(skip + PAGE_TAKE);
        scanState.running = false;
        render();
      });
    }

    step(0).catch(function (err) {
      if (seq !== scanSeq) return;
      scanState.running = false;
      scanState.error = (err && err.message) || String(err);
      render();
    });
  }

  var rescanTimer = null;
  function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(function () { rescanTimer = null; if (view === 'board') scan(); }, 400);
  }

  // ---------------------------------------------------------------------------
  // 3. Page anchors
  // ---------------------------------------------------------------------------
  function isListPage() {
    var p = location.pathname;
    return p.indexOf('/work-orders') === 0 && !/\/work-orders\/\d/.test(p);
  }
  function findBodyTable() {
    var tables = document.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].querySelector('a[href^="/work-orders/"]')) return tables[i];
    }
    return null;
  }
  // The page toolbar - title, search box, phase dropdown, filter and column icons - MUST stay
  // on screen in board view, because that toolbar IS the board's filter UI. So the thing to
  // hide is the largest ancestor of the table that does NOT contain the toolbar: measured, the
  // scroll frame two hops up, which holds the header table and the body table and nothing else.
  // Hiding the id="table" Paper instead takes the toolbar down with it (caught live 2026-08-04).
  function pageSearchInput() {
    var ins = document.querySelectorAll('input[placeholder]');
    for (var i = 0; i < ins.length; i++) {
      var ph = ins[i].getAttribute('placeholder') || '';
      // The global nav has "Search Work Orders"; the list's own box is exactly "Search".
      if (ph.trim().toLowerCase() !== 'search') continue;
      if (ins[i].closest('header,nav')) continue;
      return ins[i];
    }
    return null;
  }
  function tableBlock() {
    var t = findBodyTable();
    if (!t) return null;
    var search = pageSearchInput();
    // No toolbar found at all (layout changed?) - fall back to the Paper, which is still
    // correct-ish, rather than hiding a random ancestor.
    if (!search) return (t.closest && t.closest('#table')) || t.parentElement || t;
    var best = t.parentElement || t, el = t, hops = 0;
    while (el && el.parentElement && hops < 8) {
      el = el.parentElement;
      hops++;
      if (el.contains(search)) break;   // this ancestor owns the toolbar - the one below is ours
      best = el;
    }
    return best;
  }
  function toolbarAnchor() {
    var input = pageSearchInput();
    if (!input) return null;
    var el = input, hops = 0;
    while (el && el.parentElement && hops < 5) {
      el = el.parentElement;
      if (el.closest('header,nav')) return null;          // never mount into the global nav
      if (el.getBoundingClientRect().width > 300) return el;
      hops++;
    }
    return el;
  }

  // ---------------------------------------------------------------------------
  // 4. Styles
  // ---------------------------------------------------------------------------
  var GREEN = '#0d3d26';
  function injectCSS() {
    if (document.getElementById('bwn-kanban-css')) return;
    var st = document.createElement('style');
    st.id = 'bwn-kanban-css';
    st.textContent = [
      '#bwn-kanban{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;padding:8px 0 24px;}',
      '#bwn-kanban .kb-bar{display:flex;align-items:center;gap:12px;padding:6px 4px 10px;flex-wrap:wrap;}',
      '#bwn-kanban .kb-note{color:#5b6b63;font-size:12px;}',
      '#bwn-kanban .kb-note b{color:#0d3d26;}',
      '#bwn-kanban .kb-err{color:#a11;font-size:12px;}',
      '#bwn-kanban select{font:12px inherit;padding:4px 6px;border:1px solid #cfd8d3;border-radius:6px;background:#fff;}',
      '#bwn-kanban .kb-lanes{display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:12px;}',
      '#bwn-kanban .kb-lane{flex:0 0 300px;background:#f4f6f5;border:1px solid #e2e8e5;border-radius:10px;display:flex;flex-direction:column;max-height:calc(100vh - 260px);}',
      '#bwn-kanban .kb-lane.kb-over{border-color:' + GREEN + ';background:#eaf2ee;}',
      '#bwn-kanban .kb-lane h4{margin:0;padding:10px 12px;font:600 12px inherit;color:' + GREEN + ';display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8e5;position:sticky;top:0;background:#f4f6f5;border-radius:10px 10px 0 0;}',
      '#bwn-kanban .kb-lane h4 span{color:#5b6b63;font-weight:500;}',
      '#bwn-kanban .kb-cards{overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;}',
      '#bwn-kanban .kb-card{background:#fff;border:1px solid #e2e8e5;border-radius:8px;padding:8px 10px;cursor:grab;box-shadow:0 1px 2px rgba(0,0,0,.04);border-left:3px solid transparent;}',
      '#bwn-kanban .kb-card:hover{border-color:#c2cec8;}',
      '#bwn-kanban .kb-card.kb-drag{opacity:.45;}',
      // Severity edge. Only ever set from a published verdict; a card with no verdict keeps
      // the transparent edge rather than being coloured "clear", which would be a claim.
      '#bwn-kanban .kb-card.sev2{border-left-color:#a11;}',
      '#bwn-kanban .kb-card.sev1{border-left-color:#c98a00;}',
      '#bwn-kanban .kb-card.sevack{border-left-color:#b9c3be;}',
      '#bwn-kanban .kb-clock{margin-top:5px;font:600 11px ui-monospace,"Segoe UI Mono",monospace;color:#3d4a44;}',
      '#bwn-kanban .kb-clock.over{color:#a11;}',
      '#bwn-kanban .kb-clock.watch{color:#8a6100;}',
      '#bwn-kanban .kb-why{margin-top:4px;font-size:11.5px;line-height:1.35;color:#a11;}',
      '#bwn-kanban .kb-why.warnonly{color:#8a6100;}',
      '#bwn-kanban .kb-why.ackd{color:#5b6b63;}',
      '#bwn-kanban .kb-meta{margin-top:4px;font-size:11.5px;color:#3d4a44;}',
      '#bwn-kanban .kb-meta .miss{color:#a11;font-weight:600;}',
      '#bwn-kanban .kb-meta .soon{color:#8a6100;font-weight:600;}',
      '#bwn-kanban .kb-vend{margin-top:4px;font-size:11px;color:#5b6b63;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#bwn-kanban .kb-lane h4 .kb-hotn{color:#a11;font-weight:700;}',
      '#bwn-kanban .kb-lane.kb-mixed h4{background:#eef2f0;}',
      '#bwn-kanban .kb-top{display:flex;justify-content:space-between;align-items:baseline;gap:6px;}',
      '#bwn-kanban .kb-wo{font-weight:700;color:' + GREEN + ';text-decoration:none;}',
      '#bwn-kanban .kb-wo:hover{text-decoration:underline;}',
      '#bwn-kanban .kb-days{font:600 11px ui-monospace,"Segoe UI Mono",monospace;color:#5b6b63;}',
      '#bwn-kanban .kb-days.kb-hot{color:#a11;}',
      '#bwn-kanban .kb-line{color:#3d4a44;margin-top:3px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#bwn-kanban .kb-scope{color:#5b6b63;margin-top:5px;font-size:11.5px;line-height:1.35;}',
      '#bwn-kanban .kb-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;}',
      '#bwn-kanban .kb-chip{font:600 10px inherit;padding:2px 6px;border-radius:999px;background:#eef2f0;color:#3d4a44;}',
      '#bwn-kanban .kb-chip.p-red{background:#fde8e8;color:#a11;}',
      '#bwn-kanban .kb-chip.p-yellow{background:#fdf3d8;color:#8a6100;}',
      '#bwn-kanban .kb-chip.p-blue{background:#e6f0fb;color:#1b4f8a;}',
      '#bwn-kanban .kb-chip.p-next{background:#f3e2fb;color:#6b1b8a;}',
      '#bwn-kanban .kb-dne{font:600 11px ui-monospace,"Segoe UI Mono",monospace;color:#0d3d26;}',
      '.bwn-kb-btn{font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;padding:5px 12px;border:1px solid ' + GREEN + ';background:#fff;color:' + GREEN + ';border-radius:6px;cursor:pointer;margin-left:8px;}',
      '.bwn-kb-btn.on{background:' + GREEN + ';color:#fff;}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------------------------------------------------------------------------
  // 5. Render
  // ---------------------------------------------------------------------------
  function storeGet(k, dflt) { try { var v = localStorage.getItem(k); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode - session only */ } }

  var view = storeGet(LS_VIEW, 'list') === 'board' ? 'board' : 'list';
  var group = storeGet(LS_GROUP, 'status') || 'status';

  function prioClass(label) {
    var s = (label || '').toLowerCase();
    if (s.indexOf('next day') > -1 || s.indexOf('p2') > -1) return 'p-next';
    if (s.indexOf('red') > -1 || s.indexOf('high') > -1) return 'p-red';
    if (s.indexOf('yellow') > -1 || s.indexOf('medium') > -1) return 'p-yellow';
    if (s.indexOf('blue') > -1 || s.indexOf('low') > -1) return 'p-blue';
    return '';
  }
  function fmtDate(d) {
    if (!d) return null;
    var t = new Date(d);
    if (isNaN(t.getTime())) return null;
    // Year included when it is not this one. "onsite 6/19" on a card read as an upcoming visit
    // when the date was 6/19 of LAST year; month/day alone cannot say which.
    var now = new Date();
    return (t.getMonth() + 1) + '/' + t.getDate() + (t.getFullYear() !== now.getFullYear() ? '/' + String(t.getFullYear()).slice(-2) : '');
  }
  // Whole days from today, signed: positive = still to come, negative = already gone.
  function dayDelta(d) {
    if (!d) return null;
    var t = new Date(d);
    if (isNaN(t.getTime())) return null;
    var a = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    var n = new Date();
    var b = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((a - b) / 86400000);
  }
  // The captured query only selects what the list's column chooser asked for, so every field
  // below is optional and an absent one renders NOTHING rather than a zero. Canonical synonym
  // lists live in bwn-suite-core's heatApiRowToEntry; these are the same names, and any field
  // this file cannot find is simply a line the card does not print.
  function firstVal(o, names) {
    if (!o) return null;
    for (var i = 0; i < names.length; i++) {
      var v = o[names[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }
  function moneyAmt(m) {
    if (m == null) return null;
    if (typeof m === 'number') return m;                       // already major units
    if (typeof m.amount !== 'number') return null;
    var p = typeof m.precision === 'number' ? m.precision : 2;
    return m.amount / Math.pow(10, p);
  }
  function fmtMoney(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  // `timeInStatus` is MINUTES. This is the fault this version exists to fix: 0.3.0 rendered it
  // as hours, so every card on a 219-row board was 60x out and none of them stood out from the
  // others. Measured three ways 2026-08-05 - W-326938's card read 12930 while List Heat's own
  // published verdict for the same WO in the same second read 215h (12930/60 = 215.5); the
  // number ticked up by 1 per minute while watching; and Umbrava's own CSV export the previous
  // morning read 191.55 hrs, which is 215 once a day is added. An HOURS-named field, if the
  // schema ever emits one, is trusted as hours and never converted twice - the same rule
  // bwn-suite-core's heatApiRowToEntry applies, for the same reason.
  // Complete-by. MEASURED against the live query 2026-08-05: there is NO top-level
  // `expectedCompletionDate` in the board selection - it hangs off the row's `priority`
  // object, beside `firstTripDate` and `category`. Written as a ladder rather than one
  // path because the selection follows the column chooser and can change under us; the
  // top-level name is kept as a fallback, not as the primary.
  function expectedOf(r) {
    var v = firstVal(r, ['expectedCompletionDate', 'completeByDate', 'completionDate']);
    if (v) return v;
    if (r && r.priority) return firstVal(r.priority, ['expectedCompletionDate', 'completeByDate']);
    return null;
  }
  // Trades arrive as an array of OBJECTS ({ id, name, systemTradeName, ... }), not strings -
  // measured on the same query. Joining the array raw prints "[object Object]" on every card
  // that has a trade, which is most of them. `vendorNames` really is plain strings; the two
  // look alike in a schema listing and are not the same shape.
  function nameList(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (!Array.isArray(v)) return (v && v.name) ? String(v.name) : '';
    return v.map(function (x) {
      if (x == null) return '';
      return (typeof x === 'object') ? String(x.name || x.systemTradeName || '') : String(x);
    }).filter(Boolean).join(', ');
  }
  function statusHours(r) {
    var h = firstVal(r, ['hoursInStatus', 'hrsInStatus', 'statusHours', 'statusHrs']);
    if (h !== null && isFinite(parseFloat(h))) return parseFloat(h);
    var m = firstVal(r, ['timeInStatus', 'minutesInStatus', 'statusMinutes']);
    if (m !== null && isFinite(parseFloat(m))) return parseFloat(m) / 60;
    return null;
  }
  // The verdict bwn-suite-core published for this WO, or null. Never a fallback computation:
  // no record means no severity is known, and the card says nothing about severity.
  function heatOf(num) {
    try {
      var raw = sessionStorage.getItem('bwn:heat:' + String(num).replace(/\D/g, ''));
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || d.v !== 1) return null;
      if (HEAT_MAX_AGE && Date.now() - (d.ts || 0) > HEAT_MAX_AGE) return null;
      return d;
    } catch (e) { return null; }
  }
  function heatCount() {
    var n = 0;
    try {
      for (var i = 0; i < rows.length; i++) if (heatOf(rows[i].number)) n++;
    } catch (e) { /* storage disabled - treat as none */ }
    return n;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function groupDef() {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === group) return GROUPS[i];
    return GROUPS[0];
  }

  function buildCard(r) {
    var card = el('div', 'kb-card');
    card.draggable = true;
    card.dataset.wo = r.number;
    card.dataset.statusId = r.statusId;
    card.dataset.statusName = r.statusName || '';

    var top = el('div', 'kb-top');
    var a = el('a', 'kb-wo', 'W-' + r.number);
    a.href = '/work-orders/' + r.number + '/details';
    top.appendChild(a);
    var days = el('span', 'kb-days' + ((Number(r.numberOfDays) || 0) > 30 ? ' kb-hot' : ''), (r.numberOfDays != null ? r.numberOfDays + 'd' : ''));
    top.appendChild(days);
    card.appendChild(top);

    if (r.clientName) card.appendChild(el('div', 'kb-line', r.clientName));
    var loc = [r.locationName, r.locationNumber].filter(Boolean).join(' ');
    if (loc) card.appendChild(el('div', 'kb-line', loc));
    if (r.assignedToMemberName) card.appendChild(el('div', 'kb-line', r.assignedToMemberName));

    var heat = heatOf(r.number);
    if (heat) {
      if (heat.acked) card.classList.add('sevack');
      else if (heat.sev === 2) card.classList.add('sev2');
      else if (heat.sev === 1) card.classList.add('sev1');
    }

    var chips = el('div', 'kb-chips');
    var pl = r.priority && r.priority.label;
    if (pl) chips.appendChild(el('span', 'kb-chip ' + prioClass(pl), pl));
    // Status is on EVERY card now, not only when the lanes are grouped by something else. On
    // a status-laned board the lane header is 300px away and off-screen once the lane scrolls,
    // and the roll-up lane below mixes statuses on purpose - so the card has to carry its own.
    if (r.statusName) chips.appendChild(el('span', 'kb-chip', r.statusName));
    // Money: DNE is what the client authorized, totalNTE is committed vendor cost. 0.3.0 showed
    // DNE alone, so a card had revenue with no cost beside it and GP could not be read off the
    // board at all. Both, then GP, and only when both are really there.
    var dneAmt = moneyAmt(firstVal(r, ['doNotExceed', 'dne', 'clientDoNotExceed']));
    var nteAmt = moneyAmt(firstVal(r, ['totalNTE', 'totalVendorNTE', 'nte', 'vendorNTE']));
    if (dneAmt !== null) chips.appendChild(el('span', 'kb-chip kb-dne', 'DNE ' + fmtMoney(dneAmt)));
    if (nteAmt !== null) chips.appendChild(el('span', 'kb-chip kb-dne', 'NTE ' + fmtMoney(nteAmt)));
    if (dneAmt !== null && nteAmt !== null && dneAmt > 0) {
      var gp = Math.round((dneAmt - nteAmt) / dneAmt * 100);
      // Vendor cost over the client's authorization is a money-control breach, not a thin
      // margin, and it is the one List Heat marks red on its own - so it is spelled out.
      chips.appendChild(el('span', 'kb-chip ' + (gp < 0 ? 'p-red' : gp < 20 ? 'p-yellow' : ''),
        gp < 0 ? 'NTE OVER DNE' : 'GP ' + gp + '%'));
    }
    if (chips.children.length) card.appendChild(chips);

    // ---- The status clock, corrected, against the limit this row was judged against -------
    var hrs = statusHours(r);
    if (hrs !== null) {
      var txt = Math.round(hrs) + 'h in status';
      var cls = 'kb-clock';
      // The limit rides on the published verdict, so the number the card shows is the number
      // the row was actually judged by - including the client-SLA scaling from List Heat
      // v3.19. Without a verdict the hours print bare: a limit is not invented here.
      if (heat && typeof heat.bad === 'number' && heat.bad > 0) {
        if (hrs >= heat.bad) { txt += ' - ' + (hrs / heat.bad).toFixed(1) + 'x the ' + Math.round(heat.bad) + 'h limit'; cls += ' over'; }
        else if (typeof heat.warn === 'number' && hrs >= heat.warn) { txt += ' - watch from ' + Math.round(heat.warn) + 'h'; cls += ' watch'; }
        else txt += ' of ' + Math.round(heat.bad) + 'h';
      }
      card.appendChild(el('div', cls, txt));
    }

    // ---- Why it is flagged: the authority's own words, not a second opinion --------------
    // The reasons are exactly the strings List Heat's computeVerdict produced for this WO, so
    // the board cannot describe a row differently from the list. The status-clock reason is
    // dropped because the line above already says it, in more detail.
    if (heat && heat.reasons && heat.reasons.length) {
      var why = heat.reasons.filter(function (t) { return !/h in "/.test(t); });
      if (why.length) {
        card.appendChild(el('div', 'kb-why' + (heat.acked ? ' ackd' : heat.sev === 1 ? ' warnonly' : ''),
          (heat.acked ? 'snoozed: ' : '') + why.join(' · ')));
      }
    }

    // ---- Dates, with the one thing 0.3.0 left out: whether they have already gone by ------
    // Measured 2026-08-05: 96 of 219 cards carried an onsite date and 91 of those were in the
    // PAST, styled identically to the 5 in the future. A missed visit read exactly like a
    // booked one, which is the opposite of the signal.
    var meta = el('div', 'kb-meta');
    var onsiteRaw = firstVal(r, ['nextOnsiteDate', 'scheduledDate', 'scheduleDate']);
    if (onsiteRaw) {
      var od = dayDelta(onsiteRaw);
      var frag = document.createElement('span');
      frag.appendChild(document.createTextNode('onsite ' + fmtDate(onsiteRaw) + ' '));
      if (od !== null && od < 0) frag.appendChild(el('span', 'miss', '(' + Math.abs(od) + 'd ago)'));
      else if (od === 0) frag.appendChild(el('span', 'soon', '(today)'));
      else if (od !== null) frag.appendChild(document.createTextNode('(in ' + od + 'd)'));
      meta.appendChild(frag);
    }
    var expRaw = expectedOf(r);
    var ed = expRaw ? dayDelta(expRaw) : null;
    // No complete-by date read -> the server's own signed day count, which IS in the board
    // selection (measured: remainingDays -4 on a WO whose priority.expectedCompletionDate had
    // passed 4 days earlier - they agree). Same fallback ladder List Heat uses, so the board
    // and the list cannot disagree about whether a WO is overdue.
    if (ed === null && r && typeof r.remainingDays === 'number' && isFinite(r.remainingDays)) ed = Math.round(r.remainingDays);
    if (ed !== null) {
      var f2 = document.createElement('span');
      f2.appendChild(document.createTextNode((meta.children.length ? ' · ' : '') + (expRaw ? 'due ' + fmtDate(expRaw) + ' ' : 'due ')));
      if (ed < 0) f2.appendChild(el('span', 'miss', '(overdue ' + Math.abs(ed) + 'd)'));
      else if (ed <= 3) f2.appendChild(el('span', 'soon', '(in ' + ed + 'd)'));
      else f2.appendChild(document.createTextNode('(in ' + ed + 'd)'));
      meta.appendChild(f2);
    }
    var noteRaw = firstVal(r, ['lastNoteDate', 'lastNoteOn', 'lastActivityDate']);
    if (noteRaw) {
      var nd = dayDelta(noteRaw);
      if (nd !== null) meta.appendChild(document.createTextNode((meta.children.length ? ' · ' : '') + 'note ' + Math.abs(nd) + 'd ago'));
    }
    if (meta.childNodes.length) card.appendChild(meta);

    // Who is doing the work, and what kind of work. `vendorNames` is an array of plain
    // strings; an EMPTY array is a fact ("nobody on it yet") and reads as such, while an
    // absent field prints nothing at all.
    var vend = r.vendorNames, trades = firstVal(r, ['trades', 'tradeNames', 'trade']);
    var vendTxt = '';
    if (Array.isArray(vend)) {
      var vs = vend.map(function (x) { return typeof x === 'string' ? x.trim() : ''; }).filter(Boolean);
      // Seven vendors on one WO is real (measured on W-283834), so the list is capped and
      // counted rather than allowed to push the scope line off the card.
      vendTxt = vs.length ? (vs.length > 2 ? vs.slice(0, 2).join(', ') + ' +' + (vs.length - 2) : vs.join(', ')) : 'no vendor yet';
    } else if (typeof vend === 'string' && vend) vendTxt = vend;
    var tradeTxt = nameList(trades);
    if (vendTxt || tradeTxt) card.appendChild(el('div', 'kb-vend', [vendTxt, tradeTxt].filter(Boolean).join(' · ')));

    if (r.scopeOfWork) {
      var s = String(r.scopeOfWork).replace(/\s+/g, ' ').trim();
      card.appendChild(el('div', 'kb-scope', s.length > CARD_SCOPE_CHARS ? s.slice(0, CARD_SCOPE_CHARS) + '...' : s));
    }
    if (heat && heat.reasons && heat.reasons.length) card.title = heat.reasons.join(' · ');

    card.addEventListener('dragstart', function (ev) {
      card.classList.add('kb-drag');
      try { ev.dataTransfer.setData('text/plain', String(r.number)); ev.dataTransfer.effectAllowed = 'move'; } catch (e) { }
      dragged = { row: r, node: card };
    });
    card.addEventListener('dragend', function () { card.classList.remove('kb-drag'); dragged = null; });
    return card;
  }

  var dragged = null;
  var writing = false;

  // statusName -> statusId, learned from the scan itself. Every lane the board draws came from
  // rows that carry both, so a lane always has an id; a lane whose id cannot be resolved is
  // refused rather than guessed.
  function statusIdFor(name) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].statusName === name && rows[i].statusId != null) return rows[i].statusId;
    }
    return null;
  }

  function writeStatus(row, targetLaneKey) {
    if (!WRITE_ENABLED) { alert('Status writes are off in this build.'); return Promise.resolve(false); }
    if (group !== 'status') {
      alert('Lanes are grouped by ' + groupDef().label + ', so dropping a card here has no status meaning.\n\nSwitch lanes to WO Status to move work orders.');
      return Promise.resolve(false);
    }
    var targetId = statusIdFor(targetLaneKey);
    if (targetId == null) { alert('Could not resolve a status id for "' + targetLaneKey + '" - nothing sent.'); return Promise.resolve(false); }
    if (writing) return Promise.resolve(false);
    if (!lastReq || !lastReq.headers) { alert('No captured session headers yet - reload the list, then try again.'); return Promise.resolve(false); }

    var ok = confirm('Change W-' + row.number + ' status?\n\n' +
      '   ' + (row.statusName || '-') + '  ->  ' + targetLaneKey + '\n\n' +
      'This writes to the live work order. It also RESETS this work order\'s\n' +
      'time-in-status clock (currently ' + (statusHours(row) !== null ? Math.round(statusHours(row)) + 'h' : 'unknown') + '), which cannot be undone by\n' +
      'changing the status back.');
    if (!ok) return Promise.resolve(false);

    writing = true;
    return fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: lastReq.headers,
      body: JSON.stringify({
        operationName: PATCH_OP,
        query: PATCH_QUERY,
        variables: { data: { workOrderNumber: row.number, statusId: { shouldInclude: true, value: targetId } } }
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      var p = j && j.data && j.data.patchWorkOrder;
      if (!p || !p.success) throw new Error((p && p.message) || 'patchWorkOrder reported no success');
      // Move it locally so the board is right immediately, then re-scan for the truth.
      row.statusName = targetLaneKey;
      row.statusId = targetId;
      return true;
    }).catch(function (err) {
      alert('Status change FAILED for W-' + row.number + '.\n\n' + ((err && err.message) || err) + '\n\nThe card stays where it was; nothing was changed.');
      return false;
    }).then(function (moved) {
      writing = false;
      // Always re-read from the API rather than trusting the optimistic move.
      scan();
      return moved;
    });
  }

  function buildLane(name, items, mixed) {
    var lane = el('div', 'kb-lane' + (mixed ? ' kb-mixed' : ''));
    lane.dataset.lane = name;
    if (mixed) lane.dataset.mixed = '1';
    var h = el('h4');
    h.appendChild(el('span', null, name));
    // Count, and how much of it is red. The lane order does not change with the heat (a board
    // whose columns reshuffle on every scan is unreadable), so the header carries the number
    // instead - that is what tells you which lane to open without scrolling through it.
    var hot = 0, known = 0;
    items.forEach(function (r) { var hv = heatOf(r.number); if (hv) { known++; if (hv.sev === 2 && !hv.acked) hot++; } });
    var cnt = el('span', null, '');
    if (hot) { cnt.appendChild(el('span', 'kb-hotn', hot + ' red')); cnt.appendChild(document.createTextNode(' / ' + items.length)); }
    else cnt.appendChild(document.createTextNode(known ? String(items.length) : items.length + ' (no heat)'));
    h.appendChild(cnt);
    lane.appendChild(h);
    var body = el('div', 'kb-cards');
    items.forEach(function (r) { body.appendChild(buildCard(r)); });
    lane.appendChild(body);

    lane.addEventListener('dragover', function (ev) { ev.preventDefault(); lane.classList.add('kb-over'); });
    lane.addEventListener('dragleave', function () { lane.classList.remove('kb-over'); });
    lane.addEventListener('drop', function (ev) {
      ev.preventDefault();
      lane.classList.remove('kb-over');
      if (!dragged) return;
      // The roll-up lane holds several statuses at once, so it names no target status and a
      // drop into it cannot mean anything. Refuse rather than pick one of them.
      if (mixed) { alert('"' + OTHER_LANE + '" holds more than one status, so there is no status to move this WO to.\n\nDrop it on a named status lane instead.'); return; }
      var from = groupDef().key(dragged.row);
      if (from === name) return;
      // writeStatus confirms, writes, and re-scans; a refusal or a failure just leaves the
      // board as it was, so the card never appears to have moved when it has not.
      writeStatus(dragged.row, name);
    });
    return lane;
  }

  function boardNode() {
    var root = el('div');
    root.id = 'bwn-kanban';

    var bar = el('div', 'kb-bar');
    var sel = document.createElement('select');
    GROUPS.forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.id; o.textContent = 'Lanes: ' + g.label;
      if (g.id === group) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      group = sel.value;
      storeSet(LS_GROUP, group);
      render();
    });
    bar.appendChild(sel);

    var note = el('div', 'kb-note');
    if (scanState.error) {
      note.className = 'kb-err';
      note.textContent = 'Scan failed: ' + scanState.error + (lastReq ? '' : ' - change a filter or reload the list so the board can capture its query.');
    } else if (scanState.running) {
      note.textContent = 'Scanning the board... ' + scanState.got + (scanState.total ? ' of ' + scanState.total : '');
    } else {
      note.innerHTML = '';
      note.appendChild(el('b', null, String(rows.length)));
      note.appendChild(document.createTextNode(' work orders' + (scanState.total && scanState.total > rows.length ? ' of ' + scanState.total + ' (capped)' : '') + ' - same filters as the list.' + (group === 'status' ? ' Drag a card to another lane to change its status (asks first, and resets that WO\'s time-in-status).' : ' Dragging only changes status when lanes are WO Status.')));
      // Say so when there is no heat to show. Severity comes from the verdicts List Heat
      // publishes, so on a board where that has not run the cards carry facts and no
      // severity - and silence about that would read as "nothing here is in trouble".
      if (rows.length) {
        var hn = heatCount();
        if (!hn) note.appendChild(el('div', 'kb-err', 'No List Heat verdicts on the bus - cards show facts but no severity. Switch to List and press Scan All (needs bwn-suite-core 1.66.31+).'));
        else if (hn < rows.length) note.appendChild(el('div', 'kb-note', 'Severity known for ' + hn + ' of ' + rows.length + ' - the rest show facts only.'));
      }
    }
    bar.appendChild(note);

    var rescan = el('button', 'bwn-kb-btn', 'Rescan');
    rescan.addEventListener('click', scan);
    bar.appendChild(rescan);
    root.appendChild(bar);

    var lanes = el('div', 'kb-lanes');
    var gd = groupDef();
    var byKey = {}, order = [];
    rows.forEach(function (r) {
      var k = gd.key(r);
      if (!byKey[k]) { byKey[k] = []; order.push(k); }
      byKey[k].push(r);
    });
    // Biggest lane first, so the board opens on where the work actually is.
    order.sort(function (a, b) { return byKey[b].length - byKey[a].length; });

    // Roll the stragglers up. Measured 2026-08-05: 26 status lanes, 11 of them 3 cards or
    // fewer, holding 23 cards that lived off the right edge behind a horizontal scroll. They
    // are collapsed into one lane at the end, which is reachable, and every card in it still
    // shows its own status chip. Only above LANE_ROLL_WHEN lanes: a filtered board of six
    // statuses is not sprawling and every lane there stays a real drop target.
    var rolled = [];
    if (order.length > LANE_ROLL_WHEN) {
      var keep = [];
      order.forEach(function (k) {
        if (byKey[k].length <= LANE_ROLL_MAX) rolled = rolled.concat(byKey[k].map(function (r) { return r; }));
        else keep.push(k);
      });
      // Refuse to roll up if it would leave nothing behind (a board of nothing but tiny lanes
      // would otherwise become one undroppable pile).
      if (keep.length) order = keep; else rolled = [];
    }

    // Worst first inside every lane: red, then amber, then the rest, and oldest first within
    // each band. A lane sorted by age alone buries a 2-day-old WO that is 4x past its status
    // limit under a hundred quiet 200-day-old ones - and age is already on every card.
    function sevOf(r) { var h = heatOf(r.number); return h ? (h.acked ? 0 : h.sev) : 0; }
    function worstFirst(a, b) {
      var d = sevOf(b) - sevOf(a);
      if (d) return d;
      return (Number(b.numberOfDays) || 0) - (Number(a.numberOfDays) || 0);
    }

    order.forEach(function (k) {
      byKey[k].sort(worstFirst);
      lanes.appendChild(buildLane(k, byKey[k], false));
    });
    if (rolled.length) {
      rolled.sort(worstFirst);
      lanes.appendChild(buildLane(OTHER_LANE, rolled, true));
    }
    if (!order.length && !rolled.length && !scanState.running) lanes.appendChild(el('div', 'kb-note', 'No work orders in the current filter.'));
    root.appendChild(lanes);
    return root;
  }

  function render() {
    if (!isListPage()) return;
    var block = tableBlock();
    if (!block || !block.parentElement) return;
    var existing = document.getElementById('bwn-kanban');

    if (view !== 'board') {
      if (existing) existing.remove();
      block.style.removeProperty('display');
      syncButton();
      return;
    }
    block.style.setProperty('display', 'none', 'important');
    var fresh = boardNode();
    if (existing) existing.replaceWith(fresh);
    else block.parentElement.insertBefore(fresh, block.nextSibling);
    syncButton();
  }

  // ---------------------------------------------------------------------------
  // 6. Toggle button, mounted into the list's own toolbar row
  // ---------------------------------------------------------------------------
  function syncButton() {
    var b = document.getElementById('bwn-kb-toggle');
    if (!b) return;
    b.textContent = view === 'board' ? 'List' : 'Board';
    b.classList.toggle('on', view === 'board');
  }

  function mountButton() {
    if (!isListPage()) {
      var stale = document.getElementById('bwn-kb-toggle');
      if (stale) stale.remove();
      return;
    }
    if (document.getElementById('bwn-kb-toggle')) return;
    var anchor = toolbarAnchor();
    if (!anchor) return;
    var b = el('button', 'bwn-kb-btn', 'Board');
    b.id = 'bwn-kb-toggle';
    b.title = 'Switch between the Umbrava table and the BWN kanban board (same filters)';
    b.addEventListener('click', function () {
      view = (view === 'board') ? 'list' : 'board';
      storeSet(LS_VIEW, view);
      if (view === 'board' && !rows.length && !scanState.running) scan();
      else render();
    });
    anchor.appendChild(b);
    syncButton();
  }

  // ---------------------------------------------------------------------------
  // 7. Lifecycle - the SPA rerenders and renavigates under us
  // ---------------------------------------------------------------------------
  var tick = null;
  function schedule() {
    if (tick) return;
    tick = setTimeout(function () {
      tick = null;
      injectCSS();
      mountButton();
      if (!isListPage()) {
        var n = document.getElementById('bwn-kanban');
        if (n) n.remove();
        return;
      }
      // React can drop our node on a rerender - put it back rather than assume it survived.
      if (view === 'board' && !document.getElementById('bwn-kanban')) render();
    }, 200);
  }

  function boot() {
    injectCSS();
    schedule();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('popstate', schedule);
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      history[m] = function () { var r = orig.apply(this, arguments); schedule(); return r; };
    });
    if (view === 'board' && isListPage()) scan();
    // No GM_registerMenuCommand: that API needs a grant, and a grant would sandbox the script
    // away from the page's fetch (see the header note). The toggle button IS the entry point,
    // and window.bwnKanban below is the escape hatch if it ever fails to mount.
    try { window.bwnKanban = { scan: scan, render: render, state: function () { return { view: view, group: group, rows: rows.length, scan: scanState, captured: !!lastReq }; } }; } catch (e) { }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
