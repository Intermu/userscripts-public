// ==UserScript==
// @name         BWN WO Audit (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.7.1
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-wo-audit.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-wo-audit.user.js
// @description  Batch WO-audit tool. Upload a WO audit .xlsx; for each work order this reads its two most recent notes DIRECTLY from Umbrava's GraphQL API in-page (using your live Umbrava session - the same read the BWN Ops Suite AI drafts use), then asks the broadway-internal-ops SWA summarize route (x-bwn-key gated, Anthropic key server-side) to write a 1-3 sentence client-ready status note. Fills the audit's notes column and downloads the workbook, preserving every other cell and formula. Runs entirely in the app.umbrava.com page so it inherits your Umbrava auth - no MCP, no pasted keys, nothing sensitive in this script. This replaces the old standalone WO_Audit_Automation.html SWA tool, whose server-side MCP path could not authenticate to Umbrava.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js#sha384=bed8dab3289d528d245bde0ae4c5c35e7b73389a50801297984eded866b82c6d2c9134cb7818bdede1405eca9ec098f0
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.7.1';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var GREEN = '#0d3d26';
  var MS_DAY = 86400000;
  var MODELS = [
    { id: 'claude-sonnet-5', label: 'Sonnet 5 (default)' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8 (best)' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
  ];
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  console.info('[BWN WO AUDIT] v' + VER + ' - in-page GraphQL notes read -> bwnAI -> /api/ai summarize -> filled .xlsx download; registers into the shared dock (bwn:dock:*), no floating fallback button');

  // ====================================================================
  // Auth: the live Umbrava Auth0 bearer, read straight from the page (same
  // content-based pick bwn-suite-ai/gql use). This is the whole reason the tool
  // runs in-page: a server-side Function has no Umbrava session, which is why the
  // old MCP route failed with a 400 "Authentication error".
  // ====================================================================
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

  // Same-origin GraphQL POST -> resolves to `data`, throws on errors[]. Carries the
  // page's own Umbrava bearer; no @connect needed (app.umbrava.com is same-origin).
  // Bounded. Without a timeout one hung read parks runPool forever: that runner never settles, so
  // Promise.all never resolves, the completion block never runs, Download never appears, and the
  // close-guard refuses to let the drawer go because `_running` is still true. The only exit was
  // reloading the tab, which discards every note already written into the in-memory workbook -
  // exactly the orphaning the guard exists to prevent, made unrecoverable.
  var GQL_TIMEOUT_MS = 30000;
  function gql(query, variables) {
    var tok = authToken();
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctl) { try { ctl.abort(); } catch (e) { } }
        reject(new Error('Umbrava did not respond in time (' + Math.round(GQL_TIMEOUT_MS / 1000) + 's)'));
      }, GQL_TIMEOUT_MS);
      fetch('/api/graphql', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, variables: variables || {} }),
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        // A batch now spans many minutes, so the bearer read once at Start can expire mid-run.
        // r.json() on a non-JSON 401 body rejects with "Unexpected token '<'", which is the exact
        // class of un-actionable message the plain-language cause layer exists to remove.
        if (r.status === 401 || r.status === 403) {
          throw new Error('your Umbrava session expired - reload the tab and press Retry Unfinished');
        }
        return r.json();
      }).then(function (j) {
        if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
        resolve(j && j.data);
      }).catch(reject);
    }).then(function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; });
  }

  function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
  function _stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // One WO's status + notes, newest first. Notes use Umbrava's REAL query, captured off the wire
  // 2026-07-23: jobNotes(workOrderNumber, includeDeleted) - a ROOT field keyed by the WO NUMBER,
  // so no internal-id lookup is needed. Field list is the confirmed WONoteFields subset. A real
  // query error now REJECTS (surfaces loudly per WO) instead of silently returning 0 notes.
  // statusName is an isolated best-effort read; on any drift it falls back to the xlsx Status col.
  var NOTES_Q = 'query($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content contentHtml createdDate isPinned isCompletion workOrderNoteSource createdBy { firstName lastName } } }';
  var STATUS_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ statusName } }';
  function woNotes(number) {
    var n = parseInt(String(number).replace(/^W-?/i, '').replace(/[^0-9]/g, ''), 10);
    if (!n || isNaN(n)) return Promise.reject(new Error('not a WO number: "' + number + '"'));
    var statusP = gql(STATUS_Q, { n: n }).then(function (d) { return (d && d.workOrder && d.workOrder.statusName) || ''; }).catch(function () { return ''; });
    var notesP = gql(NOTES_Q, { n: n }).then(function (d) { return (d && d.jobNotes) || []; });
    return Promise.all([statusP, notesP]).then(function (a) {
      var notes = a[1].slice().sort(function (x, y) {
        return (_date(y && y.createdDate) || 0) - (_date(x && x.createdDate) || 0);
      }).map(function (x) {
        x = x || {};
        var who = x.createdBy ? [x.createdBy.firstName, x.createdBy.lastName].filter(Boolean).join(' ') : '';
        return {
          content: (x.content && String(x.content).trim()) || _stripHtml(x.contentHtml),
          createdDate: x.createdDate || '',
          type: x.type || '',
          isPinned: !!x.isPinned,
          by: who,
          source: x.workOrderNoteSource || '',
        };
      });
      return { id: n, statusName: a[0], notes: notes };
    });
  }

  // ---- SWA summarize call (cross-origin -> GM_xmlhttpRequest + @connect) ----
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 60000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j, headers: r.responseHeaders || '' }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); },
        });
      } catch (e) { reject(e); }
    });
  }
  // ===== BWN AI TRANSPORT (Phase 3, TASK-011) =====================================
  // Batch summarize now rides the shared suite-wide bwnAI router and the single
  // /api/ai route (server Anthropic key; summarize tier is key-gated, no rank on the
  // server). The bwnAI block below is pasted BYTE-IDENTICAL from the suite (PAT-002) -
  // verify the SHA matches across scripts; do NOT edit its internals, only the injected
  // sender differs. summarize passes NO tools, so the sender is a single POST (no tool
  // loop, no registry).
  // ===== bwnAI v1 - shared suite-wide AI router - KEEP IN SYNC across suite scripts =====
  // Single tiered helper (spec: [[bwn-ai-tiering]]). Generalizes this module's original
  // on-device aiSummary into a router every module can call the same way. Three tiers:
  //   local    - a module-supplied mechanical fn (no model). Always-available floor.
  //   ondevice - Chrome's built-in Prompt API (Gemini Nano). Free, zero-egress, no key,
  //              @grant none. Everyone. Good for summaries/labels/short classification.
  //   proxy    - one SERVER key behind the bwn-ai SWA (Claude/Haiku). Rank-gated to
  //              managers+ (BWN_AI_ADVANCED_MIN_RANK, default 4). The network transport
  //              is INJECTED by a grant-holding script via bwnAI.setProxy(fn); modules
  //              that are @grant none (this one) never attempt it - proxy simply misses
  //              and the router falls through to on-device / local.
  // Contract: async, self-bounded by timeoutMs, ALWAYS resolves (never throws), returns
  // '' (or the local result) on any miss. Paste this block verbatim into any module that
  // needs AI; only put the block here, never a key. This is UX/cost routing - the SERVER
  // re-enforces the rank on the proxy tier (403 ROLE_REQUIRED, treated here as a miss).
  var bwnAI = (function () {
    var TASK_TIER = { summarize: 'ondevice', classify: 'ondevice', draft: 'proxy', render: 'proxy' };
    var TASK_ONELINE = { summarize: true, classify: true };
    var TASK_SYSTEM = {
      summarize: 'Summarize the input into a single plain-text line (<=200 chars). No greeting, no sign-off, no preamble, no quotes - output only the one line.',
      classify: 'Classify the input. Respond with ONLY a short label of a few words - no explanation, no punctuation beyond the label.',
      draft: 'Draft a short, professional message for a facilities coordinator. Clear and courteous. Output only the message body - no preamble.',
      render: 'Synthesize the provided work-order details into a clear, well-structured plain-text brief for a facilities coordinator. Output only the brief.'
    };
    var ROLE_TTL_MS = 6 * 3600 * 1000;   // trust the cross-refresh role slot this long

    // ---- Rank read (client, cost/UX only - the server is the real gate) ----------
    // @grant-none-safe: the AI script resolves the SERVER-computed rank once per session
    // ([[umbrava-role-auth]]) and publishes it on the `bwn:role` bus event + the
    // localStorage `bwn:role:last` slot. A live bus event is trusted directly; the slot
    // is the cross-refresh fallback, trusted only when marked ok + fresh. Never re-fetches.
    var _liveRank = null;
    try {
      document.addEventListener('bwn:evt', function (e) {
        var d = e && e.detail;
        if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _liveRank = d.rank;
      });
    } catch (e) { /* no document (worker) - rank stays unknown -> on-device */ }
    function rank() {
      if (typeof _liveRank === 'number') return _liveRank;
      try {
        var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
        if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank;
      } catch (e2) { }
      return null;
    }

    // ---- On-device (Chrome built-in Prompt API) -----------------------------------
    function langModel() {
      // The Prompt API surface has shifted across Chrome versions; probe the globals.
      var g = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : null);
      if (typeof LanguageModel !== 'undefined' && LanguageModel) return LanguageModel;
      if (g && g.LanguageModel) return g.LanguageModel;
      if (g && g.ai && g.ai.languageModel) return g.ai.languageModel;   // older window.ai shape
      return null;
    }
    function ready(api) {
      // Newer: availability() -> 'available'|'downloadable'|'downloading'|'unavailable'.
      // Older: capabilities() -> {available:'readily'|'after-download'|'no'}. Only
      // 'available'/'readily' means we can infer NOW without a multi-GB model download.
      try {
        if (typeof api.availability === 'function') return Promise.resolve(api.availability()).then(function (s) { return s === 'available'; }, function () { return false; });
        if (typeof api.capabilities === 'function') return Promise.resolve(api.capabilities()).then(function (c) { return !!c && c.available === 'readily'; }, function () { return false; });
      } catch (e) { }
      return Promise.resolve(false);
    }
    // Reuse one session PER system prompt (a new task/system gets its own; recreated on error).
    var SESSIONS = {};
    function session(api, sys) {
      var cached = SESSIONS[sys];
      if (cached) return Promise.resolve(cached);
      function keep(hasSystem) { return function (s) { try { s._bwnSystem = hasSystem; } catch (e) { } SESSIONS[sys] = s; return s; }; }
      // Prefer the system-prompt option; fall back to a bare session (older/newer variants)
      // where the instruction is prepended to the user prompt instead (_bwnSystem = false).
      return Promise.resolve(api.create({ initialPrompts: [{ role: 'system', content: sys }] }))
        .then(keep(true), function () { return Promise.resolve(api.create()).then(keep(false)); });
    }
    function onDevice(sys, content) {
      var api = langModel();
      if (!api || typeof api.create !== 'function') return Promise.resolve('');
      return ready(api).then(function (ok) {
        if (!ok) return '';
        return session(api, sys).then(function (s) {
          var usedSystem = !!(s && s._bwnSystem !== false);   // best-effort; harmless if unknown
          return s.prompt((usedSystem ? '' : sys + '\n\n') + content);
        });
      }).catch(function () { SESSIONS[sys] = null; return ''; });   // drop a bad cached session
    }

    // ---- Proxy (server key, injected transport) -----------------------------------
    // A grant-holding script installs the real cross-origin sender:
    //   bwnAI.setProxy(function (payload) { ... return Promise<string text>; })
    // payload = {task, system, prompt, maxTokens, minRank, rank}. The sender owns auth
    // (token in the JSON BODY, never Authorization - the SWA edge overwrites it) and must
    // RESOLVE '' / REJECT on any miss (403 ROLE_REQUIRED, network, empty) so we fall through.
    var _proxySend = null;
    function proxy(payload, send) {
      var fn = send || _proxySend;
      if (typeof fn !== 'function') return Promise.resolve('');   // no transport -> miss
      return Promise.resolve().then(function () { return fn(payload); })
        .then(function (t) { return String(t || ''); }, function () { return ''; });
    }

    function withTimeout(p, ms) {
      return new Promise(function (resolve) {
        var t = setTimeout(function () { resolve(undefined); }, ms);
        Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); }, function () { clearTimeout(t); resolve(undefined); });
      });
    }
    function clean(text, oneLine, maxChars) {
      var s = String(text || '');
      if (oneLine) s = s.replace(/\s+/g, ' ').replace(/^["']+|["']+$/g, '');
      return s.trim().slice(0, maxChars);
    }

    // ---- Router -------------------------------------------------------------------
    function bwnAI(opts) {
      opts = opts || {};
      var task = opts.task || 'summarize';
      var oneLine = (opts.oneLine !== undefined) ? !!opts.oneLine : !!TASK_ONELINE[task];
      var maxChars = opts.maxChars || (oneLine ? 300 : 4000);
      var sys = opts.system || TASK_SYSTEM[task] || TASK_SYSTEM.summarize;
      var content = (opts.prompt != null) ? String(opts.prompt)
        : (typeof opts.input === 'string' ? opts.input : (opts.input != null ? JSON.stringify(opts.input) : ''));
      var localFn = (typeof opts.local === 'function') ? opts.local : null;
      var floor = function () { try { return localFn ? clean(localFn(), oneLine, maxChars) : ''; } catch (e) { return ''; } };

      // Ordered tier list: desired ceiling first (task default, unless tier overrides),
      // then the fallback chain. Deduped, capped at proxy when tier says 'ondevice'.
      var desired = (opts.tier && opts.tier !== 'auto') ? opts.tier : (TASK_TIER[task] || 'ondevice');
      var order = [desired].concat(opts.fallback || ['ondevice', 'local']);
      var seen = {}, tiers = [];
      order.forEach(function (t) { if (t && !seen[t]) { seen[t] = 1; tiers.push(t); } });

      var minRank = (typeof opts.minRank === 'number') ? opts.minRank : 4;
      var r = rank();

      function step(i) {
        if (i >= tiers.length) return Promise.resolve('');
        var t = tiers[i], next = function () { return step(i + 1); };
        if (t === 'local') { return Promise.resolve(floor()); }   // terminal floor
        if (t === 'proxy') {
          // Fail CLOSED: unknown/under-rank quietly skips the paid tier (no 403 flash, no
          // wasted key) and drops to on-device. The server still backstops if we do send.
          if (r == null || r < minRank) return next();
          return proxy({ task: task, system: sys, prompt: content, maxTokens: opts.maxTokens, minRank: minRank, rank: r }, opts.proxySend)
            .then(function (out) { out = clean(out, oneLine, maxChars); return out || next(); });
        }
        if (t === 'ondevice') {
          return onDevice(sys, content).then(function (out) { out = clean(out, oneLine, maxChars); return out || next(); });
        }
        return next();
      }

      var run = step(0).then(function (out) { return out || floor(); });
      return withTimeout(run, opts.timeoutMs || 8000).then(function (v) { return v || floor() || ''; });
    }
    bwnAI.setProxy = function (fn) { _proxySend = (typeof fn === 'function') ? fn : null; };
    bwnAI.rank = rank;   // exposed for debug / gating UI
    return bwnAI;
  })();
  // ===== END bwnAI =====

  // ---- injected transport: constants + one-shot sender (TASK-011) --------------------
  var AI_URL = SWA_BASE + '/api/ai';

  // The old /api/wo-audit system prompt, replicated verbatim (hyphens only, no em-dash)
  // so the status-note style matches the retired route (output parity, TASK-011).
  var WO_AUDIT_SYSTEM = [
    'You are a work order audit assistant for a facilities-maintenance company.',
    '',
    'You are given one work order\'s header facts and its most recent notes (newest first).',
    'Write a professional 1-3 sentence client-ready status note describing where the work',
    'order stands right now, based ONLY on the notes and facts provided.',
    '',
    'Note writing rules:',
    '- Pending scheduling -> scheduling is in progress, state reason if known.',
    '- Materials pending -> materials ordered/in transit, note next action if confirmed.',
    '- Proposal in review -> state proposal status and awaiting approval.',
    '- On-site active -> state progress and next confirmed milestone.',
    '- Waiting on third party/client/vendor -> clearly state the dependency.',
    '- Complete -> state completion, mention closeout items only if confirmed.',
    '- Never invent ETAs, dates, approvals, or facts not present in the notes.',
    '- If the notes are empty or say nothing about status, say so plainly',
    '  (e.g. "No recent status notes on file.") - do NOT fabricate a status.',
    '',
    'Return ONLY the note text: 1-3 plain sentences, no preamble, no JSON, no markdown, no quotes.'
  ].join('\n');

  // Build the user turn exactly as /api/wo-audit did (WO header facts + the two most
  // recent notes, newest first) so the model sees the same input it always did.
  function buildAuditInput(wo, notes) {
    wo = wo || {};
    var top2 = (notes || []).slice(0, 2);
    var noteLines = top2.map(function (n, i) {
      n = (n && typeof n === 'object') ? n : {};
      var when = String(n.createdDate || '').trim().slice(0, 40);
      var type = String(n.type || '').trim().slice(0, 40);
      var txt = String(n.content || '').trim().slice(0, 4000);
      var head = 'Note ' + (i + 1) + (when ? ' (' + when + ')' : '') + (type ? ' [' + type + ']' : '') + ':';
      return head + '\n' + (txt || '(empty)');
    });
    var loc = [String(wo.location || '').trim(), [String(wo.city || '').trim(), String(wo.state || '').trim()].filter(Boolean).join(', ')].filter(Boolean).join(' ');
    return [
      'WO #: ' + (String(wo.raw || wo.number || '').trim() || '(unknown)'),
      'Status: ' + (String(wo.status || '').trim() || '(unknown)'),
      'Location: ' + (loc || '(unknown)'),
      'Days open: ' + (String(wo.days || '').trim() || '(unknown)'),
      'Assigned: ' + (String(wo.assignedTo || '').trim() || '(unknown)'),
      '',
      'Most recent notes (newest first):',
      noteLines.length ? noteLines.join('\n\n') : '(no notes provided)',
      '',
      'Write ONLY the 1-3 sentence client-ready status note.'
    ].join('\n');
  }

  // Parse `retry-after` out of GM_xmlhttpRequest's raw CRLF header blob. Accepts either form
  // RFC 9110 allows (delay-seconds or an HTTP-date). Returns 0 when absent or unparseable so
  // callers fall back to their own table; clamped to 120s so a wild value cannot park a row.
  function retryAfterMs(rawHeaders) {
    var m = /^[ \t]*retry-after[ \t]*:[ \t]*(.+)$/im.exec(String(rawHeaders || ''));
    if (!m) return 0;
    var v = m[1].trim();
    var secs = /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
    if (isNaN(secs)) {
      var when = Date.parse(v);
      if (isNaN(when)) return 0;
      secs = Math.ceil((when - Date.now()) / 1000);
    }
    if (!(secs > 0)) return 0;
    return Math.min(secs, 120) * 1000;
  }
  // Whether the header was PRESENT, independent of whether it parsed to a usable wait. This used
  // to be inferred at the call site as `retryAfterMs(...) > 0`, which is wrong for every header
  // the server really did send but that clamps to 0: `retry-after: 0`, `+60`, `-5`, `60, 30`, or
  // any garbage. The log line it feeds ("(no retry-after header)") is the designated live proof
  // that the SWA edge forwards the header at all, so deriving it from the value makes the one
  // planned verification report a working feature as dead.
  function hasRetryAfter(rawHeaders) {
    return /^[ \t]*retry-after[ \t]*:/im.test(String(rawHeaders || ''));
  }

  // Timing budget. These MUST fit inside the timeoutMs handed to bwnAI at the call site: the
  // BYTE-FROZEN router wraps the whole run in withTimeout(run, timeoutMs) and resolves '' when
  // it wins, which discards the recorded reason and falls through to the generic message. The
  // sender therefore gets the SHORTER deadline and always reports first; the router is only a
  // backstop. Getting this wrong is what made a 15s+45s schedule inside a 60s router budget a
  // guaranteed row failure that merely took a minute longer to arrive.
  var AI_ATTEMPT_TIMEOUT_MS = 45000;                          // one wire attempt
  var AI_ROW_BUDGET_MS = 150000;                              // attempt + a full 60s wait + attempt
  var AI_ROUTER_TIMEOUT_MS = AI_ROW_BUDGET_MS + 15000;        // backstop, never the reporter
  var THROTTLE_BACKOFF_MS = [15000, 45000];   // cumulative 60s - clears either 60s window
  var TRANSIENT_BACKOFF_MS = [2000, 6000];    // plain 5xx / network blip
  // A wait that leaves less than this cannot produce an answer, so it is the point at which the
  // budget is genuinely spent rather than merely tight. Used to TRIM an over-long wait instead of
  // abandoning the row while budget remains.
  var AI_MIN_ATTEMPT_MS = 8000;

  // Plain-language cause for a coordinator, wire detail kept in parentheses for support.
  // "HTTP 502: Anthropic API error (429)" tells the reader nothing they can act on.
  function causeText(kind, status, detail) {
    var head = (kind === 'throttle') ? 'the AI service was busy, rate limited'
      : (kind === 'timeout') ? 'the AI service did not respond in time'
      : (kind === 'auth') ? 'the SWA rejected the ingest key'
      : (kind === 'budget') ? 'gave up waiting out a rate limit'
      : 'the AI service errored';
    var tail = [];
    if (status) tail.push('HTTP ' + status);
    if (detail) tail.push(String(detail));
    return head + (tail.length ? ' (' + tail.join(': ') + ')' : '');
  }

  // An upstream Anthropic throttle reaches us as a GENERIC 502 whose body names the real
  // status, so testing status === 429 alone misses it and drops to the fast transient table -
  // reintroducing the very bug this schedule exists to fix.
  function isThrottle(r) {
    if (r.status === 429 || r.status === 529) return true;
    var e = (r.json && r.json.error) ? String(r.json.error) : '';
    return r.status === 502 && /\((?:429|529)\)/.test(e);
  }

  // Injected proxy sender: ONE POST to /api/ai (summarize tier). Reuses the existing
  // ingest-key + Umbrava-token plumbing. Resolves '' on any miss so bwnAI falls through and
  // never throws (backgrounded-tab rule), recording WHY into `ctx.reason` - including a
  // PROVISIONAL reason before each wire call, so a row abandoned mid-flight still reports
  // something truthful rather than the generic rank/key fallback.
  function aiProxySend(payload, ctx) {
    payload = payload || {};
    ctx = ctx || {};
    var key = getKey();
    if (!key) { ctx.reason = causeText('auth', 0, 'no ingest key set; use the Tampermonkey menu'); return Promise.resolve(''); }
    var body = {
      task: payload.task || 'summarize',
      input: (payload.prompt != null) ? String(payload.prompt) : '',
      userToken: authToken()
    };
    if (payload.system) body.system = payload.system;
    if (payload.model) body.model = payload.model;
    var tries = 3, attempt = 0;
    var deadline = Date.now() + AI_ROW_BUDGET_MS;
    var lastKind = '', lastStatus = 0;   // what we most recently SAW, for the budget message
    var sawThrottle = false;             // sticky: a row throttled twice then timing out is,
                                         // in substance, rate limited - say so or the reader
                                         // chases the wrong cause on the last attempt's class.
    function give(why) {
      var msg = why + (attempt > 1 ? ' after ' + attempt + ' tries' : '');
      if (sawThrottle && !/rate limited/.test(msg)) msg += '; the service was rate limiting this batch earlier';
      ctx.reason = msg;
      return '';
    }
    // When the budget is the binding constraint, name what we were up against - "ran out of
    // time" alone would send a coordinator chasing the wrong thing, which is the whole bug.
    function giveBudget() {
      var head = lastKind ? causeText(lastKind, lastStatus, '') : 'the AI service did not respond';
      return give(head + ', and the ' + Math.round(AI_ROW_BUDGET_MS / 1000) + 's limit for one row ran out');
    }
    // Never sleep past the budget, and never issue a POST after it: sleeping into the router
    // abort is what discarded the reason, and a late POST spends the shared IP throttle on a
    // row that has already been marked errored.
    function pause(waitMs, throttled, hadHeader) {
      // TRIM an over-long wait, do not abandon the row. A wait that does not fit is not proof the
      // budget is spent: a 60s hint arriving at t=90s used to fail the row reporting "the 150s
      // limit for one row ran out" with roughly 60s still unspent, when a shorter wait would have
      // left room for a third attempt. Only when there is no room for a usable attempt at all is
      // the budget actually gone - which is also what makes giveBudget()'s claim true.
      var room = deadline - Date.now() - AI_MIN_ATTEMPT_MS;
      if (waitMs > room) waitMs = room;
      if (waitMs <= 0) return Promise.resolve(giveBudget());
      if (ctx.onWait) { try { ctx.onWait(waitMs, throttled, hadHeader); } catch (e) { } }
      return sleep(waitMs).then(once);
    }
    function once() {
      attempt++;
      // Cap this attempt to what is left. An attempt that STARTS inside the budget can still
      // run past it - and past the router backstop - which is exactly how a reason gets lost.
      var remain = deadline - Date.now();
      if (remain <= 1000) return Promise.resolve(giveBudget());
      ctx.reason = causeText('timeout', 0, 'no reply yet on try ' + attempt);
      return gmPost(AI_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, body, Math.min(AI_ATTEMPT_TIMEOUT_MS, remain))
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok && r.json.status === 'final') return String(r.json.text || '');
          var throttled = isThrottle(r);
          var detail = (r.json && r.json.error) ? String(r.json.error) : '';
          lastKind = throttled ? 'throttle' : (r.status === 403 ? 'auth' : 'error');
          lastStatus = r.status;
          if (throttled) sawThrottle = true;
          // 403/400/413 are verdicts, not weather - retrying them only wastes the budget.
          if (r.status === 403 || r.status === 400 || r.status === 413) return give(causeText(lastKind, r.status, detail));
          if (attempt >= tries) return give(causeText(lastKind, r.status, detail));
          var hinted = retryAfterMs(r.headers);
          var table = throttled ? THROTTLE_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
          var planned = table[attempt - 1] || table[table.length - 1];
          // FLOOR the server hint against the table; never let it REPLACE the table. The server
          // now emits the real remaining window, which is the wait for one slot to free (~1s under
          // a steady batch) and NOT the wait until this caller is admitted. Taking it verbatim
          // made a throttled row burn all three tries in about two seconds - the same sub-2s burn
          // this release exists to remove, reintroduced by making the server honest. The table is
          // the floor because it is sized to clear the 60s sliding window on both sides of the
          // wire; a longer hint still wins, which is the case where the server knows better.
          return pause(Math.max(hinted, planned), throttled, hasRetryAfter(r.headers));
        }, function (e) {
          var why = (e && e.message) || 'network error';
          lastKind = /timed out/i.test(why) ? 'timeout' : 'error';
          lastStatus = 0;
          if (attempt >= tries) return give(causeText(lastKind, 0, why));
          return pause(TRANSIENT_BACKOFF_MS[attempt - 1] || TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1], false, false);
        });
    }
    return once();
  }
  bwnAI.setProxy(aiProxySend);

  // Summarize one WO into a status note through the unified transport. tier:'proxy'
  // (minRank 1) forces the /api/ai summarize call for any staff+ with a known role; the
  // server is key-only, so the client rank read is UX-only. A miss (connector down / role
  // not yet resolved) throws so the batch pool marks the row for "Retry Errors" (unchanged).
  function summarize(woFacts, notes, model, onWait) {
    // Per-WO context, not module state: concurrency defaults to 3, so a shared object would
    // cross-report one row's reason onto another. `onWait` lets the batch log a liveness line
    // while the sender sits in backoff.
    var ctx = { onWait: onWait };
    return bwnAI({
      task: 'summarize',
      tier: 'proxy',
      minRank: 1,
      prompt: buildAuditInput(woFacts, notes),
      system: WO_AUDIT_SYSTEM,
      oneLine: false,
      maxChars: 4000,
      timeoutMs: AI_ROUTER_TIMEOUT_MS,
      fallback: [],
      proxySend: function (p) { p.model = model; return aiProxySend(p, ctx); }
    }).then(function (note) {
      note = String(note || '').trim();
      // ctx.reason is set before the first wire call, so an unset reason now means bwnAI never
      // reached the sender AT ALL - the router fail-closed on an unknown Umbrava rank
      // (`bwn:role:last` unpublished, i.e. running without the Ops Suite). That is the only
      // case the key/role hint ever described, and the run summary states it once.
      if (!note) throw new Error(ctx.reason || 'Umbrava rank not resolved - run alongside the BWN Ops Suite');
      return note;
    });
  }

  // ---- Bounded-concurrency runner ----
  function runPool(items, worker, concurrency, onProgress, shouldStop) {
    return new Promise(function (resolve) {
      var i = 0, done = 0, results = new Array(items.length);
      function next() {
        if (i >= items.length) return Promise.resolve();
        // Cancel stops handing out NEW rows; rows already in flight finish so their notes are
        // not lost. Backoff waits can run to minutes, so a batch must be interruptible.
        if (shouldStop && shouldStop()) return Promise.resolve();
        var idx = i++;
        return Promise.resolve().then(function () { return worker(items[idx], idx); })
          .then(function (v) { results[idx] = v; }, function (e) { results[idx] = { error: (e && e.message) || String(e) }; })
          .then(function () { done++; if (onProgress) onProgress(done, items.length); return next(); });
      }
      var runners = [];
      for (var k = 0; k < Math.min(Math.max(1, concurrency), items.length || 1); k++) runners.push(next());
      Promise.all(runners).then(function () { resolve(results); });
    });
  }

  // ===== RUN ACCOUNTING =====================================================
  // A row has THREE outcomes, not two. Cancel returns from next() before the row is ever handed
  // to the worker, so `session.results[i]` stays a HOLE - distinct from a written note and from
  // an `{error}`. Every consumer used to test `.error` alone, so a skipped row was invisible: it
  // counted nowhere, could not be retried, and its note cell went out unwritten with nothing on
  // screen saying so. Module scope, and marked, so the node harness drives the real shipped bytes.

  // Index loop, not `.filter`/`.reduce`: `session.results` is a SPARSE array (assigned by index,
  // never pushed) and the iterator methods skip holes entirely - the exact rows this counts.
  // `skipped` is derived from the total so a hole cannot escape it.
  function auditTally(results, total) {
    var ok = 0, errs = 0;
    for (var i = 0; i < total; i++) {
      var r = results[i];
      if (!r) continue;
      if (r.error) errs++; else ok++;
    }
    return { ok: ok, errs: errs, skipped: total - ok - errs };
  }

  // Everything that still owes a note: errored rows AND rows the cancel never reached.
  // Positional - `session.results` is indexed by position in `session.rows`.
  function pendingRows(rows, results) {
    return rows.filter(function (row, i) {
      var r = results[i];
      return !r || !!r.error;
    });
  }

  // One vocabulary for every surface. The summary, the cancel warning and the download warning
  // previously used three different phrasings and two different totals ("unaudited" meaning
  // errored+skipped in one place, "never audited" meaning skipped only in another), so the number
  // a coordinator read at download matched nothing they had been shown.
  function owedPhrase(tal) {
    var owed = tal.errs + tal.skipped;
    var parts = [];
    if (tal.errs) parts.push(tal.errs + ' failed');
    if (tal.skipped) parts.push(tal.skipped + ' never audited');
    return owed + ' row' + (owed === 1 ? '' : 's') + ' with no note' +
      (parts.length ? ' (' + parts.join(', ') + ')' : '');
  }
  // Said wherever an unwritten cell can reach the client. Deliberately does NOT claim the cells
  // are blank: nothing is written to a row that errored or was skipped, so the cell keeps whatever
  // the uploaded workbook held - and on a recurring audit the detected notes column carries LAST
  // cycle's status text. Shipping that as current is worse than shipping a blank.
  var UNWRITTEN_NOTE = 'Those cells were not written: blank if this column is new, otherwise still holding the workbook\'s previous text.';
  // ===== END RUN ACCOUNTING =================================================

  // ====================================================================
  // Workbook mapping. Header-based (survives column reorder) with a scan for the
  // header row; write-back column detected dynamically, appended if absent.
  // ====================================================================
  var KEY_PATTERNS = [/^wo\s*#?$/i, /work\s*order\s*#/i, /^wo\s*number/i];
  var KEY_FALLBACK = [/source\s*job\s*#?/i, /^job\s*id$/i, /^job\s*#?$/i];
  function findCol(hdr, patterns) {
    for (var p = 0; p < patterns.length; p++) {
      for (var c = 0; c < hdr.length; c++) { if (patterns[p].test(hdr[c])) return c; }
    }
    return -1;
  }
  function findNoteCol(hdr) {
    // Prefer an explicit notes column; then any "note(s)" header that is about note CONTENT -
    // never a date/count/author/timestamp column, so "Last Note Date" must NOT match.
    var pref = [/^audit\s*notes?$/i, /^status\s*notes?$/i, /^notes?$/i, /coordinator\s*notes?/i, /audit.*note|note.*audit/i, /status\s*note/i];
    for (var p = 0; p < pref.length; p++) { for (var c = 0; c < hdr.length; c++) { if (pref[p].test(hdr[c])) return c; } }
    var last = -1;
    for (var i = 0; i < hdr.length; i++) {
      if (/\bnotes?\b/i.test(hdr[i]) && !/date|count|#|by|author|time|updated|\blast\b/i.test(hdr[i])) last = i;
    }
    return last;
  }
  function mapSheet(ws) {
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
    // Locate the header row: the first row (of the first 15) that matches a key pattern.
    var headerRow = 0, keyCol = -1;
    for (var r = 0; r < Math.min(15, aoa.length); r++) {
      var row = (aoa[r] || []).map(function (x) { return String(x == null ? '' : x); });
      var k = findCol(row, KEY_PATTERNS);
      if (k === -1) k = findCol(row, KEY_FALLBACK);
      if (k !== -1) { headerRow = r; keyCol = k; break; }
    }
    var hdr = (aoa[headerRow] || []).map(function (x) { return String(x == null ? '' : x); });
    if (keyCol === -1) keyCol = findCol(hdr, KEY_PATTERNS);
    if (keyCol === -1) keyCol = findCol(hdr, KEY_FALLBACK);
    var map = {
      headerRow: headerRow,
      key: keyCol,
      keyName: keyCol > -1 ? hdr[keyCol] : null,
      status: findCol(hdr, [/^status$/i, /wo\s*status/i]),
      city: findCol(hdr, [/^city$/i]),
      state: findCol(hdr, [/^state$/i]),
      location: findCol(hdr, [/location|site|store/i]),
      days: findCol(hdr, [/aged|days\s*open|^days$/i]),
      assigned: findCol(hdr, [/assigned|coordinator|owner/i]),
      note: findNoteCol(hdr),
      noteAppended: false,
    };
    map.noteName = map.note > -1 ? hdr[map.note] : null;
    map.aoa = aoa;
    return map;
  }
  // Ensure a note column exists on the worksheet; append "Audit Notes" if none was found.
  function ensureNoteCol(ws, map) {
    if (map.note > -1) return map;
    var range = XLSX.utils.decode_range(ws['!ref']);
    var col = range.e.c + 1;
    ws[XLSX.utils.encode_cell({ c: col, r: map.headerRow })] = { t: 's', v: 'Audit Notes' };
    range.e.c = col;
    ws['!ref'] = XLSX.utils.encode_range(range);
    map.note = col; map.noteName = 'Audit Notes'; map.noteAppended = true;
    return map;
  }
  function cellStr(aoa, r, c) {
    if (c < 0) return '';
    var row = aoa[r] || [];
    var v = row[c];
    return v == null ? '' : String(v).trim();
  }

  // ====================================================================
  // UI
  // ====================================================================
  var session = null;   // { wb, ws, map, rows:[{rowIdx, key}], results:[], name }
  // Module scope so the dock-eviction listener can see it too. A run can now span many minutes
  // of rate-limit backoff, so dismissing the drawer mid-run has to stop being a silent way to
  // throw away every note already written into the workbook.
  var _running = false, _cancelled = false;

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:' + GREEN + ';color:#fff;padding:9px 16px;border-radius:8px;font:600 13px ' + FONT + ';z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function getKey() { return GM_getValue('ingest_key', ''); }

  function buildModal() {
    if (document.getElementById('bwn-woaudit-ov')) return;
    // Suite drawer: slides out from the dock rail, styled by Core's page-wide sheet.
    var ov = document.createElement('aside');
    ov.id = 'bwn-woaudit-ov'; ov.className = 'bwn-drawer';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'WO Audit');
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;';
    box.innerHTML =
      '<div class="bwn-drawer-hd"><div><div class="t">WO Audit</div><div class="s">batch status notes from an audit .xlsx</div></div>' +
      '<button type="button" id="bwn-woaudit-x" class="bwn-drawer-x" title="Close" aria-label="Close">&times;</button></div>' +
      '<div class="bwn-drawer-body">' +
      '<div id="bwn-woaudit-keywarn" style="display:none;background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:12.5px"></div>' +
      // Completeness gets its OWN banner rather than sharing the ingest-key one: they fire in
      // different situations and would clobber each other. It persists outside the 240px log,
      // where the same sentence is one 12px monospace line among forty that look identical - the
      // coordinator clicks Download, the browser takes focus, and the file is already on disk.
      // role=status so it is announced rather than only drawn.
      '<div id="bwn-woaudit-warn" role="status" aria-live="polite" style="display:none;background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:12.5px;font-weight:600"></div>' +
      '<label style="display:block;font-weight:600;margin-bottom:6px">1. Audit workbook (.xlsx)</label>' +
      '<input type="file" id="bwn-woaudit-file" accept=".xlsx,.xls" style="margin-bottom:6px">' +
      '<div id="bwn-woaudit-sheetwrap" style="display:none;margin:8px 0"><label style="font-weight:600;margin-right:8px">Sheet</label><select id="bwn-woaudit-sheet"></select></div>' +
      '<div id="bwn-woaudit-mapinfo" style="font-size:12.5px;color:#444;margin:8px 0;white-space:pre-line"></div>' +
      '<div id="bwn-woaudit-notecolwrap" style="display:none;margin:8px 0"><label style="font-weight:600;margin-right:8px">Write notes to column</label><select id="bwn-woaudit-notecol"></select></div>' +
      '<div style="display:flex;gap:16px;margin:12px 0;flex-wrap:wrap">' +
      '<div><label style="display:block;font-weight:600;margin-bottom:4px">Model</label><select id="bwn-woaudit-model"></select></div>' +
      '<div><label style="display:block;font-weight:600;margin-bottom:4px">Concurrency</label><input id="bwn-woaudit-conc" type="number" min="1" max="6" value="3" style="width:64px"></div>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0">' +
      '<button id="bwn-woaudit-start" style="background:' + GREEN + ';color:#fff;border:0;padding:9px 18px;border-radius:8px;font-weight:600;cursor:pointer">Start Audit</button>' +
      '<button id="bwn-woaudit-cancel" style="display:none;background:#6b1d1d;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Cancel</button>' +
      '<button id="bwn-woaudit-retry" style="display:none;background:#8a4b00;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Retry Unfinished</button>' +
      '<button id="bwn-woaudit-dl" style="display:none;background:#1a5f3e;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Download .xlsx</button>' +
      '</div>' +
      '<div id="bwn-woaudit-prog" style="font-weight:600;margin:6px 0"></div>' +
      '<div id="bwn-woaudit-log" style="font:12px ui-monospace,Consolas,monospace;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:8px;padding:10px;max-height:240px;overflow:auto;white-space:pre-wrap"></div>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);

    var $ = function (id) { return document.getElementById(id); };
    // Dismissal is refused while a run is in flight - a stray backdrop click during a long
    // backoff would otherwise orphan the workbook in memory with no route to Download.
    function tryClose() {
      if (_running) { logln('  (still running - press Cancel first if you want to stop)'); return; }
      ov.remove();
    }
    ov.addEventListener('click', function (e) { if (e.target === ov) tryClose(); });
    $('bwn-woaudit-x').onclick = tryClose;

    var msel = $('bwn-woaudit-model');
    MODELS.forEach(function (m) { var o = document.createElement('option'); o.value = m.id; o.textContent = m.label; msel.appendChild(o); });

    var kw = $('bwn-woaudit-keywarn');
    if (!getKey()) { kw.style.display = 'block'; kw.textContent = 'SWA ingest key not set. Open the Tampermonkey menu -> "BWN WO Audit: Set SWA ingest key" (same key as the rest of the BWN Ops Suite), then reopen this.'; }

    var log = $('bwn-woaudit-log');
    function logln(s) { log.textContent += (log.textContent ? '\n' : '') + s; log.scrollTop = log.scrollHeight; }
    // The persistent half of a warning. Null-safe for the same reason the button writes are: the
    // drawer can be gone or rebuilt while a run is in flight.
    function setWarn(msg) {
      var w = $('bwn-woaudit-warn'); if (!w) return;
      w.textContent = msg || '';
      w.style.display = msg ? 'block' : 'none';
    }

    var loaded = null;   // { wb, name }
    $('bwn-woaudit-file').onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      // Belt and braces with the disabled attribute set in runAudit: a file picked mid-run would
      // replace `loaded` and orphan every note already written into the workbook in memory.
      if (_running) { logln('! A run is in progress - finish or cancel it before loading another workbook.'); return; }
      var fr = new FileReader();
      fr.onload = function () {
        try {
          if (typeof XLSX === 'undefined') throw new Error('spreadsheet library not loaded - reload the page');
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellFormula: true, cellStyles: true });
          loaded = { wb: wb, name: (f.name || 'wo-audit.xlsx').replace(/\.(xlsx|xls)$/i, '') };
          var sw = $('bwn-woaudit-sheetwrap'), ss = $('bwn-woaudit-sheet');
          ss.innerHTML = '';
          wb.SheetNames.forEach(function (nm) { var o = document.createElement('option'); o.value = nm; o.textContent = nm; ss.appendChild(o); });
          sw.style.display = wb.SheetNames.length > 1 ? 'block' : 'none';
          ss.onchange = describe;
          describe();
        } catch (err) { $('bwn-woaudit-mapinfo').textContent = 'Could not read workbook: ' + ((err && err.message) || err); }
      };
      fr.readAsArrayBuffer(f);
    };

    function currentSheet() { return loaded ? ($('bwn-woaudit-sheet').value || loaded.wb.SheetNames[0]) : null; }
    function describe() {
      if (!loaded) return;
      // Never rebuild `session` mid-run. A run now spans minutes of backoff, and swapping the
      // session under in-flight workers makes `session.rows.indexOf(row)` return -1, so their
      // notes are written to `results[-1]` where auditTally's index loop can never see them -
      // the rows report as "never audited" while their notes went into the OLD sheet.
      if (_running) return;
      // Results on screen belong to the session being replaced. Leaving Retry visible lets a
      // stale press audit the NEW workbook into whatever column was detected for it, overwriting
      // the client's existing Notes text; leaving Download visible offers the previous workbook.
      var rb0 = $('bwn-woaudit-retry'); if (rb0) rb0.style.display = 'none';
      var db0 = $('bwn-woaudit-dl'); if (db0) db0.style.display = 'none';
      setWarn('');   // the previous session's completeness state does not describe this workbook
      var ws = loaded.wb.Sheets[currentSheet()];
      var map = mapSheet(ws);
      var hdr = (map.aoa[map.headerRow] || []).map(function (x) { return String(x == null ? '' : x); });
      var dataRows = [];
      for (var r = map.headerRow + 1; r < map.aoa.length; r++) {
        var key = cellStr(map.aoa, r, map.key);
        if (key) dataRows.push({ rowIdx: r, key: key });
      }
      // Write-back column picker: every header + an append option, defaulting to the detection.
      // Header-detection is a hint only; the operator confirms so a wrong guess is never silent.
      var ncsel = $('bwn-woaudit-notecol');
      ncsel.innerHTML = '';
      hdr.forEach(function (h, i) { var o = document.createElement('option'); o.value = String(i); o.textContent = (h || ('(col ' + (i + 1) + ')')) + (i === map.note ? '  <-- detected' : ''); ncsel.appendChild(o); });
      var appendOpt = document.createElement('option'); appendOpt.value = 'append'; appendOpt.textContent = '+ append new "Audit Notes" column'; ncsel.appendChild(appendOpt);
      ncsel.value = (map.note > -1) ? String(map.note) : 'append';
      $('bwn-woaudit-notecolwrap').style.display = 'block';
      var info = [
        'WO # column: ' + (map.keyName != null ? '"' + map.keyName + '"' : 'NOT FOUND (cannot run)'),
        'Work orders detected: ' + dataRows.length,
      ].join('\n');
      $('bwn-woaudit-mapinfo').textContent = info;
      $('bwn-woaudit-start').disabled = !(map.key > -1 && dataRows.length);
      session = { wb: loaded.wb, sheet: currentSheet(), map: map, rows: dataRows, results: [], name: loaded.name };
    }

    $('bwn-woaudit-start').onclick = function () { runAudit(false); };
    $('bwn-woaudit-retry').onclick = function () { runAudit(true); };
    $('bwn-woaudit-dl').onclick = function () { downloadResult(); };
    // Stops handing out new rows; in-flight rows finish so their notes are kept and Download
    // still appears. Without this the only exit from a long backoff is reloading the tab.
    $('bwn-woaudit-cancel').onclick = function () {
      if (!_running || _cancelled) return;
      _cancelled = true;
      logln('Cancelling - letting the rows already in flight finish...');
      this.disabled = true;
    };

    function runAudit(retryOnly) {
      if (!session) return;
      var key = getKey();
      if (!key) { kw.style.display = 'block'; kw.textContent = 'Set the SWA ingest key first (Tampermonkey menu).'; return; }
      if (!authToken()) { logln('! Not signed into Umbrava (no usable token). Reload the tab and retry.'); return; }
      var model = $('bwn-woaudit-model').value;
      var conc = Math.max(1, Math.min(6, parseInt($('bwn-woaudit-conc').value, 10) || 3));
      var ws = session.wb.Sheets[session.sheet];
      // Resolve the write-back column from the picker (detection is only the default) - but never
      // again once a column has been APPENDED. Both branches force `note = -1` first, which
      // defeats ensureNoteCol's own `if (map.note > -1) return` guard, so re-resolving appends a
      // SECOND "Audit Notes" column and splits one audit across two half-blank columns in the
      // client's workbook. The picker still governs the first resolution, and a run against an
      // EXISTING column stays re-resolvable because nothing was appended.
      if (!session.map.noteAppended) {
        var pick = $('bwn-woaudit-notecol').value;
        if (pick === 'append') { session.map.note = -1; ensureNoteCol(ws, session.map); }
        else { session.map.note = parseInt(pick, 10); if (isNaN(session.map.note)) { session.map.note = -1; ensureNoteCol(ws, session.map); } }
      }

      // Resume, not just retry: rows a cancel skipped owe a note exactly as much as errored rows
      // do, and matching `.error` alone left them permanently unfinishable.
      var targets = retryOnly
        ? pendingRows(session.rows, session.results)
        : session.rows.slice();
      if (retryOnly && !targets.length) { logln('Nothing left to finish - every row has a note.'); return; }

      $('bwn-woaudit-start').disabled = true; $('bwn-woaudit-retry').style.display = 'none'; $('bwn-woaudit-dl').style.display = 'none';
      // Lock the inputs that can replace `session` under in-flight workers. describe() also
      // refuses while running; this stops the interaction reaching it at all.
      $('bwn-woaudit-file').disabled = true;
      var shSel = $('bwn-woaudit-sheet'); if (shSel) shSel.disabled = true;
      $('bwn-woaudit-cancel').style.display = 'inline-block';
      $('bwn-woaudit-cancel').disabled = false;
      _running = true; _cancelled = false;
      setWarn('');   // stale from the previous pass; recomputed when this one finishes
      if (!retryOnly) { log.textContent = ''; session.results = new Array(session.rows.length); }
      logln((retryOnly ? 'Retrying ' : 'Auditing ') + targets.length + ' work orders with ' + model + ' (concurrency ' + conc + ')...');
      var prog = $('bwn-woaudit-prog');
      // Seed it: onProgress only fires when a row SETTLES, and a throttled row can now sit in
      // backoff for over a minute. A blank progress area plus a silent log reads as a hang.
      prog.textContent = 'Progress: 0 / ' + targets.length;

      runPool(targets, function (row) {
        var origIdx = session.rows.indexOf(row);
        // Liveness while the sender waits out a throttle. `hadHeader` is deliberately surfaced:
        // this is the first use of GM_xmlhttpRequest responseHeaders anywhere in the suite, so
        // the first live throttle tells us whether the retry-after plumbing actually works.
        var onWait = function (ms, throttled, hadHeader) {
          logln('  . WO ' + row.key + ': ' + (throttled ? 'AI service busy' : 'retrying') +
            ', waiting ' + Math.round(ms / 1000) + 's' +
            (throttled ? (hadHeader ? ' (server retry-after)' : ' (no retry-after header)') : ''));
        };
        return woNotes(row.key)
          .then(function (data) {
            var woFacts = {
              raw: row.key,
              number: row.key,
              status: data.statusName || cellStr(session.map.aoa, row.rowIdx, session.map.status),
              city: cellStr(session.map.aoa, row.rowIdx, session.map.city),
              state: cellStr(session.map.aoa, row.rowIdx, session.map.state),
              location: cellStr(session.map.aoa, row.rowIdx, session.map.location),
              days: cellStr(session.map.aoa, row.rowIdx, session.map.days),
              assignedTo: cellStr(session.map.aoa, row.rowIdx, session.map.assigned),
            };
            var top2 = data.notes.slice(0, 2);
            return summarize(woFacts, top2, model, onWait).then(function (note) {
              return { note: note, notesFound: data.notes.length };
            });
          })
          .then(function (out) {
            // Write into the worksheet cell, dropping any formula (string value only).
            ws[XLSX.utils.encode_cell({ c: session.map.note, r: row.rowIdx })] = { t: 's', v: out.note };
            session.results[origIdx] = { key: row.key, note: out.note, notesFound: out.notesFound };
            logln('  WO ' + row.key + ' (' + out.notesFound + ' notes): ' + (out.note ? out.note.slice(0, 90) : '(blank)'));
            return session.results[origIdx];
          })
          .catch(function (e) {
            session.results[origIdx] = { key: row.key, error: (e && e.message) || String(e) };
            logln('  ! WO ' + row.key + ': ' + session.results[origIdx].error);
            throw e;   // marks the pool slot as errored too
          });
      }, conc, function (done, total) { prog.textContent = 'Progress: ' + done + ' / ' + total; },
        function () { return _cancelled; })
        .then(function () {
          _running = false;
          var fi = $('bwn-woaudit-file'); if (fi) fi.disabled = false;
          var sh = $('bwn-woaudit-sheet'); if (sh) sh.disabled = false;
          var tal = auditTally(session.results, session.rows.length);
          logln((_cancelled ? 'Cancelled. ' : 'Done. ') + tal.ok + ' written, ' + tal.errs + ' failed' +
            (tal.skipped ? ', ' + tal.skipped + ' never audited' : '') + '.');
          // Guidance belongs HERE, once, not appended to every failing row: mid-run a reader
          // cannot evaluate "if every row failed", and 40 copies scroll the results out of the
          // 240px log box. This line is the actual decision point.
          // Guidance is derived from what the rows ACTUALLY reported, not from the fact that they
          // all failed. The old all-failed branch reprinted the key/role diagnosis that this
          // release exists to kill: when a whole batch throttles, ok is 0 and the last line the
          // coordinator reads told them to re-enter a key that was never the problem.
          if (tal.errs) {
            var causes = [];
            for (var ci = 0; ci < session.rows.length; ci++) {
              var rr = session.results[ci];
              if (rr && rr.error) causes.push(String(rr.error));
            }
            var allThrottle = causes.length && causes.every(function (c) { return /rate limited|was busy/i.test(c); });
            var anyAuth = causes.some(function (c) { return /ingest key|rank not resolved|session expired/i.test(c); });
            if (allThrottle) {
              logln('Every failure was the AI service rate limiting this batch. Nothing is misconfigured - wait a minute and press Retry Unfinished.');
            } else if (anyAuth) {
              logln('At least one row failed on access. Check the SWA ingest key (Tampermonkey menu) and that you are signed into Umbrava with a resolved role - run the BWN Ops Suite alongside this.');
            } else {
              logln('Some rows failed. The causes are listed above; rate limits clear on their own, so Retry Unfinished usually finishes them.');
            }
          }
          // The cancel path's own warning. A skipped row produced no log line at all while it was
          // being skipped, so without this the only trace it existed is the row count.
          if (tal.skipped) {
            logln('! ' + tal.skipped + ' row' + (tal.skipped === 1 ? '' : 's') +
              ' stopped before being audited. ' + UNWRITTEN_NOTE + ' Press Retry Unfinished to complete them.');
          }
          // Null-safe: the drawer can be gone if it was dismissed before the guard existed, or
          // rebuilt mid-run. Losing the buttons must not kill the results.
          var sb = $('bwn-woaudit-start'); if (sb) sb.disabled = false;
          var cb = $('bwn-woaudit-cancel'); if (cb) cb.style.display = 'none';
          var db = $('bwn-woaudit-dl'); if (db) db.style.display = 'inline-block';
          if (tal.errs || tal.skipped) { var rb = $('bwn-woaudit-retry'); if (rb) rb.style.display = 'inline-block'; }
          // Persist the completeness state outside the scrolling log, where it survives the
          // coordinator being pulled away between finishing a run and pressing Download.
          setWarn(tal.errs + tal.skipped
            ? 'This workbook is INCOMPLETE: ' + owedPhrase(tal) + ' of ' + session.rows.length + '. ' + UNWRITTEN_NOTE + ' Press Retry Unfinished before sending it.'
            : '');
        });
    }

    function downloadResult() {
      if (!session) return;
      // The workbook is what reaches the client, so the warning fires HERE too, not only in the
      // run summary a coordinator may have scrolled past in a 240px log box.
      var tal = auditTally(session.results, session.rows.length);
      var owed = tal.errs + tal.skipped;
      if (owed) {
        logln('! Downloading with ' + owedPhrase(tal) + ' of ' + session.rows.length + '. ' + UNWRITTEN_NOTE);
        // A blocking acknowledgement, because everything softer has already failed here: the
        // warning used to be one monospace line in a scrolling box, and the moment Download is
        // pressed the browser takes focus and the file is on disk. This is the last point at
        // which an incomplete workbook can still be stopped from reaching a client.
        var proceed = true;
        try {
          proceed = window.confirm(
            'This audit is INCOMPLETE.\n\n' + owedPhrase(tal) + ' of ' + session.rows.length + '.\n\n' +
            UNWRITTEN_NOTE + '\n\nDownload it anyway?');
        } catch (e) { proceed = true; }   // a page that breaks confirm must not trap the workbook
        if (!proceed) { logln('Download cancelled. Press Retry Unfinished to complete the batch.'); return; }
      }
      // The filename is the only part of this that survives into Downloads, an email, and the
      // client's inbox. A partial export must not arrive under the same name as a complete one.
      var fname = session.name + (owed ? '-audited-INCOMPLETE-' + owed + '-unwritten' : '-audited') + '.xlsx';
      try {
        var out = XLSX.write(session.wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
        var blob = new Blob([out], { type: XLSX_MIME });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        // The toast is a success signal; it must not read as one for a partial export.
        toast(owed ? ('Downloaded INCOMPLETE ' + fname) : ('Downloaded ' + fname));
      } catch (err) { logln('! Download failed: ' + ((err && err.message) || err)); }
    }
  }

  // ---- Launchers ----
  try {
    GM_registerMenuCommand('BWN WO Audit: open', buildModal);
    GM_registerMenuCommand('BWN WO Audit: Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', getKey() || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { /* menu API absent - floating button still works */ }

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // bwn-suite-core's Launcher hosts the shared dock ([[bwn-launcher-dock]]); we
  // register one entry ('wo-audit') instead of hand-placing a bottom-left button.
  // detail.key carries the entry id (detail.id is the bwn:evt event name). If no
  // host announces within a few seconds we fall back to the old floating button.
  var DOCK_KEY = 'wo-audit';
  var _hostSeen = false;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'WO Audit', icon: '📋', weight: 20,
        title: 'BWN WO Audit - batch status notes from an audit .xlsx'
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
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildModal();
      // Another tool took the drawer slot - close ours, UNLESS a batch is in flight (a run can
      // span minutes of rate-limit backoff, and evicting it would discard the written rows).
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY && !_running) {
        var o = document.getElementById('bwn-woaudit-ov'); if (o) o.remove();
      }
    });
  } catch (e) { }

  // Register into the dock on load (covers a host already up); the host heartbeat
  // re-registers us later. No host means Core is off or failed to load - warn rather
  // than drawing a corner button; the dock tab is the only launcher this tool has.
  dockRegister();
  setTimeout(function () {
    if (!_hostSeen) console.warn('[BWN WO AUDIT] no dock host - install/enable BWN Suite Core to reach WO Audit.');
  }, 4000);
})();
