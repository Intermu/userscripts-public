// ==UserScript==
// @name         BWN Suite - AI (Broadway National)
// @namespace    broadwaynational.bwn
// @version      1.42.3
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-suite-ai.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-suite-ai.user.js
// @description  The Umbrava tools that call outside APIs, kept separate from the zero-egress Core script. Client Update and WO Audit drafts (Anthropic Claude; draft-only, scrubbed before sending, you review before posting); Find Techs / Find Suppliers (Google Places; vendor leads near a WO); and Job View (opens the Ops-Dashboard job card on the WO page - WO details from Umbrava plus the authored case file and next actions, read-only). Network access is limited by the browser to the declared API hosts and the BWN Static Web App. API keys are stored in Tampermonkey's storage via the menu commands and never enter the page. Toggle modules in BWN_MODULES below.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      places.googleapis.com
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

(function () {
  'use strict';

  // ---- Module kill switches (edit here) ----------------------------------
  var BWN_MODULES = {
    clientUpdate: true,   // Client Update + WO Audit buttons on the notes view
    findTechs: true,      // Find Techs + Find Suppliers buttons by Purchase Orders
    jobView: true,        // Job View: pop the Ops-Dashboard job modal on a WO page
    serviceRequest: true  // Augment Umbrava's Build Requests modal (NTE preset + team inbox)
  };

  var BWN_VER = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.34.2';

  // Module overrides set by the Ops Suite panel (Core); reload to apply. Both
  // scripts read the shared bwn:modules blob and honor only their own keys.
  try {
    var _mp = JSON.parse(localStorage.getItem('bwn:modules') || '{}');
    if (_mp && typeof _mp === 'object') Object.keys(_mp).forEach(function (k) {
      if (typeof _mp[k] === 'boolean' && k in BWN_MODULES) BWN_MODULES[k] = _mp[k];
    });
  } catch (e) { /* defaults */ }

  // Publish version + whether each API key is set (booleans only \u2014 never the
  // keys) so Core's Ops Suite panel can show status. Re-published after a save.
  var AI_LOAD_TS = Date.now();
  function publishAiStatus() {
    try {
      localStorage.setItem('bwn:status:ai', JSON.stringify({
        ver: BWN_VER,
        // The per-user Anthropic key was retired (TASK-014); drafting rides the shared
        // SWA connector now. Report advanced-AI reachability off the connector ingest key
        // so Core's Ops panel status line stays meaningful without a per-user key.
        anthropic: !!GM_getValue('ingest_key', ''),
        places: !!GM_getValue('places_key', ''),
        ingest: !!GM_getValue('ingest_key', ''),
        // ts is the LOAD time, never refreshed: Core's "loaded this session" handshake
        // (aiFresh, o30AiReady, aiEnabled) compares it to Core's own load stamp within
        // 60s. Stamping Date.now() on key-save republishes made the suite call this
        // script "stale" the moment a key was set mid-session (review; pre-existing).
        ts: AI_LOAD_TS
      }));
    } catch (e) { /* best-effort */ }
  }
  publishAiStatus();

  console.info('[BWN SUITE AI] v' + BWN_VER + ' |',
    'Shared Core 7 \u00b7 Client Update 1.47 \u00b7 Find Techs 2.15 \u00b7 Connector 1.5 |',
    'enabled:', Object.keys(BWN_MODULES).filter(function (k) { return BWN_MODULES[k]; }).join(', '));

  // ===== BWN SHARED CORE v7 - KEEP IN SYNC across both suite scripts =====
  // Single source of truth for the bus, suite config, parsing, brand tokens, and
  // the shared UI primitives. Both userscripts carry an IDENTICAL copy: they run in
  // separate Tampermonkey scopes (Core @grant none vs AI's GM_* grants) and cannot
  // share a runtime object across that boundary - they share DATA via sessionStorage
  // /localStorage instead. When you edit this block: bump the version below and paste
  // it into BOTH files. Pure helpers + storage only; never put credentials here.
  var BWN = (function () {
    var VERSION = 7;

    // ---- BWN bus (suite data contract v1; per-origin sessionStorage) ----------
    // WO Assist (Core) is the PRODUCER of bwn:wo:{id}; everyone else consumes with
    // DOM as truth and the bus as fallback. List Heat publishes bwn:heat:{id}.
    function woId() {
      var m = location.pathname.match(/work-orders\/(\d+)/);
      return m ? m[1] : null;
    }
    function busGet(id, maxAgeMs) {
      try {
        var raw = sessionStorage.getItem('bwn:wo:' + id);
        if (!raw) return null;
        var d = JSON.parse(raw);
        if (d.v !== 1 || (maxAgeMs && Date.now() - d.ts > maxAgeMs)) return null;
        return d;
      } catch (e) { return null; }
    }
    function busPut(id, data) {
      try {
        data.v = 1; data.ts = Date.now();
        sessionStorage.setItem('bwn:wo:' + id, JSON.stringify(data));
        document.dispatchEvent(new CustomEvent('bwn:update', { detail: { id: id } }));
      } catch (e) { /* storage full or blocked: bus is best-effort */ }
    }
    function busHeatGet(id, maxAgeMs) {
      try {
        var raw = sessionStorage.getItem('bwn:heat:' + id);
        if (!raw) return null;
        var d = JSON.parse(raw);
        if (d.v !== 1 || (maxAgeMs && Date.now() - d.ts > maxAgeMs)) return null;
        return d;
      } catch (e) { return null; }
    }
    function busVendors(maxAgeMs) {
      var d = busGet(woId(), maxAgeMs || 12 * 3600000);
      if (!d || !Array.isArray(d.pos)) return [];
      return d.pos.map(function (p) { return (p && p.vendor) ? String(p.vendor).trim() : ''; }).filter(Boolean);
    }

    // ---- Suite config (localStorage bwn:config, versioned, merged over defaults) ----
    // Read-modify-write PRESERVES unknown keys (e.g. Views presets) so any module can
    // stash its own data in the same blob. A missing/malformed key falls back to default.
    var CFG_DEFAULTS = {
      targetGP: 35,
      gpWarn: 30, gpBad: 20,
      hrsWarn: 72, hrsBad: 240,
      activeMult: 0.5,
      dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7
    };
    function cfg() {
      var out = {};
      try {
        var raw = localStorage.getItem('bwn:config');
        var d = raw ? JSON.parse(raw) : null;
        if (d && typeof d === 'object' && d.v === 1) out = d;   // preserve unknown keys for read-modify-write
      } catch (e) { out = {}; }
      Object.keys(CFG_DEFAULTS).forEach(function (k) {
        if (!(typeof out[k] === 'number' && isFinite(out[k]))) out[k] = CFG_DEFAULTS[k];
      });
      return out;
    }
    function cfgSave(partial) {
      try {
        var cur = cfg();
        Object.keys(partial).forEach(function (k) { cur[k] = partial[k]; });
        cur.v = 1;
        localStorage.setItem('bwn:config', JSON.stringify(cur));
        document.dispatchEvent(new CustomEvent('bwn:config'));   // WO Assist + List Heat live-refresh on this
      } catch (e) { /* best-effort */ }
    }

    // ---- Money / date / vendor-name parsing -----------------------------------
    function money(n) {
      return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function parseMoney(s) {
      var m = (s || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    }
    function parseBare(s) {
      var n = parseFloat(String(s || '').replace(/[$,\s]/g, ''));
      return isNaN(n) ? null : n;
    }
    function parseUSDate(s) {
      var m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (!m) return null;
      var y = parseInt(m[3], 10); if (y < 100) y += 2000;
      var d = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    function alphaOnly(s) { return (s || '').toUpperCase().replace(/[^A-Z]/g, ''); }
    // Longest common substring length between two strings.
    function lcsLen(a, b) {
      if (!a || !b) return 0;
      var n = b.length, prev = new Array(n + 1).fill(0), best = 0;
      for (var i = 1; i <= a.length; i++) {
        var cur = new Array(n + 1).fill(0);
        for (var j = 1; j <= n; j++) {
          if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
        }
        prev = cur;
      }
      return best;
    }

    // ---- Field readers / React-safe setter ------------------------------------
    function inputVal(testid) {
      var el = document.querySelector('[data-testid="' + testid + '"]');
      if (!el) return '';
      if (el.tagName === 'INPUT') return el.value || '';
      var inp = el.querySelector('input');
      return inp ? (inp.value || '') : (el.textContent || '').trim();
    }
    function setNativeValue(el, value) {
      var proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ---- Brand tokens + gradient ----------------------------------------------
    var GREEN = 'linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk))';
    function injectTokens() {
      if (document.getElementById('bwn-suite-tokens')) return;
      var st = document.createElement('style');
      st.id = 'bwn-suite-tokens';
      st.textContent =
        ':root{' +
          /* brand (theme-independent) */
          '--bwn-green:#1a5f3e;--bwn-green-dk:#0d3d26;--bwn-accent:#2ECC71;--bwn-bad:#c0392b;--bwn-warn:#e67e22;' +
          /* role tokens - LIGHT (surfaces / text / borders) */
          '--bwn-surface:#ffffff;--bwn-surface-2:#f7faf8;--bwn-surface-3:#eef3f0;--bwn-tint:#e8f3ed;' +
          '--bwn-text:#1f2a24;--bwn-text-strong:#0d3d26;--bwn-text-muted:#5a6b62;--bwn-text-faint:#66786e;' +
          '--bwn-border:#dde6e1;--bwn-border-2:#eef2f4;' +
          '--bwn-ok-bg:#e8f3ed;--bwn-ok-fg:#0d3d26;--bwn-bad-bg:#fdecea;--bwn-bad-fg:#7b241c;--bwn-warn-bg:#fff4e8;--bwn-warn-fg:#8a4b12;' +
          '--bwn-shadow:0 18px 60px rgba(13,38,26,.18);' +
        '}' +
        '[data-bwn-theme="dark"]{' +
          '--bwn-surface:#15201b;--bwn-surface-2:#1b2823;--bwn-surface-3:#243029;--bwn-tint:#1d3528;' +
          '--bwn-text:#e8efe9;--bwn-text-strong:#9fe3b8;--bwn-text-muted:#a3b3aa;--bwn-text-faint:#7d8f86;' +
          '--bwn-border:#2c3a33;--bwn-border-2:#243029;' +
          '--bwn-ok-bg:#173026;--bwn-ok-fg:#8fe0ab;--bwn-bad-bg:#3a1d1a;--bwn-bad-fg:#f2a99f;--bwn-warn-bg:#3a2a14;--bwn-warn-fg:#f0c48a;' +
          '--bwn-shadow:0 18px 60px rgba(0,0,0,.5);' +
        '}' +
        /* shared focus ring for the dropdown menu items (inline styles can't do :focus-visible) */
        '[role="menuitem"]:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--bwn-accent);}';
      (document.head || document.documentElement).appendChild(st);
    }
    // Manual theme (Light default). Persisted in localStorage['bwn:theme']; applied as
    // data-bwn-theme on <html> so every BWN panel re-themes. Only BWN UI is affected.
    function getTheme() { try { return localStorage.getItem('bwn:theme') === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
    function applyTheme(t) { try { document.documentElement.setAttribute('data-bwn-theme', t === 'dark' ? 'dark' : 'light'); } catch (e) { } }
    function setTheme(t) { try { localStorage.setItem('bwn:theme', t === 'dark' ? 'dark' : 'light'); } catch (e) { } applyTheme(t); try { document.dispatchEvent(new CustomEvent('bwn:theme')); } catch (e) { } }

    // ---- Shared dropdown menu (ARIA menu-button + keyboard nav) ---------------
    // Trigger is a menu-button (aria-haspopup/expanded); the menu is role=menu with
    // roving focus: open with Enter/Space/Down, move with Up/Down/Home/End, close with
    // Esc/Tab (restoring focus to the trigger). Built on open, removed on close,
    // positioned fixed at the trigger so no parent overflow can clip it.
    function makeDropdown(label, items) {
      var wrap = document.createElement('span');
      wrap.style.cssText = 'display:inline-flex;vertical-align:middle;';
      var trig = document.createElement('button');
      trig.type = 'button';
      trig.setAttribute('aria-haspopup', 'menu');
      trig.setAttribute('aria-expanded', 'false');
      trig.style.cssText = 'min-width:104px;padding:6px 12px;font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;color:#fff;border:none;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;background:' + GREEN + ';';
      var lab = document.createElement('span'); lab.textContent = label;
      var car = document.createElement('span'); car.textContent = '▾'; car.setAttribute('aria-hidden', 'true'); car.style.cssText = 'font-size:10px;opacity:.85;transition:transform .15s;';
      trig.appendChild(lab); trig.appendChild(car);
      wrap.appendChild(trig);

      var menu = null, rows = [];
      function focusAt(i) { if (rows.length) rows[(i + rows.length) % rows.length].focus(); }
      function removeMenu(restore) {
        if (!menu) return;
        menu.remove(); menu = null; rows = [];
        car.style.transform = 'none';
        trig.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll, true);
        if (restore) { try { trig.focus(); } catch (e) { } }
      }
      function onDoc(e) { if (menu && !menu.contains(e.target) && !trig.contains(e.target)) removeMenu(false); }
      function onScroll() { removeMenu(false); }
      function onKey(e) {
        if (!menu) return;
        var i = rows.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); removeMenu(true); }
        else if (e.key === 'Tab') { removeMenu(false); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
        else if (e.key === 'End') { e.preventDefault(); focusAt(rows.length - 1); }
      }
      function openMenu() {
        menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', label);
        menu.style.cssText = 'position:fixed;z-index:99998;min-width:212px;background:var(--bwn-surface);border:1px solid var(--bwn-border);border-radius:10px;box-shadow:var(--bwn-shadow);padding:6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;';
        rows = [];
        items.forEach(function (it) {
          var row = document.createElement('button');
          row.type = 'button';
          row.setAttribute('role', 'menuitem');
          row.tabIndex = -1;
          row.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:left;padding:9px 12px;border:none;background:transparent;border-radius:7px;cursor:pointer;font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;color:var(--bwn-text);';
          row.textContent = it.label;
          if (it.desc) {
            var d = document.createElement('span');
            d.textContent = it.desc;
            d.style.cssText = 'display:block;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-top:2px;';
            row.appendChild(d);
          }
          row.addEventListener('mouseenter', function () { row.style.background = 'var(--bwn-tint)'; });
          row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });
          row.addEventListener('click', function (e) { e.preventDefault(); removeMenu(true); it.fn(); });
          menu.appendChild(row);
          rows.push(row);
        });
        document.body.appendChild(menu);
        var r = trig.getBoundingClientRect();
        var left = Math.min(Math.round(r.left), window.innerWidth - menu.offsetWidth - 8);   // keep on-screen
        menu.style.left = Math.max(8, left) + 'px';
        menu.style.top = Math.round(r.bottom + 4) + 'px';
        car.style.transform = 'rotate(180deg)';
        trig.setAttribute('aria-expanded', 'true');
        focusAt(0);
        setTimeout(function () {
          document.addEventListener('mousedown', onDoc, true);
          document.addEventListener('keydown', onKey, true);
          window.addEventListener('scroll', onScroll, true);
          window.addEventListener('resize', onScroll, true);
        }, 0);
      }
      trig.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (menu) removeMenu(false); else openMenu();   // Enter/Space activate the button natively → this fires
      });
      trig.addEventListener('keydown', function (e) {
        if (!menu && e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
      });
      return wrap;
    }

    // ---- Accessible-dialog helper ---------------------------------------------
    // Adds role/aria, traps Tab focus, restores focus on release. {modal:true}
    // (default) also pulls focus back if it escapes a swapped-out body.
    function a11yDialog(dialogEl, opts) {
      opts = opts || {};
      var modal = opts.modal !== false;
      var prevFocus = document.activeElement;
      dialogEl.setAttribute('role', 'dialog');
      if (modal) dialogEl.setAttribute('aria-modal', 'true');
      if (opts.label) dialogEl.setAttribute('aria-label', opts.label);
      if (!dialogEl.hasAttribute('tabindex')) dialogEl.setAttribute('tabindex', '-1');
      var SEL = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
      function focusables() {
        return Array.prototype.filter.call(dialogEl.querySelectorAll(SEL), function (el) {
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        });
      }
      function onTrapKey(e) {
        if (e.key !== 'Tab' || !dialogEl.isConnected) return;
        var f = focusables(), act = document.activeElement;
        if (!f.length) { e.preventDefault(); try { dialogEl.focus(); } catch (_) {} return; }
        var first = f[0], last = f[f.length - 1];
        if (!dialogEl.contains(act)) { e.preventDefault(); first.focus(); return; }   // focus escaped (content swapped): pull it back
        if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
      }
      document.addEventListener('keydown', onTrapKey, true);
      var mo = null;
      if (modal && typeof MutationObserver === 'function') {
        mo = new MutationObserver(function (records) {
          if (!dialogEl.isConnected || dialogEl.contains(document.activeElement)) return;
          var structural = false;
          for (var i = 0; i < records.length && !structural; i++) {
            var rm = records[i].removedNodes;
            for (var j = 0; j < rm.length; j++) { if (rm[j].nodeType === 1) { structural = true; break; } }
          }
          if (!structural) return;
          try { (focusables()[0] || dialogEl).focus(); } catch (_) {}
        });
        mo.observe(dialogEl, { childList: true, subtree: true });
      }
      setTimeout(function () { try { (opts.initial || focusables()[0] || dialogEl).focus(); } catch (_) {} }, 0);
      return function release() {
        document.removeEventListener('keydown', onTrapKey, true);
        if (mo) { mo.disconnect(); mo = null; }
        try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus(); } catch (_) {}
      };
    }

    // ---- Shared utility helpers (Shared Core v3) --------------------------------
    // Canonical DOM event names for the suite bus (use these, not string literals).
    var EVENTS = { update: 'bwn:update', config: 'bwn:config', theme: 'bwn:theme' };
    function debounce(fn, ms) {
      var t = null;
      return function () { clearTimeout(t); t = setTimeout(fn, ms); };
    }
    // Clipboard write + standard button feedback; falls back to a copyable prompt.
    function copyText(text, btn, idleLabel) {
      navigator.clipboard.writeText(text).then(function () {
        if (btn) {
          btn.textContent = 'Copied ✓';
          setTimeout(function () { btn.textContent = idleLabel || 'Copy'; }, 1500);
        }
      }, function () { prompt('Copy manually:', text); });
    }
    // JSON storage wrappers: parse/stringify + quota/privacy try-catch in one place.
    function lsGetJSON(key, def) { try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : def; } catch (e) { return def; } }
    function lsSetJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } }
    function ssGetJSON(key, def) { try { var r = sessionStorage.getItem(key); return r ? JSON.parse(r) : def; } catch (e) { return def; } }
    function ssSetJSON(key, val) { try { sessionStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } }
    // ---- Failure containment (Shared Core v4) -----------------------------------
    // Modules are inline IIFEs: without containment, one module's init throw kills
    // every module declared after it - including the Ops panel that hosts the kill
    // switches. safeModule wraps module init; guard wraps long-lived callbacks
    // (observers, timers). Errors log to console AND to a capped localStorage list
    // (bwn:err:core / bwn:err:ai) for the Ops panel to surface. Never rethrown.
    var ERR_KEY = null;   // set by announceCore (needs the script name)
    function pushErr(tag, e) {
      var msg = e && e.message ? e.message : String(e);
      console.error('[BWN] ' + tag + ':', e);
      if (!ERR_KEY) return;
      var list = lsGetJSON(ERR_KEY, []);
      if (!Array.isArray(list)) list = [];
      list.push({ tag: String(tag), msg: String(msg).slice(0, 200), ts: Date.now() });
      while (list.length > 10) list.shift();
      lsSetJSON(ERR_KEY, list);
    }
    var guardMuted = {};   // record one error per tag per minute; repeats are swallowed
    function guard(fn, tag) {
      return function () {
        try { return fn.apply(this, arguments); }
        catch (e) {
          var now = Date.now();
          if (!guardMuted[tag] || now - guardMuted[tag] > 60000) {
            guardMuted[tag] = now;
            pushErr(tag || 'guard', e);
          }
        }
      };
    }
    function safeModule(id, fn) {
      try { fn(); }
      catch (e) { pushErr('module:' + id, e); }
    }

    // ---- Note-metadata resolver (Shared Core v5) ---------------------------------
    // Both scripts read note timestamps/labels off Umbrava's note cards. The
    // timestamp span's class (TocUIq_lastModifiedDate) is a hashed CSS-module name -
    // the most rename-prone selector in the suite - and a rebuild would silently
    // blank note ages (stale-note chips, Recent Update windows, audit timelines).
    // Resolution order: pinned class → session-memoized rediscovered class →
    // content heuristic (a short header-row leaf span whose text parses as a date).
    // A fallback hit is recorded once per session so drift is visible, not silent.
    var NOTE_SUMMARY_SEL = '[data-testid^="wo-note-"][data-testid$="-summary"]';
    var NOTE_TS_CLS = 'TocUIq_lastModifiedDate';   // pinned; re-pin here when Umbrava rebuilds
    function noteCard(summaryEl) {
      // Tightest ancestor that still maps to exactly one note. BOUNDED: with a
      // single note mounted, an unbounded walk would climb to <html> and make
      // label/timestamp resolution page-wide.
      var node = summaryEl;
      for (var hop = 0; hop < 8; hop++) {
        var p = node.parentElement;
        if (!p || p === document.body || p.querySelectorAll(NOTE_SUMMARY_SEL).length !== 1) break;
        node = p;
      }
      return node;
    }
    // Tolerant note-timestamp parser: absolute ("6/12/2026, 10:04 AM"), relative
    // ("2 hours ago", "yesterday"), or anything Date.parse accepts. Returns Date|null.
    function parseNoteDateLoose(ts) {
      if (!ts) return null;
      var s = String(ts).trim(), low = s.toLowerCase(), now = new Date();
      if (/\btoday\b|just now|moments? ago|\bnow\b/.test(low)) return now;
      if (/\byesterday\b/.test(low)) { var y = new Date(now); y.setDate(y.getDate() - 1); return y; }
      var rel = low.match(/(\d+)\s*(minute|min|hour|hr|day|week|month)s?\s+ago/);
      if (rel) {
        var n = parseInt(rel[1], 10), u = rel[2], d = new Date(now);
        if (/^min/.test(u)) d.setMinutes(d.getMinutes() - n);
        else if (/^h/.test(u)) d.setHours(d.getHours() - n);
        else if (/^day/.test(u)) d.setDate(d.getDate() - n);
        else if (/^week/.test(u)) d.setDate(d.getDate() - n * 7);
        else if (/^month/.test(u)) d.setMonth(d.getMonth() - n);
        return d;
      }
      var md = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
      if (md) {
        var mo = parseInt(md[1], 10), da = parseInt(md[2], 10);
        if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;   // "13/13", "12/45": not a date
        if (md[3]) {
          // Full date: prefer Date.parse so a trailing time ("6/12/2026, 10:04 AM")
          // keeps its time-of-day - day-boundary math (staleness, tie-breaks) stays
          // exact. Fall back to constructing from the matched tokens.
          var full = Date.parse(s);
          if (!isNaN(full)) return new Date(full);
          var yr = parseInt(md[3], 10); if (yr < 100) yr += 2000;
          var dtY = new Date(yr, mo - 1, da);
          return (dtY.getMonth() === mo - 1 && dtY.getDate() === da) ? dtY : null;
        }
        var dt = new Date(now.getFullYear(), mo - 1, da);
        if (dt.getMonth() !== mo - 1 || dt.getDate() !== da) return null;   // 2/30-style rollover
        if (dt.getTime() - now.getTime() > 86400000) dt.setFullYear(dt.getFullYear() - 1);   // bare M/D in the future = last year
        return dt;
      }
      var nat = Date.parse(s);
      return isNaN(nat) ? null : new Date(nat);
    }
    // Strict "is this a note TIMESTAMP" test for the fallback paths: only shapes a
    // real timestamp takes (relative, today/yesterday, M/D[/Y], month-name+day) and
    // only plausible ages - never the bare Date.parse fallback, which swallows
    // store/PO numbers ("0491" parses as the year 491).
    function looksLikeNoteTimestamp(s) {
      if (!s) return false;
      var t = String(s).trim(), low = t.toLowerCase();
      if (/^\d+$/.test(t)) return false;                       // bare number: note id, store #, PO #
      var shaped = /\btoday\b|just now|moments? ago|\bnow\b|\byesterday\b/.test(low) ||
        /\d+\s*(minute|min|hour|hr|day|week|month)s?\s+ago/.test(low) ||
        /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(t) ||
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(low);
      if (!shaped) return false;
      var d = parseNoteDateLoose(t);
      if (!d) return false;
      var age = (Date.now() - d.getTime()) / 86400000;
      return age > -2 && age < 3700;                           // plausible note age (~10 years)
    }
    function noteMetaFallbackNote(how) {
      try {
        if (sessionStorage.getItem('bwn:sel:notets:warned')) return;
        sessionStorage.setItem('bwn:sel:notets:warned', '1');
        pushErr('selector:note-ts', 'pinned note-timestamp class missing - using ' + how + ' (Umbrava rebuilt? re-pin NOTE_TS_CLS)');
      } catch (e) { /* best-effort */ }
    }
    function noteMeta(card) {
      if (!card) return { ts: '', label: '' };
      // Label: the type chip (Client/Vendor/Internal/…) - a span.ellipsis outside
      // the author/timestamp cluster AND outside the note text, and not itself a
      // timestamp-shaped string.
      var label = '';
      var spans = card.querySelectorAll('span.ellipsis');
      for (var i = 0; i < spans.length; i++) {
        if ((spans[i].className || '').indexOf('TocUIq') !== -1) continue;
        if (spans[i].closest('[data-testid$="-summary"], [data-testid$="-description"]')) continue;
        var t = (spans[i].textContent || '').trim();
        if (t && t.length <= 40 && !looksLikeNoteTimestamp(t)) { label = t; break; }
      }
      // Timestamp 1: pinned class (zero extra work while Umbrava is unchanged).
      var el = card.querySelector('span.' + NOTE_TS_CLS);
      if (el) return { ts: (el.textContent || '').trim(), label: label };
      // Which note is this card for (memoization is keyed by DISTINCT notes)?
      var sumEl = card.querySelector(NOTE_SUMMARY_SEL);
      var noteId = sumEl ? (sumEl.getAttribute('data-testid') || '').replace(/\D+/g, '') : '';
      // Timestamp 2: session-memoized rediscovered class - trusted only after it
      // matched on 3+ DISTINCT notes, and only when its text still looks like a
      // real timestamp (a generic layout class must not hijack resolution).
      var memo = ssGetJSON('bwn:sel:notets', null);
      if (memo && memo.cls && Array.isArray(memo.ids) && memo.ids.length >= 3) {
        el = card.querySelector('span[class="' + memo.cls + '"]');
        if (el && looksLikeNoteTimestamp(el.textContent)) {
          noteMetaFallbackNote('memoized class "' + memo.cls + '"');
          return { ts: (el.textContent || '').trim(), label: label };
        }
      }
      // Timestamp 3: content heuristic - the LAST short leaf span in the card's
      // header (never inside the note text itself) that is timestamp-shaped.
      var best = null;
      var leaves = card.querySelectorAll('span');
      for (var j = 0; j < leaves.length; j++) {
        var lf = leaves[j];
        if (lf.children.length) continue;
        if (lf.closest('[data-testid$="-summary"], [data-testid$="-description"]')) continue;
        var tx = (lf.textContent || '').trim();
        if (!tx || tx.length > 40) continue;
        if (looksLikeNoteTimestamp(tx)) best = lf;
      }
      if (!best) return { ts: '', label: label };
      try {
        var cls = best.getAttribute('class') || '';
        if (cls && noteId) {
          var cur = ssGetJSON('bwn:sel:notets', null);
          if (!cur || cur.cls !== cls || !Array.isArray(cur.ids)) cur = { cls: cls, ids: [] };
          if (cur.ids.indexOf(noteId) === -1) { cur.ids.push(noteId); if (cur.ids.length > 6) cur.ids.shift(); }
          ssSetJSON('bwn:sel:notets', cur);
        }
      } catch (e2) { /* best-effort */ }
      noteMetaFallbackNote('content heuristic');
      return { ts: (best.textContent || '').trim(), label: label };
    }

    // ---- Module health beacons (Shared Core v5) ----------------------------------
    // Modules report their mount lifecycle to bwn:health:{core|ai} so a module that
    // silently stopped mounting (selector drift after an Umbrava deploy) shows in
    // the Ops panel instead of just being… absent. States: 'ok' (mounted/active),
    // 'waiting' (page doesn't apply / anchors absent - normal), 'miss' (anchors
    // present but the module UI failed to appear - investigate). Use STABLE detail
    // strings: writes happen on state+detail CHANGE only. Stored in sessionStorage -
    // health is PER TAB (the Ops panel reports the tab it's opened in), so one tab's
    // page load can never wipe or misrepresent another tab's module states.
    var HEALTH_KEY = null;                        // set by announceCore
    var beatLast = {};                            // moduleId -> "state|detail"
    function beat(moduleId, state, detail) {
      var sig = state + '|' + (detail || '');
      if (beatLast[moduleId] === sig) return;
      beatLast[moduleId] = sig;
      if (!HEALTH_KEY) return;
      var blob = ssGetJSON(HEALTH_KEY, {});
      if (!blob || typeof blob !== 'object') blob = {};
      blob[moduleId] = { state: state, detail: String(detail || '').slice(0, 120), ts: Date.now() };
      ssSetJSON(HEALTH_KEY, blob);
    }

    // ---- Scroll-harvest engine (Shared Core v7) -----------------------------------
    // One implementation of the virtualized-list sweep both scripts previously
    // duplicated (WO Assist Deep Scan; AI note collection): walk the scroller in
    // 85%-viewport strides every 220ms, capturing each tick, until the item count
    // is stable at the bottom (3 quiet ticks) or the step cap (120). Lifecycle
    // rules - hard-won in the v1.8/v1.5 fixes - are the contract:
    //  - cancelled() true  → abort SILENTLY: restore scroll, call nothing;
    //  - scroller unmounted but not cancelled → re-resolve via rescroller() and
    //    continue; if none can be found, COMMIT what was captured - done(false);
    //  - stable-bottom completion → done(true); step-cap exit → done(false).
    // done(complete): true ONLY for a converged full sweep (v7). Callers publishing
    // to the shared note cache MUST respect it - a truncated top-of-list prefix
    // passes every validity check and would poison both scripts for the TTL.
    function findScroller(anchorEl) {
      var node = anchorEl ? anchorEl.parentElement : null;
      while (node && node !== document.body) {
        var st = getComputedStyle(node);
        if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 20) return node;
        node = node.parentElement;
      }
      return null;
    }
    // opts: { scroller, rescroller(), capture(), count(), cancelled(), progress(n), done(complete) }
    function harvest(opts) {
      var box = opts.scroller;
      opts.capture();
      if (!box) { opts.done(true); return; }   // not scrollable: what's mounted is ALL of it - complete
      var lastCount = -1, stable = 0, steps = 0, MAX = 120;
      box.scrollTop = 0;
      function tick() {
        if (opts.cancelled && opts.cancelled()) {
          if (box && box.isConnected) { try { box.scrollTop = 0; } catch (e) { } }
          return;
        }
        if (!box.isConnected) {
          box = opts.rescroller ? opts.rescroller() : null;
          if (!box) { opts.done(false); return; }   // list gone entirely: commit what we captured - PARTIAL
        }
        opts.capture();
        var n = opts.count();
        if (opts.progress) opts.progress(n);
        var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 5;
        stable = (n === lastCount) ? stable + 1 : 0;
        lastCount = n;
        var full = atBottom && stable >= 3;
        if (full || steps++ > MAX) {
          box.scrollTop = 0;
          opts.done(full);   // step-cap exit is PARTIAL
          return;
        }
        box.scrollTop = Math.min(box.scrollTop + box.clientHeight * 0.85, box.scrollHeight);
        setTimeout(tick, 220);
      }
      tick();
    }

    // Shared-core drift guard: each script announces the core version AND export
    // manifest it carries (bwn:corever:core / bwn:corever:ai). Because this block
    // must be pasted into BOTH files on every edit, a version mismatch means one
    // file was missed - and an export-list mismatch at the SAME version means a
    // paste dropped part of the block. Both warn loudly and show in the Ops panel.
    function announceCore(script) {
      ERR_KEY = 'bwn:err:' + script;
      HEALTH_KEY = 'bwn:health:' + script;
      ssSetJSON(HEALTH_KEY, {});                  // per-tab health; modules re-report below
      var exp = [];
      try { exp = Object.keys(BWN || {}).sort(); } catch (e) { /* called pre-assignment */ }
      lsSetJSON('bwn:corever:' + script, { v: VERSION, ts: Date.now(), exports: exp });
      // Drift check runs DEFERRED so the peer script (loading in this same page) has
      // announced its CURRENT blob first - otherwise the first load after a correct
      // both-files update would read the peer's stale pre-update blob and cry wolf.
      // A peer that did not announce recently (uninstalled/disabled) is skipped: the
      // Ops panel status row already reports it as not loaded.
      setTimeout(function () {
        var other = script === 'core' ? 'ai' : 'core';
        var peer = lsGetJSON('bwn:corever:' + other, null);
        if (!peer || Date.now() - (peer.ts || 0) > 120000) return;   // peer not live this session
        if (typeof peer.v === 'number' && peer.v !== VERSION) {
          console.warn('[BWN] SHARED CORE DRIFT: this script carries v' + VERSION + ' but the ' + other.toUpperCase() +
            ' script announced v' + peer.v + '. Paste the newer BWN SHARED CORE block into both files and re-import.');
        } else if (Array.isArray(peer.exports) && peer.exports.length && exp.length) {
          var diffs = exp.filter(function (k) { return peer.exports.indexOf(k) === -1; })
            .concat(peer.exports.filter(function (k) { return exp.indexOf(k) === -1; }));
          if (diffs.length) {
            console.warn('[BWN] SHARED CORE DRIFT: same version (v' + VERSION + ') but the export lists differ (' +
              diffs.join(', ') + ') - a paste dropped part of the block. Re-paste it into both files.');
          }
        }
      }, 2500);
    }

    return {
      VERSION: VERSION,
      woId: woId, busGet: busGet, busPut: busPut, busHeatGet: busHeatGet, busVendors: busVendors,
      CFG_DEFAULTS: CFG_DEFAULTS, cfg: cfg, cfgSave: cfgSave,
      money: money, parseMoney: parseMoney, parseBare: parseBare, parseUSDate: parseUSDate,
      alphaOnly: alphaOnly, lcsLen: lcsLen,
      inputVal: inputVal, setNativeValue: setNativeValue,
      GREEN: GREEN, injectTokens: injectTokens,
      getTheme: getTheme, setTheme: setTheme, applyTheme: applyTheme,
      makeDropdown: makeDropdown, a11yDialog: a11yDialog,
      EVENTS: EVENTS, debounce: debounce, copyText: copyText,
      lsGetJSON: lsGetJSON, lsSetJSON: lsSetJSON, ssGetJSON: ssGetJSON, ssSetJSON: ssSetJSON,
      safeModule: safeModule, guard: guard,
      noteCard: noteCard, noteMeta: noteMeta, parseNoteDateLoose: parseNoteDateLoose,
      NOTE_SUMMARY_SEL: NOTE_SUMMARY_SEL,
      beat: beat,
      findScroller: findScroller, harvest: harvest,
      announceCore: announceCore
    };
  })();
  BWN.injectTokens();
  BWN.applyTheme(BWN.getTheme());
  BWN.announceCore('ai');
  // ===== END BWN SHARED CORE =====

  // ===== BEGIN bwnNotesApi =====
  // Notes WITHOUT scraping the list (2026-08-04). Both the AI drafts' collect and WO
  // Assist's Deep Scan used to walk the VIRTUALIZED notes list by scrolling it: slow,
  // and only ever as complete as the sweep managed to see. Umbrava's own API answers
  // the same question in ONE call. Measured on W-283834:
  //   workOrderNotes(workOrderNumber: 283834) -> 308 notes, while the DOM had 17
  //   mounted; all 17 bodies byte-identical to the rendered text (`content` is PLAIN
  //   TEXT - do not strip "tags", it eats <someone@example.com>); createdDate is an
  //   absolute ISO stamp instead of the relative strings a scrape has to guess at.
  // The note TYPE comes back as an int, so noteTypesV2 supplies the label map (82 rows,
  // cached for a day) - all 17 mounted labels matched their type name.
  // Same-origin fetch on the app's own bearer, so @grant none still holds.
  // EVERY failure path REJECTS so the caller falls back to the scroll sweep: no token,
  // schema drift, a non-list payload, or a read that does not even contain the notes
  // currently on screen. Degrading to the old behaviour is fine; silently handing a
  // draft a partial history is not.
  // Byte-identical in bwn-suite-core and bwn-suite-ai - scripts/test-notes-api.js gates
  // that with a SHA, the same rule as the bwnAI transport block.
  var BWN_NOTES_TYPES_KEY = 'bwn:noteTypes';
  var BWN_NOTES_TYPES_TTL = 24 * 3600000;
  var BWN_NOTES_QUERY = 'query BwnWorkOrderNotes($n: Int!) { workOrderNotes(workOrderNumber: $n) { id type content createdDate lastModifiedDate isDeleted } }';
  // Auth0 access token from the SPA's own cache, picked by CONTENT: the audience slot
  // transiently holds non-Umbrava tokens, so the issuer and expiry are checked.
  function bwnNotesToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (!tok) continue;
        var parts = String(tok).split('.');
        if (parts.length !== 3) continue;
        var p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        var iss = String(p.iss || '').replace(/\/+$/, '');
        if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') continue;
        if (typeof p.exp === 'number' && (Date.now() / 1000) > p.exp) continue;
        return tok;
      }
    } catch (e) { }
    return '';
  }
  function bwnNotesGql(query, variables) {
    var tok = bwnNotesToken();
    if (!tok) return Promise.reject(new Error('no live Umbrava token in this tab'));
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      if (!j || !j.data) throw new Error('empty GraphQL response');
      return j.data;
    });
  }
  // type id -> label. A failure here must NOT fail the notes read: labels degrade to '',
  // which only widens a keep-list filter. It can never invent or drop a note.
  function bwnNoteTypeMap() {
    try {
      var c = JSON.parse(localStorage.getItem(BWN_NOTES_TYPES_KEY) || 'null');
      if (c && c.v === 1 && c.map && (Date.now() - (c.ts || 0)) < BWN_NOTES_TYPES_TTL) return Promise.resolve(c.map);
    } catch (e) { }
    return bwnNotesGql('{ noteTypesV2 { id name } }').then(function (d) {
      var map = {};
      (d.noteTypesV2 || []).forEach(function (t) { if (t && t.id != null) map[String(t.id)] = String(t.name == null ? '' : t.name); });
      try { localStorage.setItem(BWN_NOTES_TYPES_KEY, JSON.stringify({ v: 1, ts: Date.now(), map: map })); } catch (e2) { }
      return map;
    }, function () { return {}; });
  }
  // Render the ISO stamp the way the notes list renders it ("6/24/2026, 9:52 AM") so
  // every existing consumer - parseNoteDateLoose, looksLikeNoteTimestamp, the staleness
  // math - reads an API note exactly as it read a scraped one. tsAbs carries the exact
  // epoch beside it, so nothing has to re-parse to be precise.
  function bwnNotesTsText(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(+d)) return '';
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    var mm = d.getMinutes(); mm = (mm < 10 ? '0' : '') + mm;
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ', ' + h + ':' + mm + ' ' + ap;
  }
  // Coverage gate: if the notes list is on screen, every note MOUNTED in it must be in
  // the API result. That is the one check that catches a read of the wrong thing without
  // trusting counts. Nothing mounted = nothing to check (the API is then the only source).
  function bwnNotesApiCovers(list) {
    var have = {};
    (list || []).forEach(function (n) { have[String(n.id)] = 1; });
    var mounted = document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]');
    for (var i = 0; i < mounted.length; i++) {
      var m = (mounted[i].getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/);
      if (m && !have[m[1]]) return false;
    }
    return true;
  }
  // Resolves [{id, label, ts, tsAbs, body}] - the SAME shape the scrape produces and the
  // shared bwn:notes bus stores, so no consumer downstream can tell the difference.
  function bwnNotesApi(woNumber) {
    var n = parseInt(String(woNumber == null ? '' : woNumber).replace(/\D/g, ''), 10);
    if (!n) return Promise.reject(new Error('no WO number for the notes read'));
    return bwnNoteTypeMap().then(function (types) {
      return bwnNotesGql(BWN_NOTES_QUERY, { n: n });
    }, function () { return bwnNotesGql(BWN_NOTES_QUERY, { n: n }); }).then(function (d) {
      var rows = d && d.workOrderNotes;
      if (!Array.isArray(rows)) throw new Error('workOrderNotes did not return a list');
      var types = {};
      try { var c = JSON.parse(localStorage.getItem(BWN_NOTES_TYPES_KEY) || 'null'); if (c && c.map) types = c.map; } catch (e) { }
      var out = [];
      rows.forEach(function (r) {
        if (!r || r.isDeleted) return;               // the list does not show deleted notes
        var iso = r.createdDate || r.lastModifiedDate || '';
        var dt = iso ? new Date(iso) : null;
        out.push({
          id: String(r.id),
          label: (r.type != null && types[String(r.type)]) || '',
          ts: bwnNotesTsText(iso),
          tsAbs: (dt && !isNaN(+dt)) ? +dt : null,
          body: String(r.content == null ? '' : r.content).trim()
        });
      });
      if (!bwnNotesApiCovers(out)) throw new Error('API notes did not include every note on screen - not trusting it');
      return out;
    });
  }
  // ===== END bwnNotesApi =====

  // ---- Outer-scope aliases (names used by both AI modules) ----------------
  // Bus = read-only consumer of Core's contract; config falls back to defaults
  // when Core isn't present. Dropdown + dialog are the shared UI primitives.
  var bwnWOId = BWN.woId;
  function bwnBusWO(maxAgeMs) { return BWN.busGet(BWN.woId(), maxAgeMs); }
  var bwnBusVendors = BWN.busVendors;
  var bwnSuiteConfig = BWN.cfg;
  var bwnMakeDropdown = BWN.makeDropdown;
  var bwnA11yDialog = BWN.a11yDialog;

  // ---- WO-action connector (Phase 2) --------------------------------------
  // Relays coordinator actions captured in Umbrava to the SWA activity log so they show
  // in the dashboard's Activity Log + reporting. Core (zero-egress) enqueues events to
  // localStorage `bwn:ingestq`; THIS script (which already has the network grant) drains
  // + POSTs them with the shared function key. Actor = the Auth0-logged-in Umbrava user.
  // Dormant until the key is set (Tampermonkey menu → "Set SWA ingest key"). No new page
  // egress - GM_xmlhttpRequest to the one declared @connect host.
  var INGEST_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/wo-ingest';
  var INGEST_CLIENT = 'pilot';
  // ═══ CONNECTOR CONTRACT v1 - keep in sync with api/wo-ingest + Core ═══
  //   POST {actor, events[]}             ← localStorage bwn:ingestq (Core enqueues, this drains)
  //   POST {actor, o30lines[]|snapshot}  ← Over-30 panel "Sync" / bwn:heat:snap relay
  //   GET  ?target=<tracking>            → sessionStorage bwn:swa:<tracking> (Core's checklist merge)
  //   GET  ?o30=<targets>                → Over-30 panel "last entered" context
  // Auth: x-bwn-key header (GM 'ingest_key'). KILL-SWITCH: the Ops Suite "SWA connector"
  // toggle (bwn:modules.connector === false) disables ALL SWA egress - read LIVE each
  // tick, so flipping it takes effect without a reload.
  var CONNECTOR_V = 1;
  function connectorEnabled() {
    try { var mp = JSON.parse(localStorage.getItem('bwn:modules') || '{}'); return mp.connector !== false; } catch (e) { return true; }
  }
  // Connector health → Ops Suite Status (BWN.beat writes on change only, so details
  // must stay stable). 3 consecutive failures = 'miss' - a wrong key (403) or a broken
  // deploy no longer fails silently while the queue grows.
  var connFails = 0;
  function connOk() { connFails = 0; BWN.beat('connector', 'ok', 'SWA sync active (contract v' + CONNECTOR_V + ')'); }
  function connFail(code) { connFails++; if (connFails >= 3) BWN.beat('connector', 'miss', 'SWA sync failing (HTTP ' + code + ') - check the ingest key / deployment'); }
  var ingestBusy = false;
  function ingestActor() {
    try {
      var k = Object.keys(localStorage).filter(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); })[0];
      if (!k) return 'unknown';
      var d = (JSON.parse(localStorage.getItem(k)) || {}).decodedToken;
      var u = d && d.user;
      return (u && (u.email || u.name)) || 'unknown';   // prefer email → matches the dashboard's AAD userDetails so the SAME person aggregates in reporting
    } catch (e) { return 'unknown'; }
  }
  function ingestDrain() {
    if (ingestBusy) return;
    if (!connectorEnabled()) { BWN.beat('connector', 'waiting', 'disabled via the Ops Suite toggle'); return; }   // kill-switch - and say so, else the last green 'ok' beat lies for the rest of the session
    var key = GM_getValue('ingest_key', '');
    if (!key) { BWN.beat('connector', 'waiting', 'SWA ingest key not set'); return; }
    var q = BWN.lsGetJSON('bwn:ingestq', []);
    if (!Array.isArray(q) || !q.length) return;
    // Only id-carrying events are sendable - clearSent and the server dedup both key on
    // the id, so an id-less (legacy/corrupt) entry would re-POST every tick forever.
    var sendable = q.filter(function (e) { return e && e.id && e.action; });
    if (sendable.length !== q.length) BWN.lsSetJSON('bwn:ingestq', sendable);   // purge the unsendables once
    if (!sendable.length) return;
    var batch = sendable.slice(0, 50);
    var sent = {}; batch.forEach(function (e) { sent[e.id] = 1; });
    var body;
    try { body = JSON.stringify({ actor: ingestActor(), events: batch }); }
    catch (e) { return; }                                 // couldn't serialize → do NOT set the busy flag (would wedge the drain)
    // Clear by EVENT ID, not by position: Core's 200-cap can trim the front mid-POST, so a
    // positional slice would drop unsent events. Re-read so items Core queued during the
    // POST survive. Server dedups by the same id, so a teardown-before-clear can't duplicate.
    function clearSent() {
      var cur = BWN.lsGetJSON('bwn:ingestq', []); if (!Array.isArray(cur)) cur = [];
      BWN.lsSetJSON('bwn:ingestq', cur.filter(function (e) { return !(e && e.id && sent[e.id]); }));
    }
    ingestBusy = true;
    GM_xmlhttpRequest({
      method: 'POST',
      url: INGEST_URL + '?client=' + INGEST_CLIENT,
      headers: { 'Content-Type': 'application/json', 'x-bwn-key': key },
      data: body,
      timeout: 15000,
      onload: function (r) {
        ingestBusy = false;
        // Clear on: a 2xx that is REALLY our endpoint's `ok:true` JSON (a redirect chased to
        // an AAD login page also lands as 200, but as HTML - must NOT clear); or a 400 =
        // non-retryable (malformed/all-unknown verbs) → drop so it can't head-of-line-block.
        // 403 (bad key)/429/5xx → leave the queue for the next tick.
        var stored = false;
        if (r.status >= 200 && r.status < 300) { try { stored = JSON.parse(r.responseText).ok === true; } catch (e) { } }
        if (stored || r.status === 400) clearSent();
        if (stored || r.status === 400) connOk(); else connFail(r.status);   // 400 = reached + authed (junk dropped); anything else counts toward 'miss'
        if (stored && typeof window.__bwnJvPush === 'function') window.__bwnJvPush();   // WO actions posted -> freshen this WO's live facts
      },
      onerror: function () { ingestBusy = false; connFail('network'); },     // network → retry next tick
      ontimeout: function () { ingestBusy = false; connFail('timeout'); }    // stalled request must not wedge the drain for the session
    });
  }
  setTimeout(BWN.guard(ingestDrain, 'ingestDrain'), 6000);     // flush any prior-session queue shortly after load
  setInterval(BWN.guard(ingestDrain, 'ingestDrain'), 30000);   // then periodically

  // Job → dashboard plan round-trip: Core queues the authored "Next Actions Required"
  // plan the checklist is running off to localStorage 'bwn:planq'; this drains it to the
  // SWA 'job-plans' store (key-gated POST {plans}), which the dashboard mirrors when its
  // own case file has no authored plan. Same clear-by-id + dedup discipline as ingestDrain.
  var planBusy = false;
  function planDrain() {
    if (planBusy) return;
    if (!connectorEnabled()) return;   // kill-switch - ingestDrain already reports the 'waiting' beat
    var key = GM_getValue('ingest_key', '');
    if (!key) return;
    var q = BWN.lsGetJSON('bwn:planq', []);
    if (!Array.isArray(q) || !q.length) return;
    var sendable = q.filter(function (e) { return e && e.id && e.target && Array.isArray(e.items) && e.items.length; });
    if (sendable.length !== q.length) BWN.lsSetJSON('bwn:planq', sendable);   // purge unsendables once
    if (!sendable.length) return;
    // Collapse to the latest entry per target (Core already keeps one pending per tracking,
    // but a legacy queue might hold more) and cap the batch.
    var byTarget = {}; sendable.forEach(function (e) { byTarget[e.target] = e; });
    var batch = Object.keys(byTarget).map(function (t) { return byTarget[t]; }).slice(0, 20);
    var sentIds = {}, sentTargets = {}; batch.forEach(function (e) { if (e.id) sentIds[e.id] = 1; sentTargets[e.target] = e.h || null; });
    var body;
    try { body = JSON.stringify({ actor: ingestActor(), plans: batch.map(function (e) { return { target: e.target, items: e.items, src: e.src || 'note' }; }) }); }
    catch (e) { return; }   // couldn't serialize → don't set busy (would wedge the drain)
    // Terminal result (2xx ok, or 400 = invalid/non-retryable): drop the entries we sent
    // AND any same-CONTENT duplicate for those targets (a stale dup must not survive and
    // overwrite the server next tick), but KEEP a DIFFERENT-content entry Core may have
    // queued mid-flight. Record the sent content hash in 'bwn:plansent' so Core's dedup
    // won't re-enqueue this exact plan (and, on 400, won't loop on invalid content).
    function settle() {
      var cur = BWN.lsGetJSON('bwn:planq', []); if (!Array.isArray(cur)) cur = [];
      BWN.lsSetJSON('bwn:planq', cur.filter(function (e) {
        if (!e) return false;
        if (e.id && sentIds[e.id]) return false;
        if (Object.prototype.hasOwnProperty.call(sentTargets, e.target) && e.h && e.h === sentTargets[e.target]) return false;
        return true;
      }));
      var ps = BWN.lsGetJSON('bwn:plansent', null); if (!ps || typeof ps !== 'object') ps = {};
      Object.keys(sentTargets).forEach(function (t) { if (sentTargets[t]) ps[t] = sentTargets[t]; });
      var pk = Object.keys(ps); while (pk.length > 500) delete ps[pk.shift()];
      BWN.lsSetJSON('bwn:plansent', ps);
    }
    planBusy = true;
    GM_xmlhttpRequest({
      method: 'POST',
      url: INGEST_URL + '?client=' + INGEST_CLIENT,
      headers: { 'Content-Type': 'application/json', 'x-bwn-key': key },
      data: body,
      timeout: 15000,
      onload: function (r) {
        planBusy = false;
        var stored = false;
        if (r.status >= 200 && r.status < 300) { try { stored = JSON.parse(r.responseText).ok === true; } catch (e) { } }
        if (stored || r.status === 400) { settle(); connOk(); } else connFail(r.status);   // 400 = reached + authed (invalid dropped); transient/403/5xx retry next tick
      },
      onerror: function () { planBusy = false; connFail('network'); },
      ontimeout: function () { planBusy = false; connFail('timeout'); }
    });
  }
  setTimeout(BWN.guard(planDrain, 'planDrain'), 7500);
  setInterval(BWN.guard(planDrain, 'planDrain'), 30000);
  // Reverse direction: pull the DASHBOARD's case file + ack state for the on-screen WO
  // (by tracking #) onto the bus, so Core can merge the dashboard's Next Actions Required
  // into the checklist. Cached per tracking # for SWA_TTL; no-ops off WO pages or when
  // the ingest key isn't set. Same single @connect host.
  var SWA_TTL = 10 * 60000;
  var swaBusy = false;
  function swaTracking() {
    var el = document.querySelector('[data-testid="work-order-header-tracking-number"]');
    return el ? (el.textContent || '').replace(/\D+/g, '') : '';
  }
  function swaSync() {
    if (swaBusy) return;
    if (!connectorEnabled()) return;                      // kill-switch: Ops Suite toggle
    var key = GM_getValue('ingest_key', '');
    if (!key) return;
    var tr = swaTracking();
    if (!tr) return;
    var cur = BWN.ssGetJSON('bwn:swa:' + tr, null);
    if (cur && cur.ts && Date.now() - cur.ts < SWA_TTL) return;   // fresh (a null record is cached too - absent case files aren't re-fetched every tick)
    swaBusy = true;
    GM_xmlhttpRequest({
      method: 'GET',
      url: INGEST_URL + '?client=' + INGEST_CLIENT + '&target=' + encodeURIComponent(tr),
      headers: { 'x-bwn-key': key },
      timeout: 15000,
      onload: function (r) {
        swaBusy = false;
        if (r.status < 200 || r.status >= 300) { connFail(r.status); return; }
        var d = null; try { d = JSON.parse(r.responseText); } catch (e) { }
        if (!d || d.ok !== true) return;                     // a chased login redirect (200 HTML) must not cache garbage
        connOk();
        BWN.ssSetJSON('bwn:swa:' + tr, { v: 1, ts: Date.now(), job: d.job || null, eq: d.eq || null });
      },
      onerror: function () { swaBusy = false; connFail('network'); },
      ontimeout: function () { swaBusy = false; connFail('timeout'); }
    });
  }
  setTimeout(BWN.guard(swaSync, 'swaSync'), 6500);
  setInterval(BWN.guard(swaSync, 'swaSync'), 30000);
  // Daily board-trend relay: List Heat writes localStorage bwn:heat:snap ONLY on a
  // clean full Scan All; push the newest unsent day into the SWA trend (o30-lines
  // blob) so leadership gets team-wide over-30 numbers without an export. The trend
  // entry records WHO scanned (a team-filtered scan is that coordinator's view).
  function o30SnapPush() {
    if (!connectorEnabled()) return;                      // kill-switch: Ops Suite toggle
    var key = GM_getValue('ingest_key', ''); if (!key) return;
    var snaps = null; try { snaps = JSON.parse(localStorage.getItem('bwn:heat:snap') || 'null'); } catch (e) { }
    if (!snaps || typeof snaps !== 'object') return;
    var days = Object.keys(snaps).sort(); if (!days.length) return;
    var latest = days[days.length - 1];
    var s = snaps[latest] || {};
    // Sent-marker carries the VALUES, not just the date - a later, fuller clean scan
    // the same day (e.g. full board after a team-filtered morning scan) re-pushes the
    // corrected numbers instead of being locked out until tomorrow (review).
    var sig = latest + '|' + [s.over30 || 0, s.open || 0, s.bad || 0, s.warn || 0].join(',');
    if (localStorage.getItem('bwn:o30:snapsent') === sig) return;
    GM_xmlhttpRequest({
      method: 'POST', url: INGEST_URL + '?client=' + INGEST_CLIENT,
      headers: { 'Content-Type': 'application/json', 'x-bwn-key': key },
      data: JSON.stringify({ actor: ingestActor(), snapshot: { date: latest, over30: s.over30 || 0, open: s.open || 0, bad: s.bad || 0, warn: s.warn || 0 } }),
      timeout: 15000,
      onload: function (r) {
        var d = null; try { d = JSON.parse(r.responseText); } catch (e) { }
        if (r.status >= 200 && r.status < 300 && d && d.ok === true) { connOk(); try { localStorage.setItem('bwn:o30:snapsent', sig); } catch (e) { } }
        else connFail(r.status);
      },
      onerror: function () { connFail('network'); }, ontimeout: function () { connFail('timeout'); }
    });
  }
  setTimeout(BWN.guard(o30SnapPush, 'o30SnapPush'), 8000);
  setInterval(BWN.guard(o30SnapPush, 'o30SnapPush'), 60000);
  GM_registerMenuCommand('Set SWA ingest key', function () {
    var cur = GM_getValue('ingest_key', '');
    var v = prompt('Paste the WO_INGEST_KEY (the SWA ingest function key; stored locally in Tampermonkey, never in the page):', cur || '');
    if (v !== null) { GM_setValue('ingest_key', v.trim()); publishAiStatus(); alert(v.trim() ? 'Saved.' : 'Cleared.'); }
  });

  // ===== BWN AI TRANSPORT (Phase 2 - unified bwnAI transport) =========================
  // The grant-holder half of the unified AI transport ([[bwn-ai-transport]] GOAL-002).
  // This file owns the network grant + the SWA connector, so it wires the REAL proxy tier
  // into the shared bwnAI router: the cross-origin sender to POST /api/ai AND the same-origin
  // tool executor. @grant none modules (Drop Upload) only carry the bwnAI block and never
  // reach the paid tier - it misses and falls through.
  //
  // Layout (top to bottom):
  //   1. bwnAI block  - PASTE-IDENTICAL across the suite (PAT-002). DO NOT edit its internals;
  //                     the transport differs ONLY by the injected sender, wired via setProxy.
  //   2. tool registry (TASK-007) - same-origin GraphQL reads the model may call.
  //   3. same-origin bearer read + gql - the operator bearer NEVER leaves the browser (SEC-001).
  //   4. driver (TASK-008) - runs the stateless client<->server tool loop to a final answer.
  //   5. proxy sender (TASK-009) - bwnAI.setProxy(...) with the GM_xmlhttpRequest transport.
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

  // Drawer slot contract (bwn:drawer:open): another tool claimed the shared slot - fold this
  // script's surfaces away. Lives OUTSIDE the bwnAI block on purpose: PAT-002 keeps that block
  // byte-identical across drop-upload/suite-ai/wo-audit, and this listener is suite-ai-only.
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:drawer:open') {
        if (d.key !== 'findtechs') { var p = document.getElementById('bwn-ft-panel'); if (p) p.remove(); }
        if (d.key !== 'jobview') { var jv = document.getElementById('bwn-jv-overlay'); if (jv) jv.remove(); }
        if (d.key !== 'clientupdate') { var cu = document.getElementById('bwn-cu-overlay'); if (cu) cu.remove(); }
        if (d.key !== 'over30') { var o3 = document.getElementById('bwn-o30b-overlay'); if (o3) o3.remove(); }
      }
    });
  } catch (e) { /* no document (worker) - nothing to fold */ }

  // ---- Tool registry (TASK-007) --------------------------------------------------------
  // Each tool is function(input) -> Promise<{ok, content}>, executed IN-PAGE against
  // /api/graphql with the operator's own Auth0 bearer (SEC-001: the bearer never leaves the
  // browser). CONFIRMED selectors only - no guessed Umbrava fields (repo Hard Rule 6). A tool
  // NEVER throws into the driver loop: it resolves {ok:false, content:'<reason>'} on any fault
  // so the loop always terminates. `content` is JSON-serializable; the driver stringifies it.
  var AI_WO_Q =
    'query($n:Int!){ workOrder(workOrderNumber:$n){ ' +
    '  number statusName locationId locationName ' +
    '  scopeOfWork serviceInstructions ' +
    '  priority{ label } trades{ id name } doNotExceed{ amount } ' +
    '} }';
  // Umbrava's REAL notes query, captured off the wire 2026-07-23 (confirmed WONoteFields
  // subset), matching bwn-wo-audit NOTES_Q byte-for-byte.
  var AI_NOTES_Q =
    'query($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ ' +
    '  id type content contentHtml createdDate isPinned isCompletion workOrderNoteSource ' +
    '  createdBy { firstName lastName } } }';

  function aiWoNum(v) {
    var n = parseInt(String(v == null ? '' : v).replace(/^W-?/i, '').replace(/[^0-9]/g, ''), 10);
    return (!n || isNaN(n)) ? null : n;
  }
  function aiDate(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
  function aiStripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

  var AI_TOOLS = {
    getWorkOrder: function (input) {
      var n = aiWoNum(input && input.workOrderNumber);
      if (!n) return Promise.resolve({ ok: false, content: 'invalid or missing workOrderNumber' });
      return aiGql(AI_WO_Q, { n: n }).then(function (d) {
        var wo = d && d.workOrder;
        if (!wo) return { ok: false, content: 'work order ' + n + ' not found' };
        return { ok: true, content: {
          number: wo.number, statusName: wo.statusName || '',
          locationId: wo.locationId || null, locationName: wo.locationName || '',
          scopeOfWork: wo.scopeOfWork || '', serviceInstructions: wo.serviceInstructions || '',
          priority: (wo.priority && wo.priority.label) || '',
          trades: (wo.trades || []).map(function (t) { return t && t.name; }).filter(Boolean),
          nte: (wo.doNotExceed && wo.doNotExceed.amount != null) ? wo.doNotExceed.amount : null
        } };
      }, function (e) { return { ok: false, content: 'work order read failed: ' + ((e && e.message) || e) }; });
    },
    getJobNotes: function (input) {
      var n = aiWoNum(input && input.workOrderNumber);
      if (!n) return Promise.resolve({ ok: false, content: 'invalid or missing workOrderNumber' });
      var limit = (input && typeof input.limit === 'number' && input.limit > 0) ? Math.min(input.limit, 50) : 20;
      return aiGql(AI_NOTES_Q, { n: n }).then(function (d) {
        var notes = ((d && d.jobNotes) || []).slice().sort(function (x, y) {
          return (aiDate(y && y.createdDate) || 0) - (aiDate(x && x.createdDate) || 0);
        }).slice(0, limit).map(function (x) {
          x = x || {};
          var who = x.createdBy ? [x.createdBy.firstName, x.createdBy.lastName].filter(Boolean).join(' ') : '';
          return {
            content: (x.content && String(x.content).trim()) || aiStripHtml(x.contentHtml),
            createdDate: x.createdDate || '', type: x.type || '',
            isPinned: !!x.isPinned, isCompletion: !!x.isCompletion,
            by: who, source: x.workOrderNoteSource || ''
          };
        });
        return { ok: true, content: { workOrderNumber: n, count: notes.length, notes: notes } };
      }, function (e) { return { ok: false, content: 'job notes read failed: ' + ((e && e.message) || e) }; });
    },
    // RISK-004: the location -> work-orders selector is NOT pinned. Per repo Hard Rule 6 we do
    // NOT guess a GraphQL field. Return a clear, terminating tool_result so Ask stays WO-scoped
    // and the loop still ends. TODO capture/replay the live query, then wire the confirmed
    // selector here (see [[bwn-ai-transport]] RISK-004 / [[bwn-ask-copilot]]).
    getLocationWorkOrders: function (input) {
      return Promise.resolve({ ok: false, content:
        'getLocationWorkOrders is not yet wired - the location-to-work-orders selector is ' +
        'unconfirmed and will not be guessed. Ask the coordinator for a specific work-order ' +
        'number and use getWorkOrder / getJobNotes instead.' });
    }
  };

  // Anthropic tool DEFINITIONS sent as `tools` in the /api/ai request (the server passes them
  // to the model; it does NOT execute them - REQ-006). Names match AI_TOOLS keys exactly.
  var AI_TOOL_DEFS = [
    { name: 'getWorkOrder',
      description: 'Look up a single Umbrava work order by its number. Returns status, location, scope of work, service instructions, priority, trades, and the not-to-exceed amount.',
      input_schema: { type: 'object', properties: {
        workOrderNumber: { type: 'string', description: 'The work order number, digits only or W-prefixed, e.g. "375038" or "W-375038".' }
      }, required: ['workOrderNumber'] } },
    { name: 'getJobNotes',
      description: 'Read the job notes for a work order, newest first. Returns each note text, author, date, type, and pinned/completion flags.',
      input_schema: { type: 'object', properties: {
        workOrderNumber: { type: 'string', description: 'The work order number, digits only or W-prefixed.' },
        limit: { type: 'number', description: 'Max notes to return (default 20, cap 50).' }
      }, required: ['workOrderNumber'] } },
    { name: 'getLocationWorkOrders',
      description: 'List the work orders at a location. NOTE: not yet available - the selector is unconfirmed and this returns an unavailable notice. Prefer getWorkOrder with a specific work-order number.',
      input_schema: { type: 'object', properties: {
        locationId: { type: 'string', description: 'The Umbrava location id.' }
      }, required: ['locationId'] } }
  ];

  // ---- Same-origin bearer read + GraphQL -----------------------------------------------
  // Mirrors the proven jobView data layer (isUmbravaToken / authToken / gql, [[umbrava-role-auth]]).
  // Kept self-contained here because those copies are trapped in the jobView module scope and
  // the transport must work even when Job View is toggled off. The bearer is picked by CONTENT
  // (the auth cache slot transiently holds a non-Umbrava SCM token) and read FRESH each round
  // (RISK-001: it is short-lived). It rides only same-origin /api/graphql (SEC-001); the copy
  // sent to the SWA goes in the JSON BODY (SEC-002), never the Authorization header.
  function aiIsUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function aiUserToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (tok && aiIsUmbravaToken(tok)) return tok;
      }
      return '';
    } catch (e) { return ''; }
  }
  function aiGql(query, variables) {
    var tok = aiUserToken();
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

  // ---- Driver + POST transport (TASK-008) ----------------------------------------------
  var AI_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/ai';
  var AI_MAX_TOOL_ROUNDS = 6;        // match the server default (BWN_AI_MAX_TOOL_ITERS)
  var AI_MAX_CALLS_PER_ROUND = 8;    // backstop on a single over-eager assistant turn
  var AI_REQ_TIMEOUT_MS = 60000;     // per round-trip; the loop count bounds total time

  // One POST to /api/ai over GM_xmlhttpRequest (the SWA is a declared @connect host). Reads the
  // ingest key FRESH so a mid-session save/clear is honored. Resolves the parsed JSON on 2xx,
  // else null - a 403 ROLE_REQUIRED / network error / timeout / disabled connector is a MISS,
  // never a throw, so bwnAI falls through to on-device (backgrounded-tab rule: never hang).
  function aiPost(body) {
    return new Promise(function (resolve) {
      if (!connectorEnabled()) { resolve(null); return; }        // kill-switch
      var key = GM_getValue('ingest_key', '');
      if (!key) { resolve(null); return; }                       // key not set -> miss
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: AI_URL, timeout: AI_REQ_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json', 'x-bwn-key': key },
          data: JSON.stringify(body),
          onload: function (r) {
            var j = null; try { j = JSON.parse(r.responseText); } catch (e) { }
            if (r.status >= 200 && r.status < 300 && j) resolve(j);
            else resolve(null);
          },
          onerror: function () { resolve(null); },
          ontimeout: function () { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  // Execute one server-issued tool call same-origin. Returns a toolResults[] entry
  // {tool_use_id, content, is_error?}; never throws (a thrown/failed tool becomes is_error).
  function aiExecTool(call) {
    var id = (call && call.id) || '';
    var name = call && call.name;
    var input = (call && call.input) || {};
    var fn = AI_TOOLS[name];
    if (typeof fn !== 'function') {
      return Promise.resolve({ tool_use_id: id, content: JSON.stringify({ ok: false, content: 'unknown tool: ' + name }), is_error: true });
    }
    return Promise.resolve().then(function () { return fn(input); }).then(function (res) {
      res = res || { ok: false, content: 'tool returned nothing' };
      var tr = { tool_use_id: id, content: JSON.stringify(res) };
      if (res.ok === false) tr.is_error = true;
      return tr;
    }, function (e) {
      return { tool_use_id: id, content: JSON.stringify({ ok: false, content: 'tool threw: ' + ((e && e.message) || e) }), is_error: true };
    });
  }

  // Drive the stateless server loop to a final answer. `post` is injectable for tests (defaults
  // to aiPost). Given the initial request body: POST; while the server answers
  // status:'tool_calls', execute each call same-origin, then re-POST the RETURNED messages +
  // toolResults + tools + a FRESH userToken (RISK-001). The client round cap backstops the
  // server cap (which forces a final first). Resolves the final text, or '' on any miss/cap so
  // bwnAI falls through. Never throws, never hangs.
  function aiDriveLoop(initialBody, post) {
    post = post || aiPost;
    var tools = initialBody.tools;
    function step(body, posts) {
      if (posts > AI_MAX_TOOL_ROUNDS + 1) return Promise.resolve('');   // backstop; server finalizes at its own cap first
      return post(body).then(function (resp) {
        if (!resp || resp.ok !== true) return '';                       // miss / handled failure -> fall through
        if (resp.status === 'final') return String(resp.text || '');
        if (resp.status === 'tool_calls' && Array.isArray(resp.toolCalls) && resp.toolCalls.length && Array.isArray(resp.messages)) {
          var calls = resp.toolCalls.slice(0, AI_MAX_CALLS_PER_ROUND);
          return Promise.all(calls.map(aiExecTool)).then(function (toolResults) {
            var next = { task: body.task, messages: resp.messages, toolResults: toolResults, tools: tools, userToken: aiUserToken() };
            if (body.model) next.model = body.model;
            if (body.client) next.client = body.client;
            return step(next, posts + 1);
          });
        }
        return '';                                                      // unknown status -> fall through
      }, function () { return ''; });
    }
    return step(initialBody, 1);
  }

  // ---- Injected proxy sender (TASK-009) ------------------------------------------------
  // bwnAI's proxy tier calls this with {task, system, prompt, maxTokens, minRank, rank}. It
  // builds the initial /api/ai request (tools + userToken in the BODY, SEC-002) and runs the
  // tool loop to a final answer. HONORS the connector guards (kill-switch / ingest-key-not-set)
  // exactly like the other SWA calls: on any guard miss or no usable bearer it resolves '' so
  // the router falls through to on-device / local, never errors ([[bwn-ai-tiering]] proxy-miss).
  function aiProxySend(payload) {
    payload = payload || {};
    if (!connectorEnabled()) return Promise.resolve('');
    if (!GM_getValue('ingest_key', '')) return Promise.resolve('');
    var userToken = aiUserToken();
    if (!userToken) return Promise.resolve('');                         // advanced tasks need a vouch; no bearer -> miss
    var body = {
      task: payload.task || 'ask',
      prompt: (payload.prompt != null) ? String(payload.prompt) : '',
      userToken: userToken
    };
    // Only tool-using tasks (ask) get the tool registry. draft/render carry every fact
    // inline in the prompt; attaching tools would let the model fan out extra Umbrava
    // reads (latency/cost) and, on a client-facing scrubbed draft, pull back the very
    // notes the caller scrubbed out. Keep non-ask tasks single round-trip, tool-free.
    if (body.task === 'ask') body.tools = AI_TOOL_DEFS;
    if (payload.system) body.system = payload.system;                   // server ignores this for 'ask' (grounding cannot be spoofed)
    if (payload.client) body.client = payload.client;
    return Promise.resolve().then(function () { return aiDriveLoop(body); })
      .then(function (t) { return String(t || ''); }, function () { return ''; });
  }

  // Wire the real transport into the shared router. The bwnAI block above stays paste-identical
  // across the suite; ONLY this injection differs (PAT-002 / [[bwn-ai-tiering]] injected-sender).
  bwnAI.setProxy(aiProxySend);
  // ===== END BWN AI TRANSPORT =========================================================



  // ==========================================================================
  // MODULE: Client Update / WO Audit Drafts v1.46
  // ==========================================================================
  if (BWN_MODULES.clientUpdate) BWN.safeModule('clientUpdate', function () {
    'use strict';

    // ---- Config (edit here) ----------------------------------------------
    var CFG = {
      MODEL: 'claude-sonnet-4-6',          // any valid Anthropic API model string
      STREAM: false,                       // false = reliable buffered request (recommended); true = live token-streaming bar (needs a Tampermonkey build that signals stream completion)
      INCLUDE_ASSIGNED_VENDOR: false,      // true = allow vendor names through (you review the draft anyway)
      // Client mode now uses ALL note labels as factual input (best available facts),
      // protected by three layers: every body is scrubbed before transmission, the
      // system prompt forbids internal data in the output, and you review each draft.
      // KEEP_LABELS is retained only as an optional restriction: set CLIENT_MODE.keepAll
      // to false below to fall back to label filtering with this list.
      KEEP_LABELS: ['client'],
      INTERNAL_KEYWORDS: ['markup', 'margin', 'gross profit', ' gp ', 'profit', 'our cost', 'per foot', 'per ft'],
      MAX_TOKENS: 600
    };

    var BTN_ID = 'bwn-client-update-btn';
    var GREEN = BWN.GREEN;

    // Prompt-pack version: stamped on cached drafts so a prompt edit invalidates
    // stale caches. Bump when any SYSTEM_PROMPT_* changes materially.
    var PROMPT_V = 3;

    // Runtime knobs (Ops Suite panel → bwn:config.ai; the in-code CFG values are
    // the defaults). Plain localStorage read - nothing here touches the network.
    function aiCfg() {
      var c = bwnSuiteConfig();
      var a = (c && typeof c.ai === 'object' && c.ai) ? c.ai : {};
      return {
        model: (typeof a.model === 'string' && a.model.trim()) ? a.model.trim() : CFG.MODEL,
        windowDays: (typeof a.windowDays === 'number' && a.windowDays >= 1 && a.windowDays <= 60) ? Math.round(a.windowDays) : 7,
        includeVendor: (typeof a.includeVendor === 'boolean') ? a.includeVendor : CFG.INCLUDE_ASSIGNED_VENDOR,
        preflight: (a.preflight === 'always' || a.preflight === 'never') ? a.preflight : 'auto'
      };
    }

    // ---- Usage ledger (tokens per month; numbers only, readable by the Ops panel) ----
    var lastUsage = null;   // {input, output} of the most recent successful generation
    function recordUsage(u) {
      try {
        if (!u || (!u.input && !u.output)) return;
        var d0 = new Date();
        var key = d0.getFullYear() + '-' + ('0' + (d0.getMonth() + 1)).slice(-2);
        var led = BWN.lsGetJSON('bwn:ai:usage', {}) || {};
        var cur = led[key] || { calls: 0, input: 0, output: 0 };
        cur.calls++; cur.input += u.input || 0; cur.output += u.output || 0;
        led[key] = cur;
        var ks = Object.keys(led).sort();
        while (ks.length > 6) delete led[ks.shift()];
        BWN.lsSetJSON('bwn:ai:usage', led);
      } catch (e) { /* ledger is best-effort */ }
    }

    console.info('[BWN CU] client-update userscript loaded on', location.href);

    // The per-user Anthropic key was retired in TASK-014 - drafting now rides the shared
    // bwnAI transport (SWA connector + one server key). No "Set Anthropic API key" menu.

    // ---- Reading the work order ------------------------------------------
    function txt(testid) {
      var el = document.querySelector('[data-testid="' + testid + '"]');
      return el ? (el.textContent || '').trim() : '';
    }
    var inputVal = BWN.inputVal;
    function getHeader() {
      return {
        tracking: txt('work-order-header-tracking-number'),
        wo: txt('work-order-header-number-formatted'),
        status: inputVal('statusId-autocomplete-input'),
        firstTrip: inputVal('work-order-first-trip-date-picker'),
        completeBy: inputVal('work-order-expected-completion-date-picker'),
        location: txt('wo-location-dropdown-input-label'),
        assignedTo: inputVal('assignedTo-autocomplete-input')
      };
    }

    // Note card walking + label/timestamp reading moved to the shared core (v5):
    // BWN.noteCard + BWN.noteMeta - a self-healing resolver shared with WO Assist,
    // so a hashed-class rename in Umbrava degrades gracefully in BOTH scripts.

    // ---- Scrub internal data before anything leaves the browser ----------
    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function vendorNames() {
      var out = [];
      document.querySelectorAll('[data-testid="purchase-order-vendor-name"]').forEach(function (el) {
        var v = (el.textContent || '').trim();
        if (v && out.indexOf(v) === -1) out.push(v);
      });
      if (!out.length) bwnBusVendors().forEach(function (v) { if (v && out.indexOf(v) === -1) out.push(v); });   // PO panel not mounted: fall back to Core's bus
      return out;
    }

    function scrub(text, vendors) {
      var t = text || '';
      // Dollar amounts.
      t = t.replace(/\$\s*[\d,]+(\.\d{1,2})?/g, '[redacted]');
      // Email addresses and phone numbers (vendor threads are full of these; never client-appropriate).
      t = t.replace(/[\w.+-]+@[\w.-]+\.\w{2,}/g, '[contact]');
      t = t.replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]');
      // Vendor names (unless explicitly allowed through).
      if (!aiCfg().includeVendor) {
        vendors.forEach(function (v) { if (v) t = t.replace(new RegExp(escapeRe(v), 'ig'), '[contractor]'); });
      }
      // Drop any line containing internal-pricing keywords.
      t = t.split('\n').filter(function (line) {
        var low = ' ' + line.toLowerCase() + ' ';
        return !CFG.INTERNAL_KEYWORDS.some(function (k) { return low.indexOf(k) !== -1; });
      }).join('\n');
      return t.trim();
    }

    // Find the scrollable notes container (shared resolver, v1.36).
    function notesScroller() { return BWN.findScroller(document.querySelector(BWN.NOTE_SUMMARY_SEL)); }

    // ---- Shared deep-scan cache (bus: bwn:notes:{woId}) --------------------
    // ONE full note collection - from EITHER script (WO Assist's Deep Scan or a
    // draft here) - serves every tool on the WO. Sandboxes can't share objects,
    // so the notes ride the sessionStorage bus like everything else. Validity:
    // a TTL, plus "no mounted note id the cache has never seen" (someone posted
    // a note since → stale). Session-scoped; at most 3 WOs kept (quota hygiene).
    var NOTES_TTL = 30 * 60000;
    function busNotesKey() { return 'bwn:notes:' + (bwnWOId() || location.pathname); }
    function busNotesGet() {
      try {
        var d = JSON.parse(sessionStorage.getItem(busNotesKey()) || 'null');
        if (!d || d.v !== 1 || !Array.isArray(d.notes)) return null;
        if (Date.now() - (d.ts || 0) > NOTES_TTL) return null;
        var byId = {};
        d.notes.forEach(function (n) { byId[n.id] = n; });
        var mounted = document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]');
        for (var i = 0; i < mounted.length; i++) {
          var m = (mounted[i].getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/);
          if (!m) continue;
          var cn = byId[m[1]];
          if (!cn) return null;                                  // new note since the scan → stale
          // Edited-in-place detection: an edit bumps the note's last-modified stamp,
          // and the editor is almost certainly LOOKING at the note (= mounted here).
          var liveTs = BWN.noteMeta(BWN.noteCard(mounted[i])).ts || '';
          if (liveTs && (cn.ts || '') && liveTs !== cn.ts) return null;   // edited → stale
        }
        return d.notes;
      } catch (e) { return null; }
    }
    function busNotesPut(notesArr) {
      try {
        // Slim before publish: cap monster note bodies (visible "…[truncated]" marker
        // the model can see; a fresh collect always works from full bodies) and refuse
        // payloads that would crowd the sessionStorage quota (review m5). The size
        // check runs BEFORE pruning so a refused publish never evicts another WO's
        // good cache.
        var slim = notesArr.map(function (n) {
          var b = String(n.body || '');
          if (b.length > 6000) b = b.slice(0, 6000) + ' …[truncated]';
          // Freeze an absolute epoch NOW so a relative ts ("2 hours ago") captured at
          // scan time doesn't drift when a consumer re-parses it later (timeline M1).
          var da = n.ts ? BWN.parseNoteDateLoose(n.ts) : null;
          return { id: n.id, label: n.label || '', ts: n.ts || '', tsAbs: da ? +da : null, body: b };
        });
        var blob = JSON.stringify({ v: 1, ts: Date.now(), notes: slim });
        if (blob.length > 2000000) { console.info('[BWN CU] note cache skipped - payload too large (' + Math.round(blob.length / 1024) + 'KB)'); return; }
        var keys = [];
        for (var i = 0; i < sessionStorage.length; i++) {
          var k = sessionStorage.key(i);
          if (k && k.indexOf('bwn:notes:') === 0 && k !== busNotesKey()) {
            var d = null; try { d = JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e2) { }
            keys.push({ k: k, ts: (d && d.ts) || 0 });
          }
        }
        keys.sort(function (a, b) { return b.ts - a.ts; });
        for (var j = 2; j < keys.length; j++) sessionStorage.removeItem(keys[j].k);
        sessionStorage.setItem(busNotesKey(), blob);
      } catch (e) { /* quota - cache is best-effort */ }
    }

    // Capture every currently-mounted note into `store` (keyed by id). Virtualized
    // lists recycle rows, so we grab each note's data while it's on screen.
    function captureMounted(store) {
      document.querySelectorAll('[data-testid^="wo-note-"][data-testid$="-summary"]').forEach(function (s) {
        var m = (s.getAttribute('data-testid') || '').match(/wo-note-(\d+)-summary/);
        if (!m) return;
        var id = m[1];
        if (store[id] && store[id].body) return;       // already have it with text
        var bodyEl = document.querySelector('[data-testid="wo-note-' + id + '-description"]');
        var body = bodyEl ? (bodyEl.textContent || '').trim() : (s.textContent || '').trim();
        var meta = BWN.noteMeta(BWN.noteCard(s));
        store[id] = { label: meta.label, ts: meta.ts, body: body };
      });
    }

    // Scroll the notes list end-to-end, accumulating all notes regardless of
    // whether the list recycles (virtualized) or appends (lazy). DOM-only, no token.
    // Sweep runs on the shared BWN.harvest engine (v1.36). Lifecycle: a WO change
    // or THIS modal instance closing aborts - doneCb never fires, so no API call is
    // billed and the NEW WO's notes can't leak into this draft. Identity (not just
    // id-presence) is compared so an orphaned ticker can't be revived by a freshly
    // reopened modal. A same-WO list remount re-attaches and continues.
    function collectAllNotes(progress, doneCb, onAbort, force) {
      // Shared-cache fast path: a full collection already exists for this WO (from
      // WO Assist's Deep Scan or a previous draft) - skip the scroll entirely.
      // `force` (Shift-Regenerate) bypasses it: the human lever for the one case
      // detection can't cover (a DELETED note is indistinguishable from one merely
      // scrolled out of the virtualized window).
      var cached = force === true ? null : busNotesGet();
      if (cached) {
        var store0 = {};
        cached.forEach(function (n) { store0[n.id] = { label: n.label || '', ts: n.ts || '', body: n.body || '' }; });
        console.info('[BWN CU] using shared note cache:', cached.length, 'notes');
        if (progress) progress(cached.length);
        setTimeout(function () { doneCb(store0, true); }, 0);   // keep the async contract; flag the provenance
        return;
      }
      var store = {};
      var epoch = bwnWOId();
      var overlayEl = document.getElementById('bwn-cu-overlay');   // this run's modal instance
      // The API read (bwnNotesApi) answers in one call what the sweep below scrolls for.
      // It gets the SAME abort identity as the sweep: a WO change or THIS modal closing
      // discards the result, so a late answer can never seed the next WO's draft.
      function stillOurs() { return bwnWOId() === epoch && document.getElementById('bwn-cu-overlay') === overlayEl; }
      function abortNow() {
        console.info('[BWN CU] note collection aborted - page or modal changed mid-collect');
        // If the modal survived (browser-chrome navigation), tell it - otherwise
        // it sits frozen at "Collecting…" over the new page forever.
        if (onAbort && document.getElementById('bwn-cu-overlay') === overlayEl) onAbort();
      }
      bwnNotesApi(epoch).then(function (list) {
        if (!stillOurs()) { abortNow(); return; }
        list.forEach(function (n) { store[n.id] = { label: n.label || '', ts: n.ts || '', body: n.body || '' }; });
        if (progress) progress(list.length);
        busNotesPut(list);          // one API read serves every other tool on this WO too
        console.info('[BWN CU] notes read from the API:', list.length, 'notes - no scrolling');
        doneCb(store);
      }, function (err) {
        console.info('[BWN CU] API notes read unavailable (' + ((err && err.message) || err) + ') - falling back to the scroll sweep');
        if (!stillOurs()) { abortNow(); return; }
        sweep();
      });
      function sweep() {
      BWN.harvest({
        scroller: notesScroller(),
        rescroller: notesScroller,
        capture: function () { captureMounted(store); },
        count: function () { return Object.keys(store).length; },
        cancelled: function () {
          if (stillOurs()) return false;
          abortNow();
          return true;
        },
        progress: progress,
        done: function (complete) {
          // Publish ONLY a converged full sweep so every other tool reuses it - a
          // truncated top-of-list prefix passes every validity check and would
          // poison the shared cache for the TTL (review M1).
          if (complete) {
            busNotesPut(Object.keys(store).map(function (id) {
              return { id: id, label: store[id].label || '', ts: store[id].ts || '', body: store[id].body || '' };
            }));
          } else {
            console.info('[BWN CU] collection was PARTIAL - not published to the shared cache');
          }
          doneCb(store);
        }
      });
      }
    }

    // Apply keep-list + scrub to the collected notes.
    function processNotes(store, vendors, mode) {
      var keep = [], skipped = 0;
      Object.keys(store).forEach(function (id) {
        var n = store[id], label = n.label || '';
        if (!mode.keepAll && mode.keepLabels.indexOf(label.toLowerCase()) === -1) { skipped++; return; }
        var body = mode.scrub ? scrub(n.body, vendors) : (n.body || '').trim();
        if (!body) return;
        keep.push({ label: label, ts: n.ts, body: body });
      });
      return { keep: keep, skipped: skipped, total: Object.keys(store).length };
    }

    // ---- Recent-window date parsing (for the Recent Update mode) ---------
    // Note timestamps come from the rendered list and the format can vary, so
    // parse tolerantly and FAIL OPEN: an unreadable date is kept (and counted)
    // rather than silently dropped, and the prompt also scopes by cutoff date.
    // The parser itself was promoted to the shared core (v5) so WO Assist's
    // staleness math uses the identical logic.
    var parseNoteDate = BWN.parseNoteDateLoose;
    function withinDays(ts, days) {
      var d = parseNoteDate(ts);
      if (!d) return null;                                   // unreadable date
      var diff = (Date.now() - d.getTime()) / 86400000;
      return diff <= days && diff >= -1;                     // within window (small future skew tolerated)
    }

    // ---- Prompt assembly --------------------------------------------------
    var SYSTEM_PROMPT_CLIENT = [
      'You write brief, client-facing status updates for facilities maintenance work orders, sent by Broadway National to an external client.',
      'RULES:',
      '1. Use ONLY facts present in the provided data and notes. Never infer or invent status, dates, or progress.',
      '2. If there is no confirmed scheduling date or next step in the notes, SAY SO PLAINLY (e.g., "No confirmed scheduling date yet as of [latest note date]."). Do not soften gaps or imply progress that is not stated.',
      '3. Never output dollar amounts, pricing, markup, margin, vendor/contractor company names, personal contacts, or any internal commentary, even if present in the input.',
      '3b. Notes may contain forwarded email threads (From/To/Sent headers, names, emails, phone numbers). Summarize only the operational substance - what happened on site, scheduling, progress, what is being awaited - and never reproduce names, email addresses, phone numbers, or pricing from them.',
      '3c. Input notes come from mixed sources (Client, Vendor, Internal, Billing, Email). Use them ALL as factual background to determine the true current state, but the OUTPUT must read as a clean external update: never reference internal processes, note labels, vendor coordination chatter, approvals, or billing mechanics. Translate internal facts into client-appropriate status (e.g., a vendor confirming Friday becomes "service is scheduled for Friday").',
      '4. Professional, concise, plain language. Lead with the current status, then the next step or what is being awaited.',
      '5. Output ONLY the update text - no greeting, sign-off, or subject line. Default to concise (a few sentences). Expand only when the work order genuinely warrants it - a long or complex history may need more, a simple one should stay short. Use plain prose for straightforward updates, or a few short bullets if the WO has multiple distinct threads worth separating. Length should match what the situation actually requires, never padded.'
    ].join('\n');

    var SYSTEM_PROMPT_AUDIT = [
      'You write a structured INTERNAL audit summary of a facilities maintenance work order for Broadway National operations staff. Internal use only \u2014 NOT for the client. Include everything operationally significant, but be economical: do not recap every note or restate email exchanges verbatim. The output is pasted into a work-order note that renders as a formatted case file, so follow the exact section structure below.',
      'RULES:',
      '1. Use only facts present in the provided data and notes. Do not invent status, dates, amounts, or progress. If a needed fact is missing, say so and FLAG it.',
      '2. Output these sections IN THIS ORDER, using the exact heading words shown so the note renders correctly. Omit a section only if there is genuinely nothing to put in it.',
      '3. LINE 1 is a title line with no label, in the form: TRACKING #<tracking number> | WO <work order number> | <CLIENT> STORE <location number> \u2014 <CITY, ST>. Use whatever identifiers are available and drop any piece you lack, keeping the | separators between the pieces you do have.',
      '4. LINE 2 is a subtitle line containing pipes: <CLIENT FULL NAME> | <SITE ADDRESS> | PO# <po number> / CLIENT WO# <client wo>. Drop pieces you lack. Do not use the | character anywhere else in the output.',
      '5. Next a line "CURRENT STATUS: <one sentence on exactly where the WO stands right now>". You may follow it with one to three plain sentences of supporting detail with no label.',
      '6. Next a heading line "RISK FLAGS:" followed by one line per risk, each beginning "FLAG: " \u2014 every unresolved item, missing confirmation, GP or margin gap, ETA gap, or aging concern. Use the AGING STANDARDS in the source facts to decide what is stale, aging, or overdue. If there are none, write "FLAG: None outstanding.".',
      '7. Optionally a heading line "TIMELINE:" followed by dated lines in the form "M/D \u2014 <what happened>" (e.g. "6/18 \u2014 crew onsite, drilled footing"), oldest first, limited to the key milestones and recent activity (roughly 6-10 entries) \u2014 not every note or email exchange.',
      '8. Next a heading line "VENDORS:" followed by one line per vendor in the form "<Vendor Name> (<contact if known>) \u2014 <role> \u2014 <short detail; short detail> $<amount>". Put every dollar figure for that vendor on its line (confirmed total, adders, incurred costs) so they render in the amount column. One vendor per line.',
      '9. Next a heading line "NEXT ACTIONS:" followed by a numbered list (1., 2., 3., ...) of concrete actions, most urgent first, each a short imperative line with a date or target where the notes provide one. Attribute every action to the assigned coordinator using the exact full name given as "Assigned coordinator" in the source facts (e.g. "<that full name> \u2014 follow up with the vendor by 6/25"). Never use a name, initial, username, or handle taken from the notes or note authors as the action owner. If no assigned coordinator is provided, write the actions as plain imperatives with no name prefix.',
      '10. Plain operational language. Do NOT use markdown tables. Do NOT use the | character except in the title and subtitle lines. Section headings must be exactly CURRENT STATUS:, RISK FLAGS:, TIMELINE:, VENDORS:, NEXT ACTIONS:. No preamble, no sign-off, no closing commentary.'
    ].join('\n');

    var SYSTEM_PROMPT_OVER30 = [
      'You write a single standardized "OVER 30" status line for a facilities maintenance work order, in the terse ALL-CAPS style Broadway National ops uses in its WO Audit spreadsheet. Internal use.',
      'RULES:',
      '1. Use ONLY facts in the provided data and notes. Do not invent status, dates, or progress.',
      '2. Output EXACTLY ONE line, ALL CAPS, beginning with "OVER 30 - ".',
      '3. If the work type is clear from the trades or scope, add it right after as a tag plus a dash: "WIFI PROJECT", "RETROFIT PROJECT", "RF PROJECT", or "SERVICE". If it is not clearly one of these, omit the type tag.',
      '4. Then give the current status and the immediate next step or blocker, telegraphic style, segments separated by " - ". Include key dates as M/D (e.g. "REWIRING COMPLETED 6/15 - NEED ESD ON MATERIALS", "PROPOSAL SUBMITTED 6/16 AWAITING CLIENT APPROVAL", "ECD 6/23"). Use common ops shorthand where it fits: ESD, ECD, ETA, ATF, TSP, OWL, NEMA, F/U, SCHED.',
      '5. One line only. No preamble, no quotes, no trailing period. Match the tone and brevity of these examples:',
      '   OVER 30 - WIFI PROJECT - AWAITING CLIENT APPROVAL',
      '   OVER 30 - RETROFIT PROJECT - REWIRING COMPLETED 6/15 - NEED ESD ON MATERIALS',
      '   OVER 30 - WIFI PROJECT - PROPOSAL SUBMITTED 6/16 AWAITING CLIENT APPROVAL',
      '   OVER 30 - PEND BORING TECHS SCHEDULE',
      '   OVER 30 - ECD 6/23'
    ].join('\n');

    var SYSTEM_PROMPT_NEXTSTEPS = [
      'You produce a short, action-oriented NEXT STEPS list for a facilities maintenance work order, for Broadway National operations staff. Internal use only - NOT for the client. The goal is to tell the coordinator exactly what to do next to move this work order forward.',
      'RULES:',
      '1. Use only facts present in the provided data and notes. Do not invent status, dates, owners, or progress.',
      '2. Begin with ONE headline line naming the job: the work order number and location/site if present, otherwise a 3 to 6 word description of the work. This is the only title line.',
      '3. Next, one line "CURRENT STATUS: <one sentence on where the WO stands now>". If something is blocking progress or a needed fact is missing (no ETA, awaiting a confirmation, GP not addressed), add a heading line "RISK FLAGS" followed by one or two short flag lines naming the blocker or gap.',
      '4. Then a heading line "NEXT STEPS" followed by a numbered list (1., 2., 3., ...) of concrete actions, most urgent first, 2 to 6 steps. Each step is one short imperative line - what to do, and if the notes name a who (vendor, client, internal role) or a date/target, include it (e.g. "Follow up with A-Plus on revised quote - target 6/25"). Direct steps to the assigned coordinator; never prefix a step with a name, initial, username, or handle taken from the notes or note authors.',
      '5. Plain operational language, telegraphic is fine. Output ONLY the headline, the CURRENT STATUS line, any RISK FLAGS, and the NEXT STEPS list. No client-facing language, no full timeline recap, no vendor table, no preamble or sign-off. Do NOT use markdown tables.'
    ].join('\n');

    var SYSTEM_PROMPT_RECENT = [
      'You write a SHORT internal "recent update" on a facilities maintenance work order for Broadway National operations staff \u2014 a delta covering only the most recent activity window, NOT a full audit. Internal use only \u2014 NOT for the client. Be brief: a quick catch-up a coordinator can read in seconds. The output is pasted into a work-order note that renders as a formatted case file, so use the exact section headings below.',
      'RULES:',
      '1. Use only facts present in the provided data and notes. Do not invent status, dates, amounts, or progress. Cover only activity within the RECENT WINDOW given in the source facts; use older notes only as background to make the recent activity intelligible.',
      '2. LINE 1 is a title line with no label: TRACKING #<tracking number> | WO <work order number> | <CLIENT> STORE <location number> \u2014 <CITY, ST>. Drop any piece you lack, keep the | separators between the pieces you have. Do not use | anywhere else.',
      '3. Next a line "CURRENT STATUS: <one sentence on exactly where the WO stands right now>".',
      '4. Next a heading line "RECENT ACTIVITY:" followed by dated lines in the form "M/D \u2014 <what happened>" within the recent window, oldest first. If nothing happened in the window, write one line "M/D \u2014 No activity on record in the last N days." using the window length. Keep to genuinely new items \u2014 a handful of lines, not a full history.',
      '5. Next a heading line "RISK FLAGS:" with one line per currently-open risk, each beginning "FLAG: " \u2014 only items still unresolved as of now (missing confirmation, GP or margin gap, ETA gap, or aging concern). Use the AGING STANDARDS in the source facts to judge staleness. If none, write "FLAG: None outstanding.".',
      '6. Next a heading line "NEXT ACTIONS:" with a numbered list of concrete next steps, most urgent first. Attribute every action to the assigned coordinator using the exact full name given as "Assigned coordinator" in the source facts. Never use a name, initial, username, or handle taken from the notes or note authors. If no assigned coordinator is provided, write plain imperatives with no name prefix.',
      '7. Plain operational language. No VENDORS table, no full timeline recap, no preamble or sign-off. Do NOT use markdown tables. Do NOT use the | character except in the title line. Section headings must be exactly CURRENT STATUS:, RECENT ACTIVITY:, RISK FLAGS:, NEXT ACTIONS:.'
    ].join('\n');

    var CLIENT_MODE = {
      name: 'Client Update',
      keepAll: true,                       // use ALL labels as factual input (scrubbed); set false to filter to keepLabels
      keepLabels: CFG.KEEP_LABELS,         // only applies when keepAll is false
      scrub: true,                         // every note body is redacted before transmission regardless of label
      system: SYSTEM_PROMPT_CLIENT,
      maxTokens: 1500,                      // headroom to expand on complex WOs; prompt keeps it concise by default
      prefix: function (basis) { return 'Draft from ' + basis + ' - review before sending.\n\n'; }
    };

    var AUDIT_MODE = {
      name: 'WO Audit',
      keepAll: true,                        // internal: include all labels (Client/Vendor/Internal/Billing/Email/Proposal Approved/unknown)
      keepLabels: [],
      scrub: false,                         // internal: keep amounts, vendor names, GP notes
      system: SYSTEM_PROMPT_AUDIT,
      maxTokens: 6000,                      // long audits exceed 2k tokens; was truncating mid-sentence
      noteType: 'Recap',                    // enables the "Add as Recap note" button in the result modal
      prefix: function (basis) { return 'Internal audit - from ' + basis + '.\n\n'; }
    };

    var OVER30_MODE = {
      name: 'Over 30',
      keepAll: true,                        // internal: read all note labels to judge true current state
      keepLabels: [],
      scrub: false,                         // internal: keep full detail
      system: SYSTEM_PROMPT_OVER30,
      maxTokens: 200,                       // one terse line
      noteType: 'Recap',                    // enables the "Add as Recap note" button in the result modal
      prefix: function (basis) { return 'Over-30 audit line - from ' + basis + '. Review, then add to the WO note (or paste).\n\n'; }
    };

    var NEXTSTEPS_MODE = {
      name: 'Next Actions',                 // matches the dashboard "Next Actions Required" callout
      keepAll: true,                        // internal: read all note labels to judge true current state
      keepLabels: [],
      scrub: false,                         // internal: keep full detail
      system: SYSTEM_PROMPT_NEXTSTEPS,
      maxTokens: 1200,                      // short action list; headroom for a few flagged gaps
      noteType: 'Action',                   // enables the "Add as Action note" button in the result modal
      prefix: function (basis) { return 'Next actions - from ' + basis + '. Review, then add to the WO note (or paste).\n\n'; }
    };

    var RECENT_MODE = {
      name: 'Recent Update',
      keepAll: true,                        // internal: read all note labels to judge true current state
      keepLabels: [],
      scrub: false,                         // internal: keep full detail
      system: SYSTEM_PROMPT_RECENT,
      maxTokens: 1500,                      // short delta; not a full audit
      windowDays: 7,                        // only summarize notes from the last N days (relative to now)
      noteType: 'Recap',                    // enables the "Add as Recap note" button in the result modal
      prefix: function (basis) { return 'Recent update - from ' + basis + '. Review, then add to the WO note (or paste).\n\n'; }
    };

    function buildUserContent(h, notes, mode, win) {
      var lines = [];
      lines.push('WORK ORDER (source facts):');
      if (h.tracking) lines.push('- ' + h.tracking);
      if (h.wo) lines.push('- WO ' + h.wo);
      if (h.location) lines.push('- Location: ' + h.location);
      if (h.status) lines.push('- Operational status: ' + h.status);
      if (h.assignedTo) lines.push('- Assigned coordinator (owner of all next actions): ' + h.assignedTo);
      if (h.firstTrip) lines.push('- First trip by: ' + h.firstTrip);
      if (h.completeBy) lines.push('- Complete by: ' + h.completeBy);
      if (!mode.scrub) {
        var cfg = bwnSuiteConfig();
        lines.push('AGING STANDARDS (suite-wide; judge staleness and aging risk against these exact thresholds):');
        lines.push('- A note is stale after ' + cfg.noteStaleDays + ' days with no update.');
        lines.push('- Time in status is a concern past ' + cfg.hrsWarn + ' hrs and serious past ' + cfg.hrsBad + ' hrs.');
        lines.push('- A scheduled or needed date is due soon within ' + cfg.dueWarnDays + ' days.');
      }
      if (win) {
        var cutoff = new Date(Date.now() - win * 86400000);
        var cs = (cutoff.getMonth() + 1) + '/' + cutoff.getDate() + '/' + cutoff.getFullYear();
        lines.push('RECENT WINDOW: this is a SHORT recent-activity update, not a full audit. Cover only what happened on or after ' + cs + ' (the last ' + win + ' days); use older notes only as background.');
      }
      lines.push('');
      if (mode.scrub) {
        lines.push('NOTES (mixed sources - Client/Vendor/Internal/etc; amounts, contacts, pricing, vendor names already redacted; use as facts only, never reintroduce internal detail):');
      } else {
        lines.push('NOTES (internal - full detail, most recent first):');
      }
      if (!notes.length) {
        lines.push('(none available - state plainly that there is no recent update on record.)');
      } else {
        notes.forEach(function (n) {
          lines.push('[' + (n.ts || 'date n/a') + '] (' + n.label + ') ' + n.body.replace(/\s+/g, ' ').trim());
        });
      }
      return lines.join('\n');
    }

    // ---- Draft generation via the shared bwnAI transport (TASK-013) --------
    // Routes task:'draft' through the suite-wide bwnAI router. Managers+ hit the SWA
    // proxy (one server key; no per-user Anthropic key), everyone else degrades to the
    // on-device model and then to a miss - the tiering policy in [[bwn-ai-tiering]]. No
    // direct Anthropic API call. The signature is preserved so the Client Update /
    // WO Audit / Recent / Next Steps / Over-30 call sites are unchanged. The proxy path
    // is buffered (single round-trip), so onStream is accepted for compatibility but not
    // driven; the modal's own progress estimate animates the wait. A total miss (no
    // manager rank AND no on-device model) surfaces as an error so callers show it
    // instead of a blank draft - the same contract the old direct path presented.
    function generate(systemPrompt, userContent, maxTokens, cb, onStream) {
      var cap = maxTokens || CFG.MAX_TOKENS;
      Promise.resolve().then(function () {
        return bwnAI({
          task: 'draft',
          system: systemPrompt,
          prompt: userContent,
          maxTokens: cap,
          oneLine: false,
          maxChars: Math.max(8000, cap * 8),   // never truncate a long draft
          timeoutMs: 60000                      // drafts via the proxy can exceed the 8s default
        });
      }).then(function (text) {
        text = String(text || '').trim();
        if (text) { cb(null, text); return; }
        cb(new Error('No draft was produced. Drafting rides the shared AI connector (manager tier), then the on-device model. Check the SWA ingest key or try again.'));
      }, function () {
        cb(new Error('No draft was produced. Try again.'));
      });
    }

    // ---- Review modal (BWN house style) ------------------------------------
    var STYLE_ID = 'bwn-cu-style';
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        '#bwn-cu-overlay{position:fixed;top:0;bottom:0;left:var(--bwn-dock-w,158px);z-index:100000;display:flex;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;animation:bwnFade .2s ease-out;}' +
        '@keyframes bwnFade{from{opacity:0}to{opacity:1}}' +
        '@keyframes bwnUp{from{transform:translateX(-14px);opacity:.4}to{transform:none;opacity:1}}' +
        '@keyframes bwnSpin{to{transform:rotate(360deg)}}' +
        '#bwn-cu-card{width:920px;max-width:calc(100vw - var(--bwn-dock-w,158px) - 8px);height:100%;display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:0 14px 14px 0;overflow:hidden;box-shadow:10px 0 34px rgba(13,38,26,.2);animation:bwnUp .18s ease-out;}' +
        '.bwn-cu-head{position:relative;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:18px 22px;display:flex;align-items:center;gap:14px;}' +
        '.bwn-cu-head::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,rgba(46,204,113,.5),transparent);}' +
        '.bwn-cu-head .t{font-weight:500;font-size:17px;line-height:1.15;letter-spacing:-.01em;}' +
        '.bwn-cu-head .s{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.7);margin-top:4px;}' +
        '.bwn-cu-tag{margin-left:auto;padding:5px 12px;border-radius:999px;font:600 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:.7px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;}' +
        '.bwn-cu-tag::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;}' +
        '.bwn-cu-tag.client{background:rgba(46,204,113,.18);color:var(--bwn-accent);border:1px solid rgba(46,204,113,.4);}' +
        '.bwn-cu-tag.audit{background:rgba(230,126,34,.18);color:var(--bwn-warn);border:1px solid rgba(230,126,34,.45);}' +
        '.bwn-cu-body{padding:20px 22px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:14px;}' +
        '.bwn-cu-spin{width:36px;height:36px;border:3px solid var(--bwn-tint);border-top-color:var(--bwn-green);border-radius:50%;animation:bwnSpin .7s linear infinite;margin:30px auto 10px;}' +
        '.bwn-cu-step{text-align:center;font-weight:500;color:var(--bwn-green-dk);font-size:14px;}' +
        '.bwn-cu-count{text-align:center;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-bottom:24px;min-height:15px;}' +
        '.bwn-cu-prog{width:78%;max-width:420px;height:8px;margin:30px auto 12px;background:var(--bwn-tint);border-radius:999px;overflow:hidden;}' +
        '.bwn-cu-prog>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--bwn-green),var(--bwn-accent));border-radius:999px;transition:width .25s cubic-bezier(.2,.8,.2,1);}' +
        '.bwn-cu-pct{text-align:center;font:500 13px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);margin-bottom:4px;}' +
        '.bwn-cu-stats{display:flex;gap:8px;flex-wrap:wrap;}' +
        '.bwn-cu-stat{padding:6px 12px;border-radius:999px;background:var(--bwn-surface-3);border:1px solid var(--bwn-border);font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-muted);letter-spacing:.2px;}' +
        '.bwn-cu-stat.ok{background:var(--bwn-tint);border-color:rgba(46,204,113,.35);color:var(--bwn-green);}' +
        '.bwn-cu-ta{width:100%;box-sizing:border-box;border:1px solid var(--bwn-border);border-radius:12px;padding:16px;min-height:280px;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;resize:vertical;outline:none;color:var(--bwn-text);background:var(--bwn-surface-2);transition:border-color .15s,box-shadow .15s,background .15s;}' +
        '.bwn-cu-ta:hover{border-color:var(--bwn-border);}' +
        '.bwn-cu-ta:focus{border-color:var(--bwn-accent);background:var(--bwn-surface);box-shadow:0 0 0 3px rgba(46,204,113,.16);}' +
        '.bwn-cu-meta{display:flex;justify-content:space-between;gap:12px;font:11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-cu-err{background:var(--bwn-bad-bg);color:var(--bwn-bad-fg);border-left:3px solid var(--bwn-bad);border-radius:10px;padding:13px 15px;font-size:13px;line-height:1.55;}' +
        '.bwn-cu-warn{background:var(--bwn-warn-bg);color:var(--bwn-warn-fg);border-left:3px solid var(--bwn-warn);border-radius:10px;padding:11px 14px;font-size:12.5px;line-height:1.5;}' +
        '.bwn-cu-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:14px 20px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-cu-btn{padding:9px 18px;border:none;border-radius:9px;cursor:pointer;font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;transition:filter .12s,transform .08s,box-shadow .12s;}' +
        '.bwn-cu-btn:hover{filter:brightness(1.05);}' +
        '.bwn-cu-btn:active{transform:translateY(1px);}' +
        '.bwn-cu-btn:disabled{opacity:.5;cursor:default;transform:none;}' +
        '.bwn-cu-btn.primary{color:#fff;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));box-shadow:0 2px 8px rgba(13,61,38,.25);}' +
        '.bwn-cu-btn.primary:hover{box-shadow:0 4px 14px rgba(13,61,38,.32);}' +
        '.bwn-cu-btn.ghost{color:var(--bwn-green);background:var(--bwn-tint);}' +
        '.bwn-cu-btn.ghost:hover{background:var(--bwn-tint);}' +
        '.bwn-cu-btn:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}' +
        '.bwn-cu-hint{margin-right:auto;font:11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-cu-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}' +
        '.bwn-cu-toolbar .bwn-cu-stats{flex:1;}' +
        '.bwn-cu-seg{display:inline-flex;background:var(--bwn-surface-3);border:1px solid var(--bwn-border);border-radius:9px;padding:2px;gap:2px;}' +
        '.bwn-cu-seg button{border:none;background:transparent;padding:5px 13px;border-radius:7px;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;text-transform:none;letter-spacing:.3px;color:var(--bwn-text-muted);cursor:pointer;transition:background .12s,color .12s,box-shadow .12s;}' +
        '.bwn-cu-seg button.on{background:var(--bwn-surface);color:var(--bwn-green);box-shadow:0 1px 3px rgba(13,38,26,.12);}' +
        '.bwn-cu-seg button:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}' +
        '.bwn-cu-note{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);display:flex;align-items:center;gap:7px;}' +
        '.bwn-cu-note::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--bwn-accent);flex:none;}' +
        '.bwn-cu-doc{flex:1;min-height:280px;overflow:auto;border:1px solid var(--bwn-border);border-radius:12px;padding:22px 26px;background:var(--bwn-surface-2);color:var(--bwn-text);font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-cu-doc>:first-child{margin-top:0;}' +
        '.bwn-cu-doc>:last-child{margin-bottom:0;}' +
        '.bwn-cu-doc p{margin:0 0 11px;}' +
        '.bwn-cu-doc strong{font-weight:500;color:var(--bwn-green-dk);}' +
        '.bwn-cu-doc em{font-style:italic;}' +
        '.bwn-cu-doc ul{margin:6px 0 13px;padding-left:6px;list-style:none;}' +
        '.bwn-cu-doc li{position:relative;margin:5px 0;padding-left:18px;}' +
        '.bwn-cu-doc li::before{content:"";position:absolute;left:3px;top:9px;width:5px;height:5px;border-radius:50%;background:var(--bwn-accent);}' +
        '.bwn-cu-doc hr{border:none;border-top:1px solid var(--bwn-border);margin:16px 0;}' +
        '.bwn-cu-h{font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green-dk);letter-spacing:-.01em;margin:18px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--bwn-border-2);}' +
        '.bwn-cu-doc>.bwn-cu-h:first-child{margin-top:0;}' +
        '.bwn-cu-title{font:600 18px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green-dk);letter-spacing:-.02em;margin:2px 0 2px;}' +
        '.bwn-cu-sub{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin:0 0 6px;letter-spacing:.2px;}' +
        '.bwn-cu-flag{position:relative;margin:6px 0;padding:10px 13px;background:var(--bwn-warn-bg);border:1px solid var(--bwn-warn-bg);border-left:3px solid var(--bwn-warn);border-radius:9px;font-size:13px;line-height:1.5;color:var(--bwn-warn-fg);}' +
        '.bwn-cu-flag.hot{background:var(--bwn-bad-bg);border-color:var(--bwn-bad-bg);border-left-color:var(--bwn-bad);color:var(--bwn-bad-fg);}' +
        '.bwn-cu-tl{display:flex;flex-direction:column;margin:6px 0 13px;border:1px solid var(--bwn-border);border-radius:10px;overflow:hidden;}' +
        '.bwn-cu-tlrow{display:grid;grid-template-columns:84px 1fr;gap:10px;padding:7px 12px;border-bottom:1px solid var(--bwn-surface-3);font-size:13px;line-height:1.45;}' +
        '.bwn-cu-tlrow:last-child{border-bottom:none;}' +
        '.bwn-cu-tlrow:nth-child(even){background:var(--bwn-surface-2);}' +
        '.bwn-cu-tldate{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);white-space:nowrap;padding-top:1px;}' +
        '.bwn-cu-tltext{color:var(--bwn-text-muted);min-width:0;}' +
        '.bwn-cu-tlrow.hot{background:var(--bwn-bad-bg);}' +
        '.bwn-cu-tlrow.hot .bwn-cu-tldate{color:var(--bwn-bad);}' +
        '.bwn-cu-ol{margin:6px 0 13px;padding-left:22px;}' +
        '.bwn-cu-ol li{margin:5px 0;padding-left:4px;line-height:1.5;}' +
        '.bwn-cu-ol li::marker{color:var(--bwn-green);font-weight:500;}' +
        '.nd-title{font:600 21px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green-dk);letter-spacing:-.02em;margin:0 0 3px;}' +
        '.nd-sub{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);letter-spacing:.2px;margin:0 0 16px;}' +
        '.nd-h{display:flex;align-items:center;gap:10px;margin:26px 0 12px;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);text-transform:none;letter-spacing:normal;}' +
        '.nd-h::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--bwn-tint),transparent);}' +
        '.bwn-cu-doc>.nd-h:first-child{margin-top:0;}' +
        '.bwn-cu-doc>.nd-title:first-child{margin-top:0;}' +
        '.nd-status{background:linear-gradient(135deg,var(--bwn-tint),var(--bwn-tint));border:1px solid var(--bwn-border);border-left:4px solid var(--bwn-accent);border-radius:10px;padding:13px 16px;margin:0 0 6px;font-size:14px;line-height:1.55;color:var(--bwn-text);}' +
        '.nd-flag{display:grid;grid-template-columns:26px 1fr;gap:11px;align-items:start;margin:8px 0;padding:11px 14px;background:var(--bwn-warn-bg);border:1px solid var(--bwn-warn-bg);border-left:3px solid var(--bwn-warn);border-radius:10px;font-size:13.5px;line-height:1.5;color:var(--bwn-warn-fg);}' +
        '.nd-flag .fn{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-warn-fg);background:var(--bwn-warn-bg);border-radius:6px;width:26px;height:22px;display:flex;align-items:center;justify-content:center;}' +
        '.nd-flag.hot{background:var(--bwn-bad-bg);border-color:var(--bwn-bad-bg);border-left-color:var(--bwn-bad);color:var(--bwn-bad-fg);}' +
        '.nd-flag.hot .fn{color:#fff;background:var(--bwn-bad);}' +
        '.nd-vend{display:grid;grid-template-columns:1fr 118px;gap:14px;align-items:start;margin:8px 0;padding:12px 15px;background:var(--bwn-surface);border:1px solid var(--bwn-tint);border-radius:10px;}' +
        '.nd-vend .vn-main{min-width:0;}' +
        '.nd-vend .vn-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;}' +
        '.nd-vend .vn-name{font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green-dk);}' +
        '.nd-vend .vn-role{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);background:var(--bwn-tint);border:1px solid var(--bwn-border);border-radius:999px;padding:2px 9px;letter-spacing:.2px;}' +
        '.nd-vend .vn-people{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin:3px 0 0;}' +
        '.nd-vend .vn-det{list-style:none;margin:8px 0 0;padding:0;}' +
        '.nd-vend .vn-det li{position:relative;padding-left:15px;margin:3px 0;font-size:13px;line-height:1.45;color:var(--bwn-text-muted);}' +
        '.nd-vend .vn-det li::before{content:"";position:absolute;left:2px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--bwn-accent);}' +
        '.nd-vend .vn-det li strong{color:var(--bwn-green-dk);}' +
        '.nd-vend .vn-money{display:flex;flex-direction:column;gap:4px;align-items:flex-end;border-left:1px solid var(--bwn-border-2);padding-left:12px;}' +
        '.nd-vend .vn-amt{font:500 13px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);white-space:nowrap;}' +
        '.nd-vend .vn-amt.none{color:var(--bwn-text-faint);font-weight:500;}' +
        '.nd-tl{display:flex;flex-direction:column;margin:8px 0 14px;border:1px solid var(--bwn-border);border-radius:11px;overflow:hidden;}' +
        '.nd-tlrow{display:grid;grid-template-columns:108px 1fr;gap:14px;padding:8px 14px;border-bottom:1px solid var(--bwn-surface-3);font-size:13.5px;line-height:1.45;}' +
        '.nd-tlrow:last-child{border-bottom:none;}' +
        '.nd-tlrow:nth-child(even){background:var(--bwn-surface-2);}' +
        '.nd-tldate{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);white-space:nowrap;padding-top:1px;}' +
        '.nd-tltext{color:var(--bwn-text-muted);min-width:0;}' +
        '.nd-tlrow.hot{background:var(--bwn-bad-bg);}' +
        '.nd-tlrow.hot .nd-tldate{color:var(--bwn-bad);}' +
        '.nd-ol{margin:6px 0 14px;padding-left:0;list-style:none;counter-reset:nd;}' +
        '.nd-ol li{position:relative;counter-increment:nd;padding:5px 0 5px 34px;line-height:1.5;border-bottom:1px solid var(--bwn-surface-3);}' +
        '.nd-ol li:last-child{border-bottom:none;}' +
        '.nd-ol li::before{content:counter(nd);position:absolute;left:0;top:5px;width:22px;height:22px;border-radius:7px;background:var(--bwn-tint);color:var(--bwn-green);font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;display:flex;align-items:center;justify-content:center;}' +
        '.nd-ul{margin:6px 0 14px;padding-left:4px;list-style:none;}' +
        '.nd-ul li{position:relative;margin:5px 0;padding-left:18px;line-height:1.5;}' +
        '.nd-ul li::before{content:"";position:absolute;left:3px;top:9px;width:5px;height:5px;border-radius:50%;background:var(--bwn-accent);}' +
        '.nd-table{width:100%;border-collapse:collapse;margin:8px 0 12px;font-size:11px;}' +
        '.nd-table th{text-align:left;background:var(--bwn-surface-3);color:var(--bwn-green);font:500 9.5px ui-monospace,"Segoe UI Mono","SF Mono",monospace;text-transform:none;letter-spacing:normal;padding:6px 9px;border:1px solid var(--bwn-tint);}' +
        '.nd-table td{padding:6px 9px;border:1px solid var(--bwn-tint);vertical-align:top;}' +
        '.nd-table tr:nth-child(even) td{background:var(--bwn-surface-2);}' +
        '@media (prefers-reduced-motion: reduce){#bwn-cu-overlay,#bwn-cu-card{animation:none;}.bwn-cu-spin{animation-duration:1.2s;}.bwn-cu-btn:active{transform:none;}}';
      document.head.appendChild(st);
    }

    // ---- Lightweight markdown rendering (safe DOM, no innerHTML) ----------
    // Handles the subset the model emits: **bold**, *italic*, whole-line-bold
    // headings, # headings, - / * / \u2022 bullets, and --- dividers.
    function mdInline(parent, text) {
      var re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_)/g, m, last = 0;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
        var bold = m[2] !== undefined;
        var node = document.createElement(bold ? 'strong' : 'em');
        node.textContent = bold ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
        parent.appendChild(node);
        last = m.index + m[0].length;
      }
      if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
    }
    function renderMarkdown(container, src) {
      while (container.firstChild) container.removeChild(container.firstChild);
      var lines = (src || '').replace(/\r/g, '').split('\n');
      var ul = null, ol = null, tl = null, first = true, section = 'other', flagN = 0;
      var HOT_FLAG = /\b(escalat|overdue|unpaid|halt|cannot|breach|urgent|immediately|lien|default|stop work)\b/i;
      var HOT_TL = /\b(escalat|halt|hospital|accident|overdue|dispute|rejected|cancel|lawsuit|lien)\b/i;
      function flushUl() { if (ul) { container.appendChild(ul); ul = null; } }
      function flushOl() { if (ol) { container.appendChild(ol); ol = null; } }
      function flushTl() { if (tl) { container.appendChild(tl); tl = null; } }
      function flushAll() { flushUl(); flushOl(); flushTl(); }
      function addP(txt, cls) { var p = document.createElement('p'); if (cls) p.className = cls; mdInline(p, txt); container.appendChild(p); }
      function heading(txt) { flushAll(); var hd = document.createElement('div'); hd.className = 'nd-h'; hd.textContent = txt.replace(/\*\*/g, '').replace(/:\s*$/, '').trim(); container.appendChild(hd); }
      function capsLabel(s) { var core = s.replace(/\([^)]*\)/g, ''); return (core.match(/[a-z]/g) || []).length <= 1 && /[A-Z]/.test(core); }
      function sectionOf(label) { var L = label.toUpperCase(); if (/RISK FLAG/.test(L)) return 'flags'; if (/VENDOR|SUPPLIER/.test(L)) return 'vendors'; if (/TIMELINE/.test(L)) return 'timeline'; if (/NEXT ACTION/.test(L)) return 'actions'; if (/BLOCK|REMAIN|DONE SO FAR/.test(L)) return 'list'; if (/STATUS/.test(L)) return 'status'; return 'other'; }
      function flagCard(txt) { flushAll(); txt = txt.replace(/^\s*(?:\d+[\.\)]|[\u2022\-*])\s*/, '').replace(/^FLAG\s*[:\-\u2014]\s*/i, ''); flagN++; var card = document.createElement('div'); card.className = 'nd-flag' + (HOT_FLAG.test(txt) ? ' hot' : ''); var n = document.createElement('span'); n.className = 'fn'; n.textContent = flagN; var body = document.createElement('span'); mdInline(body, txt.replace(/\bFLAG:\s*/gi, '')); card.appendChild(n); card.appendChild(body); container.appendChild(card); }
      function vendorCard(line) {
        flushAll();
        var segs = line.split(/\s+\u2014\s+/);
        var nameRaw = segs[0] || line, people = '', name = nameRaw, role = '', detail = '';
        var pm = nameRaw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
        if (pm) { name = pm[1].trim(); people = pm[2].trim(); }
        if (segs.length >= 3) { role = segs[1].trim(); detail = segs.slice(2).join(' \u2014 '); }
        else { detail = segs.slice(1).join(' \u2014 '); }
        var money = [], seen = {}, mm, mre = /\$[\d,]+(?:\.\d+)?\s?[KkMm]?/g;
        while ((mm = mre.exec(line)) !== null) { var v = mm[0].replace(/\s+/g, ''); if (!seen[v]) { seen[v] = 1; money.push(v); } }
        var card = document.createElement('div'); card.className = 'nd-vend';
        var main = document.createElement('div'); main.className = 'vn-main';
        var headEl = document.createElement('div'); headEl.className = 'vn-head';
        var nm = document.createElement('span'); nm.className = 'vn-name'; nm.textContent = name; headEl.appendChild(nm);
        if (role) { var rl = document.createElement('span'); rl.className = 'vn-role'; rl.textContent = role; headEl.appendChild(rl); }
        main.appendChild(headEl);
        if (people) { var pe = document.createElement('div'); pe.className = 'vn-people'; pe.textContent = people; main.appendChild(pe); }
        var parts = detail.split(/;\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
        if (parts.length) { var dl = document.createElement('ul'); dl.className = 'vn-det'; parts.forEach(function (p) { var li = document.createElement('li'); mdInline(li, p); dl.appendChild(li); }); main.appendChild(dl); }
        card.appendChild(main);
        var moneyEl = document.createElement('div'); moneyEl.className = 'vn-money';
        if (money.length) { money.forEach(function (v) { var s = document.createElement('span'); s.className = 'vn-amt'; s.textContent = v; moneyEl.appendChild(s); }); }
        else { var dash = document.createElement('span'); dash.className = 'vn-amt none'; dash.textContent = '\u2014'; moneyEl.appendChild(dash); }
        card.appendChild(moneyEl);
        container.appendChild(card);
      }
      function isTableRow(s) { return /^\|/.test(s) && (s.match(/\|/g) || []).length >= 2; }
      function isSep(c) { return /-/.test(c) && /^[\s:|-]+$/.test(c); }
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t) { flushAll(); continue; }
        if (isTableRow(t)) {
          flushAll();
          var rows = [], jj = i;
          while (jj < lines.length && isTableRow(lines[jj].trim())) {
            var p = lines[jj].trim().split('|'); if (p.length && p[0].trim() === '') p.shift(); if (p.length && p[p.length - 1].trim() === '') p.pop();
            rows.push(p.map(function (x) { return x.trim(); })); jj++;
          }
          var dataRows = rows.filter(function (rw) { return !(rw.length > 0 && rw.every(isSep)); });
          var head = dataRows.length ? dataRows[0] : null;
          var table = document.createElement('table'); table.className = 'nd-table';
          if (head) { var trh = document.createElement('tr'); head.forEach(function (c) { var th = document.createElement('th'); th.textContent = c; trh.appendChild(th); }); table.appendChild(trh); }
          for (var k = 1; k < dataRows.length; k++) {
            var tr = document.createElement('tr');
            dataRows[k].forEach(function (c) {
              var td = document.createElement('td');
              td.textContent = c;
              tr.appendChild(td);
            });
            table.appendChild(tr);
          }
          container.appendChild(table); i = jj - 1; continue;
        }
        if (first) { first = false; flushAll(); var ttl = document.createElement('div'); ttl.className = 'nd-title'; ttl.textContent = t.replace(/\*\*/g, ''); container.appendChild(ttl); continue; }
        if (/\|/.test(t) || /tracking #|internal use only/i.test(t)) { flushAll(); addP(t, 'nd-sub'); continue; }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushAll(); container.appendChild(document.createElement('hr')); continue; }
        var hm = t.match(/^#{1,6}\s+(.*)$/);
        var wb = t.match(/^\*\*([^*]+)\*\*$/);
        var lc = t.match(/^([A-Z0-9][A-Z0-9 .,'\/&()\-]{2,46}?):\s*(.*)$/);
        if (hm || wb || (lc && capsLabel(lc[1]))) {
          var label = hm ? hm[1] : wb ? wb[1] : lc[1];
          heading(label); section = sectionOf(label); flagN = 0;
          if (lc && lc[2] && lc[2].trim()) { if (section === 'status') { var cb = document.createElement('div'); cb.className = 'nd-status'; mdInline(cb, lc[2].trim()); container.appendChild(cb); } else addP(lc[2].trim()); }
          continue;
        }
        if (section === 'vendors') { vendorCard(t); continue; }
        if (section === 'flags') { flagCard(t); continue; }
        var dm = t.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:[\u2013\-]\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?)\s+[\u2014\u2013\-]\s+(.*)$/);
        if (dm) { flushUl(); flushOl(); if (!tl) { tl = document.createElement('div'); tl.className = 'nd-tl'; } var row = document.createElement('div'); row.className = 'nd-tlrow' + (HOT_TL.test(dm[2]) ? ' hot' : ''); var ds = document.createElement('span'); ds.className = 'nd-tldate'; ds.textContent = dm[1]; var tx = document.createElement('span'); tx.className = 'nd-tltext'; mdInline(tx, dm[2]); row.appendChild(ds); row.appendChild(tx); tl.appendChild(row); continue; }
        flushTl();
        var nm2 = t.match(/^(\d+)[\.\)]\s+(.*)$/);
        if (nm2) { flushUl(); if (!ol) { ol = document.createElement('ol'); ol.className = 'nd-ol'; } var oli = document.createElement('li'); mdInline(oli, nm2[2]); ol.appendChild(oli); continue; }
        flushOl();
        var bm = t.match(/^([\u2022\-*])\s+(.*)$/);
        if (bm || section === 'list') { if (!ul) { ul = document.createElement('ul'); ul.className = 'nd-ul'; } var bli = document.createElement('li'); mdInline(bli, bm ? bm[2] : t); ul.appendChild(bli); continue; }
        flushUl();
        addP(t);
      }
      flushAll();
    }
    // Strip markdown for clipboard: clean text suitable for email / WO notes.
    function stripMarkdown(src) {
      return (src || '').replace(/\r/g, '').split('\n').map(function (line) {
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return '';
        var t = line.replace(/^\s*#{1,6}\s+/, '');
        t = t.replace(/^\s*[-*\u2022]\s+/, '\u2022 ');
        t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
        t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
        t = t.replace(/_([^_]+)_/g, '$1');
        return t.replace(/[ \t]+$/, '');
      }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function modal(mode, h) {
      ensureStyle();
      var old = document.getElementById('bwn-cu-overlay');
      if (old) old.remove();

      // Claim the shared drawer slot so whatever tool is open folds away first.
      try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: 'clientupdate' } })); } catch (e) { }
      var wrap = document.createElement('div'); wrap.id = 'bwn-cu-overlay';
      var card = document.createElement('div'); card.id = 'bwn-cu-card';

      var head = document.createElement('div'); head.className = 'bwn-cu-head';
      var hl = document.createElement('div');
      var t = document.createElement('div'); t.className = 't'; t.textContent = mode.name;
      hl.appendChild(t);
      var subText = [h && h.wo ? 'WO ' + h.wo : '', h && h.tracking ? h.tracking : '', h && h.status ? h.status : '']
        .filter(Boolean).join('  \u00b7  ');
      if (subText) {
        var s = document.createElement('div'); s.className = 's'; s.textContent = subText;
        hl.appendChild(s);
      }
      var tag = document.createElement('span');
      tag.className = 'bwn-cu-tag ' + (mode.scrub ? 'client' : 'audit');
      tag.textContent = mode.scrub ? 'CLIENT-SAFE' : 'INTERNAL ONLY';
      head.appendChild(hl); head.appendChild(tag);

      var body = document.createElement('div'); body.className = 'bwn-cu-body';
      var foot = document.createElement('div'); foot.className = 'bwn-cu-foot';

      card.appendChild(head); card.appendChild(body); card.appendChild(foot);
      wrap.appendChild(card);

      var releaseA11y = null;
      function close() {
        cancelEst();
        document.removeEventListener('keydown', onKey);
        if (releaseA11y) { releaseA11y(); releaseA11y = null; }
        wrap.remove();
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
      document.body.appendChild(wrap);
      releaseA11y = bwnA11yDialog(card, { label: mode.name + ' draft - review before sending', modal: true });

      function btn(label, primary, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'bwn-cu-btn ' + (primary ? 'primary' : 'ghost');
        b.textContent = label;
        b.addEventListener('click', fn);
        return b;
      }
      function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

      var stepEl = null, countEl = null, progFillEl = null, pctEl = null;
      var progVal = 0, progTimer = 0;
      function cancelEst() { if (progTimer) { clearInterval(progTimer); progTimer = 0; } }
      function paintProg(p) {
        progVal = Math.max(0, Math.min(100, p));
        if (progFillEl) progFillEl.style.width = progVal.toFixed(1) + '%';
        if (pctEl) pctEl.textContent = Math.round(progVal) + '%';
      }
      var api = {
        loading: function (step, count) {
          if (!stepEl || !document.getElementById('bwn-cu-overlay')) {
            clear(body); clear(foot);
            pctEl = document.createElement('div'); pctEl.className = 'bwn-cu-pct'; pctEl.textContent = '0%';
            var track = document.createElement('div'); track.className = 'bwn-cu-prog';
            progFillEl = document.createElement('i'); track.appendChild(progFillEl);
            stepEl = document.createElement('div'); stepEl.className = 'bwn-cu-step';
            countEl = document.createElement('div'); countEl.className = 'bwn-cu-count';
            body.appendChild(pctEl); body.appendChild(track); body.appendChild(stepEl); body.appendChild(countEl);
            foot.appendChild(btn('Cancel', false, close));
          }
          stepEl.textContent = step;
          countEl.textContent = count || '';
        },
        setProgress: function (p) { cancelEst(); paintProg(p); },
        estimate: function (toPct, ms) {
          cancelEst();
          var from = progVal, span = toPct - from, t0 = Date.now();
          if (span <= 0 || ms <= 0) { paintProg(toPct); return; }
          progTimer = setInterval(function () {
            if (!document.getElementById('bwn-cu-overlay')) { cancelEst(); return; }
            var k = Math.min(1, (Date.now() - t0) / ms);
            paintProg(Math.max(progVal, from + span * (1 - Math.pow(1 - k, 3))));
            if (k >= 1) cancelEst();
          }, 180);
        },
        finishProgress: function () { cancelEst(); paintProg(100); },
        streamProgress: function (pct, count) { paintProg(Math.max(progVal, pct)); if (count != null && countEl) countEl.textContent = count; },
        // Preflight (v1.35): show exactly which notes will be sent and what the
        // input costs BEFORE the paid call; untick notes to leave them out.
        preflight: function (mode2, keepNotes, stats, buildContent, onGo) {
          stepEl = null; cancelEst();
          clear(body); clear(foot);
          var bar = document.createElement('div'); bar.className = 'bwn-cu-stats';
          function chip2(label, ok) { var c = document.createElement('span'); c.className = 'bwn-cu-stat' + (ok ? ' ok' : ''); c.textContent = label; bar.appendChild(c); }
          chip2(stats.used + ' note' + (stats.used === 1 ? '' : 's') + ' collected', true);
          if (stats.excluded) chip2(stats.excluded + ' excluded');
          chip2(stats.total + ' total on WO');
          body.appendChild(bar);
          var note2 = document.createElement('div'); note2.className = 'bwn-cu-note';
          note2.textContent = 'Preflight - untick notes to leave them out, then Generate.';
          body.appendChild(note2);
          var list = document.createElement('div');
          list.style.cssText = 'flex:1;min-height:200px;overflow:auto;border:1px solid var(--bwn-border);border-radius:12px;background:var(--bwn-surface-2);padding:4px 8px;';
          var checks = [];
          keepNotes.forEach(function (n) {
            var row = document.createElement('label');
            row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:6px 4px;border-bottom:1px solid var(--bwn-border-2);cursor:pointer;font:12.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-text);';
            var cb2 = document.createElement('input'); cb2.type = 'checkbox'; cb2.checked = true;
            cb2.style.cssText = 'margin-top:2px;accent-color:var(--bwn-green);flex:none;';
            var tx = document.createElement('span');
            tx.style.cssText = 'min-width:0;';
            var head2 = document.createElement('span');
            head2.style.cssText = 'display:block;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);';
            head2.textContent = (n.ts || 'date n/a') + (n.label ? ' · ' + n.label : '');
            var bodyTx = document.createElement('span');
            bodyTx.style.cssText = 'display:block;';
            var bt = (n.body || '').replace(/\s+/g, ' ');
            var long2 = bt.length > 110;
            function renderBody(expanded) { bodyTx.textContent = (expanded || !long2) ? bt : bt.slice(0, 110) + '…'; }
            renderBody(false);
            tx.appendChild(head2); tx.appendChild(bodyTx);
            // Full bodies ARE captured and sent to the model - the 110-char cap here is
            // display-only. This lets the coordinator verify a row is complete without
            // leaving the modal. The row is a <label>, so the toggle MUST preventDefault
            // + stopPropagation, otherwise clicking it flips the note's checkbox.
            if (long2) {
              var more = document.createElement('span');
              more.style.cssText = 'display:inline-block;margin-top:2px;font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);cursor:pointer;user-select:none;';
              var expanded2 = false;
              more.textContent = '▾ show full note';
              more.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                expanded2 = !expanded2; renderBody(expanded2);
                more.textContent = expanded2 ? '▴ show less' : '▾ show full note';
              });
              tx.appendChild(more);
            }
            cb2.addEventListener('change', updateEst);
            row.appendChild(cb2); row.appendChild(tx);
            list.appendChild(row);
            checks.push(cb2);
          });
          body.appendChild(list);
          var meta2 = document.createElement('div'); meta2.className = 'bwn-cu-meta';
          var estEl = document.createElement('span');
          var capEl = document.createElement('span');
          capEl.textContent = 'output cap ' + mode2.maxTokens + ' tok';
          meta2.appendChild(estEl); meta2.appendChild(capEl);
          body.appendChild(meta2);
          var exact = null;   // count_tokens result for the FULL selection
          function selected() { return keepNotes.filter(function (n2, i2) { return checks[i2].checked; }); }
          function updateEst() {
            var sel = selected();
            var est = Math.round(buildContent(sel).length / 3.6);
            var allOn = sel.length === keepNotes.length;
            estEl.textContent = sel.length + ' of ' + keepNotes.length + ' notes → ' +
              (allOn && exact !== null ? exact + ' input tokens (exact)' : '~' + est + ' input tokens');
          }
          updateEst();
          // The exact input-token count (a free count_tokens call) was retired with the
          // direct Anthropic key path (TASK-014); the preflight shows the char estimate.
          foot.appendChild(btn('Cancel', false, close));
          foot.appendChild(btn('Generate', true, function () {
            // An empty selection is a valid generation (the prompt states "no
            // update on record") - the button must never be a silent no-op.
            onGo(selected());
          }));
        },
        result: function (text, stats, regenFn, note, refineFn, warns) {
          stepEl = null; cancelEst();
          clear(body); clear(foot);

          // Toolbar: stat chips + Preview / Edit segmented toggle
          var toolbar = document.createElement('div'); toolbar.className = 'bwn-cu-toolbar';
          var row = document.createElement('div'); row.className = 'bwn-cu-stats';
          function stat(label, ok) {
            var c = document.createElement('span');
            c.className = 'bwn-cu-stat' + (ok ? ' ok' : '');
            c.textContent = label;
            row.appendChild(c);
          }
          stat(stats.used + ' note' + (stats.used === 1 ? '' : 's') + ' used', true);
          if (stats.excluded) stat(stats.excluded + ' excluded');
          stat(stats.total + ' total on WO');
          toolbar.appendChild(row);
          var seg = document.createElement('div'); seg.className = 'bwn-cu-seg';
          var bPrev = document.createElement('button'); bPrev.type = 'button'; bPrev.textContent = 'Preview';
          var bEdit = document.createElement('button'); bEdit.type = 'button'; bEdit.textContent = 'Edit';
          seg.appendChild(bPrev); seg.appendChild(bEdit);
          toolbar.appendChild(seg);
          body.appendChild(toolbar);

          // Refine row: one-click re-prompts on the CURRENT draft (no re-collect, no re-scroll).
          if (refineFn) {
            var refRow = document.createElement('div');
            refRow.style.cssText = 'display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:-2px 0 2px;';
            var rl = document.createElement('span'); rl.textContent = 'Refine';
            rl.style.cssText = 'font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);';
            refRow.appendChild(rl);
            [['shorter', 'Shorter'], ['longer', 'Longer'], ['tighten', 'Tighten'], ['firmer', 'Firmer']].forEach(function (rr) {
              var rb = document.createElement('button'); rb.type = 'button'; rb.textContent = rr[1];
              rb.style.cssText = 'padding:4px 11px;border:1px solid var(--bwn-border);border-radius:8px;cursor:pointer;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;text-transform:none;color:var(--bwn-green);background:var(--bwn-tint);';
              rb.addEventListener('click', function () { refineFn(rr[0], ta.value); });
              refRow.appendChild(rb);
            });
            body.appendChild(refRow);
          }

          // Optional context note \u2014 shown above the draft, not included in the copy.
          if (note && String(note).trim()) {
            var nt = document.createElement('div'); nt.className = 'bwn-cu-note';
            nt.textContent = String(note).trim();
            body.appendChild(nt);
          }

          // Output safety net (client mode): flag anything that slipped past the
          // scrub + prompt rules so it gets edited out during review.
          if (warns && warns.length) {
            var wv = document.createElement('div'); wv.className = 'bwn-cu-warn';
            wv.textContent = '\u26a0 Review: this draft still contains ' + warns.join(', ') +
              ' \u2014 client-safe drafts must not include these. Edit before sending.';
            body.appendChild(wv);
          }

          // Rendered (preview) + raw (edit) views over one source of truth (ta.value)
          var doc = document.createElement('div'); doc.className = 'bwn-cu-doc';
          var ta = document.createElement('textarea'); ta.className = 'bwn-cu-ta'; ta.value = text;
          ta.style.display = 'none';
          body.appendChild(doc); body.appendChild(ta);

          var meta = document.createElement('div'); meta.className = 'bwn-cu-meta';
          var lenEl = document.createElement('span');
          var srcEl = document.createElement('span');
          // Token line only for a FRESH generation \u2014 a cached draft made no API call
          // this open, and module-global lastUsage may belong to another WO/mode.
          var freshGen = !/saved draft/.test(String(note || ''));
          srcEl.textContent = (mode.scrub ? 'amounts \u00b7 contacts \u00b7 vendors redacted at source' : 'full internal detail') +
            (lastUsage && freshGen ? ' \u00b7 ' + lastUsage.input + ' in / ' + lastUsage.output + ' out tok' : '') + ' \u00b7 prompt v' + PROMPT_V;
          function updateLen() {
            var words = (ta.value.trim().match(/\S+/g) || []).length;
            lenEl.textContent = words + ' words \u00b7 ' + ta.value.length + ' chars';
          }
          meta.appendChild(lenEl); meta.appendChild(srcEl);
          body.appendChild(meta);

          function setView(v) {
            var preview = v !== 'edit';
            if (preview) renderMarkdown(doc, ta.value);
            doc.style.display = preview ? '' : 'none';
            ta.style.display = preview ? 'none' : '';
            bPrev.className = preview ? 'on' : '';
            bEdit.className = preview ? '' : 'on';
            if (!preview) ta.focus();
          }
          bPrev.addEventListener('click', function () { setView('preview'); });
          bEdit.addEventListener('click', function () { setView('edit'); });
          ta.addEventListener('input', updateLen);
          updateLen();
          setView('preview');

          var hint = document.createElement('span');
          hint.className = 'bwn-cu-hint';
          hint.textContent = 'Draft only \u2014 review before sending';
          foot.appendChild(hint);
          if (regenFn) {
            var rgBtn = btn('Regenerate', false, function (e) { regenFn(!!(e && e.shiftKey)); });
            rgBtn.title = 'Redraft. Shift-click: also re-collect the notes fresh (bypasses the shared scan cache).';
            foot.appendChild(rgBtn);
          }
          if (mode.noteType) {
            // "Add as <Type> note": hand the generated text to Core's composer bridge, which opens
            // Umbrava's Add Note composer prefilled and sets the Type autocomplete (e.g. Recap).
            // The coordinator still reviews + Saves in Umbrava (attribution stays theirs).
            var noteBtn = btn('Add as ' + mode.noteType + ' note', true, function () {
              try { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'core:insertnote', text: stripMarkdown(ta.value), noteType: mode.noteType } })); } catch (e) { }
              noteBtn.textContent = 'Opening note...'; noteBtn.disabled = true;
              setTimeout(close, 600);
            });
            noteBtn.title = "Open Umbrava's Add Note composer prefilled with this + set Type to " + mode.noteType + ", then review + Save there. (Also copied to clipboard as a fallback.)";
            foot.appendChild(noteBtn);
          }
          var copyBtn = btn('Copy', true, function () {
            GM_setClipboard(stripMarkdown(ta.value));   // clean text \u2014 no markdown markers
            copyBtn.textContent = 'Copied \u2713';
            copyBtn.disabled = true;
            setTimeout(close, 700);
          });
          foot.appendChild(copyBtn);
          foot.appendChild(btn('Close', false, close));
        },
        error: function (msg) {
          stepEl = null; cancelEst();
          clear(body); clear(foot);
          var e = document.createElement('div'); e.className = 'bwn-cu-err';
          e.textContent = msg;
          body.appendChild(e);
          foot.appendChild(btn('Close', false, close));
        },
        close: close
      };
      return api;
    }

    // ---- Main action ------------------------------------------------------
    // ---- Refine presets: post-generation re-prompts on the current draft --
    var REFINE = {
      shorter: { label: 'Shorter', directive: 'Make it noticeably shorter and more concise - cut secondary detail but keep the current status, any flags, and the next steps.' },
      longer: { label: 'Longer', directive: 'Expand with more of the relevant operational detail already implied by the draft; do not introduce new facts.' },
      tighten: { label: 'Tighten', directive: 'Tighten the wording - remove filler and redundancy and sharpen each line - at roughly the same length.' },
      firmer: { label: 'Firmer', directive: 'Make the tone firmer and more direct while staying professional: clearer asks and more urgency on outstanding items.' }
    };

    // ---- Draft cache (per WO + mode, this browser tab only) ---------------
    // A generated draft is cached so reopening the same mode on the same WO is
    // instant and free (no re-scroll, no API call). Regenerate forces a fresh
    // collect + draft. sessionStorage = clears when the tab closes, so a draft
    // never goes stale across sessions.
    function draftCacheKey(mode) {
      var id = bwnWOId() || location.pathname;
      return 'bwn_draft_' + id + '_' + mode.name.replace(/\s+/g, '');
    }
    function draftCacheSet(mode, text, stats, note) {
      try { sessionStorage.setItem(draftCacheKey(mode), JSON.stringify({ text: text, stats: stats, note: note || '', ts: Date.now(), promptV: PROMPT_V })); } catch (e) { /* quota: non-fatal */ }
    }
    function draftCacheGet(mode) {
      try {
        var raw = sessionStorage.getItem(draftCacheKey(mode));
        if (!raw) return null;
        var d = JSON.parse(raw);
        // promptV gate: a draft generated under an older prompt pack must not
        // resurface as a "saved draft" after the prompts change.
        return (d && d.text && d.stats && d.promptV === PROMPT_V) ? d : null;
      } catch (e) { return null; }
    }
    function draftAge(ts) {
      var mins = Math.round((Date.now() - (ts || 0)) / 60000);
      return mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : mins < 60 ? mins + ' min ago' : Math.round(mins / 60) + 'h ago';
    }

    // ---- Output safety net (client mode) -----------------------------------
    // Input is scrubbed and the prompt forbids internal data, but the finished
    // draft is checked once more before display; hits render as a review warning.
    function outputLeakCheck(text, vendors) {
      var hits = [], t = text || '';
      if (/\$\s*\d/.test(t)) hits.push('a dollar amount');
      if (/[\w.+-]+@[\w.-]+\.\w{2,}/.test(t)) hits.push('an email address');
      if (/(\+?1[\s.-]?)?\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}|\b\d{3}[.-]\d{3}[.-]\d{4}\b/.test(t)) hits.push('a phone number');
      var up = t.toUpperCase();
      vendors.forEach(function (v) {
        if (v && v.length >= 4 && up.indexOf(v.toUpperCase()) !== -1) hits.push('vendor name "' + v + '"');
      });
      return hits;
    }

    function run(mode) {
      var h = getHeader();
      var vendors = vendorNames();
      var m = modal(mode, h);
      var runWO = bwnWOId() || location.pathname;   // the WO this run belongs to

      // Render the draft, (re)cache it, and wire the Refine actions. refineFn re-prompts
      // on the CURRENT (possibly hand-edited) text \u2014 one quick pass, no re-collect. The
      // BASE note is cached; displayNote (with the "saved draft" stamp) is shown only.
      function showResult(text, stats, note, regenFn, displayNote) {
        // The API stream can outlive a navigation: draftCacheKey derives the WO id
        // at WRITE time, so a draft finishing after a WO switch would cache WO A's
        // text under WO B. Never cache or present a draft under a different WO.
        if ((bwnWOId() || location.pathname) !== runWO) {
          m.error('The page changed while drafting - this draft belonged to a different work order and was discarded. Reopen AI Draft on the WO you want.');
          return;
        }
        draftCacheSet(mode, text, stats, note);
        var warns = mode.scrub ? outputLeakCheck(text, vendors) : [];
        m.result(text, stats, regenFn, displayNote || note, function (key, cur) { refineRun(key, cur, stats, note, regenFn); }, warns);
      }
      function refineRun(key, cur, stats, note, regenFn) {
        var instr = REFINE[key];
        if (!instr || !cur || !cur.trim()) return;
        m.loading('Refining \u2014 ' + instr.label + '\u2026', 'one quick pass');
        m.estimate(92, Math.max(6000, mode.maxTokens * 4));
        var sys = 'You revise an existing draft for a facilities maintenance work order. ' + instr.directive +
          ' Keep the SAME format and section structure, keep every fact (invent nothing), and output ONLY the revised text \u2014 no preamble or commentary.';
        if (mode.scrub) sys += ' This is a CLIENT-FACING update: never introduce dollar amounts, pricing, markup, vendor/contractor company names, personal contacts, or internal commentary.';
        var maxT = (key === 'longer') ? Math.round(mode.maxTokens * 1.4) : mode.maxTokens;   // Longer needs headroom or it truncates against the same cap
        var expChars = Math.max(400, maxT * 3.5);
        generate(sys, 'DRAFT TO REVISE:\n\n' + cur, maxT, function (err, text) {
          if (err) { m.error(err.message); return; }
          m.finishProgress();
          showResult(text, stats, note, regenFn);
        }, function (soFar) {
          var words = (soFar.trim().match(/\S+/g) || []).length;
          m.streamProgress(Math.min(95, 20 + 75 * soFar.length / expChars), words + ' words\u2026');
        });
      }

      function startCollect(forceFresh) {
        m.loading('Collecting the full note history\u2026', 'one API read - scroll sweep only if that fails');
        m.estimate(25, 6000);
        collectAllNotes(
          function (n) { m.loading('Collecting the full note history\u2026', n + ' notes loaded'); },
          function (store, fromCache) {
            var res = processNotes(store, vendors, mode);
            // windowDays on the mode is a FLAG; the actual day count is a knob
            // (Ops panel → bwn:config.ai.windowDays, default 7).
            var win = mode.windowDays ? aiCfg().windowDays : 0;
            var keep = res.keep, unknownDates = 0, droppedOld = 0;
            if (win) {
              keep = res.keep.filter(function (n) {
                var w = withinDays(n.ts, win);
                if (w === null) { unknownDates++; return true; }   // unreadable date: keep, but surface the count
                if (!w) { droppedOld++; return false; }
                return true;
              });
            }
            var stats = { used: keep.length, excluded: res.skipped + droppedOld, total: res.total };
            var basis = stats.used + ' note' + (stats.used === 1 ? '' : 's') +
              (stats.excluded ? ', ' + stats.excluded + ' excluded' : '') + ' (from ' + stats.total + ' total)' +
              (fromCache ? ' · shared scan cache - Shift-Regenerate to re-collect' : '');
            console.info('[BWN CU] notes collected:', res.total, '| used:', keep.length, '| excluded:', stats.excluded, win ? '| window(days):' + win : '');
            var noteText = mode.prefix(basis);
            if (win) {
              noteText = 'Recent update \u2014 last ' + win + ' days, from ' + basis +
                (unknownDates ? ' \u00b7 ' + unknownDates + ' note(s) had unreadable dates (included)' : '') +
                '. Review, then paste into the WO note.';
            }
            function contentFor(sel) { return buildUserContent(h, sel, mode, win); }
            function go(sel) {
              var used = sel || keep;
              var userContent = contentFor(used);
              var basis2 = used.length !== keep.length
                ? used.length + ' hand-picked note' + (used.length === 1 ? '' : 's') + ' (from ' + stats.total + ' total)'
                : basis;
              // The provenance note (shown above the draft AND cached) must describe
              // the actual selection, not the pre-preflight full set.
              var noteText2 = used.length === keep.length ? noteText
                : win ? 'Recent update \u2014 last ' + win + ' days, from ' + basis2 + '. Review, then paste into the WO note.'
                : mode.prefix(basis2);
              m.loading('Drafting with Claude\u2026', basis2);
              m.estimate(92, Math.max(8000, mode.maxTokens * 5));
              var expChars = Math.max(400, Math.min(mode.maxTokens * 3.5, 700 + used.length * 14));
              generate(mode.system, userContent, mode.maxTokens, function (err, text) {
                if (err) { m.error(err.message); return; }
                m.finishProgress();
                showResult(text,
                  { used: used.length, excluded: stats.excluded + (keep.length - used.length), total: stats.total },
                  noteText2, function () { go(used); });
              }, function (soFar) {
                var words = (soFar.trim().match(/\S+/g) || []).length;
                m.streamProgress(Math.min(95, 20 + 75 * soFar.length / expChars), words + ' words drafted\u2026');
              });
            }
            // Preflight gate: 'always', or 'auto' when the payload is heavy enough
            // that reviewing what goes out beats one-click speed.
            var pf = aiCfg().preflight;
            if (pf === 'always' || (pf === 'auto' && (keep.length > 60 || contentFor(keep).length > 30000))) {
              m.preflight(mode, keep, stats, contentFor, go);
            } else {
              go();
            }
          },
          function () { m.error('The page changed - note collection was cancelled. Reopen AI Draft on the WO you want.'); },
          forceFresh === true   // Shift-Regenerate: bypass the shared note cache
        );
      }

      var cached = draftCacheGet(mode);
      if (cached) {
        var disp = (cached.note ? cached.note + ' \u00b7 ' : '') + 'saved draft (' + draftAge(cached.ts) + ') \u2014 Regenerate for a fresh one';
        showResult(cached.text, cached.stats, cached.note, startCollect, disp);   // instant; Regenerate runs a fresh collect + draft
      } else startCollect();
    }

    // ---- Mount the buttons on the notes view -----------------------------
    function makeBtn(label, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'min-width:104px;padding:6px 10px;font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;' +
        'color:#fff;border:none;border-radius:6px;cursor:pointer;text-align:center;background:' + GREEN + ';';
      b.addEventListener('click', function (e) { e.preventDefault(); fn(); });
      return b;
    }

    function findAddNote() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (/add note/i.test((btns[i].textContent || '').trim())) return btns[i];
      }
      return null;
    }

    function mount() {
      if (document.getElementById(BTN_ID)) { BWN.beat('clientUpdate', 'ok', 'AI Draft menu mounted'); return true; }
      // Only on a notes view that actually has notes loaded.
      if (!document.querySelector('[data-testid^="wo-note-"][data-testid$="-summary"]')) { BWN.beat('clientUpdate', 'waiting', 'notes view not open'); return false; }

      var bar = document.createElement('div');
      bar.id = BTN_ID;
      bar.style.cssText = 'display:inline-flex;gap:6px;align-items:center;vertical-align:middle;margin-right:8px;';
      bar.appendChild(bwnMakeDropdown('AI Draft', [
        { label: 'Client Update', desc: 'Client-safe draft', fn: function () { run(CLIENT_MODE); } },
        { label: 'WO Audit', desc: 'Internal \u00b7 full case file', fn: function () { run(AUDIT_MODE); } },
        { label: 'Recent Update', desc: 'Internal \u00b7 recent window', fn: function () { run(RECENT_MODE); } },
        { label: 'Next Actions', desc: 'Action \u00b7 next actions', fn: function () { run(NEXTSTEPS_MODE); } },
        { label: 'Over 30', desc: 'Internal \u00b7 one-line', fn: function () { run(OVER30_MODE); } }
      ]));

      var addNote = findAddNote();
      if (addNote && addNote.parentNode) {
        addNote.parentNode.insertBefore(bar, addNote);     // sit just left of Add Note
      } else {
        var dl = document.querySelector('[data-testid="download-notes-button"]');
        if (dl && dl.parentNode) {
          dl.parentNode.insertBefore(bar, dl.nextSibling);
        } else {
          bar.style.cssText += 'position:fixed;bottom:20px;right:20px;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.25);';
          document.body.appendChild(bar);
        }
      }
      console.info('[BWN CU] buttons mounted');
      BWN.beat('clientUpdate', 'ok', 'AI Draft menu mounted');
      return true;
    }

    var pollTimer = null;
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function schedule() {
      if (mount()) { stopPoll(); return; }
      if (pollTimer) return;
      var ticks = 0;
      pollTimer = setInterval(BWN.guard(function () {
        if (mount() || !/\/work-orders\//.test(location.pathname)) { stopPoll(); return; }
        // Watchdog: notes on screen ~10s with no mount = the Add Note anchor drifted.
        if (document.querySelector('[data-testid^="wo-note-"][data-testid$="-summary"]') && ++ticks === 40) {
          BWN.beat('clientUpdate', 'miss', 'notes visible 10s but the AI Draft menu never mounted - anchor drift?');
        }
      }, 'clientUpdate:poll'), 250);
    }
    var obs = new MutationObserver(BWN.guard(schedule, 'clientUpdate:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    schedule();

    // Command-palette bridge: Core's palette dispatches bwn:cmd DOM events; this
    // listener lives INSIDE the module so the kill switch disables it too.
    var PAL_MODES = { 'ai:client': CLIENT_MODE, 'ai:audit': AUDIT_MODE, 'ai:recent': RECENT_MODE, 'ai:next': NEXTSTEPS_MODE, 'ai:over30': OVER30_MODE };
    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail;
      if (!d || !PAL_MODES[d.id]) return;
      if (!document.querySelector('[data-testid^="wo-note-"][data-testid$="-summary"]')) {
        alert('Open the WO notes view first - the draft needs the note history.');
        return;
      }
      run(PAL_MODES[d.id]);
    }, 'clientUpdate:cmd'));

    // ---- Batch Over-30 lines (list-level; staged by List Heat via bwn:cmd) ----
    // Option A of the batch design: one "OVER 30 -" line per aged open job, drafted
    // from the STRUCTURED scan facts List Heat stages in sessionStorage - no note
    // history (that's the single-WO Over 30 mode). Each row links to its WO for the
    // full-fidelity draft when a line needs more depth. Chunked calls; per-row and
    // TSV copy for the audit workbook Key.
    var SYSTEM_PROMPT_OVER30_BATCH = [
      'You write standardized "OVER 30" status lines for a BATCH of facilities maintenance work orders, in the terse ALL-CAPS style Broadway National ops uses in its WO Audit spreadsheet. Internal use.',
      'INPUT: one numbered job per line, with LIST-LEVEL facts only (status, ages, dates, heat flags). There is NO note history - never invent visit outcomes, parts, approvals, or conversations. Derive each line strictly from the status, the dates, and the flags given.',
      'RULES:',
      '1. Output EXACTLY one line per input job, in the SAME order, each in the form: <n>. OVER 30 - <line> - where <n> is that job’s number from the input.',
      '2. After the number, ALL CAPS, telegraphic segments separated by " - ". Lead with what the status means, then the sharpest aging fact or flag, then the implied next step. Use ops shorthand where natural: ESD, ECD, ETA, F/U, SCHED.',
      '3. Include concrete dates as M/D when the input provides them (sched date, expected completion, last note).',
      '4. Nothing else: no preamble, no commentary, no blank lines between outputs.',
      '   Example output lines:',
      '   1. OVER 30 - PENDING MATERIALS - 45D OPEN - F/U SUPPLIER FOR ESD',
      '   2. OVER 30 - SCHED 6/12 PASSED 18D AGO - CHASE VENDOR FOR COMPLETION DOCS',
      '   3. OVER 30 - AWAITING CLIENT APPROVAL - NO NOTE 12D - F/U CLIENT'
    ].join('\n');

    var O30B_STYLE_ID = 'bwn-o30b-style';
    function ensureO30BStyle() {
      if (document.getElementById(O30B_STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = O30B_STYLE_ID;
      st.textContent =
        '#bwn-o30b-overlay{position:fixed;top:0;bottom:0;left:var(--bwn-dock-w,158px);z-index:100000;display:flex;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;animation:bwnFade .2s ease-out;}' +
        '.bwn-o30b{width:780px;max-width:calc(100vw - var(--bwn-dock-w,158px) - 8px);height:100%;display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:0 14px 14px 0;overflow:hidden;box-shadow:10px 0 34px rgba(0,0,0,.2);}' +
        '.bwn-o30b-hd{background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:15px 20px;}' +
        '.bwn-o30b-hd .t{font:600 16px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
        '.bwn-o30b-hd .s{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.72);margin-top:3px;}' +
        '.bwn-o30b-body{flex:1;overflow:auto;padding:8px 14px;}' +
        '.bwn-o30b-row{display:flex;gap:10px;align-items:flex-start;padding:8px 4px;border-bottom:1px solid var(--bwn-surface-3);}' +
        '.bwn-o30b-row:last-child{border-bottom:none;}' +
        '.bwn-o30b-row a{flex:none;width:150px;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-green);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.bwn-o30b-line{flex:1;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text);line-height:1.5;min-width:0;}' +
        '.bwn-o30b-line.pend{color:var(--bwn-text-faint);}' +
        '.bwn-o30b-prev{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin-top:3px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.bwn-o30b-prev.stale{color:var(--bwn-warn);}' +
        '.bwn-o30b-line.err{color:var(--bwn-bad);}' +
        '.bwn-o30b-ft{display:flex;gap:8px;align-items:center;padding:12px 16px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-o30b-ft .st{margin-right:auto;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}';
      document.head.appendChild(st);
    }

    // Deterministic fact line - rendered INSTANTLY for every job so the panel is useful
    // the moment it opens (previously every row sat at "…" until its AI chunk returned,
    // which reads as "produces no info" on a slow/missing key - user-reported). The AI
    // pass then REPLACES lines it successfully polishes; on any chunk error the fact
    // lines simply stand, so the batch works fully offline / keyless.
    var O30_ACTIONS = [
      [/material|supplier|rma|fabricat|equipment rental/i, 'F/U SUPPLIER FOR DELIVERY ESD - SCHED UPON RECEIPT'],
      [/awaiting 3rd|third party/i, 'CHASE 3RD PARTY FOR ETA/COMPLETION'],
      [/pending schedule|recruiting|pending dispatch|pending service|^new$/i, 'SCHED IMMEDIATELY - ASSIGN TECH/VENDOR'],
      [/proposal approved|atf approved/i, 'ASSIGN VENDOR - SCHED WITHOUT DELAY'],
      [/proposed|atf submitted/i, 'F/U CLIENT FOR PROPOSAL DECISION'],
      [/proposal|quote|trade specialist|atf prep/i, 'CHASE VENDOR PROPOSAL'],
      [/clocked out: in progress|on[\s-]?site|on the way/i, 'CONFIRM TECH PROGRESS - PUSH FOR ECD'],
      [/scheduled/i, 'CONFIRM SCHED DATE FIRM - F/U VENDOR FOR ETA'],
      [/on hold|client action/i, 'F/U CLIENT FOR DIRECTION'],
      [/confirm complete/i, 'COLLECT COMPLETION DOCS - CONFIRM COMPLETE'],
      [/pending acceptance/i, 'CHASE VENDOR TO ACCEPT - ELSE REASSIGN']
    ];
    function o30FactLine(j) {
      var bits = ['OVER 30', String(j.status || '?').toUpperCase(), (j.days || '?') + 'D OPEN'];
      var h = parseFloat(String(j.hrs || '').replace(/,/g, ''));
      if (!isNaN(h) && h > 0) {
        var lim = '';
        (j.reasons || []).some(function (r) { var m = String(r).match(/\((limit|watch from)\s*(\d+)h\)/i); if (m) { lim = ' (' + m[1].toUpperCase() + ' ' + m[2] + 'H)'; return true; } return false; });
        bits.push(Math.round(h) + 'H IN STATUS' + lim);
      }
      if (j.dne) bits.push('DNE ' + j.dne);
      if (j.prio && /red|p1|p2|high/i.test(j.prio)) bits.push(String(j.prio).toUpperCase().replace(/\s*-\s*/g, ' '));
      var lnD = BWN.parseUSDate(j.lastNote || '');
      if (lnD !== null) { var d = new Date(lnD); bits.push('LAST NOTE ' + (d.getMonth() + 1) + '/' + d.getDate()); }
      var act = 'REVIEW + UPDATE PLAN';
      for (var i = 0; i < O30_ACTIONS.length; i++) { if (O30_ACTIONS[i][0].test(j.status || '')) { act = O30_ACTIONS[i][1]; break; } }
      if ((j.reasons || []).some(function (r) { return /sched date passed/i.test(r); })) act = 'SCHED PASSED - CHASE VENDOR FOR COMPLETION DOCS';
      bits.push(act);
      return bits.join(' - ');
    }
    function o30BatchOpen() {
      var payload = null;
      try { payload = JSON.parse(sessionStorage.getItem('bwn:o30batch') || 'null'); } catch (e) { }
      if (!payload || payload.v !== 1 || !Array.isArray(payload.jobs) || !payload.jobs.length) {
        alert('No staged over-30 batch - start it from the WO HEAT banner on the list page.');
        return;
      }
      ensureStyle(); ensureO30BStyle();
      var old = document.getElementById('bwn-o30b-overlay');
      if (old) { if (old._bwnClose) old._bwnClose(); else old.remove(); }   // stop the old chunk chain + release its trap, not just the DOM
      var jobs = payload.jobs;
      var results = new Array(jobs.length);
      var cancelled = false, releaseA11y = null;

      try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: 'over30' } })); } catch (e) { }
      var ov = document.createElement('div'); ov.id = 'bwn-o30b-overlay';
      var card = document.createElement('div'); card.className = 'bwn-o30b';
      function close() {
        cancelled = true;
        document.removeEventListener('keydown', onKey);
        if (releaseA11y) { releaseA11y(); releaseA11y = null; }
        ov.remove();
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      ov._bwnClose = close;   // lets a re-open tear the old instance down properly

      var hd = document.createElement('div'); hd.className = 'bwn-o30b-hd';
      var t = document.createElement('div'); t.className = 't';
      t.textContent = 'Over-30 Lines - ' + jobs.length + ' aged open job' + (jobs.length === 1 ? '' : 's');
      var s = document.createElement('div'); s.className = 's';
      s.textContent = 'drafted from list-level scan facts - open a WO for the full single-job draft';
      hd.appendChild(t); hd.appendChild(s); card.appendChild(hd);

      var body = document.createElement('div'); body.className = 'bwn-o30b-body';
      var lineEls = [];
      jobs.forEach(function (j, jIdx) {
        var row = document.createElement('div'); row.className = 'bwn-o30b-row';
        var a = document.createElement('a'); a.href = j.href || '#'; a.textContent = j.wo || '(no #)';
        a.title = (j.client || '') + ' · ' + (j.status || '') + ' · ' + j.days + 'd open';
        // Instant deterministic fact line (pend-styled = "AI may still upgrade this");
        // copy is usable immediately, and Copy-all works before any AI chunk returns.
        results[jIdx] = o30FactLine(j);
        var ln = document.createElement('div'); ln.className = 'bwn-o30b-line pend'; ln.textContent = results[jIdx];
        var cp = document.createElement('button'); cp.type = 'button'; cp.className = 'bwn-cu-btn ghost'; cp.textContent = 'Copy';
        cp.style.cssText = 'padding:3px 10px;font-size:10px;flex:none;'; cp.disabled = false;
        cp.addEventListener('click', function () {
          GM_setClipboard(ln.textContent);
          cp.textContent = 'Copied ✓'; setTimeout(function () { cp.textContent = 'Copy'; }, 1200);
        });
        // Middle column: the drafted line + the LAST SYNCED line beneath it ("last
        // entered M/D by X - …") so a supervisor can audit currency at a glance.
        var mid = document.createElement('div'); mid.style.cssText = 'flex:1;min-width:0;';
        var prevEl = document.createElement('div'); prevEl.className = 'bwn-o30b-prev'; prevEl.textContent = '';
        mid.appendChild(ln); mid.appendChild(prevEl);
        row.appendChild(a); row.appendChild(mid); row.appendChild(cp);
        body.appendChild(row); lineEls.push({ ln: ln, cp: cp, prev: prevEl, tracking: j.tracking || '' });
      });
      card.appendChild(body);

      var ft = document.createElement('div'); ft.className = 'bwn-o30b-ft';
      var st = document.createElement('span'); st.className = 'st'; st.textContent = 'Fact lines ready - polishing with AI…';
      ft.appendChild(st);
      var copyAll = document.createElement('button'); copyAll.type = 'button'; copyAll.className = 'bwn-cu-btn primary'; copyAll.textContent = 'Copy all (TSV)';
      copyAll.disabled = false;   // fact lines are complete data - usable before the AI pass
      copyAll.addEventListener('click', function () {
        var rows = ['Job #\tOver-30 Line'];
        jobs.forEach(function (j, i) { rows.push((j.wo || '') + '\t' + (results[i] || '')); });
        GM_setClipboard(rows.join('\n'));
        copyAll.textContent = 'Copied ✓'; setTimeout(function () { copyAll.textContent = 'Copy all (TSV)'; }, 1500);
      });
      ft.appendChild(copyAll);
      // Publish the reviewed lines to the SWA: the dashboard shows each job's latest
      // Over-30 line + date, and the NEXT batch here shows them as "last entered…".
      // Deliberate button (not auto) - these lines become the team's audit record.
      var syncBtn = document.createElement('button'); syncBtn.type = 'button'; syncBtn.className = 'bwn-cu-btn ghost'; syncBtn.textContent = 'Sync to dashboard';
      syncBtn.title = 'Publish these lines to the shared store - the dashboard (and the next batch) shows each job’s last Over-30 line + date';
      syncBtn.addEventListener('click', function () {
        if (!connectorEnabled()) { alert('The SWA connector is disabled (Ops Suite panel → SWA connector toggle).'); return; }
        var key = GM_getValue('ingest_key', '');
        if (!key) { alert('Set the SWA ingest key first (Tampermonkey menu → Set SWA ingest key).'); return; }
        var lines = [];
        jobs.forEach(function (j, i) { if ((j.tracking || '') && results[i]) lines.push({ target: j.tracking, line: results[i] }); });
        if (!lines.length) { alert('No lines with a Tracking # to sync - add the "Tracking #" column to the list and rescan.'); return; }
        var skipped = jobs.length - lines.length;
        syncBtn.disabled = true; syncBtn.textContent = 'Syncing…';
        // Chunked ≤150/POST (the server caps a batch at 200 and would TRUNCATE silently),
        // counting the server's OWN accepted totals - never the local count.
        var SYNC_CH = 150, accepted = 0;
        function syncFail(msg) { syncBtn.disabled = false; syncBtn.textContent = 'Sync to dashboard'; alert(msg); }
        (function push(off) {
          if (cancelled) return;
          if (off >= lines.length) {
            syncBtn.textContent = 'Synced ✓ (' + accepted + (accepted < jobs.length ? ' of ' + jobs.length : '') + ')';
            // Re-enable so lines AI-polished AFTER an early sync can be re-published
            // (review: a mid-polish sync used to lock the weaker fact lines in for the day).
            setTimeout(function () { if (!cancelled) { syncBtn.disabled = false; syncBtn.textContent = 'Sync again'; } }, 2500);
            st.textContent = 'Synced ' + accepted + ' line' + (accepted === 1 ? '' : 's') + ' to the dashboard' + (skipped ? ' - ' + skipped + ' skipped (no Tracking # in Umbrava)' : '') + '.';
            var now = new Date();
            lineEls.forEach(function (el, i) {
              if (!el.prev) return;
              if (el.tracking && results[i]) { el.prev.className = 'bwn-o30b-prev'; el.prev.textContent = 'last entered ' + (now.getMonth() + 1) + '/' + now.getDate() + ' (just synced) - ' + results[i]; }
              else if (!el.tracking) { el.prev.className = 'bwn-o30b-prev stale'; el.prev.textContent = 'not synced - no Tracking # in Umbrava'; }
            });
            return;
          }
          var part = lines.slice(off, off + SYNC_CH);
          GM_xmlhttpRequest({
            method: 'POST', url: INGEST_URL + '?client=' + INGEST_CLIENT,
            headers: { 'Content-Type': 'application/json', 'x-bwn-key': key },
            data: JSON.stringify({ actor: ingestActor(), o30lines: part }), timeout: 20000,
            onload: function (r) {
              var d = null; try { d = JSON.parse(r.responseText); } catch (e) { }
              if (r.status >= 200 && r.status < 300 && d && d.ok === true) { accepted += (+d.lines || 0); push(off + SYNC_CH); }
              else syncFail('Sync failed (' + r.status + (d && d.error ? ' - ' + d.error : '') + ')' + (accepted ? ' - ' + accepted + ' line(s) were stored before the failure.' : '.'));
            },
            onerror: function () { syncFail('Sync failed - network error.' + (accepted ? ' ' + accepted + ' line(s) were stored before the failure.' : '')); },
            ontimeout: function () { syncFail('Sync timed out.' + (accepted ? ' ' + accepted + ' line(s) were stored before the failure.' : '')); }
          });
        })(0);
      });
      ft.appendChild(syncBtn);
      var closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'bwn-cu-btn ghost'; closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', close);
      ft.appendChild(closeBtn);
      card.appendChild(ft);

      ov.appendChild(card);
      document.body.appendChild(ov);
      releaseA11y = bwnA11yDialog(card, { label: 'Over-30 batch lines', modal: true });

      // Each job's LAST SYNCED line + date (bulk, one GET) - the audit context the
      // supervisor needs: what was last entered and when. >7d old renders stale-amber;
      // nothing on record says so. Silent no-op without the ingest key.
      (function loadPrevLines() {
        if (!connectorEnabled()) return;                  // kill-switch: Ops Suite toggle
        var key = GM_getValue('ingest_key', '');
        var targets = jobs.map(function (j) { return j.tracking || ''; }).filter(Boolean);
        if (!key || !targets.length) return;
        // Chunked ≤100/GET: the server caps a lookup at 200 targets and a bigger board
        // would also push the query string past common length limits (~2KB) - either
        // way jobs past the cap would falsely read "no prior line".
        var GET_CH = 100, all = {};
        (function fetchChunk(off) {
          if (cancelled) return;
          if (off >= targets.length) {
            lineEls.forEach(function (el) {
              if (!el.prev) return;
              if (!el.tracking) { el.prev.className = 'bwn-o30b-prev stale'; el.prev.textContent = 'no Tracking # in Umbrava - cannot sync'; return; }
              var rec = all[el.tracking];
              if (!rec) { el.prev.textContent = 'no prior over-30 line on record'; return; }
              var when = new Date(rec.ts || 0), ageD = Math.floor((Date.now() - +when) / 86400000);
              // src 'audit' = the WO Audit case file on the dashboard (the authoritative
              // record); 'sync' = published from this panel. Newest of the two, per job.
              var srcLbl = rec.src === 'audit' ? 'last WO Audit note ' : 'last synced ';
              el.prev.textContent = srcLbl + (when.getMonth() + 1) + '/' + when.getDate() + (rec.by ? ' by ' + rec.by : '') + ' - ' + rec.line;
              el.prev.title = rec.ts || '';
              if (ageD > 7) el.prev.className = 'bwn-o30b-prev stale';
            });
            return;
          }
          GM_xmlhttpRequest({
            method: 'GET',
            url: INGEST_URL + '?client=' + INGEST_CLIENT + '&o30=' + encodeURIComponent(targets.slice(off, off + GET_CH).join(',')),
            headers: { 'x-bwn-key': key }, timeout: 15000,
            onload: function (r) {
              if (cancelled) return;
              if (r.status >= 200 && r.status < 300) {
                var d = null; try { d = JSON.parse(r.responseText); } catch (e) { }
                if (d && d.ok === true && d.lines) { Object.keys(d.lines).forEach(function (k) { all[k] = d.lines[k]; }); }
              }
              fetchChunk(off + GET_CH);   // a failed chunk degrades to "no record" for its rows only
            },
            onerror: function () { fetchChunk(off + GET_CH); }, ontimeout: function () { fetchChunk(off + GET_CH); }
          });
        })(0);
      })();

      function jobFacts(j, n) {
        var bits = ['status: ' + (j.status || '?'), (j.days || '?') + ' days open'];
        var h = parseFloat(String(j.hrs || '').replace(/,/g, ''));
        if (!isNaN(h) && h > 0) bits.push(Math.round(h) + 'h in status');
        if (j.sched) bits.push('sched date: ' + j.sched);
        if (j.exp) bits.push('expected completion: ' + j.exp);
        if (j.lastNote) bits.push('last note: ' + j.lastNote);
        if (j.prio) bits.push('priority: ' + j.prio);
        if (j.dne) bits.push('client DNE: ' + j.dne);
        if (j.reasons && j.reasons.length) bits.push('flags: ' + j.reasons.join('; '));
        return n + '. ' + (j.wo || '?') + (j.client ? ' (' + j.client + ')' : '') + ' - ' + bits.join(' · ');
      }

      var CHUNK = 20, polished = 0, aiErr = null;
      function runChunk(start) {
        if (cancelled) return;
        if (start >= jobs.length) {
          st.textContent = polished === jobs.length
            ? jobs.length + ' of ' + jobs.length + ' lines AI-polished - review before pasting.'
            : polished + ' AI-polished, ' + (jobs.length - polished) + ' fact-line' + (jobs.length - polished === 1 ? '' : 's') + (aiErr ? ' (AI: ' + aiErr + ')' : '') + ' - review before pasting.';
          return;
        }
        var slice = jobs.slice(start, Math.min(start + CHUNK, jobs.length));
        st.textContent = 'Fact lines ready - AI polishing ' + (start + 1) + '–' + (start + slice.length) + ' of ' + jobs.length + '…';
        var user = 'JOBS (' + slice.length + '):\n' + slice.map(function (j, i) { return jobFacts(j, i + 1); }).join('\n');
        generate(SYSTEM_PROMPT_OVER30_BATCH, user, Math.max(1200, slice.length * 90), function (err, text) {
          if (cancelled) return;
          if (err) {
            // Fact lines stand - promote them from pend to definitive and move on.
            aiErr = err.message || 'unavailable';
            for (var k = 0; k < slice.length; k++) lineEls[start + k].ln.className = 'bwn-o30b-line';
            runChunk(start + CHUNK);
            return;
          }
          var seen = {};   // a duplicate-numbered AI line must not double-count `polished` (last duplicate still wins the content)
          String(text || '').split('\n').forEach(function (raw) {
            var m = raw.match(/^\s*(\d+)[.)]\s*(OVER\s*30.*)$/i);
            if (!m) return;
            var idx = start + parseInt(m[1], 10) - 1;
            if (idx >= start && idx < start + slice.length) { results[idx] = m[2].trim(); if (!seen[idx]) { seen[idx] = 1; polished++; } }
          });
          for (var k2 = 0; k2 < slice.length; k2++) {
            var i2 = start + k2, el2 = lineEls[i2];
            el2.ln.textContent = results[i2];           // the AI line where returned, else the fact line stands
            el2.ln.className = 'bwn-o30b-line';
          }
          runChunk(start + CHUNK);
        });
      }
      runChunk(0);
    }

    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail;
      if (d && d.id === 'ai:over30batch') o30BatchOpen();
    }, 'clientUpdate:o30batch'));
  });

// ==========================================================================
// MODULE: Job View v0.1
// Ports the SWA Ops-Dashboard job modal onto an Umbrava WO page. A coordinator
// pops the same rich case-file card (read-only). GraphQL (same-origin, Auth0
// bearer) feeds the live WO fields; the SWA connector feeds the authored notes,
// exception-queue state, over-30 line, and pushed next-actions plan. Either
// source degrades to null independently.
// ==========================================================================
if (BWN_MODULES.jobView) BWN.safeModule('jobView', function () {
  'use strict';

  // ------------------------------------------------------------------ CONFIG
  var O30_THRESHOLD = 30;                 // seam: was window._clientConfig.over30.threshold
  var MS_DAY = 86400000, MS_HR = 3600000;
  var BTN_ID = 'bwn-jv-launch';

  // ====================================================================
  // DATA LAYER (local)
  // ====================================================================

  // Auth0 access token - same key pattern the Bid-Out tool uses. Picked by CONTENT, not just
  // key: the audience-keyed cache slot transiently holds NON-Umbrava tokens (seen live
  // 2026-07-21: an Azure Functions/SCM runtime token, iss *.scm.azurewebsites.net, HS256 -
  // this is what the 07/19 "HS256" role-debug sighting actually was). Only an unexpired token
  // whose iss is an Umbrava issuer is usable; anything else = treat as signed-out and retry.
  function isUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  // Raw first-match read (diagnostics only - shows whatever is in the slot right now).
  function rawAuthToken() {
    try {
      var k = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      })[0];
      if (!k) return '';
      var body = (JSON.parse(localStorage.getItem(k)) || {}).body;
      return (body && body.access_token) || '';
    } catch (e) { return ''; }
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

  // ---- Umbrava role sender ------------------------------------------------------
  // Sends the Auth0 access token to the SWA, which PROVES it via Umbrava's own GraphQL
  // current-user query (a vouch - the SWA never verifies the signature locally) and returns
  // the caller's Umbrava role PLUS the server-computed ladder position `rank` (1 staff ..
  // 5 director) and `tier` name. The rank is what the role-gated UX keys on - it is the
  // SAME number the enforcing endpoints (cc-purchase etc.) check, computed by the same
  // server module, so client show/hide and server enforcement can never disagree about
  // what a free-text role name means. rank/tier ride the bwn:role bus event AND the
  // localStorage 'bwn:role:last' record so sibling suite scripts (e.g. bwn-cc-purchase)
  // can gate their UI without re-fetching. The token goes ONLY to the declared SWA
  // @connect host, is never logged or cached (only the resulting role/email is). Dormant
  // until the SWA key is set + connector enabled; throttled to ~6h via a GM cache so it's
  // ~once/session.
  var ROLE_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/user-role';
  var ROLE_TTL_MS = 6 * 3600 * 1000;
  var _bwnRole = null;   // { email, sub, role, tenantId, roleQuery, ts }
  function bwnUserRole() { return _bwnRole; }   // getter for future UX gating
  // Current signed-in identity (the access token's sub) - so a cached role is only reused for
  // the SAME user (shared workstation / in-tab re-login must not inherit another user's role).
  function authSub() {
    try { var p = authToken().split('.')[1]; return p ? (JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))).sub || '') : ''; } catch (e) { return ''; }
  }
  // Persist the last role-fetch outcome (success OR failure, incl. the silent page-load
  // auto-fire) so it can be inspected from the page - no tokens/keys, just the verdict.
  function recordRole(outcome) {
    try { localStorage.setItem('bwn:role:last', JSON.stringify(Object.assign({ ver: BWN_VER, ts: Date.now() }, outcome))); } catch (e) { }
  }
  function announceRole(rc) {
    _bwnRole = rc;
    recordRole({ ok: true, role: (rc && rc.role) || null, rank: (rc && typeof rc.rank === 'number') ? rc.rank : null, tier: (rc && rc.tier) || null, email: (rc && rc.email) || '', roleQuery: (rc && rc.roleQuery) || null });
    try { console.info('[BWN] Umbrava role:', (rc && rc.role) || '(none)', (rc && rc.tier) ? ('· ' + rc.tier + ' tier (rank ' + rc.rank + ')') : '', '· ' + ((rc && rc.email) || '')); } catch (e) { }
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:role', role: (rc && rc.role) || null, rank: (rc && typeof rc.rank === 'number') ? rc.rank : null, tier: (rc && rc.tier) || null, email: (rc && rc.email) || '', roleQuery: (rc && rc.roleQuery) || null } })); } catch (e) { }
  }
  function fetchUserRole(force, cb) {
    var sub = authSub();
    if (_bwnRole && !force && _bwnRole.sub === sub) { if (cb) cb(_bwnRole); return; }
    if (!connectorEnabled()) { recordRole({ ok: false, err: 'connector-off' }); if (cb) cb(null, 'connector is off (Ops Suite toggle)'); return; }
    var key = GM_getValue('ingest_key', ''); if (!key) { recordRole({ ok: false, err: 'no-ingest-key' }); if (cb) cb(null, 'SWA ingest key not set (Tampermonkey menu)'); return; }
    var tok = authToken();
    if (!tok) {
      var whyTok = rawAuthToken() ? 'no usable Umbrava token yet (the auth cache holds a non-Umbrava token right now) - wait a few seconds or reload the tab, then retry' : 'not signed into Umbrava (no token found)';
      recordRole({ ok: false, err: whyTok });
      if (cb) cb(null, whyTok);
      return;
    }
    if (!force) {
      // same-user + fresh + carries a rank (a pre-1.39.0 cache has no rank - refetch once so
      // the role-gated UX gets the server-computed ladder position, then it caches normally)
      try { var c = JSON.parse(GM_getValue('bwn_role_cache', 'null')); if (c && c.ts && (Date.now() - c.ts) < ROLE_TTL_MS && c.sub && c.sub === sub && typeof c.rank === 'number') { announceRole(c); if (cb) cb(c); return; } } catch (e) { }
    }
    GM_xmlhttpRequest({
      method: 'POST', url: ROLE_URL, timeout: 15000,
      // Token rides in the BODY: the SWA edge overwrites the Authorization header with its own
      // platform token when proxying /api/* (root cause of every bad-iss/bad-alg since v1.34).
      headers: { 'Content-Type': 'application/json', 'x-bwn-key': key },
      data: JSON.stringify({ token: tok }),
      onload: function (r) {
        var j = null; try { j = JSON.parse(r.responseText); } catch (e) { }
        if (r.status >= 200 && r.status < 300 && j && j.ok) {
          var rc = { email: j.email || '', sub: j.sub || '', role: j.role || null, rank: (typeof j.rank === 'number') ? j.rank : null, tier: j.tier || null, tenantId: j.tenantId || '', roleQuery: j.roleQuery || null, ts: Date.now() };
          try { if (rc.role) GM_setValue('bwn_role_cache', JSON.stringify(rc)); } catch (e) { }   // persist only a RESOLVED role (never the token); a null role re-fetches next load
          announceRole(rc); if (cb) cb(rc);
        } else {
          var whyHttp = 'HTTP ' + r.status + ((j && (j.code || j.error)) ? ': ' + (j.code || j.error) : '') + ((j && j.detail) ? ('\n' + JSON.stringify(j.detail)) : '');
          recordRole({ ok: false, err: whyHttp });
          if (cb) cb(null, whyHttp);
        }
      },
      onerror: function () { recordRole({ ok: false, err: 'network error reaching the SWA' }); if (cb) cb(null, 'network error reaching the SWA'); },
      ontimeout: function () { recordRole({ ok: false, err: 'timed out reaching the SWA' }); if (cb) cb(null, 'timed out reaching the SWA'); }
    });
  }
  GM_registerMenuCommand('BWN: Check my Umbrava role', function () {
    fetchUserRole(true, function (rc, err) {
      if (rc && rc.role) alert('Umbrava role: ' + rc.role + (rc.tier ? '\nAccess tier: ' + rc.tier + ' (rank ' + rc.rank + ' of 5)' : '') + '\nResolved via: ' + (rc.roleQuery || '?') + '\nUser: ' + (rc.email || '') + '\nTenant: ' + (rc.tenantId || '') + '\n\n(AI v' + BWN_VER + ')');
      else if (rc) alert('Signed in and verified, but Umbrava returned no role.\nResolved via: ' + (rc.roleQuery || '(no query matched)') + '\nUser: ' + (rc.email || '') + '\n\n(AI v' + BWN_VER + ')');
      else alert('Could not fetch your Umbrava role.\nReason: ' + (err || 'unknown') + '\n\nChecklist: SWA ingest key set, connector on, signed into Umbrava.\n(AI v' + BWN_VER + ')');
    });
  });
  // (The temp "BWN: role debug" menu was removed in v1.38.0 - role auth confirmed working
  // 2026-07-21. The SWA's ?debug=1 echo remains server-side for future curl diagnostics.)
  // Fire once per session shortly after load so the SWA resolves the role + logs/returns the
  // query field it used (roleQuery) - this is what confirms the current-user field in prod.
  setTimeout(function () { try { fetchUserRole(false); } catch (e) { } }, 4000);

  // Same-origin GraphQL POST → resolves to `data`, throws on errors[].
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

  function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
  function _daysSince(v) { var d = _date(v); return d ? Math.floor((Date.now() - d.getTime()) / MS_DAY) : null; }
  function _stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

  // Dashboard SLA targets (verbatim from the dashboard) so reconstructed risk
  // matches isSlaViol(). Only consulted when statusHrs is known (here: null).
  var SLA_THRESH = {
    'Pending Dispatch': 8, 'Recruiting Vendor': 48, 'Vendor Compliance': 48,
    'Pending Schedule': 48, 'Clocked Out: Complete': 24, 'Vendor Proposal Required': 48,
    'Supplier Proposal Pending': 48, 'Vendor Proposal Received': 8, 'Pending Proposal Review': 4,
    'Internal Proposal Approved': 2, 'Internal Proposal Rejected': 8, 'Preparing Client Proposal': 8,
    'Proposal Approved': 2, 'Proposal Rejected': 24, 'Clocked Out: In Progress': 8,
    'Recall': 8, 'ATF Prep': 8, 'ATF Submitted': 8, 'ATF Approved': 8, 'Need Material': 96
  };
  function buildRisk(statusName, statusHrs, aged) {
    var thr = SLA_THRESH[statusName];
    var slaViol = thr != null && statusHrs != null && statusHrs > thr;
    var slaNear = thr != null && statusHrs != null && statusHrs > thr * 0.75;
    if (slaViol || (aged != null && aged >= 90)) return 'HIGH RISK';
    if (slaNear || (aged != null && aged >= 30)) return 'WATCH';
    return 'OK';
  }

  // Build the JOBS object for one WO. CONFIRMED-live fields (Bid-Out WO_Q) form
  // the reliable CORE query; every richer selection is an isolated try/catch so
  // a wrong guessed field only nulls that one thing (an unknown field errors the
  // WHOLE query it appears in). Returns a Promise → job object.
  async function woToJob(number) {
    var n = parseInt(String(number).replace(/^W-?/i, ''), 10);
    if (!n || isNaN(n)) throw new Error('No work-order number to query');

    // --- CORE (proven Bid-Out selectors) - reliable base. Throws → adapter fails.
    var CORE_Q =
      'query($n:Int!){ workOrder(workOrderNumber:$n){ ' +
      '  number trackingNumber scopeOfWork serviceInstructions ' +
      '  locationId locationName workOrderTypeId ' +
      '  address{ addressLine1 city state postalCode latitude longitude } ' +
      '  trades{ id name } priority{ label } doNotExceed{ amount } ' +
      '} }';
    var core = await gql(CORE_Q, { n: n });
    var wo = core && core.workOrder;
    if (!wo) throw new Error('Work order ' + n + ' not found (GraphQL returned no workOrder).');

    // --- internal id (keys notes/trips). ISOLATED and SEPARATE from the augment scalars,
    // so an unproven augment selector can't also suppress notes/trips (or vice-versa).
    var woId = null;
    try {
      var ID_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ id } }';
      var idr = await gql(ID_Q, { n: n });
      woId = (idr && idr.workOrder && idr.workOrder.id != null) ? idr.workOrder.id : null;
    } catch (e) { woId = null; }

    // --- AUGMENT: only the scalars we actually USE (CONFIRMED present via MCP
    // get_work_order). Isolated: nulls as a group if a selector name differs on the SPA.
    var aug = {};
    try {
      var AUG_Q =
        'query($n:Int!){ workOrder(workOrderNumber:$n){ ' +
        '  statusName creationDate workOrderDate ' +
        '  priority{ expectedCompletionDate firstTripDate } ' +
        '  doNotExceed{ precision } ' +
        '} }';
      var ar = await gql(AUG_Q, { n: n });
      aug = (ar && ar.workOrder) || {};
    } catch (e) { aug = {}; }

    // --- COORDINATOR + VENDORS (SPA selector names UNVERIFIED). Isolated.
    var coordinator = null, vendorNames = null;
    try {
      var C_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ assignedToMemberName vendorNames } }';
      var cr = await gql(C_Q, { n: n });
      var cwo = cr && cr.workOrder;
      if (cwo) {
        coordinator = cwo.assignedToMemberName || null;
        if (Array.isArray(cwo.vendorNames)) vendorNames = cwo.vendorNames;
      }
    } catch (e) { /* selectors not on the SPA schema → coordinator/vendors stay null */ }

    // --- NOTES. Umbrava's REAL query: jobNotes(workOrderNumber) is a ROOT field keyed by
    // the WO NUMBER (n), NOT the internal id. The older workOrderNotes(workOrderId) field
    // does not exist and silently returned 0 notes. Confirmed off the wire 2026-07-23
    // (bwn-wo-audit v0.3.0). Isolated: any drift nulls notes only, never the whole read.
    var notes = [];
    try {
      var N_Q = 'query($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content contentHtml createdDate isPinned isCompletion workOrderNoteSource createdBy { firstName lastName } } }';
      var nr = await gql(N_Q, { n: n });
      notes = (nr && nr.jobNotes) || [];
    } catch (e) { notes = []; }
    notes = notes.slice().sort(function (a, b) {
      return (_date(b && b.createdDate) || 0) - (_date(a && a.createdDate) || 0);
    });
    var latestNote = notes[0] || null;

    // --- TRIPS (guessed root query + shape). Isolated.
    var trips = [], poVendors = [];
    if (woId != null) {
      try {
        var T_Q =
          'query($id:Int!){ workOrderTrips(workOrderId:$id){ ' +
          '  workOrderTrips{ trips{ onSiteDate completedDate canceledDate status } } ' +
          '  purchaseOrderTrips{ vendorName trips{ onSiteDate completedDate canceledDate status } } ' +
          '} }';
        var tr = await gql(T_Q, { id: woId });
        var td = (tr && tr.workOrderTrips) || null;
        if (td) {
          var inner = td.workOrderTrips && td.workOrderTrips.trips;
          if (Array.isArray(inner)) inner.forEach(function (t) { trips.push(t); });
          var pot = td.purchaseOrderTrips;
          if (Array.isArray(pot)) pot.forEach(function (po) {
            if (po && po.vendorName) poVendors.push(po.vendorName);
            ((po && po.trips) || []).forEach(function (t) { trips.push(t); });
          });
        }
      } catch (e) { trips = []; poVendors = []; }
    }

    // --- derived dates
    var createdIso = aug.workOrderDate || aug.creationDate || null;
    var aged = _daysSince(createdIso);
    var lastUpdated = latestNote ? latestNote.createdDate : null;
    var daysSinceUpdate = latestNote ? _daysSince(latestNote.createdDate) : null;

    var onsites = trips.filter(function (t) { return t && t.onSiteDate && !t.canceledDate; })
      .map(function (t) { return _date(t.onSiteDate); }).filter(Boolean)
      .sort(function (a, b) { return a - b; });
    var firstTripDate = onsites.length ? onsites[0].toISOString()
      : ((aug.priority && aug.priority.firstTripDate) || null);
    var now = Date.now();
    var future = onsites.filter(function (d) { return d.getTime() >= now; });
    var nextOnsiteDate = future.length ? future[0].toISOString() : null;

    // --- statusHrs: no confirmed status-timeline source → null (per spec).
    var statusHrs = null;

    // --- fm: parse newest FM-type note (heuristic; null when no notes).
    var fm = null;
    var fmNote = notes.filter(function (x) { return x && x.type === 60; })[0] ||
      notes.filter(function (x) { return x && /\bnew fm\s*:/i.test(x.content || ''); })[0] || null;
    if (fmNote) {
      var m = /new fm\s*:\s*([^\n<]+)/i.exec(fmNote.content || '');
      if (m) fm = m[1].replace(/\s*[\w.+-]+@[\w.-]+.*/, '').trim() || null;
    }

    // --- money (cents → dollars; precision confirmed = 2)
    var dne = wo.doNotExceed || {};
    var prec = (aug.doNotExceed && aug.doNotExceed.precision != null) ? aug.doNotExceed.precision
      : (dne.precision != null ? dne.precision : 2);
    var cents = dne.amount != null ? dne.amount : 0;
    var amount = cents / Math.pow(10, prec);

    var vendorArr = Array.isArray(vendorNames) ? vendorNames : poVendors;
    var vendors = (vendorArr || []).filter(Boolean).join(', ') || null;
    var trades = (wo.trades || []).map(function (t) { return t && t.name; }).filter(Boolean).join(', ') || null;

    var statusName = aug.statusName || null;
    var expectedCompletion = (aug.priority && aug.priority.expectedCompletionDate) || null;
    var risk = buildRisk(statusName, statusHrs, aged);

    return {
      jobId: String(wo.trackingNumber != null ? wo.trackingNumber : (wo.number != null ? wo.number : n)),
      coordinator: coordinator,
      location: wo.locationName || null,
      status: statusName,
      aged: aged,
      statusHrs: statusHrs,
      lastUpdated: lastUpdated,
      daysSinceUpdate: daysSinceUpdate,
      priority: (wo.priority && wo.priority.label) || null,
      amount: amount,
      fm: fm,
      trades: trades,
      vendors: vendors,
      notes: latestNote ? _stripHtml(latestNote.content) : null,
      woDate: createdIso,
      firstTripDate: firstTripDate,
      nextOnsiteDate: nextOnsiteDate,
      expectedCompletion: expectedCompletion,
      risk: risk,
      // Dashboard-parity fields. city/state/wo come straight from CORE_Q (reliable but were
      // previously discarded); client/po/totalVendorNte are filled by the live bus overlay.
      city: (wo.address && wo.address.city) || null,
      state: (wo.address && wo.address.state) || null,
      wo: (wo.number != null ? String(wo.number) : null),
      po: null,
      client: null,
      totalVendorNte: null,
      projectType: null,
      mgmtAssist: null,
      mgmtNotes: null
    };
  }

  // SWA connector reads: authored case file (+eq +plan) via ?target=, latest
  // over-30 line via ?o30=. Never rejects; degrades to all-null.
  function fetchAuthored(digits) {
    return new Promise(function (resolve) {
      var out = { saved: null, eq: null, plan: null, o30: null };
      try {
        if (!connectorEnabled()) { resolve(out); return; }
        var key = GM_getValue('ingest_key', '');
        if (!key || !digits) { resolve(out); return; }
        var pending = 2;
        function done() { if (--pending <= 0) resolve(out); }
        GM_xmlhttpRequest({
          method: 'GET',
          url: INGEST_URL + '?client=' + INGEST_CLIENT + '&target=' + encodeURIComponent(digits),
          headers: { 'x-bwn-key': key }, timeout: 15000,
          onload: function (r) {
            try {
              if (r.status >= 200 && r.status < 300) {
                var d = JSON.parse(r.responseText);
                if (d && d.ok === true) { out.saved = d.job || null; out.eq = d.eq || null; out.plan = d.plan || null; }
              }
            } catch (e) { }
            done();
          },
          onerror: function () { done(); }, ontimeout: function () { done(); }
        });
        GM_xmlhttpRequest({
          method: 'GET',
          url: INGEST_URL + '?client=' + INGEST_CLIENT + '&o30=' + encodeURIComponent(digits),
          headers: { 'x-bwn-key': key }, timeout: 15000,
          onload: function (r) {
            try {
              if (r.status >= 200 && r.status < 300) {
                var d = JSON.parse(r.responseText);
                if (d && d.ok === true && d.lines) { out.o30 = d.lines[digits] || d.lines[String(digits)] || null; }
              }
            } catch (e) { }
            done();
          },
          onerror: function () { done(); }, ontimeout: function () { done(); }
        });
      } catch (e) { resolve(out); }
    });
  }

  // ====================================================================
  // RENDER DATA LOCALS  (reassigned per open; the ported helpers close over
  // these instead of the dashboard globals)
  // ====================================================================
  var JOBS = [];
  var JOB_NOTES = {};
  var O30_LINES = {};
  var JOB_PLANS = {};
  var EQ_STATE = { items: {} };
  var STATUS_HIST = {};        // no status-note history source here → stays empty
  var VENDOR_KIND = {};        // no vendor-kind override source here → stays empty
  var _jvBody = null;          // the card element openJobModal renders into
  var _jvClose = null;         // active modal's close()

  // ====================================================================
  // PORTED HELPERS - VERBATIM from the dashboard except the noted seams.
  // ====================================================================

  var escapeHtml = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var fmt$0 = function (n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
  var ageCls = function (d) { return d >= 90 ? 'age-high' : d >= 30 ? 'age-warn' : 'age-ok'; };

  function parseExcelDate(v) {
    if (!v && v !== 0) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number') {
      var epoch = new Date(Date.UTC(1899, 11, 30));
      return new Date(epoch.getTime() + v * 86400000);
    }
    var d = new Date(String(v));
    return isNaN(d) ? null : d;
  }
  function fmtDate(v) { var d = v ? parseExcelDate(v) : null; return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }

  var jobType = function (j) {
    if (typeof j === 'string') j = { jobId: j, projectType: '' };
    var pt = (j.projectType || '').toUpperCase().trim();
    if (pt) {
      if (/WIFI|WI.?FI/.test(pt)) return 'WIFI';
      if (/^RF$|RETRO/.test(pt)) return 'Retrofit';
      if (/^Q\/?R$/.test(pt)) return 'Q/R';
      if (/SERVICE/.test(pt)) return 'Service';
      return pt;
    }
    var u = (j.jobId || '').toUpperCase();
    if (/WIFI|WI-FI/.test(u)) return 'WIFI';
    if (/^RF\s|^RF\d/.test(u)) return 'Retrofit';
    return 'Service';
  };

  var staleBucket = function (j) {
    if (j.daysSinceUpdate === null || j.daysSinceUpdate === undefined) return 'never';
    if (j.daysSinceUpdate >= 7) return 'stale';
    return 'recent';
  };

  var normPriority = function (p) {
    var s = (p || '').toLowerCase().trim();
    if (/^h/.test(s)) return 'High';
    if (/^m/.test(s)) return 'Med';
    if (/^l/.test(s)) return 'Low';
    return '';
  };

  var needsAssist = function (j) { var v = String(j.mgmtAssist || '').trim().toLowerCase(); if (!v || /^(no|n|n\/a|na|false|0|none|-|-|ok)$/.test(v)) return false; return /^(y|yes|true|1|x|✓|✔)$/.test(v) || /^(need|req|escalat|assist|urgent|mgmt|help)/.test(v); };

  function priorityBucket(p) {
    var s = (p || '').toUpperCase().trim();
    if (!s) return '';
    if (/^P1\b|CRITICAL/.test(s)) return 'P1';
    if (/^P2\b|NEXT DAY/.test(s)) return 'P2';
    if (/^P3\b|STANDARD/.test(s)) return 'P3';
    if (/^P4\b|^PM\b|\bPM$/.test(s)) return 'P4';
    if (/RED|HIGH PRIORITY/.test(s)) return 'Red';
    if (/YELLOW|MEDIUM PRIORITY/.test(s)) return 'Yellow';
    if (/BLUE|LOW PRIORITY/.test(s)) return 'Blue';
    return 'Other';
  }

  function priorityPill(p) {
    if (!p) return '';
    var b = priorityBucket(p);
    var cls = 'pri2 pri2-' + b.toLowerCase();
    var short = p.replace(/\s*-\s*(Low|Medium|High)\s*Priority\s*$/i, '').trim();
    return '<span class="' + cls + '" title="' + escapeHtml(p) + '">' + escapeHtml(short) + '</span>';
  }

  function riskBadge(r) {
    if (r === 'HIGH RISK') return '<span class="badge b-red" title="High risk - aged and/or breaching its SLA target; needs attention now">HIGH RISK</span>';
    if (r === 'WATCH') return '<span class="badge b-amber" title="Watch - at risk of slipping; monitor closely">WATCH</span>';
    return '<span class="badge b-green" title="On track - within targets">OK</span>';
  }

  function statusBadge(s) {
    var cls = s.includes('Clocked Out') || s === 'On-Site' ? 'b-green' :
      s.includes('Proposal') || s === 'Scheduled' ? 'b-blue' :
        s.includes('Pending') || s.includes('Waiting') ? 'b-amber' : 'b-gray';
    return '<span class="badge ' + cls + '">' + escapeHtml(s) + '</span>';
  }

  var SUPPLIER_PATTERNS = [/\bLSI\b/i, /INDUSTRIES/i, /LIGHTING/i, /LIGHTMART/i, /MANUFACTUR/i, /\bSUPPLY\b/i, /SUPPLIES/i, /\bMATERIALS?\b/i, /GRAYBAR/i, /REXEL/i, /WESCO/i, /\bUPS\b/i, /UNITED PARCEL/i, /FEDEX/i, /FREIGHT/i, /LOGISTICS/i, /ROBINSON/i, /\bXPO\b/i, /OLD DOMINION/i, /TRUCKING/i, /SHIPPING/i, /ELECTRIC SUPPLY/i, /WHOLESALE/i, /DISTRIBUT/i, /\bCDW\b/i, /\bLOOMIN\b/i, /UNITED HDD/i, /\bELECTRONICS\b/i, /\bACAVATI\b/i, /ENERGY LIGHT/i, /SUNBELT/i, /\bRENTALS?\b/i, /\bPOST IT\b/i, /BATTERYSTUFF/i, /\bBATTER(Y|IES)\b/i, /MURDOCH/i];
  var VENDOR_OVERRIDES = [/CERTIFIED LIGHTING/i, /KILGORE INDUSTRIES/i, /LIGHTING MAINTENANCE/i, /LED ELECTRIC AND LIGHTING/i];
  function vkKey(name) { return String(name || '').trim().toUpperCase().replace(/\s+/g, ' '); }
  function vendorKind(name) { var n = String(name || ''); if (!n.trim()) return ''; var ov = VENDOR_KIND[vkKey(n)]; if (ov && ov.kind) return ov.kind; for (var i = 0; i < VENDOR_OVERRIDES.length; i++) { if (VENDOR_OVERRIDES[i].test(n)) return 'vendor'; } for (var k = 0; k < SUPPLIER_PATTERNS.length; k++) { if (SUPPLIER_PATTERNS[k].test(n)) return 'supplier'; } return 'vendor'; }

  function splitVendors(str) {
    var raw = String(str || '').split(/[;|\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var SUF = /^(inc\.?|llc|l\.l\.c\.?|co\.?|corp\.?|ltd\.?|lp|l\.p\.?|llp|pllc|p\.c\.?|pc|company|incorporated)$/i;
    var parts = [];
    raw.forEach(function (p) { if (parts.length && SUF.test(p)) { parts[parts.length - 1] += ', ' + p; } else parts.push(p); });
    return parts;
  }

  function vendorListHtml(str) {
    var parts = splitVendors(str);
    if (!parts.length) return '-';
    return '<span class="vpills">' + parts.map(function (p) { var sup = vendorKind(p) === 'supplier'; return '<span class="vpill' + (sup ? ' vpill-sup' : '') + '" title="' + (sup ? 'Supplier' : 'Vendor') + '">' + escapeHtml(p) + (sup ? '<span class="vpill-tag">SUP</span>' : '') + '</span>'; }).join('') + '</span>';
  }

  // eqChronicCount dropped (no window._o30History here) → chronic count is 0.
  function eqNoNextStep(j) {
    if (j.nextOnsiteDate) return false;
    return !/scheduled|complete|validat|atf|clocked|invoice|closed/i.test(j.status || '');
  }
  function eqPastEta(j) {
    if (!j.expectedCompletion) return false;
    var d = new Date(j.expectedCompletion);
    if (isNaN(d.getTime())) return false;
    return d < new Date(new Date().toDateString());
  }
  function eqTerminal(j) {
    var s = (j.status || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return /work complete|resolved|pending ability to bill|invoice created|invoice rejected|invoice approved|invoiced|\bpaid\b|\bclosed\b|cancell?ed|declined|revoked|\bvoid\b/.test(s);
  }
  var EQ_REASONS = {
    'never-updated': { label: 'Never updated', w: 30 },
    'mgmt-assist': { label: 'Mgmt assist', w: 24 },
    'past-eta': { label: 'Past ETA', w: 22 },
    'chronic': { label: 'Chronic', w: 20 },
    'stale-7d': { label: 'Stale 7d+', w: 18 },
    'no-next-step': { label: 'No next step', w: 16 },
    'high-priority': { label: 'High priority', w: 14 }
  };
  var EQ_ACTION = {
    'never-updated': 'Add a status update - no notes on record',
    'mgmt-assist': '⤴ Escalate to management - flagged for assist',
    'past-eta': 'Revise expected completion - past ETA',
    'chronic': '⤴ Escalate to management - stuck over-30 across 3+ audits',
    'stale-7d': 'Update the job - no note in 7+ days',
    'no-next-step': 'Schedule next onsite / set the next step',
    'high-priority': 'Prioritize - high priority and aging'
  };
  function eqReasons(j) {
    var r = [];
    if (eqTerminal(j)) return r;
    var sb = staleBucket(j);
    if (sb === 'never') r.push('never-updated');
    else if (sb === 'stale') r.push('stale-7d');
    if (eqNoNextStep(j)) r.push('no-next-step');
    if (eqPastEta(j)) r.push('past-eta');
    // chronic dropped: no over-30 history source in the userscript context.
    var pri = priorityBucket(j.priority);
    if (normPriority(j.escalationPriority) === 'High' || pri === 'P1' || pri === 'P2' || pri === 'Red') r.push('high-priority');
    if (needsAssist(j)) r.push('mgmt-assist');
    return r;
  }
  function eqStatus(jobId) {
    var it = EQ_STATE.items[jobId];
    if (!it) return { state: 'open' };
    if (it.state === 'snooze') {
      if (it.until) { var u = new Date(it.until + 'T23:59:59'); if (!isNaN(u.getTime()) && u < new Date()) return { state: 'open', expired: true }; }
      return { state: 'snooze', until: it.until, by: it.by, ts: it.ts };
    }
    if (it.state === 'ack') return { state: 'ack', by: it.by, ts: it.ts };
    return { state: 'open' };
  }

  function mdInline(parent, text) {
    var re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_)/g, m, last = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var bold = m[2] !== undefined;
      var node = document.createElement(bold ? 'strong' : 'em');
      node.textContent = bold ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
      parent.appendChild(node);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function bnRenderCaseFile(container, src) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var lines = (src || '').replace(/\r/g, '').split('\n');
    var ul = null, ol = null, tl = null, first = true, section = 'other', flagN = 0;
    var HOT_FLAG = /\b(escalat|overdue|unpaid|halt|cannot|breach|urgent|immediately|lien|default|stop work)\b/i;
    var HOT_TL = /\b(escalat|halt|hospital|accident|overdue|dispute|rejected|cancel|lawsuit|lien)\b/i;
    var flushUl = function () { if (ul) { container.appendChild(ul); ul = null; } };
    var flushOl = function () { if (ol) { container.appendChild(ol); ol = null; } };
    var flushTl = function () { if (tl) { container.appendChild(tl); tl = null; } };
    var flushAll = function () { flushUl(); flushOl(); flushTl(); };
    var addP = function (txt, cls) { var p = document.createElement('p'); if (cls) p.className = cls; mdInline(p, txt); container.appendChild(p); };
    var heading = function (txt) { flushAll(); var hd = document.createElement('div'); hd.className = 'nd-h'; hd.textContent = txt.replace(/\*\*/g, '').replace(/:\s*$/, '').trim(); container.appendChild(hd); };
    var capsLabel = function (s) { var core = s.replace(/\([^)]*\)/g, ''); return (core.match(/[a-z]/g) || []).length <= 1 && /[A-Z]/.test(core); };
    var sectionOf = function (label) { var L = label.toUpperCase(); if (/RISK FLAG/.test(L)) return 'flags'; if (/VENDOR|SUPPLIER/.test(L)) return 'vendors'; if (/TIMELINE/.test(L)) return 'timeline'; if (/NEXT ACTION|NEXT STEP|ACTION ITEM/.test(L)) return 'actions'; if (/BLOCK|REMAIN|DONE SO FAR/.test(L)) return 'list'; if (/STATUS/.test(L)) return 'status'; return 'other'; };
    var isTableRow = function (s) { return /^\|/.test(s) && (s.match(/\|/g) || []).length >= 2; };
    var isSep = function (c) { return /-/.test(c) && /^[\s:|-]+$/.test(c); };
    function flagCard(txt) {
      flushAll();
      txt = txt.replace(/^\s*(?:\d+[.)]|[•\-*])\s*/, '').replace(/^FLAG\s*[:\--]\s*/i, '');
      flagN++;
      var card = document.createElement('div'); card.className = 'nd-flag' + (HOT_FLAG.test(txt) ? ' hot' : '');
      var nn = document.createElement('span'); nn.className = 'fn'; nn.textContent = flagN;
      var body = document.createElement('span'); mdInline(body, txt.replace(/\bFLAG:\s*/gi, ''));
      card.appendChild(nn); card.appendChild(body); container.appendChild(card);
    }
    function vendorCard(line) {
      flushAll();
      var segs = line.split(/\s+-\s+/);
      var nameRaw = segs[0] || line; var people = '', name = nameRaw, role = '', detail = '';
      var pm = nameRaw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      if (pm) { name = pm[1].trim(); people = pm[2].trim(); }
      if (segs.length >= 3) { role = segs[1].trim(); detail = segs.slice(2).join(' - '); }
      else { detail = segs.slice(1).join(' - '); }
      var money = [], seen = {}; var mm; var mre = /\$[\d,]+(?:\.\d+)?\s?[KkMm]?/g;
      while ((mm = mre.exec(line)) !== null) { var v = mm[0].replace(/\s+/g, ''); if (!seen[v]) { seen[v] = 1; money.push(v); } }
      var card = document.createElement('div'); card.className = 'nd-vend';
      var main = document.createElement('div'); main.className = 'vn-main';
      var headEl = document.createElement('div'); headEl.className = 'vn-head';
      var nmEl = document.createElement('span'); nmEl.className = 'vn-name'; nmEl.textContent = name; headEl.appendChild(nmEl);
      if (vendorKind(name) === 'supplier') { var kd = document.createElement('span'); kd.className = 'nd-kind nd-sup'; kd.textContent = 'Supplier'; headEl.appendChild(kd); }
      if (role) { var rl = document.createElement('span'); rl.className = 'vn-role'; rl.textContent = role; headEl.appendChild(rl); }
      main.appendChild(headEl);
      if (people) { var pe = document.createElement('div'); pe.className = 'vn-people'; pe.textContent = people; main.appendChild(pe); }
      var parts = detail.split(/;\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (parts.length) { var dl = document.createElement('ul'); dl.className = 'vn-det'; parts.forEach(function (p) { var li = document.createElement('li'); mdInline(li, p); dl.appendChild(li); }); main.appendChild(dl); }
      card.appendChild(main);
      var moneyEl = document.createElement('div'); moneyEl.className = 'vn-money';
      if (money.length) { money.forEach(function (v) { var s = document.createElement('span'); s.className = 'vn-amt'; s.textContent = v; moneyEl.appendChild(s); }); }
      else { var dash = document.createElement('span'); dash.className = 'vn-amt none'; dash.textContent = '-'; moneyEl.appendChild(dash); }
      card.appendChild(moneyEl); container.appendChild(card);
    }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { flushAll(); continue; }
      if (isTableRow(t)) {
        flushAll();
        var rows = []; var jj = i;
        while (jj < lines.length && isTableRow(lines[jj].trim())) {
          var p = lines[jj].trim().split('|'); if (p.length && p[0].trim() === '') p.shift(); if (p.length && p[p.length - 1].trim() === '') p.pop();
          rows.push(p.map(function (x) { return x.trim(); })); jj++;
        }
        var dataRows = rows.filter(function (rw) { return !(rw.length > 0 && rw.every(isSep)); });
        var head = dataRows.length ? dataRows[0] : null;
        var vendorTbl = section === 'vendors' || (head && /vendor|supplier|company/i.test(head.join(' ')));
        var table = document.createElement('table'); table.className = 'nd-table';
        if (head) { var trh = document.createElement('tr'); head.forEach(function (c) { var th = document.createElement('th'); th.textContent = c; trh.appendChild(th); }); table.appendChild(trh); }
        for (var kk = 1; kk < dataRows.length; kk++) { var tr = document.createElement('tr'); dataRows[kk].forEach(function (c, ci) { var tdc = document.createElement('td'); if (vendorTbl && ci === 0 && vendorKind(c) === 'supplier') { tdc.textContent = c + ' '; var kd2 = document.createElement('span'); kd2.className = 'nd-kind nd-sup'; kd2.textContent = 'Supplier'; tdc.appendChild(kd2); } else { tdc.textContent = c; } tr.appendChild(tdc); }); table.appendChild(tr); }
        container.appendChild(table); i = jj - 1; continue;
      }
      if (first) { first = false; flushAll(); var ttl = document.createElement('div'); ttl.className = 'nd-title'; ttl.textContent = t.replace(/\*\*/g, ''); container.appendChild(ttl); continue; }
      if (/\|/.test(t) || /^tracking\s*#|internal use only/i.test(t)) { flushAll(); addP(t, 'nd-sub'); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushAll(); container.appendChild(document.createElement('hr')); continue; }
      var hm = t.match(/^#{1,6}\s+(.*)$/);
      var wb = t.match(/^\*\*([^*]+)\*\*$/);
      var lc = t.match(/^([A-Z0-9][A-Z0-9 .,'\/&()\-]{2,46}?):\s*(.*)$/);
      var bare = (!hm && !wb && !lc && t.length <= 42 && capsLabel(t) && sectionOf(t) !== 'other') ? t : null;
      if (hm || wb || (lc && capsLabel(lc[1])) || bare) {
        var label = hm ? hm[1] : wb ? wb[1] : lc ? lc[1] : t;
        var sec = sectionOf(label);
        if (section === 'flags' && sec === 'other' && lc && !hm && !wb) { flagCard(t); continue; }
        heading(label); section = sec; flagN = 0;
        if (lc && lc[2] && lc[2].trim()) { if (section === 'status') { var cb = document.createElement('div'); cb.className = 'nd-status'; mdInline(cb, lc[2].trim()); container.appendChild(cb); } else addP(lc[2].trim()); }
        continue;
      }
      if (section === 'vendors') { vendorCard(t); continue; }
      if (section === 'flags') { flagCard(t); continue; }
      var dm = t.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:[–\-]\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?)\s+[-–\-]\s+(.*)$/);
      if (dm) { flushUl(); flushOl(); if (!tl) { tl = document.createElement('div'); tl.className = 'nd-tl'; } var rowd = document.createElement('div'); rowd.className = 'nd-tlrow' + (HOT_TL.test(dm[2]) ? ' hot' : ''); var ds = document.createElement('span'); ds.className = 'nd-tldate'; ds.textContent = dm[1]; var tx = document.createElement('span'); tx.className = 'nd-tltext'; mdInline(tx, dm[2]); rowd.appendChild(ds); rowd.appendChild(tx); tl.appendChild(rowd); continue; }
      flushTl();
      var nm2 = t.match(/^(\d+)[.)]\s+(.*)$/);
      if (nm2) { flushUl(); if (!ol) { ol = document.createElement('ol'); ol.className = 'nd-ol'; } var oli = document.createElement('li'); mdInline(oli, nm2[2]); ol.appendChild(oli); continue; }
      flushOl();
      var bm = t.match(/^([•\-*])\s+(.*)$/);
      if (bm || section === 'list') { if (!ul) { ul = document.createElement('ul'); ul.className = 'nd-ul'; } var bli = document.createElement('li'); mdInline(bli, bm ? bm[2] : t); ul.appendChild(bli); continue; }
      flushUl();
      addP(t);
    }
    flushAll();
  }

  function renderNoteHtml(text) {
    var box = document.createElement('div');
    bnRenderCaseFile(box, String(text || ''));
    return box.innerHTML || '<p class="nd-p nd-empty">No note yet.</p>';
  }

  function splitGlued(s, dropPre) {
    var str = String(s || '');
    var re = /(^|[.\n;:])[ \t]*(\d{1,2})[.)]\s+/g; var mm, marks = [];
    while ((mm = re.exec(str)) !== null) marks.push({ m: mm.index + mm[0].indexOf(mm[2]), t: mm.index + mm[0].length });
    if (marks.length < 2) return str.replace(/\s+/g, ' ').trim() ? [str.replace(/\s+/g, ' ').trim()] : [];
    var out = []; var pre = str.slice(0, marks[0].m).replace(/^\s*(?:\d+[.)]|[•\-*])\s*/, '').replace(/\s+/g, ' ').trim(); if (pre && !dropPre) out.push(pre);
    for (var i = 0; i < marks.length; i++) { var e = (i + 1 < marks.length) ? marks[i + 1].m : str.length; var t = str.slice(marks[i].t, e).replace(/\s+/g, ' ').trim(); t = t.replace(/\s*(tracking\s*#|wo\s*#|status\s*:|risk flag|done so far)\b.*$/i, '').trim(); if (t) out.push(t); }
    return out;
  }

  function extractNextActions(text) {
    var src = String(text || ''); var ls = src.replace(/\r/g, '').split('\n');
    var headLabel = function (s) { var t = s.trim(); var hm = t.match(/^#{1,6}\s+(.*)$/); var wb = t.match(/^\*\*([^*]+)\*\*$/); var lc = t.match(/^([A-Z0-9][A-Z0-9 .,'\/&()\-]{2,46}?):\s*(.*)$/); var bt = (!hm && !wb && !lc && t.length <= 42 && /^[A-Z0-9][A-Z0-9 .,'\/&()\-]*$/.test(t) && (t.match(/[a-z]/g) || []).length <= 1 && /[A-Z]/.test(t)) ? t : null; var bare = (bt && /STATUS|RISK FLAG|VENDOR|SUPPLIER|TIMELINE|NEXT ACTION|NEXT STEP|ACTION ITEM|BLOCK|REMAIN|DONE SO FAR/.test(bt)) ? bt : null; return hm ? hm[1] : wb ? wb[1] : lc ? lc[1] : bare; };
    var start = -1;
    for (var i = 0; i < ls.length; i++) { var h = headLabel(ls[i]); if (h && /NEXT ACTION|NEXT STEP|ACTION ITEM/i.test(h)) { start = i; break; } }
    if (start < 0) {
      var hm = src.match(/next\s*actions?\s*required|next\s*actions?\b|next\s*steps?\b|action\s*items?\b/i);
      if (hm) { var items = splitGlued(src.slice(hm.index + hm[0].length), true); if (items.length >= 2) return { actions: items, rest: src.slice(0, hm.index).trim() }; }
      return { actions: [], rest: src };
    }
    var end = ls.length;
    for (var j = start + 1; j < ls.length; j++) { if (headLabel(ls[j])) { end = j; break; } }
    var actions = [];
    var inline = ls[start].match(/:\s*(.+)$/); if (inline) actions.push(inline[1].trim());
    var isItem = function (t) { return /^\s*(?:\d+[.)]|[•\-*])\s+/.test(t); };
    var seg = ls.slice(start + 1, end);
    var sawItem = false, cut = seg.length;
    for (var k = 0; k < seg.length; k++) {
      var tt = seg[k].trim();
      if (tt === '') { continue; }
      if (isItem(tt)) { sawItem = true; actions.push(tt.replace(/^\s*(?:\d+[.)]|[•\-*])\s*/, '')); continue; }
      if (sawItem) { cut = k; break; }
      actions.push(tt);
    }
    var secEnd = start + 1 + cut;
    var rest = ls.slice(0, start).concat(ls.slice(secEnd)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    var actionsOut = []; actions.forEach(function (a) { splitGlued(a).forEach(function (x) { actionsOut.push(x); }); });
    return { actions: actionsOut, rest: rest };
  }

  function nextActionsCardHtml(actions) {
    if (!actions || !actions.length) return '';
    var ol = document.createElement('ol'); ol.className = 'nd-ol';
    actions.forEach(function (a) { var li = document.createElement('li'); mdInline(li, a); ol.appendChild(li); });
    return ol.outerHTML;
  }

  function naHistoryHtml(hist) {
    if (!Array.isArray(hist) || !hist.length) return '';
    var wrap = document.createElement('details'); wrap.className = 'jm-na-hist';
    var sum = document.createElement('summary'); sum.textContent = 'Previous next actions (' + hist.length + ')'; wrap.appendChild(sum);
    hist.forEach(function (h) {
      var blk = document.createElement('div'); blk.className = 'jm-na-hist-blk';
      var dt = document.createElement('div'); dt.className = 'jm-na-hist-dt';
      dt.textContent = h && h.archivedAt ? new Date(h.archivedAt).toLocaleDateString() : 'archived';
      blk.appendChild(dt);
      var ol = document.createElement('ol'); ol.className = 'nd-ol';
      ((h && h.actions) || []).forEach(function (a) { var li = document.createElement('li'); mdInline(li, a); ol.appendChild(li); });
      blk.appendChild(ol);
      wrap.appendChild(blk);
    });
    return wrap.outerHTML;
  }

  function stuckReason(j) {
    var s = (j.status || '').toLowerCase();
    var stage;
    if (/material/.test(s)) stage = 'Waiting on materials to be ordered or delivered.';
    else if (/3rd party|third party/.test(s)) stage = 'Blocked on a third party (utility, OWL, or another vendor).';
    else if (/proposal|proposed/.test(s)) stage = 'Sitting in the proposal stage - awaiting approval.';
    else if (/pending schedule/.test(s)) stage = 'Approved but not yet scheduled.';
    else if (/scheduled/.test(s)) stage = 'Scheduled - awaiting the on-site date.';
    else if (/in progress|on-?site/.test(s)) stage = 'Work is underway on site.';
    else if (/atf/.test(s)) stage = 'In post-completion paperwork (ATF).';
    else if (/client/.test(s)) stage = 'Waiting on the client to act.';
    else if (/dispatch|recruit|compliance|specialist/.test(s)) stage = 'Still finding or onboarding a vendor.';
    else stage = 'In “' + (j.status || 'an unknown status') + '”.';
    var activity;
    if (j.daysSinceUpdate == null) activity = 'No update has ever been logged - this one needs a touch.';
    else if (j.daysSinceUpdate >= 14) activity = 'No activity in ' + j.daysSinceUpdate + ' days - likely stalled.';
    else if (j.daysSinceUpdate >= 7) activity = 'Last touched ' + j.daysSinceUpdate + ' days ago - going quiet.';
    else activity = 'Updated ' + j.daysSinceUpdate + ' day' + (j.daysSinceUpdate === 1 ? '' : 's') + ' ago.';
    var inStatus = j.statusHrs > 0 ? Math.round(j.statusHrs / 24) : null;
    return { stage: stage, activity: activity, inStatus: inStatus };
  }

  function lifecycleStripHtml(j) {
    var today = Date.now();
    var md = function (d) { return (d && !isNaN(d)) ? ((d.getMonth() + 1) + '/' + d.getDate()) : ''; };
    var wo = parseExcelDate(j.woDate), ft = parseExcelDate(j.firstTripDate), no = parseExcelDate(j.nextOnsiteDate), exp = parseExcelDate(j.expectedCompletion);
    var seq = [{ d: wo, l: 'Created' }, { d: ft, l: 'First trip' }, { d: no, l: 'Next onsite' }];
    var nextIdx = -1;
    for (var i = 0; i < seq.length; i++) { if (seq[i].d && seq[i].d.getTime() > today) { nextIdx = i; break; } }
    var nodes = seq.map(function (n, i) {
      var cls = !n.d ? 'empty' : (i === nextIdx ? 'next' : (n.d.getTime() <= today ? 'done' : 'future'));
      return { cls: cls, date: n.d ? md(n.d) : '-', lbl: n.l };
    });
    var tcCls, tcDate;
    if (exp) { tcDate = md(exp); tcCls = exp.getTime() < today ? 'miss' : (nextIdx < 0 ? 'next' : 'future'); }
    else { tcCls = 'empty'; tcDate = '-'; }
    nodes.push({ cls: tcCls, date: tcDate, lbl: 'Target close' });
    var rail = nodes.map(function (n) { return '<div class="lc-node ' + n.cls + '"><div class="lc-dot"></div><div class="lc-date">' + n.date + '</div><div class="lc-lbl">' + n.lbl + '</div></div>'; }).join('');
    var badge = '';
    if (exp) { var dl = Math.ceil((exp.getTime() - today) / 86400000); badge = dl < 0 ? '<span class="lc-badge late">Past due ' + (-dl) + 'd</span>' : '<span class="lc-badge ok">On track · ' + dl + 'd left</span>'; }
    return '<div class="lc-head"><span class="lc-title">Lifecycle</span>' + badge + '</div><div class="lc-rail">' + rail + '</div>';
  }

  // loadO30Lines dropped - O30_LINES is pre-populated per open.
  function o30LineHtml(jobId, liveNoteTs) {
    if (!O30_LINES) return '';
    var rec = Object.prototype.hasOwnProperty.call(O30_LINES, jobId) ? O30_LINES[jobId] : null;
    if (!rec) { var dg = String(jobId || '').replace(/\D+/g, ''); if (dg && Object.prototype.hasOwnProperty.call(O30_LINES, dg)) rec = O30_LINES[dg]; }
    if (!rec || !rec.line) return '';
    var d = new Date(rec.ts || 0);
    var when = isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '/' + d.getDate();
    var ageD = isNaN(d.getTime()) ? null : Math.floor((Date.now() - +d) / 86400000);
    var stale = ageD !== null && ageD > 7;
    // Newest-wins across authors: if the WO has a note NEWER than this stored line (e.g. a
    // supervisor updated it since it was drafted), flag it as superseded so the coordinator
    // re-runs Over 30 rather than trusting a stale line. (The Over-30 DRAFT already reads the
    // newest note regardless of author; this surfaces staleness on the DISPLAYED stored line.)
    var recTs = isNaN(d.getTime()) ? 0 : +d;
    var lnTs = liveNoteTs ? (+new Date(liveNoteTs)) : 0;
    var superseded = !!(recTs && lnTs && lnTs > recTs + 60000);
    var flag = superseded
      ? ' · <span style="color:#b45309;font-weight:600;">newer note since - re-run Over 30</span>'
      : (stale ? ' · <span style="color:#b45309;font-weight:500;">' + ageD + 'd old</span>' : '');
    return '<div class="jm-section-label">Latest Over-30 line' + (when ? ' <span style="font-weight:500;color:var(--muted);">- entered ' + escapeHtml(when) + (rec.by ? ' by ' + escapeHtml(rec.by) : '') + flag + '</span>' : '') + '</div>'
      + '<div class="jn-doc-card"><div class="np-text" style="font-family:ui-monospace,\'Segoe UI Mono\',\'SF Mono\',monospace;font-size:11.5px;">' + escapeHtml(rec.line) + '</div></div>';
  }

  // loadJobPlans dropped - JOB_PLANS is pre-populated per open.
  function jobPlanFor(jobId) {
    if (!JOB_PLANS) return null;
    var rec = Object.prototype.hasOwnProperty.call(JOB_PLANS, jobId) ? JOB_PLANS[jobId] : null;
    if (!rec) { var dg = String(jobId || '').replace(/\D+/g, ''); if (dg && Object.prototype.hasOwnProperty.call(JOB_PLANS, dg)) rec = JOB_PLANS[dg]; }
    return (rec && Array.isArray(rec.items) && rec.items.length) ? rec : null;
  }

  // loadStatusHist dropped - STATUS_HIST stays empty (no source here).
  function statusHistoryHtml(jobId) {
    var rec = STATUS_HIST[jobId];
    if (!rec || !Array.isArray(rec.hist) || !rec.hist.length) return '';
    var det = document.createElement('details'); det.className = 'nd-shist';
    var sum = document.createElement('summary'); sum.textContent = 'Previous status notes (' + rec.hist.length + ')'; det.appendChild(sum);
    rec.hist.forEach(function (h) {
      var blk = document.createElement('div'); blk.className = 'nd-shist-blk';
      var dt = document.createElement('div'); dt.className = 'nd-shist-dt';
      dt.textContent = h && h.capturedAt ? new Date(h.capturedAt).toLocaleDateString() : 'archived';
      blk.appendChild(dt);
      var tx = document.createElement('div'); tx.className = 'nd-shist-tx'; tx.textContent = String((h && h.note) || '');
      blk.appendChild(tx); det.appendChild(blk);
    });
    return det.outerHTML;
  }

  // jmNextActionsBlock - seam: dropped window._jnNAActions writes; ⧉ Copy is
  // rewired via [data-jv-copy] (no inline onclick).
  function jmNextActionsBlock(id, na, saved) {
    if (na.actions.length) {
      return '<div class="jm-na"><div class="jm-na-h"><span>Next Actions Required</span><button type="button" class="jm-na-copy" data-jv-copy title="Copy these next actions">⧉ Copy</button></div>' + nextActionsCardHtml(na.actions) + naHistoryHtml(saved.naHistory) + '</div>';
    }
    var jp = jobPlanFor(id);
    if (jp) {
      var d = new Date(jp.ts || 0); var when = isNaN(d.getTime()) ? '' : (d.getMonth() + 1) + '/' + d.getDate();
      var sub = '· from the job' + (when ? ' · ' + escapeHtml(when) : '') + (jp.by ? ' · ' + escapeHtml(jp.by) : '');
      return '<div class="jm-na"><div class="jm-na-h"><span>Next Actions Required <span style="font-weight:500;color:var(--muted);">' + sub + '</span></span><button type="button" class="jm-na-copy" data-jv-copy title="Copy these next actions">⧉ Copy</button></div>' + nextActionsCardHtml(jp.items) + naHistoryHtml(saved.naHistory) + '</div>';
    }
    return (saved.naHistory && saved.naHistory.length) ? '<div class="jm-na">' + naHistoryHtml(saved.naHistory) + '</div>' : '';
  }

  // openJobModal - the ported render. Seams applied:
  //  · no fromEntity / window._jmReturn / Back button
  //  · no window._jn* writes; no _bnModalOpen (openJobView owns the shell + a11y)
  //  · left holdup: AI-summary generate button removed (read-only)
  //  · _fThr → O30_THRESHOLD
  //  · right column: editor removed, note rendered read-only
  //  · null-guards on age-pill / risk badge / status badge for the degraded
  //    (GraphQL-missing) path
  // ---- WO Assist pills + next-steps (dock retired; Core computes, this renders) ----
  // Fed by WO Assist's bus publish (bwn:wo:{woNumber}). Returns '' when the bus is absent
  // (Core off / not on a WO page) so the modal degrades cleanly. Each pill click reveals the
  // specific next step for that item; ECD + "mark actioned" round-trip to Core over bwn:cmd,
  // which still owns those interactions (the completion-date helper, the acts store, notes).
  function jvPillKind(k) { return k === 'bad' ? 'p-bad' : k === 'warn' ? 'p-warn' : k === 'ok' ? 'p-ok' : k === 'info' ? 'p-info' : 'p-gray'; }
  function jvStepFor(pill, steps) {
    var pref = pill === 'ecd' ? /^ecd/ : pill === 'eta' ? /^eta/ : pill === 'stall' ? /^stall/ : pill === 'gp' ? /^escalate/ : null;
    if (pref) { for (var i = 0; i < steps.length; i++) { if (pref.test(steps[i].key || '')) return steps[i]; } }
    // status pill: fall back to the top-ranked non-anchor step so it always has guidance
    if (pill === 'status') { for (var k = 0; k < steps.length; k++) { if (!steps[k].anchor) return steps[k]; } }
    return null;
  }
  function jvStepHtml(pill, step, due) {
    var lbl = step ? step.label : (pill === 'ecd' && due ? 'Set an expected completion date' : 'No specific next step for this item.');
    var why = step ? step.why : (pill === 'ecd' && due ? (due.detail || '') : '');
    var acts = '';
    if (step && step.text) acts += '<button type="button" class="jm-step-btn" data-jv-chase="' + escapeHtml(step.key) + '">Copy chase message</button>';
    if (pill === 'ecd') acts += '<button type="button" class="jm-step-btn primary" data-jv-ecd>Set completion date</button>';
    if (step && !step.anchor && step.owner !== 'management') acts += '<button type="button" class="jm-step-btn" data-jv-actioned="' + escapeHtml(step.key) + '">Mark actioned</button>';
    return '<div class="jm-step">'
      + '<div class="jm-step-lbl">' + escapeHtml(lbl) + (step && step.done ? ' <span class="jm-step-done">done</span>' : '') + '</div>'
      + (why ? '<div class="jm-step-why">' + escapeHtml(why) + '</div>' : '')
      + (step && step.text ? '<div class="jm-step-msg">' + escapeHtml(step.text) + '</div>' : '')
      + (acts ? '<div class="jm-step-acts">' + acts + '</div>' : '')
      + '</div>';
  }
  function jvPills() {
    var woNum = ''; try { woNum = readWoNumber(); } catch (e) { }
    if (!woNum) return '';
    var b = null; try { b = BWN.busGet(woNum, 12 * 3600000); } catch (e) { }
    if (!b) return '';
    var steps = Array.isArray(b.nextSteps) ? b.nextSteps : [];
    var pills = [], details = [];
    function add(pill, kind, text, title) {
      pills.push('<button type="button" class="jm-pill ' + jvPillKind(kind) + '" data-jv-pill="' + pill + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(text) + '</button>');
      details.push('<div class="jm-pill-detail" data-jv-detail="' + pill + '" hidden>' + jvStepHtml(pill, jvStepFor(pill, steps), b.due) + '</div>');
    }
    if (b.status) add('status', 'info', b.status, 'Current WO status - click for the next step');
    if (b.due && b.due.label) add('ecd', b.due.kind, b.due.label, b.due.detail || '');
    else add('ecd', 'warn', 'No completion date', 'No expected completion date set');
    if (b.eta && b.eta.label) add('eta', b.eta.ok ? 'ok' : (b.eta.kind || 'warn'), b.eta.ok ? ('ETA ' + b.eta.label) : b.eta.label, b.eta.detail || 'On-site / ETA status');
    if (b.gpPct != null) { var gk = b.gpPct < 0 ? 'bad' : b.gpPct < 20 ? 'warn' : 'ok'; add('gp', gk, 'GP ' + b.gpPct.toFixed(0) + '%', 'Gross profit on this WO'); }
    if (b.dne != null) pills.push('<span class="jm-pill p-gray" title="Do-not-exceed / NTE ceiling">DNE ' + escapeHtml(fmt$0(b.dne)) + '</span>');
    if (b.stall && b.stall.vendor) add('stall', 'bad', 'Stalled: ' + b.stall.vendor + ' ' + b.stall.days + 'd', 'Vendor visit not confirmed');
    if (!pills.length) return '';
    return '<div class="jm-pills" data-jv-pills>' + pills.join('') + '</div><div class="jm-pill-details">' + details.join('') + '</div>';
  }

  // Overlay live WO Assist bus facts onto the job. Core parses these from the live DOM, so on
  // the OPEN work order they beat GraphQL's null/guessed fields (woToJob hardcodes statusHrs
  // null; its coordinator/vendors/notes selectors are unverified guesses). Live-changing fields
  // are refreshed on every render so the modal auto-updates as the WO changes; static facts only
  // fill gaps. No-ops when the bus is absent (Core off / not on a WO page).
  function jvOverlayBus(job) {
    if (!job) return job;
    var woNum = ''; try { woNum = readWoNumber(); } catch (e) { }
    if (!woNum) return job;
    var b = null; try { b = BWN.busGet(woNum, 12 * 3600000); } catch (e) { }
    if (!b) return job;
    // Live (authoritative on the open WO; refreshed every render):
    if (b.hrs != null) job.statusHrs = b.hrs;
    if (b.lastNote) {
      job.lastUpdated = b.lastNote;
      // Recompute days-since from the note date (avoids day-boundary drift on a stored staleDays).
      var dd = Date.now() - (+new Date(b.lastNote));
      if (dd >= 0) job.daysSinceUpdate = Math.floor(dd / 86400000);
    } else if (b.staleDays != null) job.daysSinceUpdate = b.staleDays;
    if (Array.isArray(b.pos)) {
      var vn = b.pos.map(function (p) { return p && p.vendor; }).filter(Boolean);
      if (vn.length) job.vendors = vn.join(', ');
    }
    // Static (fill gaps only):
    if (b.coordinator && !job.coordinator) job.coordinator = b.coordinator;
    if (b.client && !job.client) job.client = b.client;
    if (b.sourcePo && !job.po) job.po = b.sourcePo;
    if (b.wo && !job.wo) job.wo = String(b.wo).replace(/\D+/g, '') || job.wo;
    if (b.vendorTotal != null && !(job.totalVendorNte > 0)) job.totalVendorNte = b.vendorTotal;
    if (b.location && !job.location) job.location = b.location;
    // City/State from the bus address string (fills the authored-only path where GraphQL is absent).
    if ((!job.city || !job.state) && b.addr) {
      var am = /,\s*([^,]+),\s*([A-Za-z]{2})\b/.exec(String(b.addr));
      if (am) { if (!job.city) job.city = am[1].trim(); if (!job.state) job.state = am[2].toUpperCase(); }
    }
    return job;
  }

  function openJobModal(id) {
    var j = JOBS.find(function (x) { return x.jobId === id; }); if (!j) return;
    jvOverlayBus(j);
    var r = stuckReason(j);
    var saved = JOB_NOTES[id] || {};
    // Whitelist the action into a fixed token set - it goes into a class attribute and the
    // value comes from the SWA connector (must never carry arbitrary text into the DOM).
    var action = (saved.action === 'done' || saved.action === 'working') ? saved.action : 'none';
    var hasNote = !!(saved.note && saved.note.trim());
    var na = extractNextActions(saved.note || '');
    var actLbl = action === 'done' ? 'Action taken' : action === 'working' ? 'In progress' : 'No action yet';
    var _fThr = O30_THRESHOLD;
    var _fReasons = (j.aged != null && j.aged > _fThr) ? eqReasons(j) : [];
    var flaggedHtml = '';
    if (_fReasons.length) {
      var _fSt = eqStatus(j.jobId);
      var _fProj = (jobType(j) === 'WIFI' || jobType(j) === 'Retrofit') ? '<span class="eq-chip eq-proj" title="Project-style work (WiFi / RF) - aging past 30 is expected; not the same push-to-closure urgency as Service">📁 project-style</span>' : '';
      var _fChips = _fProj + _fReasons.map(function (c) { var rr = EQ_REASONS[c]; return '<span class="eq-chip eq-r-' + c + '">' + (rr ? rr.label : c) + '</span>'; }).join('');
      var _fActs = _fReasons.map(function (c) { return '<li>' + escapeHtml(EQ_ACTION[c] || c) + '</li>'; }).join('');
      var _fState = '';
      if (_fSt.state === 'ack') _fState = ' <span class="eq-state-pill eq-acked">✓ Ack’d' + (_fSt.by ? ' · ' + escapeHtml(_fSt.by) : '') + '</span>';
      else if (_fSt.state === 'snooze') _fState = ' <span class="eq-state-pill eq-snoozed">😴 until ' + escapeHtml(_fSt.until || '?') + (_fSt.by ? ' · ' + escapeHtml(_fSt.by) : '') + '</span>';
      flaggedHtml = '<div class="jm-flagged"><div class="jm-flagged-h">⚑ Why this is flagged' + _fState + '</div><div class="jm-flagged-chips">' + _fChips + '</div><ul class="jm-flagged-acts">' + _fActs + '</ul><div class="jm-flagged-foot">Acknowledge or snooze in the Exception Queue.</div></div>';
    }
    var box = _jvBody; if (!box) return;
    var row = function (k, v) { return '<div><span class="jm-k">' + k + '</span><span class="jm-v">' + v + '</span></div>'; };
    box.innerHTML = ''
      + '<div class="job-modal-head">'
      + '<div class="jm-head-l">'
      + '<span class="jm-id">' + escapeHtml(j.jobId) + '</span>'
      + '<span class="jm-head-sub">' + escapeHtml(j.coordinator || '-') + (j.location ? ' · ' + escapeHtml(j.location) : '') + '</span>'
      + '</div>'
      + (j.aged != null ? '<span class="age-pill ' + ageCls(j.aged) + '">' + j.aged + 'd</span>' : '')
      + (j.risk ? riskBadge(j.risk) : '')
      + '<button class="jm-x" data-jv-close aria-label="Close">×</button>'
      + '</div>'
      + '<div class="job-modal-body">'
      + jvPills()
      + '<div class="jm-cols">'
      + '<div class="jm-col jm-col-l">'
      + '<div class="jm-holdup"><div class="holdup-row">'
      + '<span><strong>Bottleneck:</strong> <span id="holdupText">' + (saved.summary ? '<span class="ai-tag">AI</span> ' + escapeHtml(saved.summary) : escapeHtml(r.stage) + ' ' + escapeHtml(r.activity) + (r.inStatus != null ? ' It has been in this status about <strong>' + r.inStatus + ' day' + (r.inStatus === 1 ? '' : 's') + '</strong>.' : '')) + '</span></span>'
      + '</div>'
      + '<div class="holdup-meta" id="holdupMeta">' + (saved.summaryAt ? 'AI summary · ' + escapeHtml(new Date(saved.summaryAt).toLocaleString()) : '') + '</div>'
      + '</div>'
      + flaggedHtml
      + jmNextActionsBlock(id, na, saved)
      + '<div class="jm-timing">'
      + '<div class="jt"><div class="jt-n">' + (j.aged != null ? j.aged : '-') + '</div><div class="jt-l">Days open</div></div>'
      + '<div class="jt"><div class="jt-n">' + (j.statusHrs ? (j.statusHrs >= 24 ? Math.round(j.statusHrs / 24) + 'd' : Math.round(j.statusHrs) + 'h') : '-') + '</div><div class="jt-l">In status</div></div>'
      + '<div class="jt"><div class="jt-n">' + (j.daysSinceUpdate == null ? '-' : (j.daysSinceUpdate === 0 ? 'Today' : j.daysSinceUpdate + 'd')) + '</div><div class="jt-l">Since last note</div></div>'
      + '</div>'
      + lifecycleStripHtml(j)
      + '<div class="jm-section-label">Details</div>'
      + '<div class="jm-grid">'
      + row('Status', j.status ? statusBadge(j.status) : '-')
      + row('Age', (j.aged != null ? j.aged : '-') + ' days since created')
      + row('Latest update', fmtDate(j.lastUpdated) ? (fmtDate(j.lastUpdated) + (j.daysSinceUpdate != null ? ' · ' + j.daysSinceUpdate + 'd ago' : '')) : (j.daysSinceUpdate == null ? 'Never' : j.daysSinceUpdate + ' days ago'))
      + row('Priority', priorityPill(j.priority) || '-')
      + row('Approved', j.amount > 0 ? fmt$0(j.amount) : '-')
      + row('FM', escapeHtml(j.fm || '-'))
      + row('Trades', escapeHtml(j.trades || '-'))
      + row('Vendors', vendorListHtml(j.vendors))
      + row('City / State', escapeHtml([j.city, j.state].filter(Boolean).join(', ') || '-'))
      + row('Client', escapeHtml(j.client || '-'))
      + row('Vendor NTE', j.totalVendorNte > 0 ? fmt$0(j.totalVendorNte) : '-')
      + row('WO # / PO #', escapeHtml([(function () { var d = j.wo ? String(j.wo).replace(/\D+/g, '') : ''; return d ? 'W-' + d : ''; })(), j.po].filter(Boolean).join('  ·  ') || '-'))
      + '</div>'
      + o30LineHtml(j.jobId, j.lastUpdated)
      + '<div class="jm-section-label">Drilldown Note</div>'
      + '<div class="jn-doc-card">' + (j.notes ? '<div class="np-text">' + escapeHtml(j.notes) + '</div>' : '<div class="np-text np-empty">No note on file.</div>') + '</div>'
      + statusHistoryHtml(j.jobId)
      + (j.mgmtNotes ? '<div class="jm-section-label">Mgmt notes (from sheet)</div><div class="jn-doc-card"><div class="np-text">' + escapeHtml(j.mgmtNotes) + '</div></div>' : '')
      + '</div>'
      + '<div class="jm-col jm-col-r">'
      + '<div class="jn-block">'
      + '<div class="jn-head">'
      + '<span class="jm-section-label" style="margin:0;">WO Audit Note <span class="jn-hint">' + (jvCanWrite() ? 'editable - saves to the Ops Dashboard' : 'authored on the Ops Dashboard · read-only here') + '</span></span>'
      + (hasNote ? '<span class="jn-pill jn-' + action + '">' + actLbl + '</span>' : '')
      + '</div>'
      + (jvCanWrite()
        ? '<textarea class="jn-edit" data-jv-noteedit spellcheck="true">' + escapeHtml(saved.note || '') + '</textarea>'
          + '<div class="jn-foot"><label class="jn-actsel">Action <select data-jv-noteaction>'
          + '<option value="none"' + (action === 'none' ? ' selected' : '') + '>No action yet</option>'
          + '<option value="working"' + (action === 'working' ? ' selected' : '') + '>In progress</option>'
          + '<option value="done"' + (action === 'done' ? ' selected' : '') + '>Action taken</option></select></label>'
          + '<span class="jn-saved">' + (saved.updatedAt ? 'Last saved ' + escapeHtml(new Date(saved.updatedAt).toLocaleString()) : '') + '</span>'
          + '<button class="jn-save" type="button" data-jv-savenote>Save note</button></div>'
        : (hasNote
          ? '<div class="jn-doc-card nd-doc">' + renderNoteHtml(na.rest) + '</div><div class="jn-foot"><span class="jn-saved">' + (saved.updatedAt ? 'Last saved ' + escapeHtml(new Date(saved.updatedAt).toLocaleString()) : '') + '</span></div>'
          : '<div class="jn-doc-card nd-doc"><p class="nd-p nd-empty">Authored notes &amp; AI summary live on the Ops Dashboard.</p></div>'))
      + '</div>'
      + '</div>'
      + '</div>'
      + '</div>';
  }

  // ====================================================================
  // MODAL SHELL  (mirrors the Client Update overlay pattern)
  // ====================================================================
  var JV_CSS = `
#bwn-jv-overlay{position:fixed;top:0;bottom:0;left:var(--bwn-dock-w,158px);z-index:100000;display:flex;overflow:hidden;font-variant-numeric:tabular-nums;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;
  --color-bg:#f0f4f8;--color-surface:#ffffff;--color-surface-alt:#f8fafc;--color-surface-faint:#fafffe;
  --color-text:#1e293b;--color-text-muted:#64748b;--color-text-ghost:#94a3b8;
  --color-border:#e2e8f0;--color-border-strong:#cbd5e1;
  --color-primary:#1a5f3e;--color-primary-strong:#0d3d26;--color-primary-faint:#f0fdf4;--color-primary-mid:#c6f0da;
  --color-accent:#2ECC71;--color-success:#2ECC71;--color-success-bg:#f0fdf4;--color-success-border:#c6f0da;--color-success-text:#1a5f3e;
  --color-warning:#f39c12;--color-warning-bg:#fff8e6;--color-warning-border:#f0d87a;--color-warning-text:#7d5a00;
  --color-danger:#e74c3c;--color-danger-bg:#fef0ee;--color-danger-border:#f7c9c9;--color-danger-text:#8b1a1a;
  --color-info:#3498db;--color-info-bg:#eaf4fd;--color-info-border:#bbd7f0;--color-info-text:#1a5699;
  --color-surface-sunken:#f1f5f9;--color-text-soft:#475569;--color-danger-bg-alt:#fde8e8;--color-warning-bg-alt:#fff3cd;--color-success-mid:#d1f0e6;
  --color-on-accent:#ffffff;--color-brand-ink:#1a5f3e;--color-sidebar:#1e293b;
  --green:#2ECC71;--green-dk:#1a5f3e;--green-bg:#f0fdf4;--amber:#f39c12;--amber-bg:#fff8e6;--red:#e74c3c;--red-bg:#fef0ee;--blue:#3498db;--blue-bg:#eaf4fd;
  --border:#e2e8f0;--text:#1e293b;--muted:#64748b;--bg:#f0f4f8;
  --green-darker:#0d3d26;--amber-text:#7d5a00;--red-text:#8b1a1a;--card:#ffffff;--card2:#f6faf7;}
#bwn-jv-overlay *,#bwn-jv-overlay *::before,#bwn-jv-overlay *::after{box-sizing:border-box;}
/* Suite drawer: the reading pane rides the dock rail edge like every other tool. It is
   wider than the form drawers (1100px) because the two-column layout needs the room; it
   clamps to whatever the rail leaves, and the max-width:900px rule at the bottom of this
   sheet stacks the columns once that clamp gets tight. */
#bwn-jv-card{background:var(--color-surface);border:none;border-radius:0 14px 14px 0;width:1100px;max-width:calc(100vw - var(--bwn-dock-w,158px) - 8px);height:100%;display:flex;flex-direction:column;box-shadow:10px 0 34px rgba(11,40,26,0.22);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;overflow:hidden;color:var(--text);animation:bwn-drawer-in .16s ease-out;}
/* Core also defines these keyframes (drawer host); duplicated here so the slide-in
   survives when Core is off - same no-host fallback rule as the launch button. */
@keyframes bwn-drawer-in{from{transform:translateX(-14px);opacity:.4;}to{transform:none;opacity:1;}}
#bwn-jv-overlay .badge{display:inline-block;font-size:9px;font-weight:600;padding:2px 7px;border-radius:99px;letter-spacing:normal;text-transform:none;}
#bwn-jv-overlay .badge.b-red{background:var(--color-danger-bg-alt);color:var(--color-danger-text);}
#bwn-jv-overlay .badge.b-amber{background:var(--color-warning-bg);color:var(--color-warning-text);}
#bwn-jv-overlay .badge.b-green{background:var(--color-success-bg);color:var(--color-brand-ink);}
#bwn-jv-overlay .badge.b-blue{background:var(--color-info-bg);color:var(--color-info-text);}
#bwn-jv-overlay .badge.b-gray{background:var(--color-surface-sunken);color:var(--color-text-soft);}
#bwn-jv-overlay .pri2{display:inline-block;font-size:9.5px;font-weight:500;padding:2px 7px;border-radius:99px;border:1px solid var(--border);background:var(--color-surface-alt);color:var(--text);}
#bwn-jv-overlay .job-modal-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--color-surface);border-radius:0 14px 0 0;}
#bwn-jv-overlay .job-modal-head .jm-id{font-family:ui-monospace,'Segoe UI Mono','SF Mono',monospace;font-weight:500;font-size:14px;color:var(--text);}
#bwn-jv-overlay .job-modal-head .jm-x{margin-left:auto;background:none;border:none;font-size:20px;line-height:1;cursor:pointer;color:var(--muted);}
#bwn-jv-overlay .job-modal-head{background:linear-gradient(135deg,#1a5f3e,#0d3d26);border-bottom:none;}
#bwn-jv-overlay .job-modal-head .jm-head-l{display:flex;flex-direction:column;gap:1px;margin-right:auto;}
#bwn-jv-overlay .job-modal-head .jm-id{color:#fff;}
#bwn-jv-overlay .job-modal-head .jm-head-sub{font-size:10px;color:rgba(255,255,255,0.8);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:500;}
#bwn-jv-overlay .job-modal-head .jm-x{color:rgba(255,255,255,0.9);}
#bwn-jv-overlay .job-modal-head .jm-x:hover{color:#fff;}
#bwn-jv-overlay .job-modal-body{padding:16px 18px;flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;}
#bwn-jv-overlay .jm-holdup{background:var(--color-surface-alt);border:1px solid var(--border);border-left:3px solid var(--green-dk);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;line-height:1.5;color:var(--text);}
#bwn-jv-overlay .jm-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px 18px;font-size:12px;margin-bottom:14px;}
#bwn-jv-overlay .jm-grid .jm-k{color:var(--muted);font-size:9px;text-transform:none;letter-spacing:normal;display:block;margin-bottom:1px;}
#bwn-jv-overlay .jm-grid .jm-v{color:var(--text);font-weight:500;}
#bwn-jv-overlay .jm-pills{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;}
#bwn-jv-overlay .jm-pill{font:600 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;padding:4px 10px;border-radius:99px;border:1px solid var(--border);background:var(--color-surface-alt);color:var(--text);cursor:pointer;white-space:nowrap;line-height:1.3;}
#bwn-jv-overlay button.jm-pill:hover{filter:brightness(0.97);}
#bwn-jv-overlay .jm-pill.active{outline:2px solid var(--green-dk);outline-offset:1px;}
#bwn-jv-overlay .jm-pill.p-bad{background:var(--color-danger-bg-alt);color:var(--color-danger-text);border-color:transparent;}
#bwn-jv-overlay .jm-pill.p-warn{background:var(--color-warning-bg);color:var(--color-warning-text);border-color:transparent;}
#bwn-jv-overlay .jm-pill.p-ok{background:var(--color-success-bg);color:var(--color-brand-ink);border-color:transparent;}
#bwn-jv-overlay .jm-pill.p-info{background:var(--color-info-bg);color:var(--color-info-text);border-color:transparent;}
#bwn-jv-overlay .jm-pill.p-gray{background:var(--color-surface-sunken);color:var(--color-text-soft);}
#bwn-jv-overlay .jm-pill-detail{background:var(--color-surface-alt);border:1px solid var(--border);border-left:3px solid var(--green-dk);border-radius:8px;padding:10px 12px;margin-bottom:8px;}
#bwn-jv-overlay .jm-step-lbl{font-weight:500;font-size:12.5px;color:var(--text);margin-bottom:3px;}
#bwn-jv-overlay .jm-step-done{font-size:9px;font-weight:500;text-transform:none;letter-spacing:normal;color:var(--color-brand-ink);background:var(--color-success-bg);padding:1px 6px;border-radius:99px;margin-left:6px;}
#bwn-jv-overlay .jm-step-why{font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:6px;}
#bwn-jv-overlay .jm-step-msg{font-size:11.5px;color:var(--text);line-height:1.5;background:var(--color-surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px;white-space:pre-wrap;margin-bottom:8px;}
#bwn-jv-overlay .jm-step-acts{display:flex;flex-wrap:wrap;gap:6px;}
#bwn-jv-overlay .jm-step-btn{font:500 10.5px -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--color-surface);color:var(--green-dk);cursor:pointer;transition:background .12s,border-color .12s;}
#bwn-jv-overlay .jm-step-btn:hover{background:var(--color-primary-faint);border-color:#cfe3d7;}
#bwn-jv-overlay .jm-step-btn:active{transform:translateY(1px);}
#bwn-jv-overlay .jm-step-btn.primary:hover{background:var(--color-primary);border-color:transparent;}
#bwn-jv-overlay .jm-step-btn.primary{background:var(--green-dk);color:#fff;border-color:transparent;}
#bwn-jv-overlay .jm-section-label{font-size:10px;text-transform:none;letter-spacing:normal;color:var(--muted);font-weight:500;margin:0 0 5px;}
#bwn-jv-overlay .jm-notes{font-size:12px;color:var(--text);line-height:1.55;white-space:pre-wrap;background:var(--color-surface-alt);border:1px solid var(--border);border-radius:8px;padding:10px 12px;max-height:260px;overflow-y:auto;}
#bwn-jv-overlay .jm-holdup .holdup-row{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;}
#bwn-jv-overlay .holdup-ai-btn{flex:none;font-size:9.5px;font-weight:500;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--color-surface);color:var(--green-dk);cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;white-space:nowrap;transition:background .12s,border-color .12s;}
#bwn-jv-overlay .holdup-ai-btn:hover{background:var(--color-primary-faint);border-color:#cfe3d7;}
#bwn-jv-overlay .holdup-ai-btn:active{transform:translateY(1px);}
#bwn-jv-overlay .holdup-meta{font-size:9px;color:var(--muted);margin-top:5px;}
#bwn-jv-overlay .jm-cols{display:grid;grid-template-columns:minmax(0,0.95fr) minmax(0,1.05fr);grid-template-rows:minmax(0,1fr);gap:18px;flex:1 1 auto;min-height:0;}
#bwn-jv-overlay .jm-col{min-width:0;min-height:0;overflow-y:auto;padding-right:6px;}
#bwn-jv-overlay .jm-col-r .jn-block{margin-top:0;border-top:none;padding-top:0;}
#bwn-jv-overlay .jm-cols .jn-doc-card{max-height:none;}
#bwn-jv-overlay .jm-timing{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 14px;}
#bwn-jv-overlay .jt{background:var(--color-surface-alt);border:1px solid var(--border);border-radius:8px;padding:8px 10px;text-align:center;}
#bwn-jv-overlay .jt-n{font:500 17px -apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#0d3d26;line-height:1.1;}
#bwn-jv-overlay .jt-l{font-size:9px;font-weight:500;text-transform:none;letter-spacing:normal;color:var(--muted);margin-top:3px;}
#bwn-jv-overlay .jm-na{background:linear-gradient(135deg,#f1f9f4,#eaf5ef);border:1px solid #d3e8dc;border-radius:8px;padding:11px 14px 6px;margin-bottom:14px;}
#bwn-jv-overlay .jm-na-h{display:flex;align-items:center;justify-content:space-between;gap:8px;font:500 10.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#0d3d26;text-transform:none;letter-spacing:normal;margin-bottom:5px;}
#bwn-jv-overlay .jm-na-copy{flex:none;font:500 9.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;text-transform:none;letter-spacing:0;color:#1a5f3e;background:#fff;border:1px solid #cfe3d7;border-radius:6px;padding:3px 8px;cursor:pointer;transition:background .12s,border-color .12s;}
#bwn-jv-overlay .jm-na-copy:hover{background:#f0fdf4;border-color:#86efac;}
#bwn-jv-overlay .jm-na-copy:active{transform:translateY(1px);}
#bwn-jv-overlay .jm-na .nd-ol{margin:2px 0 4px;}
#bwn-jv-overlay .jm-na .nd-ol li{font-size:12.5px;border-bottom-color:#d8e8de;}
#bwn-jv-overlay .jm-na-hist{margin-top:8px;border-top:1px dashed #cfe3d7;padding-top:6px;}
#bwn-jv-overlay .jm-na-hist>summary{font:500 9.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#3f6b54;text-transform:none;letter-spacing:normal;cursor:pointer;list-style:none;outline:none;}
#bwn-jv-overlay .jm-na-hist>summary::-webkit-details-marker{display:none;}
#bwn-jv-overlay .jm-na-hist>summary::before{content:'▸ ';color:#7aa890;}
#bwn-jv-overlay .jm-na-hist[open]>summary::before{content:'▾ ';}
#bwn-jv-overlay .jm-na-hist-blk{margin:6px 0 0;}
#bwn-jv-overlay .jm-na-hist-dt{font:500 9.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#7a8b82;margin-bottom:2px;}
#bwn-jv-overlay .jm-na-hist .nd-ol{margin:2px 0 6px;}
#bwn-jv-overlay .jm-na-hist .nd-ol li{font-size:11.5px;opacity:.85;}
#bwn-jv-overlay .jm-flagged{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;margin:8px 0;}
#bwn-jv-overlay .jm-flagged-h{font-size:11px;font-weight:500;color:#92400e;margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
#bwn-jv-overlay .jm-flagged-chips{margin-bottom:6px;}
#bwn-jv-overlay .jm-flagged-acts{margin:0;padding-left:18px;font-size:11.5px;color:var(--text);line-height:1.5;}
#bwn-jv-overlay .jm-flagged-foot{font-size:10px;color:var(--muted);margin-top:6px;}
#bwn-jv-overlay .jn-block{margin-top:14px;border-top:1px solid var(--border);padding-top:12px;}
#bwn-jv-overlay .jn-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;}
#bwn-jv-overlay .jn-hint{font-size:9px;font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0;}
#bwn-jv-overlay .jn-foot{display:flex;align-items:center;gap:12px;margin-top:8px;}
#bwn-jv-overlay .jn-saved{font-size:10px;color:var(--muted);margin-left:auto;}
#bwn-jv-overlay .jn-pill{display:inline-block;font-size:8.5px;font-weight:600;padding:1px 5px;border-radius:99px;letter-spacing:0.2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;}
#bwn-jv-overlay .jn-pill.jn-none{background:#fef3c7;color:#92400e;}
#bwn-jv-overlay .jn-pill.jn-working{background:#dbeafe;color:#1e40af;}
#bwn-jv-overlay .jn-pill.jn-done{background:#dcfce7;color:#166534;}
#bwn-jv-overlay .jn-doc-card{background:var(--color-surface-alt);border:1px solid var(--border);border-radius:8px;padding:15px 17px;max-height:420px;overflow-y:auto;box-shadow:inset 0 1px 2px rgba(0,0,0,0.03);}
#bwn-jv-overlay .jn-edit{width:100%;min-height:170px;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;padding:12px 14px;font:400 13px -apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:var(--text);background:var(--color-surface);resize:vertical;line-height:1.5;}
#bwn-jv-overlay .jn-foot{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap;}
#bwn-jv-overlay .jn-actsel{font:500 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--muted);display:inline-flex;align-items:center;gap:6px;}
#bwn-jv-overlay .jn-actsel select{font:400 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--color-surface);color:var(--text);}
#bwn-jv-overlay .jn-saved{font:400 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--muted);margin-left:auto;}
#bwn-jv-overlay .jn-save{background:#1a5f3e;color:#fff;border:none;border-radius:8px;padding:8px 16px;font:500 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;transition:background .12s;}
#bwn-jv-overlay .jn-save:hover:not(:disabled){background:#0d3d26;}
#bwn-jv-overlay .jn-save:active:not(:disabled){transform:translateY(1px);}
#bwn-jv-overlay .jn-save:disabled{opacity:.6;cursor:default;}
#bwn-jv-overlay .np-text{font-size:13px;line-height:1.55;color:#2a3530;white-space:pre-wrap;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;}
#bwn-jv-overlay .np-text.np-empty{color:var(--muted);font-style:italic;white-space:normal;}
#bwn-jv-overlay .nd-doc{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:13px;line-height:1.55;color:#2a3530;}
#bwn-jv-overlay .nd-doc>.nd-h:first-child,#bwn-jv-overlay .nd-doc>.nd-title:first-child{margin-top:0;}
#bwn-jv-overlay .nd-title{font:600 19px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#0d3d26;letter-spacing:-.02em;margin:0 0 3px;}
#bwn-jv-overlay .nd-sub{font:500 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#7c8c83;letter-spacing:.2px;margin:0 0 14px;}
#bwn-jv-overlay .nd-h{display:flex;align-items:center;gap:10px;margin:22px 0 11px;font:500 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#1a5f3e;text-transform:none;letter-spacing:normal;}
#bwn-jv-overlay .nd-h::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,#d6e6dd,transparent);}
#bwn-jv-overlay .nd-p{margin:5px 0;}
#bwn-jv-overlay .nd-p strong{color:#0d3d26;}
#bwn-jv-overlay .nd-empty{color:var(--muted);font-style:italic;}
#bwn-jv-overlay .nd-status{background:linear-gradient(135deg,#f1f9f4,#eaf5ef);border:1px solid #d3e8dc;border-left:4px solid #2ECC71;border-radius:10px;padding:12px 15px;margin:0 0 6px;font-size:13px;line-height:1.55;color:#234034;}
#bwn-jv-overlay .nd-flag{display:grid;grid-template-columns:26px 1fr;gap:11px;align-items:start;margin:8px 0;padding:11px 14px;background:#fff8ee;border:1px solid #f0ddbe;border-left:3px solid #e08a1e;border-radius:10px;font-size:13px;line-height:1.5;color:#5a4012;}
#bwn-jv-overlay .nd-flag .fn{font:500 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#b9740f;background:#fbeacb;border-radius:6px;width:26px;height:22px;display:flex;align-items:center;justify-content:center;}
#bwn-jv-overlay .nd-flag.hot{background:#fdece9;border-color:#f1cabf;border-left-color:#c0392b;color:#6e2018;}
#bwn-jv-overlay .nd-flag.hot .fn{color:#fff;background:#c0392b;}
#bwn-jv-overlay .nd-vend{display:grid;grid-template-columns:1fr 112px;gap:14px;align-items:start;margin:8px 0;padding:12px 15px;background:#fff;border:1px solid #e4ece7;border-radius:10px;}
#bwn-jv-overlay .nd-vend .vn-main{min-width:0;}
#bwn-jv-overlay .nd-vend .vn-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
#bwn-jv-overlay .nd-vend .vn-name{font:500 13.5px -apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#0d3d26;}
#bwn-jv-overlay .nd-vend .vn-role{font:500 10.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#1a5f3e;background:#e8f3ed;border:1px solid #d3e8dc;border-radius:999px;padding:2px 9px;letter-spacing:.2px;}
#bwn-jv-overlay .nd-vend .vn-people{font:500 11.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#90a097;margin:3px 0 0;}
#bwn-jv-overlay .nd-vend .vn-det{list-style:none;margin:8px 0 0;padding:0;}
#bwn-jv-overlay .nd-vend .vn-det li{position:relative;padding-left:15px;margin:3px 0;font-size:12.5px;line-height:1.45;color:#3c4842;}
#bwn-jv-overlay .nd-vend .vn-det li::before{content:"";position:absolute;left:2px;top:8px;width:4px;height:4px;border-radius:50%;background:#9fc7ac;}
#bwn-jv-overlay .nd-vend .vn-det li strong{color:#0d3d26;}
#bwn-jv-overlay .nd-vend .vn-money{display:flex;flex-direction:column;gap:4px;align-items:flex-end;border-left:1px solid #eef2f4;padding-left:12px;}
#bwn-jv-overlay .nd-vend .vn-amt{font:500 12.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#1a5f3e;white-space:nowrap;}
#bwn-jv-overlay .nd-vend .vn-amt.none{color:#c2ccc6;font-weight:500;}
#bwn-jv-overlay .nd-table{width:100%;border-collapse:collapse;margin:8px 0 12px;font-size:11px;}
#bwn-jv-overlay .nd-table th{text-align:left;background:var(--color-surface-alt);color:var(--green-dk);font-weight:500;font-size:9.5px;text-transform:none;letter-spacing:normal;padding:6px 9px;border:1px solid var(--border);}
#bwn-jv-overlay .nd-table td{padding:6px 9px;border:1px solid var(--border);vertical-align:top;}
#bwn-jv-overlay .nd-table tr:nth-child(even) td{background:rgba(15,61,38,0.025);}
#bwn-jv-overlay .nd-tl{display:flex;flex-direction:column;margin:8px 0 14px;border:1px solid #e7eee9;border-radius:11px;overflow:hidden;}
#bwn-jv-overlay .nd-tlrow{display:grid;grid-template-columns:104px 1fr;gap:14px;padding:8px 14px;border-bottom:1px solid #f1f5f2;font-size:13px;line-height:1.45;}
#bwn-jv-overlay .nd-tlrow:last-child{border-bottom:none;}
#bwn-jv-overlay .nd-tlrow:nth-child(even){background:#fafcfb;}
#bwn-jv-overlay .nd-tldate{font:500 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#1a5f3e;white-space:nowrap;padding-top:1px;}
#bwn-jv-overlay .nd-tltext{color:#2a3530;min-width:0;}
#bwn-jv-overlay .nd-tlrow.hot{background:#fdece9;}
#bwn-jv-overlay .nd-tlrow.hot .nd-tldate{color:#c0392b;}
#bwn-jv-overlay .nd-ol{margin:6px 0 14px;padding-left:0;list-style:none;counter-reset:nd;}
#bwn-jv-overlay .nd-ol li{position:relative;counter-increment:nd;padding:5px 0 5px 34px;line-height:1.5;border-bottom:1px solid #f3f6f4;}
#bwn-jv-overlay .nd-ol li:last-child{border-bottom:none;}
#bwn-jv-overlay .nd-ol li::before{content:counter(nd);position:absolute;left:0;top:5px;width:22px;height:22px;border-radius:7px;background:#e8f3ed;color:#1a5f3e;font:500 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;display:flex;align-items:center;justify-content:center;}
#bwn-jv-overlay .nd-ul{margin:6px 0 14px;padding-left:4px;list-style:none;}
#bwn-jv-overlay .nd-ul li{position:relative;margin:5px 0;padding-left:18px;line-height:1.5;}
#bwn-jv-overlay .nd-ul li::before{content:"";position:absolute;left:3px;top:9px;width:5px;height:5px;border-radius:50%;background:#2ECC71;}
#bwn-jv-overlay .nd-kind{display:inline-block;margin-left:6px;font-size:8.5px;font-weight:600;text-transform:none;letter-spacing:normal;padding:1px 5px;border-radius:4px;vertical-align:middle;}
#bwn-jv-overlay .nd-sup{background:#fdf3e0;color:#9a6a12;border:1px solid #e8cfa0;}
#bwn-jv-overlay .vnd-sep{margin:0 5px;color:var(--muted);}
#bwn-jv-overlay .nd-shist{margin:8px 0 4px;}
#bwn-jv-overlay .nd-shist>summary{font:500 9.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#3f6b54;text-transform:none;letter-spacing:normal;cursor:pointer;list-style:none;outline:none;}
#bwn-jv-overlay .nd-shist>summary::-webkit-details-marker{display:none;}
#bwn-jv-overlay .nd-shist>summary::before{content:'▸ ';color:#7aa890;}
#bwn-jv-overlay .nd-shist[open]>summary::before{content:'▾ ';}
#bwn-jv-overlay .nd-shist-blk{margin:7px 0 0;padding:8px 11px;background:var(--color-surface-alt);border:1px solid var(--border);border-radius:8px;}
#bwn-jv-overlay .nd-shist-dt{font:500 9.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#7a8b82;margin-bottom:3px;}
#bwn-jv-overlay .nd-shist-tx{font:400 11.5px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:var(--color-text);line-height:1.5;white-space:pre-wrap;}
#bwn-jv-overlay .lc-head{display:flex;align-items:center;gap:10px;margin:2px 0 10px;}
#bwn-jv-overlay .lc-title{font:600 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:#1a5f3e;text-transform:none;letter-spacing:normal;}
#bwn-jv-overlay .lc-badge{font-size:9.5px;font-weight:600;border-radius:99px;padding:2px 9px;letter-spacing:.2px;}
#bwn-jv-overlay .lc-badge.ok{background:#eaf5ef;color:#1a5f3e;border:1px solid #cfe7d8;}
#bwn-jv-overlay .lc-badge.late{background:#fdece9;color:#c0392b;border:1px solid #f1cabf;}
#bwn-jv-overlay .lc-rail{display:flex;align-items:flex-start;position:relative;margin:6px 2px 14px;}
#bwn-jv-overlay .lc-node{flex:1;display:flex;flex-direction:column;align-items:center;text-align:center;position:relative;min-width:0;}
#bwn-jv-overlay .lc-node::before{content:"";position:absolute;top:6px;left:-50%;width:100%;height:2px;background:var(--border);z-index:0;}
#bwn-jv-overlay .lc-node:first-child::before{display:none;}
#bwn-jv-overlay .lc-node.done::before{background:#2ECC71;}
#bwn-jv-overlay .lc-dot{width:13px;height:13px;border-radius:50%;background:var(--color-surface);border:2px solid var(--border);z-index:1;margin-bottom:6px;}
#bwn-jv-overlay .lc-node.done .lc-dot{background:#2ECC71;border-color:#2ECC71;}
#bwn-jv-overlay .lc-node.next .lc-dot{background:var(--color-surface);border-color:var(--green-dk);box-shadow:0 0 0 3px #e8f3ed;}
#bwn-jv-overlay .lc-node.miss .lc-dot{background:#c0392b;border-color:#c0392b;}
#bwn-jv-overlay .lc-date{font:500 11px ui-monospace,'Segoe UI Mono','SF Mono',monospace;color:var(--text);line-height:1.2;}
#bwn-jv-overlay .lc-node.future .lc-date,#bwn-jv-overlay .lc-node.empty .lc-date{color:var(--muted);}
#bwn-jv-overlay .lc-node.miss .lc-date{color:#c0392b;}
#bwn-jv-overlay .lc-lbl{font-size:8.5px;font-weight:500;text-transform:none;letter-spacing:normal;color:var(--muted);margin-top:2px;}
#bwn-jv-overlay .eq-chip{display:inline-block;font-size:10px;font-weight:600;line-height:1.5;padding:1px 7px;border-radius:10px;margin:1px 3px 1px 0;border:1px solid transparent;white-space:nowrap;}
#bwn-jv-overlay .eq-proj{background:transparent;color:var(--muted);border:1px dashed var(--border)!important;}
#bwn-jv-overlay .eq-r-never-updated,#bwn-jv-overlay .eq-r-mgmt-assist,#bwn-jv-overlay .eq-r-past-eta{background:#fef2f2;color:#991b1b;border-color:#fecaca;}
#bwn-jv-overlay .eq-r-stale-7d,#bwn-jv-overlay .eq-r-chronic,#bwn-jv-overlay .eq-r-high-priority{background:#fffbeb;color:#92400e;border-color:#fde68a;}
#bwn-jv-overlay .eq-r-no-next-step{background:#eff6ff;color:#1e40af;border-color:#bfdbfe;}
#bwn-jv-overlay .eq-state-pill{font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;margin-right:6px;display:inline-block;}
#bwn-jv-overlay .eq-acked{background:#ecfdf5;color:#065f46;}
#bwn-jv-overlay .eq-snoozed{background:#fffbeb;color:#92400e;}
#bwn-jv-overlay .vpills{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;}
#bwn-jv-overlay .vpill{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;line-height:1.3;padding:2px 8px;border-radius:99px;background:var(--color-surface-alt);border:1px solid var(--border);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;}
#bwn-jv-overlay .vpill-sup{background:#fdf3e0;border-color:#e8cfa0;color:#9a6a12;}
#bwn-jv-overlay .vpill-tag{font-size:7px;font-weight:600;letter-spacing:0.3px;opacity:0.85;}
#bwn-jv-overlay .ai-tag{display:inline-block;font-size:8px;font-weight:600;letter-spacing:0.5px;background:var(--green-dk);color:#fff;border-radius:4px;padding:1px 4px;vertical-align:middle;margin-right:3px;}
#bwn-jv-overlay .age-pill{font-family:ui-monospace,'Segoe UI Mono','SF Mono',monospace;font-weight:600;font-size:10px;padding:2px 6px;border-radius:99px;}
#bwn-jv-overlay .age-ok{background:var(--color-success-bg);color:var(--color-brand-ink);}
#bwn-jv-overlay .age-warn{background:var(--color-warning-bg);color:var(--color-warning-text);}
#bwn-jv-overlay .age-high{background:var(--color-danger-bg-alt);color:var(--color-danger-text);}
#bwn-jv-overlay .age-pill.age-high{box-shadow:inset 0 0 0 1.5px var(--color-danger-text,#991b1b);}
@media (max-width:900px){
  #bwn-jv-overlay .jm-cols{grid-template-columns:1fr;grid-template-rows:auto;gap:0;flex:0 0 auto;height:auto;min-height:0;}
  #bwn-jv-overlay .jm-col{overflow-y:visible;padding-right:0;}
  #bwn-jv-overlay .job-modal-body{overflow:auto;}
  #bwn-jv-overlay .jm-col-r .jn-block{margin-top:14px;border-top:1px solid var(--border);padding-top:12px;}
  #bwn-jv-overlay .jm-cols .jn-doc-card{max-height:420px;}
}
`;

  function ensureStyle() {
    if (document.getElementById('bwn-jv-style')) return;
    var st = document.createElement('style'); st.id = 'bwn-jv-style'; st.textContent = JV_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function copyNextActionsFrom(root) {
    var lis = root.querySelectorAll('.jm-na > .nd-ol li');
    if (!lis.length) return;
    var lines = [];
    Array.prototype.forEach.call(lis, function (li, i) { lines.push((i + 1) + '. ' + (li.textContent || '').trim()); });
    var text = lines.join('\n');
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text); }
      else if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); }
    } catch (e) { }
    var btn = root.querySelector('[data-jv-copy]');
    if (btn) { var old = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(function () { try { btn.textContent = old; } catch (_) { } }, 1200); }
  }

  function wireHandlers(root) {
    var x = root.querySelector('[data-jv-close]');
    if (x) x.addEventListener('click', function () { if (_jvClose) _jvClose(); });
    var cp = root.querySelector('[data-jv-copy]');
    if (cp) cp.addEventListener('click', function () { copyNextActionsFrom(root); });
    var sv = root.querySelector('[data-jv-savenote]');
    if (sv) sv.addEventListener('click', function () {
      var ta = root.querySelector('[data-jv-noteedit]'), asel = root.querySelector('[data-jv-noteaction]');
      saveJvNote(ta ? ta.value : '', asel ? asel.value : 'none', sv);
    });

    // WO Assist pills (dock retired): click a pill to reveal that item's specific next step.
    var pills = root.querySelectorAll('[data-jv-pill]');
    Array.prototype.forEach.call(pills, function (p) {
      p.addEventListener('click', function () {
        var key = p.getAttribute('data-jv-pill');
        var det = root.querySelector('[data-jv-detail="' + key + '"]');
        var open = det && !det.hasAttribute('hidden');
        Array.prototype.forEach.call(root.querySelectorAll('[data-jv-detail]'), function (d) { d.setAttribute('hidden', ''); });
        Array.prototype.forEach.call(pills, function (q) { q.classList.remove('active'); });
        if (det && !open) { det.removeAttribute('hidden'); p.classList.add('active'); }
      });
    });
  }

  // Next-step actions route back to Core (it still owns the ECD helper, acts store, and note
  // drafting). Delegated so it covers buttons in whichever detail block is open. Bound ONCE per
  // modal (from openJobView), NOT in wireHandlers - jvRefresh re-runs wireHandlers on every bus
  // update and the card element persists across innerHTML swaps, so binding here would stack a
  // listener each refresh and fire "Mark actioned" N times (duplicate notes / stacked prompts).
  function wireJvDelegation(root) {
    root.addEventListener('click', function (e) {
      var t = e.target;
      var ecd = t && t.closest && t.closest('[data-jv-ecd]');
      if (ecd) { try { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'core:ecd' } })); } catch (x) { } if (_jvClose) _jvClose(); return; }
      var act = t && t.closest && t.closest('[data-jv-actioned]');
      if (act) {
        var k = act.getAttribute('data-jv-actioned');
        var typed = prompt('What did you do? (optional - becomes the WO note)', '');
        if (typed === null) return;
        try { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'core:act', key: k, note: typed } })); } catch (x) { }
        toast('Logged - review the drafted note on the WO and post it.');
        if (_jvClose) _jvClose();
        return;
      }
      var ch = t && t.closest && t.closest('[data-jv-chase]');
      if (ch) {
        var kk = ch.getAttribute('data-jv-chase'), b = null;
        try { b = BWN.busGet(readWoNumber(), 12 * 3600000); } catch (x) { }
        var step = b && (b.nextSteps || []).filter(function (s) { return s.key === kk; })[0];
        if (step && step.text) {
          try { if (typeof GM_setClipboard === 'function') GM_setClipboard(step.text); else if (navigator.clipboard) navigator.clipboard.writeText(step.text); } catch (x) { }
          ch.textContent = '✓ Copied'; setTimeout(function () { try { ch.textContent = 'Copy chase message'; } catch (_) { } }, 1200);
        }
        return;
      }
    });
  }

  function openJobView(job, aux) {
    ensureStyle();
    aux = aux || {};
    var id = String(job.jobId);
    _jvTarget = id;
    JOBS = [job];
    JOB_NOTES = {}; JOB_NOTES[id] = aux.saved || {};
    O30_LINES = {}; if (aux.o30) O30_LINES[id] = aux.o30;
    JOB_PLANS = {}; if (aux.plan) JOB_PLANS[id] = aux.plan;
    EQ_STATE = { items: {} }; if (aux.eq) EQ_STATE.items[id] = aux.eq;
    STATUS_HIST = {};
    VENDOR_KIND = {};

    var old = document.getElementById('bwn-jv-overlay'); if (old) old.remove();
    // Claim the shared drawer slot so whatever tool is open folds away first.
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: 'jobview' } })); } catch (e) { }
    var wrap = document.createElement('div'); wrap.id = 'bwn-jv-overlay';
    var card = document.createElement('div'); card.id = 'bwn-jv-card';
    wrap.appendChild(card);
    _jvBody = card;
    openJobModal(id);
    wireHandlers(card);
    wireJvDelegation(card);   // once per modal (survives jvRefresh's innerHTML swaps)

    var releaseA11y = null;
    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (releaseA11y) { releaseA11y(); releaseA11y = null; }
      wrap.remove();
      if (_jvBody === card) _jvBody = null;
      if (_jvClose === close) _jvClose = null;
    }
    function onKey(e) { if (e.key === 'Escape') { close(); } }
    _jvClose = close;
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    // Non-modal, like the rest of the drawers: there is no backdrop to click away and the
    // work order behind stays usable, so Escape and the header X are the ways out.
    releaseA11y = bwnA11yDialog(card, { label: 'Job View', modal: false });
  }

  // Auto-update: when Core republishes the bus for the WO we're showing, re-render the open
  // modal (debounced) so it tracks the live work order. Guards the note editor - skips while
  // the user is focused in it, and preserves an unsaved draft across the re-render.
  var _jvRefreshT = null;
  function jvRefresh() {
    if (!_jvBody || !_jvTarget) return;
    var ta = _jvBody.querySelector('[data-jv-noteedit]');
    var asel = _jvBody.querySelector('[data-jv-noteaction]');
    var ae = document.activeElement;
    if (ae && (ae === ta || ae === asel)) return;   // don't yank the note text / collapse the dropdown mid-edit
    var draft = ta ? ta.value : null;
    var draftAct = asel ? asel.value : null;
    try {
      openJobModal(_jvTarget);       // re-reads JOBS[0], re-overlays the bus, re-renders
      wireHandlers(_jvBody);
      if (draft != null) { var ta2 = _jvBody.querySelector('[data-jv-noteedit]'); if (ta2) ta2.value = draft; }
      if (draftAct != null) { var as2 = _jvBody.querySelector('[data-jv-noteaction]'); if (as2) as2.value = draftAct; }
    } catch (e) { }
  }
  document.addEventListener('bwn:update', BWN.guard(function (e) {
    if (!_jvBody) return;
    var id = e && e.detail && e.detail.id;
    var woNum = ''; try { woNum = readWoNumber(); } catch (x) { }
    if (id != null && woNum && String(id) !== String(woNum)) return;   // a different WO's bus
    clearTimeout(_jvRefreshT);
    _jvRefreshT = setTimeout(jvRefresh, 800);
  }, 'jobView:busupdate'));

  // ====================================================================
  // TRIGGER
  // ====================================================================
  function readTrackingDigits() {
    var el = document.querySelector('[data-testid="work-order-header-tracking-number"]');
    return el ? String(el.textContent || '').replace(/\D+/g, '') : '';
  }
  // Best-effort WO number (distinct from the tracking number). Prefer an explicit
  // header element; fall back to the formatted "W-<n>" shown in the header.
  function readWoNumber() {
    // The URL path segment IS the workOrderNumber - the same reliable source loadWO/Bid-Out
    // query by. Prefer it; the header testids below are guesses that may not exist.
    var u = location.pathname.match(/\/work-orders\/(\d+)/);
    if (u) return u[1];
    var el = document.querySelector('[data-testid="work-order-header-work-order-number"]') ||
      document.querySelector('[data-testid="work-order-header-number"]');
    var d = el ? String(el.textContent || '').replace(/\D+/g, '') : '';
    if (d) return d;
    var scope = document.querySelector('[data-testid^="work-order-header"]');
    var hay = (scope ? scope.textContent : ((document.querySelector('main') || document.body || {}).textContent)) || '';
    var m = /\bW-\s?(\d{3,})\b/.exec(hay);
    return m ? m[1] : '';
  }

  function blankJob(digits) {
    return {
      jobId: String(digits), coordinator: null, location: null, status: null, aged: null, statusHrs: null,
      lastUpdated: null, daysSinceUpdate: null, priority: null, amount: null, fm: null, trades: null, vendors: null,
      notes: null, woDate: null, firstTripDate: null, nextOnsiteDate: null, expectedCompletion: null, risk: null,
      projectType: null, mgmtAssist: null, mgmtNotes: null
    };
  }

  function toast(msg) {
    try {
      var t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:100001;max-width:340px;background:#0d3d26;color:#fff;font:500 13px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;padding:11px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);';
      document.body.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (_) { } }, 4200);
    } catch (e) { }
  }

  // ---- Live push (jobFacts) + note write-back (noteWrite) via wo-ingest ----------
  var _jvTarget = '';
  function jvCanWrite(){ return connectorEnabled() && !!GM_getValue('ingest_key',''); }
  function jvPost(bodyObj, cb){
    try {
      if(!connectorEnabled()){ if(cb) cb(false,'connector off'); return; }
      var key=GM_getValue('ingest_key',''); if(!key){ if(cb) cb(false,'no key'); return; }
      GM_xmlhttpRequest({ method:'POST', url:INGEST_URL+'?client='+INGEST_CLIENT,
        headers:{'Content-Type':'application/json','x-bwn-key':key},
        data:JSON.stringify(Object.assign({actor:ingestActor()},bodyObj)), timeout:20000,
        onload:function(r){ var ok=r.status>=200&&r.status<300; if(cb) cb(ok, ok?'':('HTTP '+r.status)); },
        onerror:function(){ if(cb) cb(false,'network'); }, ontimeout:function(){ if(cb) cb(false,'timeout'); } });
    } catch(e){ if(cb) cb(false,e.message); }
  }
  function saveJvNote(note, action, btn){
    if(!_jvTarget){ toast('Job View: no tracking # to save against.'); return; }
    if(btn){ btn.disabled=true; btn.textContent='Saving...'; }
    jvPost({ noteWrite:{ target:_jvTarget, note:String(note||''), action:action||'none' } }, function(ok,msg){
      if(btn){ btn.disabled=false; btn.textContent='Save note'; }
      toast(ok ? 'Job View: note saved to the Ops Dashboard.' : ('Job View: save failed - '+msg));
    });
  }
  function pushJobFacts(job, target){
    target = target || _jvTarget;
    if(!target || !job) return;
    function iso(d){ return d ? (d instanceof Date ? d.toISOString() : String(d)) : null; }
    jvPost({ jobFacts:{ target:target, status:job.status, coordinator:job.coordinator, location:job.location,
      priority:job.priority, fm:job.fm, trades:job.trades, vendors:job.vendors, amount:job.amount, aged:job.aged,
      statusHrs:job.statusHrs, daysSinceUpdate:job.daysSinceUpdate, lastUpdated:iso(job.lastUpdated), woDate:iso(job.woDate),
      firstTripDate:iso(job.firstTripDate), nextOnsiteDate:iso(job.nextOnsiteDate), expectedCompletion:iso(job.expectedCompletion),
      woNumber:job.wo||job.woNumber, sourceJob:job.sourceJob||job.jobId,
      city:job.city, state:job.state, client:job.client, sourcePo:job.po, vendorNte:job.totalVendorNte } });
  }
  // Freshen the CURRENT WO on the dashboard when the connector records WO actions
  // (debounced per WO). Exposed on window so the top-level connector drain can call it.
  var _jvPushed = {};
  window.__bwnJvPush = function(){
    try {
      if(!jvCanWrite()) return;
      var woNum = readWoNumber(), tr = String(readTrackingDigits() || woNum || '').replace(/\D+/g,'');
      if(!tr) return;
      if(_jvPushed[tr] && Date.now()-_jvPushed[tr] < 300000) return;   // once per WO / 5 min
      _jvPushed[tr] = Date.now();
      woToJob(woNum || tr).then(function(j){ if(j){ try{ jvOverlayBus(j); }catch(_){} pushJobFacts(j, tr); } }).catch(function(){});
    } catch(e){}
  };

  function launch() {
    try {
      var tracking = readTrackingDigits();
      var woNum = readWoNumber();
      if (!tracking && !woNum) {
        toast('Job View: could not read the WO number from this page.');
        BWN.beat('jobView', 'miss', 'no WO number / tracking on page');
        return;
      }
      var digits = tracking || woNum;      // authored data is keyed by tracking digits
      var queryNum = woNum || tracking;    // GraphQL is queried by WO number
      Promise.all([
        woToJob(queryNum).catch(function (e) {
          BWN.beat('jobView', 'miss', 'GraphQL woToJob failed: ' + ((e && e.message) || e));
          return null;
        }),
        fetchAuthored(digits)              // never rejects
      ]).then(function (res) {
        var job = res[0];
        var au = res[1] || { saved: null, eq: null, plan: null, o30: null };
        // Guard against a mis-resolved WO number pointing at a different WO.
        if (job && tracking && String(job.jobId).replace(/\D+/g, '') !== tracking) {
          BWN.beat('jobView', 'miss', 'GraphQL tracking ' + job.jobId + ' != page tracking ' + tracking + ' - authored only');
          job = null;
        }
        var haveGql = !!job;
        var haveAuthored = !!(au.saved || au.plan || au.o30 || au.eq);
        if (!haveGql && !haveAuthored) {
          toast('Job View: no work-order data available (GraphQL and dashboard both unavailable).');
          BWN.beat('jobView', 'miss', 'both GraphQL and authored data unavailable');
          return;
        }
        if (!job) job = blankJob(digits);
        job.jobId = String(digits);        // canonical key aligns GraphQL + authored
        openJobView(job, au);
        if (haveGql) pushJobFacts(job);    // live-sync on open: push fresh WO facts to the dashboard
        BWN.beat('jobView', 'ok', 'opened ' + digits + (haveGql ? '' : ' (authored-only)'));
      }).catch(function (e) {
        toast('Job View: ' + ((e && e.message) || 'failed to open'));
        BWN.beat('jobView', 'error', 'open failed: ' + ((e && e.message) || e));
      });
    } catch (e) {
      BWN.beat('jobView', 'error', 'launch threw: ' + ((e && e.message) || e));
    }
  }

  function styleLaunchBtn(btn, floating) {
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font:500 12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;padding:6px 12px;border-radius:7px;border:1px solid #1a5f3e;background:#1a5f3e;color:#fff;cursor:pointer;vertical-align:middle;'
      + (floating ? 'position:fixed;bottom:20px;right:20px;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.25);' : 'margin-left:8px;');
  }
  function makeLaunchBtn() {
    var btn = document.createElement('button');
    btn.id = BTN_ID; btn.type = 'button'; btn.textContent = '📋 Job View';
    btn.addEventListener('click', BWN.guard(launch, 'jobView:launch'));
    return btn;
  }
  function mountFloating() {
    if (document.getElementById(BTN_ID)) return;
    var btn = makeLaunchBtn(); styleLaunchBtn(btn, true);
    document.body.appendChild(btn);
  }
  function mount() {
    if (document.getElementById(BTN_ID)) { BWN.beat('jobView', 'ok', 'launcher mounted'); return true; }
    if (!/\/work-orders\//.test(location.pathname)) return false;
    var anchor = document.querySelector('[data-testid="work-order-header-tracking-number"]');
    if (!anchor || !anchor.parentNode) { BWN.beat('jobView', 'waiting', 'WO header tracking anchor not found'); return false; }
    var btn = makeLaunchBtn(); styleLaunchBtn(btn, false);
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    BWN.beat('jobView', 'ok', 'launcher mounted');
    return true;
  }

  var pollTimer = null, ticks = 0;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function schedule() {
    if (mount()) { stopPoll(); return; }
    if (pollTimer) return;
    ticks = 0;
    pollTimer = setInterval(BWN.guard(function () {
      if (!/\/work-orders\//.test(location.pathname)) { stopPoll(); return; }
      if (mount()) { stopPoll(); return; }
      if (++ticks === 40) {   // ~10s: header anchor never appeared → floating fallback
        mountFloating();
        BWN.beat('jobView', 'miss', 'WO header anchor never appeared - used floating fallback');
        stopPoll();
      }
    }, 'jobView:poll'), 250);
  }
  var obs = new MutationObserver(BWN.guard(schedule, 'jobView:observe'));
  obs.observe(document.body, { childList: true, subtree: true });
  schedule();

  GM_registerMenuCommand('Open Job View', BWN.guard(launch, 'jobView:menu'));
});

  // ==========================================================================
  // MODULE: Find Techs / Find Suppliers v2.15
  // ==========================================================================
  if (BWN_MODULES.findTechs) BWN.safeModule('findTechs', function () {
    'use strict';

    var BTN_ID = 'bwn-findtech-btn';
    var GREEN = BWN.GREEN;

    // Trade keyword -> related Places search terms (edit here).
    var TRADE_TERMS = {
      electrical: ['electrical contractor', 'commercial electrician', 'low voltage data contractor'],
      plumbing: ['plumbing contractor', 'commercial plumber'],
      hvac: ['hvac contractor', 'commercial hvac service'],
      handyman: ['handyman service', 'general contractor'],
      carpentry: ['carpentry contractor', 'general contractor'],
      roofing: ['roofing contractor'],
      painting: ['commercial painting contractor'],
      flooring: ['flooring contractor'],
      locksmith: ['commercial locksmith'],
      glass: ['commercial glass contractor', 'glazier'],
      door: ['commercial door contractor', 'overhead door service'],
      refrigeration: ['commercial refrigeration contractor'],
      laundry: ['commercial laundry equipment repair', 'commercial laundry equipment service', 'commercial appliance repair'],
      general: ['general contractor', 'commercial contractor']
    };
    var TRADE_KEYWORDS = Object.keys(TRADE_TERMS);

    // Trade keyword -> supply-house search terms (Find Suppliers button).
    var TRADE_SUPPLY_TERMS = {
      electrical: ['electrical supply store', 'electrical wholesaler', 'lighting supply'],
      plumbing: ['plumbing supply store', 'plumbing wholesaler'],
      hvac: ['hvac supply store', 'hvac wholesaler'],
      handyman: ['hardware store', 'building supply'],
      carpentry: ['lumber supply', 'building materials supply'],
      roofing: ['roofing supply'],
      painting: ['paint supply store'],
      flooring: ['flooring supply store'],
      locksmith: ['locksmith supply', 'security hardware supply'],
      glass: ['glass supply'],
      door: ['door hardware supply', 'overhead door supply'],
      refrigeration: ['refrigeration supply'],
      laundry: ['commercial laundry equipment supplier', 'laundry equipment distributor', 'appliance parts supply'],
      general: ['building supply', 'contractor supply']
    };

    // Classification signals (Places business types + name keywords).
    var SUPPLIER_TYPES = ['hardware_store', 'home_improvement_store', 'wholesaler', 'store', 'lighting_store', 'electronics_store'];
    var CONTRACTOR_TYPES = ['electrician', 'plumber', 'general_contractor', 'roofing_contractor', 'painter', 'locksmith'];
    var SUPPLIER_NAME_RE = /\b(supply|supplies|supplier|wholesale|wholesaler|distribut\w*|hardware|depot|warehouse|lumber)\b/i;
    var CONTRACTOR_NAME_RE = /\b(contractor|contracting|construction|installation|mechanical)\b/i;

    function hasType(types, set) { return (types || []).some(function (t) { return set.indexOf(t) !== -1; }); }
    function isSupplierish(name, types) { return SUPPLIER_NAME_RE.test(name) || hasType(types, SUPPLIER_TYPES); }
    function isContractorish(name, types) { return CONTRACTOR_NAME_RE.test(name) || hasType(types, CONTRACTOR_TYPES); }

    // Map odd trade names (e.g. "Toilets") to a known trade keyword.
    var TRADE_SYNONYMS = {
      plumbing: ['toilet', 'restroom', 'sink', 'drain', 'faucet', 'water heater', 'pipe', 'sewer', 'grease trap', 'urinal', 'backflow'],
      electrical: ['lighting', 'light', 'outlet', 'breaker', 'power', 'wiring', 'sign', 'ballast', 'panel'],
      hvac: ['heating', 'cooling', 'air condition', 'furnace', 'rooftop', 'rtu', 'exhaust', 'ventilation'],
      refrigeration: ['cooler', 'freezer', 'walk-in', 'ice machine'],
      door: ['overhead door', 'roll up', 'roll-up', 'dock', 'gate', 'storefront'],
      glass: ['window', 'mirror'],
      handyman: ['general repair', 'misc', 'miscellaneous'],
      laundry: ['washer', 'dryer', 'laundry', 'launderette', 'laundromat', 'washing machine']
    };

    function resolveTradeKey(low) {
      for (var i = 0; i < TRADE_KEYWORDS.length; i++) {
        if (low.indexOf(TRADE_KEYWORDS[i]) !== -1) return TRADE_KEYWORDS[i];
      }
      for (var k in TRADE_SYNONYMS) {
        if (TRADE_SYNONYMS[k].some(function (s) { return low.indexOf(s) !== -1; })) return k;
      }
      return null;
    }

    // Only http/https URIs are rendered as links; anything else (javascript:, data:,
    // etc.) is dropped. API responses are third-party input - never trust the scheme.
    function isSafeHttpUrl(u) { return /^https?:\/\//i.test(u || ''); }

    console.info('[BWN FT] find-techs userscript loaded on', location.href);

    GM_registerMenuCommand('Set Google Places key', function () {
      var cur = GM_getValue('places_key', '');
      var v = prompt('Paste your Google Places API key (stored locally in Tampermonkey, not in the page):', cur || '');
      if (v !== null) { GM_setValue('places_key', v.trim()); publishAiStatus(); alert('Saved.'); }
    });

    // ---- Read WO context --------------------------------------------------
    // Trade is a multi-value chip field. Anchor the WO trades root (the testid
    // 'trades-dropdown-field' is also reused inside PO panels, so prefer the WO one).
    function detectTrades() {
      var field = document.querySelector('[data-testid="wo-trades-dropdown"]') ||
                  document.querySelector('[data-testid="trades-dropdown-field"]');
      if (!field) { console.info('[BWN FT] trades field not found'); return []; }
      var out = [];
      // Chips carry data-tag-index; some MUI builds only set MuiChip-labelMedium, so
      // read the chip's own text rather than relying on a bare .MuiChip-label class.
      field.querySelectorAll('[data-tag-index], .MuiChip-root').forEach(function (chip) {
        var lab = chip.querySelector('.MuiChip-label') || chip;
        var t = (lab.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      });
      out = out.filter(function (v, i) { return out.indexOf(v) === i; });
      console.info('[BWN FT] trades detected:', out);
      return out;
    }

    // Address is the value of the location autocomplete's own input.
    function detectAddress() {
      var inp = document.querySelector('[data-testid="wo-location-dropdown-input"] input');
      var v = inp ? (inp.value || inp.getAttribute('title') || '').trim() : '';
      if (v) return v;
      // Fallback: scan near the location widget for a street-address pattern.
      var re = /\d{1,6}\s+[\w .'\-]+,\s*[\w .'\-]+,\s*[A-Z]{2}\s*\d{5}/;
      var root = document.querySelector('[data-testid="wo-location-dropdown"]');
      var m = root && (root.textContent || '').match(re);
      return m ? m[0] : '';
    }

    function alphaOnly(s) { return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

    function getPOVendors() {
      var out = [];
      document.querySelectorAll('[data-testid="purchase-order-vendor-name"], [data-testid="purchase-order-vendor-link"]').forEach(function (el) {
        var v = (el.textContent || '').trim(); if (v) out.push(v);
      });
      document.querySelectorAll('[data-testid^="POAccordion-"] a').forEach(function (el) {
        var v = (el.textContent || '').trim(); if (v) out.push(v);
      });
      if (!out.length) out = bwnBusVendors();   // PO panel not mounted: fall back to Core's bus
      return out.map(alphaOnly).filter(function (v) { return v.length >= 4; });
    }

    // ---- Geometry ---------------------------------------------------------
    function milesBetween(a, b, c, d) {
      var R = 3958.8, dLat = (c - a) * Math.PI / 180, dLon = (d - b) * Math.PI / 180;
      var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }

    // Composite lead score: Bayesian-shrunk rating minus a mild distance penalty.
    // Surfaces established vendors over a thin-review shop that merely happens to be closer.
    function vendorScore(rating, reviews, miles) {
      var C = 3.8, m = 10;                                  // prior mean + prior weight (pulls thin-review places toward the mean)
      var base = (rating == null) ? (C - 1.2)               // no rating at all: below the prior, but not dead last
        : ((reviews * rating) + (m * C)) / (reviews + m);
      return base - (miles * 0.05);                         // ~ -1.0 over 20 mi on a 5-pt scale; distance breaks ties, never dominates
    }

    // Project a point `miles` away from center at `bearing` (radians).
    function offset(c, miles, bearing) {
      var R = 3958.8, dr = miles / R;
      var lat1 = c.latitude * Math.PI / 180, lon1 = c.longitude * Math.PI / 180;
      var lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(bearing));
      var lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
      return { latitude: lat2 * 180 / Math.PI, longitude: lon2 * 180 / Math.PI };
    }

    // Search origins to cover a radius. Each query biases a ~31mi (50km) circle,
    // so radii beyond that need a ring of extra centers to actually fetch far results.
    function originsFor(center, radiusMi) {
      var origins = [center];
      if (radiusMi > 31) {
        var ringMi = radiusMi * 0.6;
        var n = radiusMi >= 75 ? 8 : 6;
        for (var i = 0; i < n; i++) origins.push(offset(center, ringMi, (2 * Math.PI * i) / n));
      }
      return origins;
    }

    // ---- Places API (New) -------------------------------------------------
    function placesSearch(key, body, mask, cb) {
      var done = false;
      function finish(err, data) { if (done) return; done = true; cb(err, data); }
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://places.googleapis.com/v1/places:searchText',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': mask
        },
        data: JSON.stringify(body),
        onload: function (res) {
          try {
            var data = JSON.parse(res.responseText || '{}');
            if (data.error) {
              var m = data.error.message || ('HTTP ' + res.status);
              if (/SERVICE_DISABLED|not been used|disabled|PERMISSION_DENIED/i.test(res.responseText || '')) {
                m = 'Places API (New) is not enabled on your key - enable "Places API (New)" in Google Cloud and restrict the key to it.';
              }
              finish(new Error(m)); return;
            }
            if (res.status < 200 || res.status >= 300) { finish(new Error('HTTP ' + res.status + ': ' + (res.responseText || '').slice(0, 160))); return; }
            finish(null, data.places || []);
          } catch (e) { finish(new Error('Bad Places response (HTTP ' + res.status + '): ' + (res.responseText || '').slice(0, 160))); }
        },
        ontimeout: function () { finish(new Error('Places request timed out (15s).')); },
        onerror: function () { finish(new Error('Network error calling Places (check @connect / key restrictions).')); }
      });
    }

    // ---- Search orchestration --------------------------------------------
    function runSearch(trade, address, mode, radiusMi, statusEl, done, onProgress) {
      var key = GM_getValue('places_key', '');
      if (!key) { done(new Error('No Places key set. Tampermonkey menu → "Set Google Places key".')); return; }
      if (!address) { done(new Error('No address detected - type the site address in the box above.')); return; }

      var supplyMode = mode.kind === 'supplier';
      var map = supplyMode ? TRADE_SUPPLY_TERMS : TRADE_TERMS;
      var suffix = supplyMode ? ' supply' : ' contractor';

      // `trade` may be several comma-separated trades (multi-value field). Map each
      // through the mode's term map (+ related) and merge, de-duping the search terms.
      var tradeList = (trade || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!tradeList.length) tradeList = ['general'];
      var termSet = {};
      tradeList.forEach(function (tr) {
        var low = tr.toLowerCase();
        var matched = resolveTradeKey(low);
        var ts = (matched && map[matched]) || [tr + suffix];
        ts.forEach(function (t) { termSet[t] = true; });
      });
      var terms = Object.keys(termSet);
      var poVendors = getPOVendors();

      statusEl.textContent = 'Locating site…';
      // 1) Resolve the site to coordinates via a Places text search on the address.
      placesSearch(key, { textQuery: address, maxResultCount: 1 }, 'places.location,places.formattedAddress', function (err, sites) {
        if (err) { done(err); return; }
        if (!sites.length || !sites[0].location) { done(new Error('Could not resolve the site address.')); return; }
        var center = sites[0].location;
        var origins = originsFor(center, radiusMi);     // center (+ ring for wide radii)

        var mask = 'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.websiteUri,places.types,places.primaryType,places.businessStatus';
        // Build the full job list (one query per origin × term), then drain it through a
        // small concurrency pool instead of firing every request at once. Same queries,
        // same merged result - just paced, so a wide radius (up to 9 origins × several
        // terms = 50-80 queries) can't burst the Places quota into 429s or spike cost.
        var jobs = [];
        origins.forEach(function (origin) {
          terms.forEach(function (term) { jobs.push({ origin: origin, term: term }); });
        });
        var all = {}, pending = jobs.length, totalQ = jobs.length, hadErr = null;
        var next = 0, inFlight = 0, finished = false, MAX_CONCURRENT = 6;
        if (onProgress) onProgress(0.1);
        statusEl.textContent = 'Searching ' + terms.length + ' term(s) across ' + origins.length + ' area(s)…';
        if (!jobs.length) { done(null, []); return; }   // defensive: origins+terms are always >=1, so this never fires

        function runJob(job) {
          var body = {
            textQuery: job.term + ' near ' + address,
            maxResultCount: 20,
            locationBias: { circle: { center: job.origin, radius: 50000 } }   // 50km bias per origin; ring covers wider radii
          };
          placesSearch(key, body, mask, function (e, places) {
            if (e) { hadErr = e; }
            (places || []).forEach(function (p) {
              if (!p.id || all[p.id]) return;
              var nm = (p.displayName && p.displayName.text) || '';
              if (!nm) return;
              if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') return;   // drop permanently/temporarily closed businesses
              var types = (p.types || []).concat(p.primaryType ? [p.primaryType] : []);
              // Mode filter: contractors drop supplier-ish; suppliers drop pure contractors.
              if (!supplyMode && isSupplierish(nm, types)) return;
              if (supplyMode && isContractorish(nm, types) && !isSupplierish(nm, types)) return;
              var nn = alphaOnly(nm);
              // Skip vendors already on this WO.
              if (poVendors.some(function (v) { return nn.indexOf(v) !== -1 || v.indexOf(nn) !== -1; })) return;
              var dist = (p.location) ? milesBetween(center.latitude, center.longitude, p.location.latitude, p.location.longitude) : 999;
              if (dist > radiusMi + 5) return;   // ring origins can pull in far overshoot; keep within the requested radius
              var rt = (typeof p.rating === 'number') ? p.rating : null;
              var rv = p.userRatingCount || 0;
              all[p.id] = {
                name: nm,
                addr: p.formattedAddress || '',
                phone: p.nationalPhoneNumber || '',
                site: isSafeHttpUrl(p.websiteUri) ? p.websiteUri : '',   // drop non-http(s) schemes at intake
                rating: rt,
                reviews: rv,
                miles: dist,
                lat: p.location ? p.location.latitude : null,            // kept for the shared prospect pipeline
                lng: p.location ? p.location.longitude : null,
                score: vendorScore(rt, rv, dist)
              };
            });
            inFlight--;
            pending--;
            if (onProgress) onProgress(0.1 + 0.9 * (totalQ - pending) / totalQ);
            if (pending === 0) {     // every query has returned
              if (finished) return;
              finished = true;
              var list = Object.keys(all).map(function (k2) { return all[k2]; }).sort(function (x, y) { return (y.score - x.score) || (x.miles - y.miles); });
              done(hadErr && !list.length ? hadErr : null, list);
              return;
            }
            pump();   // a slot freed: start the next queued query
          });
        }

        function pump() {
          while (inFlight < MAX_CONCURRENT && next < jobs.length) {
            inFlight++;
            runJob(jobs[next++]);
          }
        }
        pump();   // kick off the first batch (up to MAX_CONCURRENT in flight)
      });
    }

    // ---- Panel UI (BWN house style) ---------------------------------------
    var STYLE_ID = 'bwn-ft-style';
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        '.bwn-ft-overlay{position:fixed;top:0;bottom:0;left:var(--bwn-dock-w,158px);z-index:100000;display:flex;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;animation:bwnFtFade .2s ease-out;}' +
        '@keyframes bwnFtFade{from{opacity:0}to{opacity:1}}' +
        '@keyframes bwnFtUp{from{transform:translateX(-14px);opacity:.4}to{transform:none;opacity:1}}' +
        '.bwn-ft-card{width:560px;max-width:calc(100vw - var(--bwn-dock-w,158px) - 8px);display:flex;flex-direction:column;background:var(--bwn-surface);border-radius:0 14px 14px 0;overflow:hidden;box-shadow:10px 0 34px rgba(13,38,26,.2);animation:bwnFtUp .18s ease-out;}' +
        '.bwn-ft-head{position:relative;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));color:#fff;padding:18px 22px;display:flex;align-items:center;gap:14px;}' +
        '.bwn-ft-head::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,rgba(46,204,113,.5),transparent);}' +
        '.bwn-ft-head .t{font-weight:500;font-size:17px;line-height:1.15;letter-spacing:-.01em;}' +
        '.bwn-ft-head .s{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.7);margin-top:4px;}' +
        '.bwn-ft-tag{margin-left:auto;padding:5px 12px;border-radius:999px;font:600 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;letter-spacing:.7px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;}' +
        '.bwn-ft-tag::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;}' +
        '.bwn-ft-tag.contractor{background:rgba(46,204,113,.18);color:var(--bwn-accent);border:1px solid rgba(46,204,113,.4);}' +
        '.bwn-ft-tag.supplier{background:rgba(230,126,34,.18);color:var(--bwn-warn);border:1px solid rgba(230,126,34,.45);}' +
        '.bwn-ft-ctrls{padding:16px 22px;display:flex;flex-direction:column;gap:11px;border-bottom:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-ft-grid{display:grid;grid-template-columns:1fr 1.4fr;gap:12px;}' +
        '.bwn-ft-field label{display:block;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin:0 0 5px 2px;}' +
        '.bwn-ft-field input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--bwn-border);border-radius:10px;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;outline:none;color:var(--bwn-text);background:var(--bwn-surface-2);transition:border-color .15s,box-shadow .15s,background .15s;}' +
        '.bwn-ft-field input:hover{border-color:var(--bwn-border);}' +
        '.bwn-ft-field input:focus{border-color:var(--bwn-accent);background:var(--bwn-surface);box-shadow:0 0 0 3px rgba(46,204,113,.16);}' +
        '.bwn-ft-radrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}' +
        '.bwn-ft-radlbl{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-ft-seg{display:inline-flex;background:var(--bwn-surface-3);border:1px solid var(--bwn-border);border-radius:9px;padding:2px;gap:2px;}' +
        '.bwn-ft-seg button{border:none;background:transparent;padding:5px 13px;border-radius:7px;font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;text-transform:none;letter-spacing:.3px;color:var(--bwn-text-muted);cursor:pointer;transition:background .12s,color .12s,box-shadow .12s;}' +
        '.bwn-ft-seg button.on{background:var(--bwn-surface);color:var(--bwn-green);box-shadow:0 1px 3px rgba(13,38,26,.12);}' +
        '.bwn-ft-seg button:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}' +
        '.bwn-ft-btn{padding:9px 18px;border:none;border-radius:9px;cursor:pointer;font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;transition:filter .12s,transform .08s,box-shadow .12s;}' +
        '.bwn-ft-btn:hover{filter:brightness(1.05);}' +
        '.bwn-ft-btn:active{transform:translateY(1px);}' +
        '.bwn-ft-btn:disabled{opacity:.5;cursor:default;transform:none;}' +
        '.bwn-ft-btn.primary{color:#fff;background:linear-gradient(135deg,var(--bwn-green),var(--bwn-green-dk));box-shadow:0 2px 8px rgba(13,61,38,.25);}' +
        '.bwn-ft-btn.primary:hover{box-shadow:0 4px 14px rgba(13,61,38,.32);}' +
        '.bwn-ft-btn.ghost{color:var(--bwn-green);background:var(--bwn-tint);}' +
        '.bwn-ft-btn.ghost:hover{background:var(--bwn-tint);}' +
        '.bwn-ft-btn:focus-visible{outline:2px solid var(--bwn-accent);outline-offset:2px;}' +
        '.bwn-ft-status{padding:12px 22px 0;font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);display:flex;align-items:center;gap:7px;min-height:15px;}' +
        '.bwn-ft-status::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--bwn-accent);flex:none;}' +
        '.bwn-ft-prog{margin:0 22px 4px;height:8px;background:var(--bwn-tint);border-radius:999px;overflow:hidden;}' +
        '.bwn-ft-prog>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--bwn-green),var(--bwn-accent));border-radius:999px;transition:width .25s cubic-bezier(.2,.8,.2,1);}' +
        '.bwn-ft-results{overflow:auto;padding:12px 22px 16px;flex:1;display:flex;flex-direction:column;gap:8px;}' +
        '.bwn-ft-row{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:start;padding:12px 15px;background:var(--bwn-surface);border:1px solid var(--bwn-tint);border-radius:10px;transition:border-color .12s,box-shadow .12s;}' +
        '.bwn-ft-row:hover{border-color:var(--bwn-border);box-shadow:0 2px 8px rgba(13,38,26,.06);}' +
        '.bwn-ft-row .vn-main{min-width:0;}' +
        '.bwn-ft-row .vn-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}' +
        '.bwn-ft-name{font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green-dk);}' +
        '.bwn-ft-dist{padding:2px 9px;border-radius:999px;background:var(--bwn-tint);border:1px solid var(--bwn-border);color:var(--bwn-green);font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;}' +
        '.bwn-ft-rating{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}' +
        '.bwn-ft-unv{font:500 10px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-warn-fg);background:var(--bwn-warn-bg);border:1px solid var(--bwn-warn);padding:1px 7px;border-radius:999px;letter-spacing:.4px;}' +
        '.bwn-ft-addr{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);margin:5px 0 0;}' +
        '.bwn-ft-right{display:flex;gap:7px;align-items:center;flex-wrap:wrap;justify-content:flex-end;}' +
        '.bwn-ft-phone{font:500 12px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-muted);white-space:nowrap;text-decoration:none;}' +
        '.bwn-ft-link{font:500 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:var(--bwn-green);background:var(--bwn-tint);border:1px solid var(--bwn-border);padding:5px 11px;border-radius:8px;text-decoration:none;transition:background .12s;}' +
        '.bwn-ft-link:hover{background:var(--bwn-tint);}' +
        '.bwn-ft-link.bbb{color:var(--bwn-text-muted);background:var(--bwn-surface-3);border-color:var(--bwn-border);}' +
        '.bwn-ft-empty{padding:18px 4px;color:var(--bwn-text-faint);font-size:13px;}' +
        '.bwn-ft-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:14px 20px;border-top:1px solid var(--bwn-border-2);background:var(--bwn-surface-2);}' +
        '.bwn-ft-hint{margin-right:auto;font:11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:var(--bwn-text-faint);}';
      document.head.appendChild(st);
    }

    function clearEl(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    // BBB's find_loc wants a city/state, not a street address (a full street
    // address over-constrains the search and yields nothing). Pull "City, ST"
    // out of the Google-formatted address; return '' if it can't be found.
    function bbbLoc(addr) {
      if (!addr) return '';
      var parts = String(addr).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      for (var i = 1; i < parts.length; i++) {
        var m = parts[i].match(/^([A-Z]{2})\s+\d{5}(?:-\d{4})?$/);   // "<city>, TX 79092"
        if (m) return parts[i - 1] + ', ' + m[1];
      }
      for (var j = 1; j < parts.length; j++) {
        if (/^[A-Z]{2}$/.test(parts[j])) return parts[j - 1] + ', ' + parts[j];   // "<city>, TX, USA"
      }
      return '';
    }

    // ---- Radius preference (persisted across opens) -----------------------
    function ftLoadRadius() {
      try { var n = parseInt(localStorage.getItem('bwn_ft_radius'), 10); return [15, 30, 50, 75, 100].indexOf(n) !== -1 ? n : 30; }
      catch (e) { return 30; }
    }
    function ftSaveRadius(mi) { try { localStorage.setItem('bwn_ft_radius', String(mi)); } catch (e) { /* non-fatal */ } }

    function openPanel(mode) {
      ensureStyle();
      var old = document.getElementById('bwn-ft-panel');
      if (old) old.remove();

      var trade = detectTrades().join(', ');
      var address = detectAddress();
      var fullList = [];      // all results
      var radiusMi = ftLoadRadius();   // persisted across opens
      var fetchedRadius = 0;  // largest radius we've actually fetched for
      var pipeKnown = [];     // pipeline prospects fetched for this site (outcome history source)
      var pipeSeeded = false; // fullList currently holds FREE pipeline rows, not paid results

      var wrap = document.createElement('div');
      wrap.id = 'bwn-ft-panel';
      wrap.className = 'bwn-ft-overlay';
      // Claim the shared drawer slot so whatever tool is open folds away first.
      try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: 'findtechs' } })); } catch (e) { }
      var card = document.createElement('div');
      card.className = 'bwn-ft-card';

      var releaseA11y = null;
      function close() {
        document.removeEventListener('keydown', onKey);
        if (releaseA11y) { releaseA11y(); releaseA11y = null; }
        wrap.remove();
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });

      // Header
      var head = document.createElement('div'); head.className = 'bwn-ft-head';
      var hl = document.createElement('div');
      var t = document.createElement('div'); t.className = 't'; t.textContent = mode.title;
      var sub = document.createElement('div'); sub.className = 's';
      sub.textContent = 'Google Places \u00b7 sourcing list only \u00b7 de-duped against this WO\u2019s vendors';
      hl.appendChild(t); hl.appendChild(sub);
      var tag = document.createElement('span');
      tag.className = 'bwn-ft-tag ' + mode.kind;
      tag.textContent = mode.kind === 'supplier' ? 'SUPPLY HOUSES' : 'NET-NEW LEADS';
      head.appendChild(hl); head.appendChild(tag);

      // Controls
      var ctrls = document.createElement('div'); ctrls.className = 'bwn-ft-ctrls';
      function field(labelTxt, val) {
        var w = document.createElement('div'); w.className = 'bwn-ft-field';
        var l = document.createElement('label'); l.textContent = labelTxt;
        var inp = document.createElement('input'); inp.value = val || '';
        w.appendChild(l); w.appendChild(inp); w.input = inp; return w;
      }
      var grid = document.createElement('div'); grid.className = 'bwn-ft-grid';
      var tradeF = field('Trade', trade);
      var addrF = field('Site address', address);
      grid.appendChild(tradeF); grid.appendChild(addrF);

      var RADII = [15, 30, 50, 75, 100];
      var radRow = document.createElement('div'); radRow.className = 'bwn-ft-radrow';
      var radLbl = document.createElement('span'); radLbl.textContent = 'Radius'; radLbl.className = 'bwn-ft-radlbl';
      radRow.appendChild(radLbl);
      var seg = document.createElement('div'); seg.className = 'bwn-ft-seg';
      var radBtns = {};
      RADII.forEach(function (mi) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = mi + ' mi';
        b.addEventListener('click', function () {
          radiusMi = mi; ftSaveRadius(mi); setRadiusUI();
          // Pipeline-seeded rows are radius-agnostic (miles unknown): re-render, never silently
          // fire a PAID search from a radius click - Search is the only paid trigger.
          if (fullList.length && (mi <= fetchedRadius || pipeSeeded)) render();
          else if (fullList.length) doSearch();
        });
        radBtns[mi] = b; seg.appendChild(b);
      });
      radRow.appendChild(seg);

      // Sort toggle: re-orders the current results in place (no re-search).
      var sortMode = 'score';
      var SORTS = [['score', 'Best'], ['distance', 'Nearest'], ['rating', 'Top-rated']];
      var sortWrap = document.createElement('span'); sortWrap.style.cssText = 'display:inline-flex;align-items:center;gap:7px;margin-left:14px;';
      var sortLbl = document.createElement('span'); sortLbl.className = 'bwn-ft-radlbl'; sortLbl.textContent = 'Sort';
      var sortSegEl = document.createElement('div'); sortSegEl.className = 'bwn-ft-seg';
      var sortBtns = {};
      SORTS.forEach(function (s) {
        var b = document.createElement('button'); b.type = 'button'; b.textContent = s[1];
        b.addEventListener('click', function () { sortMode = s[0]; setSortUI(); if (fullList.length) render(); });
        sortBtns[s[0]] = b; sortSegEl.appendChild(b);
      });
      function setSortUI() { SORTS.forEach(function (s) { sortBtns[s[0]].className = (s[0] === sortMode ? 'on' : ''); }); }
      sortWrap.appendChild(sortLbl); sortWrap.appendChild(sortSegEl);
      setSortUI();
      radRow.appendChild(sortWrap);

      var searchBtn = document.createElement('button'); searchBtn.type = 'button'; searchBtn.textContent = 'Search';
      searchBtn.className = 'bwn-ft-btn primary';
      searchBtn.style.marginLeft = 'auto';
      radRow.appendChild(searchBtn);

      function setRadiusUI() {
        RADII.forEach(function (mi) { radBtns[mi].className = (mi === radiusMi ? 'on' : ''); });
      }
      setRadiusUI();

      ctrls.appendChild(grid); ctrls.appendChild(radRow);

      var status = document.createElement('div'); status.className = 'bwn-ft-status';
      var prog = document.createElement('div'); prog.className = 'bwn-ft-prog'; prog.style.display = 'none';
      var progBar = document.createElement('i'); prog.appendChild(progBar);
      var progTimer = 0, progShown = 0, progFloor = 0;
      function paintProg(p) { progShown = Math.max(0, Math.min(100, p)); progBar.style.width = progShown + '%'; }
      function progTick() {
        if (!document.body.contains(prog)) { clearInterval(progTimer); progTimer = 0; return; }   // modal closed mid-search: self-clean
        var ceil = Math.min(92, progFloor * 100 + 70);
        if (progShown < ceil) paintProg(progShown + (ceil - progShown) * 0.08);   // ease toward ceiling between real milestones
      }
      function setProg(frac) {
        prog.style.display = 'block';
        progFloor = Math.max(progFloor, Math.max(0, Math.min(1, frac)));
        if (progFloor * 100 > progShown) paintProg(progFloor * 100);              // real progress jumps the bar forward
        if (!progTimer) progTimer = setInterval(progTick, 200);
      }
      function hideProg() {
        if (progTimer) { clearInterval(progTimer); progTimer = 0; }
        paintProg(100);
        setTimeout(function () { prog.style.display = 'none'; paintProg(0); progFloor = 0; }, 320);
      }
      var results = document.createElement('div'); results.className = 'bwn-ft-results';

      // Footer
      var foot = document.createElement('div'); foot.className = 'bwn-ft-foot';
      var hint = document.createElement('span'); hint.className = 'bwn-ft-hint';
      hint.textContent = mode.blurb;
      foot.appendChild(hint);
      var copyAllBtn = document.createElement('button'); copyAllBtn.type = 'button'; copyAllBtn.textContent = 'Copy list';
      copyAllBtn.className = 'bwn-ft-btn ghost';
      copyAllBtn.addEventListener('click', function () {
        var shown = visible();
        if (!shown.length) return;
        var tsv = shown.map(function (r) {
          return [r.name, (r.pipe && !(r.miles > 0)) ? 'pipeline' : (r.miles.toFixed(1) + ' mi'), r.phone, r.site, r.addr].join('\t');
        }).join('\n');
        GM_setClipboard('Name\tDistance\tPhone\tWebsite\tAddress\n' + tsv);
        copyAllBtn.textContent = 'Copied \u2713'; setTimeout(function () { copyAllBtn.textContent = 'Copy list'; }, 1500);
      });
      foot.appendChild(copyAllBtn);
      var closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.textContent = 'Close';
      closeBtn.className = 'bwn-ft-btn ghost';
      closeBtn.addEventListener('click', close);
      foot.appendChild(closeBtn);

      function visible() { return fullList.filter(function (r) { return r.miles <= radiusMi; }); }
      function sortShown(arr) {
        if (sortMode === 'distance') return arr.slice().sort(function (a, b) { return a.miles - b.miles; });
        if (sortMode === 'rating') return arr.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0) || (b.reviews || 0) - (a.reviews || 0); });
        return arr.slice().sort(function (a, b) { return (b.score - a.score) || (a.miles - b.miles); });   // composite (default)
      }

      function render() {
        var shown = sortShown(visible());
        clearEl(results);
        status.textContent = fullList.length
          ? (pipeSeeded
            ? shown.length + ' known ' + mode.noun + '(s) from the BWN pipeline (free) - Search runs a fresh paid lookup'
            : shown.length + ' ' + mode.noun + '(s) within ' + radiusMi + ' mi (of ' + fullList.length + ' found)')
          : '0 ' + mode.noun + '(s) found - widen the radius or adjust the trade';
        shown.forEach(function (r) {
          var row = document.createElement('div'); row.className = 'bwn-ft-row';
          var main = document.createElement('div'); main.className = 'vn-main';
          var rhead = document.createElement('div'); rhead.className = 'vn-head';
          var name = document.createElement('span'); name.className = 'bwn-ft-name'; name.textContent = r.name;
          var dist = document.createElement('span'); dist.className = 'bwn-ft-dist';
          dist.textContent = (r.pipe && !(r.miles > 0)) ? '📇 pipeline' : (r.miles.toFixed(1) + ' mi');   // city-matched pipeline rows carry no distance
          rhead.appendChild(name); rhead.appendChild(dist);
          if (r.rating != null) {
            var rt = document.createElement('span'); rt.className = 'bwn-ft-rating';
            rt.textContent = '\u2605 ' + r.rating + ' (' + r.reviews + ')';
            rhead.appendChild(rt);
          }
          if (r.rating == null || r.reviews < 5) {          // thin Google footprint: flag for human vetting, don't hide
            var unv = document.createElement('span'); unv.className = 'bwn-ft-unv'; unv.textContent = 'UNVETTED';
            rhead.appendChild(unv);
          }
          if (r.outcome && r.outcome.status) {              // pipeline outcome history (recorded via Bid-Out)
            var oc = document.createElement('span'); oc.className = 'bwn-ft-unv';
            oc.textContent = r.outcome.status.toUpperCase();
            oc.title = (r.outcome.note || '') + (r.outcome.wo ? ' - WO ' + r.outcome.wo : '');
            if (r.outcome.status === 'joined') oc.style.cssText = 'color:#166534;border-color:#166534;';
            else if (r.outcome.status === 'declined' || r.outcome.status === 'do-not-contact') oc.style.cssText = 'color:#b91c1c;border-color:#b91c1c;';
            rhead.appendChild(oc);
          }
          main.appendChild(rhead);
          if (r.addr) { var ad = document.createElement('div'); ad.className = 'bwn-ft-addr'; ad.textContent = r.addr; main.appendChild(ad); }
          var right = document.createElement('div'); right.className = 'bwn-ft-right';
          if (r.phone) {
            var ph = document.createElement('a'); ph.href = 'tel:' + r.phone; ph.textContent = r.phone;
            ph.className = 'bwn-ft-phone'; right.appendChild(ph);
          }
          if (isSafeHttpUrl(r.site)) {
            var w2 = document.createElement('a'); w2.href = r.site; w2.target = '_blank';
            w2.rel = 'noopener noreferrer';                 // new tab cannot reach back into the Umbrava session
            w2.textContent = 'Website';
            w2.className = 'bwn-ft-link'; right.appendChild(w2);
          }
          var bbb = document.createElement('a');             // BBB lookup: deep link only, no scraping / no allowlist change
          var bbbCity = bbbLoc(r.addr);
          bbb.href = 'https://www.bbb.org/search?find_text=' + encodeURIComponent(r.name) +
            (bbbCity ? '&find_loc=' + encodeURIComponent(bbbCity) : '');   // name + city/state only (a full street address over-constrains BBB)
          bbb.target = '_blank'; bbb.rel = 'noopener noreferrer';
          bbb.textContent = 'BBB \u2197';
          bbb.className = 'bwn-ft-link bbb'; right.appendChild(bbb);
          // Outcome dropdown: record that we reached out / they declined / do-not-contact / etc.
          // Saved to the shared pipeline (same store Bid-Out writes), so the history follows this
          // vendor into every future search near here.
          (function (rr) {
            var oc = document.createElement('select');
            oc.className = 'bwn-ft-oc';
            oc.title = 'Record an outcome for this ' + mode.noun + ' (saved to the shared BWN pipeline)';
            oc.style.cssText = 'margin-top:4px;font:400 11px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#5a6b62;border:1px solid #dde6e1;border-radius:6px;padding:2px 4px;background:#fff;max-width:130px;';
            var opts = [['', 'outcome…'], ['contacted', 'Reached out'], ['declined', 'Declined'], ['no-response', 'No response'], ['joined', 'Joined network'], ['do-not-contact', 'Do not contact']];
            opts.forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; oc.appendChild(op); });
            oc.addEventListener('change', function () {
              var st = oc.value; if (!st) return;
              var lbl = { contacted: 'reached out', declined: 'declined', 'no-response': 'no response', joined: 'joined network', 'do-not-contact': 'do not contact' }[st];
              var note = prompt('Optional note for "' + rr.name + '" (' + lbl + ') - e.g. why:', '');
              if (note === null) { oc.value = ''; return; }   // Cancel = abort (outcome appends have no undo)
              oc.disabled = true; status.textContent = 'Saving outcome for ' + rr.name + '…';
              var ftWo = (location.pathname.match(/\/work-orders\/(\d+)/) || [])[1] || '';
              vpRecordOutcome(rr, mode, tradeF.input.value, st, note, ftWo, function (err) {
                if (err) { oc.disabled = false; oc.value = ''; status.textContent = '⚠ Could not save outcome: ' + err.message; return; }
                rr.outcome = { status: st, note: note, wo: ftWo }; rr.dnc = (st === 'do-not-contact');
                render();   // rebuild so the badge reflects the new outcome
              });
            });
            right.appendChild(oc);
          })(r);
          row.appendChild(main); row.appendChild(right);
          results.appendChild(row);
        });
        if (!shown.length && fullList.length) {
          var empty = document.createElement('div'); empty.className = 'bwn-ft-empty';
          empty.textContent = 'Nothing within ' + radiusMi + ' mi - widen the radius.';
          results.appendChild(empty);
        }
      }

      function doSearch() {
        clearEl(results); status.textContent = 'Searching\u2026';
        pipeSeeded = false;   // paid results replace the free pipeline seed
        searchBtn.disabled = true;
        setProg(0.03);
        runSearch(tradeF.input.value, addrF.input.value, mode, radiusMi, status, function (err, list) {
          searchBtn.disabled = false;
          hideProg();
          if (err) { status.textContent = '\u26a0 ' + err.message; return; }
          fullList = list || []; fetchedRadius = radiusMi;
          vpAnnotate(fullList, pipeKnown);   // outcome history must FOLLOW the prospect into fresh paid results
          render();
          vpUpsert(fullList, mode, tradeF.input.value);   // save the paid discovery to the shared prospect pipeline
        }, function (frac) { setProg(frac); });
      }
      searchBtn.addEventListener('click', doSearch);

      card.appendChild(head); card.appendChild(ctrls); card.appendChild(status); card.appendChild(prog); card.appendChild(results); card.appendChild(foot);
      wrap.appendChild(card);
      document.body.appendChild(wrap);
      releaseA11y = bwnA11yDialog(card, { label: mode.title, modal: true, initial: searchBtn });

      // FREE first look: show what the shared BWN pipeline already knows near this site
      // (saved by earlier Bid-Out / Find Techs / Find Suppliers runs) before any paid search.
      var cs = vpCityState(address);
      if (cs) vpFetchCity(cs, mode.kind, function (known) {
        if (!known.length || !document.body.contains(card)) return;
        pipeKnown = known;   // kept for outcome annotation of any later paid search
        if (searchBtn.disabled) return;   // a search is already running - don't seed/clobber it
        var dec = known.filter(function (p) { return p.lastOutcome && p.lastOutcome.status === 'declined'; }).length;
        var dnc = known.filter(function (p) { return p.lastOutcome && p.lastOutcome.status === 'do-not-contact'; }).length;
        if (!fullList.length) {
          fullList = known.map(function (p) {
            return { name: p.name, addr: p.addr || '', phone: p.phone || '', site: p.website || '',
                     rating: p.rating, reviews: p.ratingCount || 0, miles: p.miles != null ? p.miles : 0,
                     lat: p.lat, lng: p.lng, score: 0, pipe: true, outcome: p.lastOutcome || null };
          });
          fetchedRadius = radiusMi;
          pipeSeeded = true;
          render();
          // After render() so it isn't overwritten by the results count line.
          status.textContent = '📇 ' + known.length + ' known ' + mode.noun + '(s) already in the BWN pipeline for ' + cs.city + ', ' + cs.state +
            (dec ? ' · ' + dec + ' declined' : '') + (dnc ? ' · ' + dnc + ' do-not-contact' : '') + ' - free; Search runs a fresh paid lookup.';
        }
      });
    }

    // ---- Mount the button next to "Purchase Orders" ----------------------
    function findPOHeader() {
      var els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span');
      for (var i = 0; i < els.length; i++) {
        if ((els[i].textContent || '').trim() === 'Purchase Orders' && els[i].children.length === 0) return els[i];
      }
      return null;
    }

    // ---- Modes ------------------------------------------------------------
    var CONTRACTOR_MODE = { kind: 'contractor', title: 'Find Techs - net-new contractors near this WO', noun: 'contractor', blurb: 'Sourcing leads - verify before recruiting.' };
    var SUPPLIER_MODE = { kind: 'supplier', title: 'Find Suppliers - trade supply houses near this WO', noun: 'supplier', blurb: 'Nearby supply houses.' };

    // ---- BWN vendor-prospect PIPELINE (shared with Bid-Out) --------------------
    // Every paid Places search is SAVED to the shared prospect store, and the panel shows what
    // is already KNOWN near the site (free) before any paid search - including outcome history
    // (declined / joined / do-not-contact) recorded from Bid-Out. Key-gated; degrades silently.
    var PROSPECTS_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/vendor-prospects';
    function vpKey() { try { return GM_getValue('ingest_key', ''); } catch (e) { return ''; } }
    function vpCityState(address) {
      var m = String(address || '').match(/,\s*([^,]+?),\s*([A-Z]{2})\b/);
      return m ? { city: m[1].trim(), state: m[2] } : null;
    }
    function vpFetchCity(cs, kind, cb) {
      var k = vpKey(); if (!k || !cs) { cb([]); return; }
      GM_xmlhttpRequest({
        method: 'GET', timeout: 25000,
        url: PROSPECTS_URL + '?city=' + encodeURIComponent(cs.city) + '&state=' + encodeURIComponent(cs.state) + '&kind=' + kind,
        headers: { 'x-bwn-key': k },
        onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } cb((j && j.ok && j.prospects) || []); },
        onerror: function () { cb([]); }, ontimeout: function () { cb([]); }
      });
    }
    function vpDomain(u) { try { return new URL(String(u || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } }
    // Prospect key: MUST mirror the server keyOf (api/vendor-prospects) so an outcome we POST
    // lands on the SAME record a discovery upserts - domain(website) || normalized-name || name.
    function vpNormName(s2) { return String(s2 || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(inc|llc|corp|co|company|ltd|the|and|of)\b/g, ' ').replace(/[^a-z0-9]+/g, ''); }
    function vpKeyOf(r) { return r.pkey || vpDomain(r.site) || vpNormName(r.name) || String(r.name || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    // Carry pipeline outcome history (declined / do-not-contact / joined) + the server's own key
    // onto freshly-searched rows for the same company, so a paid re-discovery never renders a
    // flagged vendor "clean" and an outcome recorded here targets the exact right record.
    function vpAnnotate(rows, known) {
      if (!rows || !rows.length || !known || !known.length) return;
      var byDom = {}, byName = {};
      known.forEach(function (p) { var d = vpDomain(p.website); if (d) byDom[d] = p; var n = alphaOnly(p.name || ''); if (n) byName[n] = p; });
      rows.forEach(function (r) {
        var p = (vpDomain(r.site) && byDom[vpDomain(r.site)]) || byName[alphaOnly(r.name || '')];
        if (p) {
          if (p.key) r.pkey = p.key;
          if (p.lastOutcome) { r.outcome = p.lastOutcome; r.dnc = (p.lastOutcome.status === 'do-not-contact'); }
        }
      });
    }
    function vpUpsert(list, mode, trade) {
      var k = vpKey(); if (!k || !list || !list.length) return;
      var recs = list.slice(0, 120).map(function (r) {
        return { name: r.name, website: r.site || '', phone: r.phone || '', addr: r.addr || '',
                 lat: r.lat, lng: r.lng, rating: r.rating, ratingCount: r.reviews,
                 kind: mode.kind, trades: trade ? [String(trade).split(',')[0].trim()] : [],
                 source: mode.kind === 'supplier' ? 'findsuppliers' : 'findtechs' };
      });
      (function send(i) {
        if (i >= recs.length) return;
        GM_xmlhttpRequest({
          method: 'POST', timeout: 30000, url: PROSPECTS_URL,
          headers: { 'Content-Type': 'application/json', 'x-bwn-key': k },
          data: JSON.stringify({ upsert: recs.slice(i, i + 40) }),
          onload: function () { send(i + 40); }, onerror: function () { }, ontimeout: function () { }
        });
      })(0);
    }
    // Record an outcome (reached-out / declined / no-response / joined / do-not-contact) for one
    // prospect, saved to the SHARED pipeline so every future Find Techs / Bid-Out search near
    // that area shows the history. The server only appends to an EXISTING record, so we upsert
    // the row first (idempotent) - then the outcome lands on the same key we compute here.
    function vpRecordOutcome(row, mode, trade, status, note, wo, cb) {
      var k = vpKey(); if (!k) { if (cb) cb(new Error('No SWA key set (Tampermonkey menu -> "Set SWA ingest key").')); return; }
      var key = vpKeyOf(row);
      var rec = { name: row.name, website: row.site || '', phone: row.phone || '', addr: row.addr || '',
                  lat: row.lat, lng: row.lng, rating: row.rating, ratingCount: row.reviews,
                  kind: mode.kind, trades: trade ? [String(trade).split(',')[0].trim()] : [],
                  source: mode.kind === 'supplier' ? 'findsuppliers' : 'findtechs' };
      function postOutcome() {
        GM_xmlhttpRequest({
          method: 'POST', timeout: 30000, url: PROSPECTS_URL,
          headers: { 'Content-Type': 'application/json', 'x-bwn-key': k },
          data: JSON.stringify({ outcomes: [{ key: key, status: status, wo: wo || '', note: note || '' }] }),
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } if (j && j.ok && j.applied) { if (cb) cb(null, key); } else { if (cb) cb(new Error((j && j.error) || ('HTTP ' + r.status))); } },
          onerror: function () { if (cb) cb(new Error('network error')); }, ontimeout: function () { if (cb) cb(new Error('timed out')); }
        });
      }
      GM_xmlhttpRequest({   // ensure the record exists (idempotent) BEFORE appending the outcome
        method: 'POST', timeout: 30000, url: PROSPECTS_URL,
        headers: { 'Content-Type': 'application/json', 'x-bwn-key': k },
        data: JSON.stringify({ upsert: [rec] }),
        onload: postOutcome, onerror: postOutcome, ontimeout: postOutcome
      });
    }

    function makeBtn(label, fn) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.style.cssText = 'min-width:104px;padding:6px 10px;font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;text-transform:none;' +
        'color:#fff;border:none;border-radius:6px;cursor:pointer;text-align:center;background:' + GREEN + ';';
      b.addEventListener('click', function (e) { e.preventDefault(); fn(); });
      return b;
    }

    function buildBar() {
      var bar = document.createElement('div');
      bar.className = 'bwn-ft-bar';
      bar.style.cssText = 'display:inline-flex;gap:6px;align-items:center;align-self:center;flex:0 0 auto;margin-left:8px;';
      bar.appendChild(bwnMakeDropdown('Find', [
        { label: 'Find Techs', desc: 'Net-new contractor leads', fn: function () { openPanel(CONTRACTOR_MODE); } },
        { label: 'Find Suppliers', desc: 'Nearby supply houses', fn: function () { openPanel(SUPPLIER_MODE); } }
      ]));
      return bar;
    }

    // Anchor 1: the PO section's "+" add button (present only when POs exist).
    function mountPO() {
      var plus = document.querySelector('[data-testid="purchase-order-add-button"]');
      var hdr = !plus ? findPOHeader() : null;
      if (!plus && !hdr) return false;
      if (plus) {
        var span = plus.parentElement;                 // plain <span> wrapper
        var row = span && span.parentElement;          // flex row
        var target = row || plus.parentNode;
        if (target.querySelector(':scope > .bwn-ft-bar')) return true;
        if (row) row.insertBefore(buildBar(), span.nextSibling);
        else plus.parentNode.insertBefore(buildBar(), plus.nextSibling);
      } else {
        if (hdr.parentNode.querySelector(':scope > .bwn-ft-bar')) return true;
        hdr.parentNode.insertBefore(buildBar(), hdr.nextSibling);
      }
      return true;
    }

    // Anchor 2: the "See Who Is Available / Assign Vendor" action row.
    // Used only as a fallback - if the PO section is showing the buttons, defer to it.
    function mountActionRow(poPresent) {
      var btns = document.querySelectorAll('button');
      var anchor = null;
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim().toLowerCase();
        if (t === 'assign vendor' || t === 'see who is available') { anchor = btns[i]; break; }
      }
      if (!anchor) return false;
      var row = anchor.parentElement;
      if (!row) return false;
      var existing = row.querySelector(':scope > .bwn-ft-bar');
      if (poPresent) {                                  // PO section owns the buttons; clear the action-row copy
        if (existing) existing.remove();
        return false;
      }
      if (existing) return true;
      row.appendChild(buildBar());                      // sit after the action buttons
      return true;
    }

    function mount() {
      var a = mountPO();                                // true when the PO section is present
      var b = mountActionRow(a);                        // suppressed when PO section is present
      var ok = a || b;   // true if at least one anchor was handled; observer adds/removes as the PO section appears
      if (ok) BWN.beat('findTechs', 'ok', 'Find menu mounted');
      return ok;
    }

    var pollTimer = null;
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
    function schedule() {
      if (mount()) { stopPoll(); return; }
      // Without this, an SPA navigation away from the PO section would leave the
      // last 'ok' beat standing for a page where the module isn't mounted at all.
      BWN.beat('findTechs', 'waiting', 'PO section not rendered');
      if (pollTimer) return;
      var ticks = 0;
      pollTimer = setInterval(BWN.guard(function () {
        if (mount() || !/\/work-orders\//.test(location.pathname)) { stopPoll(); return; }
        // Watchdog: PO section on screen ~10s with no mount (an insertion throw the
        // guard swallowed, or partial anchor drift) = investigate.
        if ((document.querySelector('[data-testid="purchase-order-add-button"]') || findPOHeader()) && ++ticks === 33) {
          BWN.beat('findTechs', 'miss', 'PO section visible 10s but the Find menu never mounted - anchor drift?');
        }
      }, 'findTechs:poll'), 300);
    }
    var obs = new MutationObserver(BWN.guard(schedule, 'findTechs:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    schedule();

    // Command-palette bridge (Core dispatches bwn:cmd) - inside the module so
    // the kill switch disables it too.
    document.addEventListener('bwn:cmd', BWN.guard(function (e) {
      var d = e && e.detail;
      if (!d) return;
      if (d.id === 'ai:findtechs') openPanel(CONTRACTOR_MODE);
      else if (d.id === 'ai:findsup') openPanel(SUPPLIER_MODE);
    }, 'findTechs:cmd'));
  });

  // ============================================================================
  // SERVICE REQUEST HELPER - augments Umbrava's native "Build Requests" modal
  // (opened by "See Who Is Available"). Stage 1, client-side only: preset the
  // required vendor NTE at a configurable % of the WO's Client DNE (rounded to
  // the nearest $10), and optionally default the Contact Email to a team "bids"
  // inbox. Degrades to a no-op if a field can't be found; never overwrites a
  // value the coordinator already typed.
  // ============================================================================
  if (BWN_MODULES.serviceRequest) BWN.safeModule('serviceRequest', function () {
    'use strict';

    function srPct() { var n = parseInt(GM_getValue('sr_nte_pct', '60'), 10); return (isNaN(n) || n < 0 || n > 100) ? 60 : n; }
    function srEmail() { return String(GM_getValue('sr_contact_email', '') || '').trim(); }

    GM_registerMenuCommand('Set SR vendor-NTE % (of Client DNE)', function () {
      var v = prompt('Vendor NTE is auto-filled in the Build Requests modal as this % of the Client DNE (rounded to the nearest $10).\n\nEnter a whole number 0-100:', String(srPct()));
      if (v === null) return;
      var n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 100) { alert('Enter a whole number between 0 and 100.'); return; }
      GM_setValue('sr_nte_pct', String(n));
      alert('Service Request: vendor NTE preset set to ' + n + '% of Client DNE.');
    });
    GM_registerMenuCommand('Set SR contact email (team inbox)', function () {
      var v = prompt('Default the Build Requests "Contact Email" to a team bids inbox.\nLeave BLANK to keep the work order assignee (Umbrava default).', srEmail());
      if (v === null) return;
      v = v.trim();
      if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { alert('That does not look like an email address.'); return; }
      GM_setValue('sr_contact_email', v);
      alert(v ? ('Service Request: contact email will default to ' + v) : 'Service Request: contact email will stay the work order assignee.');
    });

    function srToast(msg) {
      try {
        var t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:100002;max-width:360px;background:#0d3d26;color:#fff;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;padding:11px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);';
        document.body.appendChild(t);
        setTimeout(function () { try { t.remove(); } catch (_) { } }, 4600);
      } catch (e) { }
    }

    // Find an input by its visible MUI label within `scope`. Returns the element or null.
    function fieldInput(scope, labelRe) {
      var labels = scope.querySelectorAll('label');
      for (var i = 0; i < labels.length; i++) {
        var t = (labels[i].textContent || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();
        if (!labelRe.test(t)) continue;
        var fc = labels[i].closest('.MuiFormControl-root, .MuiTextField-root') || labels[i].parentElement;
        if (!fc) continue;
        var inp = fc.querySelector('input:not([type="hidden"]):not(.MuiSelect-nativeInput), textarea');
        if (inp) return inp;
      }
      return null;
    }

    // Client DNE for the current WO: prefer Core's bus (dne), else read the WO field.
    function clientDNE() {
      try { var b = BWN.busGet(BWN.woId(), 12 * 3600000); if (b && b.dne != null && b.dne > 0) return b.dne; } catch (e) { }
      var inp = fieldInput(document, /^client dne$/i);
      if (inp) { var n = parseFloat(String(inp.value || '').replace(/[$,\s]/g, '')); if (!isNaN(n) && n > 0) return n; }
      return 0;
    }

    // The open Build Requests modal panel, if present (matched by its heading text).
    function findModal() {
      var mods = document.querySelectorAll('.MuiModal-root, .MuiDialog-root, [role="presentation"], [role="dialog"]');
      for (var i = 0; i < mods.length; i++) {
        if ((mods[i].textContent || '').indexOf('Build Requests') !== -1) return mods[i].querySelector('.MuiPaper-root') || mods[i];
      }
      return null;
    }

    function enhance(panel) {
      // NTE preset (Step 1). Only fill an EMPTY NTE so a typed value is never stomped.
      var nteInp = fieldInput(panel, /^nte$/i);
      if (nteInp && !String(nteInp.value || '').trim()) {
        var dne = clientDNE();
        if (dne > 0) {
          var pct = srPct();
          var nte = Math.round((dne * pct / 100) / 10) * 10;
          if (nte > 0) {
            try { BWN.setNativeValue(nteInp, String(nte)); } catch (e) { }
            srToast('Vendor NTE preset to $' + nte.toLocaleString() + ' (' + pct + '% of $' + dne.toLocaleString() + ' Client DNE) - adjust if needed.');
          }
        }
      }
      // Contact Email -> team inbox, only when configured; otherwise leave the assignee.
      var em = srEmail();
      if (em) {
        var emInp = fieldInput(panel, /^contact email$/i);
        if (emInp && String(emInp.value || '').trim() !== em) { try { BWN.setNativeValue(emInp, em); } catch (e) { } }
      }
    }

    // ---- Stage 2: net-new (outside-network) vendors INLINE in the Select-Vendors step -------
    // Sourced from Google Places on a "Find nearby" click, de-duped against the network vendors
    // Umbrava is already showing, and selectable right here. "Invite selected" hands the chosen
    // leads to Bid-Out's review-before-send (Umbrava CANNOT dispatch non-network vendors, so
    // their outreach goes through our CAN-SPAM-safe email flow - nothing auto-sends). Re-injected
    // if React re-renders the list away; sourced leads (SR_LEADS) survive the re-inject.
    var SR_MASK = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.location';
    var SR_LEADS = [];
    function srEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }
    function srNorm(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\./g, '').replace(/\b(inc|llc|corp|co|company|ltd|the|and|of)\b/g, ' ').replace(/[^a-z0-9]+/g, ''); }
    function srMiles(aLat, aLng, bLat, bLng) {
      if (![aLat, aLng, bLat, bLng].every(function (n) { return typeof n === 'number'; })) return null;
      var R = 3958.8, dLat = (bLat - aLat) * Math.PI / 180, dLng = (bLng - aLng) * Math.PI / 180;
      var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }
    function srWoAddr() {
      try { var b = BWN.busGet(BWN.woId(), 12 * 3600000); if (b && b.addr) return b.addr; } catch (e) { }
      var el = document.querySelector('[data-testid="wo-location-dropdown-input-label"]') || document.querySelector('[data-testid="wo-location-dropdown-input"] input');
      return el ? String(el.value || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }
    function srWoTrade() {
      var el = document.querySelector('[data-testid="wo-trades-dropdown"]') || document.querySelector('[data-testid="trades-dropdown-field"]');
      var t = el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      return (t.split(/[,;]/)[0] || '').trim();
    }
    function srPlaces(body, mask, cb) {
      var key = GM_getValue('places_key', '');
      if (!key) { cb(new Error('Set the Google Places API key (Tampermonkey menu) to find net-new vendors.')); return; }
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: 'https://places.googleapis.com/v1/places:searchText',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
          data: JSON.stringify(body), timeout: 20000,
          onload: function (r) { try { var j = JSON.parse(r.responseText || '{}'); if (r.status < 200 || r.status >= 300) { cb(new Error('Places ' + r.status + (j.error ? ': ' + j.error.message : ''))); return; } cb(null, j.places || []); } catch (e) { cb(e); } },
          onerror: function () { cb(new Error('Network error calling Places (check @connect / key).')); },
          ontimeout: function () { cb(new Error('Places request timed out.')); }
        });
      } catch (e) { cb(e); }
    }
    function srNetworkNames(panel) {
      var out = {};
      panel.querySelectorAll('a[href^="/vendors/"]').forEach(function (a) {
        var n = srNorm((a.textContent || '').replace(/\s+/g, ' ').trim()); if (n.length >= 4) out[n] = 1;
      });
      return out;
    }
    function srFindNetNew(panel, cb) {
      var addr = srWoAddr(); if (!addr) { cb(new Error('No work-order address found to search around.')); return; }
      var trade = srWoTrade();
      srPlaces({ textQuery: addr, maxResultCount: 1 }, 'places.location', function (e1, centers) {
        var c = (!e1 && centers && centers[0] && centers[0].location) ? centers[0].location : null;
        var body = { textQuery: (trade ? trade + ' ' : '') + 'contractor near ' + addr, maxResultCount: 20 };
        if (c) body.locationBias = { circle: { center: c, radius: 50000 } };
        srPlaces(body, SR_MASK, function (e2, places) {
          if (e2) { cb(e2); return; }
          var net = srNetworkNames(panel), seen = {}, leads = [];
          (places || []).forEach(function (p) {
            var name = (p.displayName && p.displayName.text) || ''; if (!name) return;
            var nn = srNorm(name); if (!nn || net[nn] || seen[nn]) return; seen[nn] = 1;
            leads.push({
              name: name, phone: p.nationalPhoneNumber || '', website: /^https?:\/\//i.test(p.websiteUri || '') ? p.websiteUri : '',
              rating: (typeof p.rating === 'number') ? p.rating : null, ratingCount: p.userRatingCount || 0,
              mi: (c && p.location) ? srMiles(c.latitude, c.longitude, p.location.latitude, p.location.longitude) : null
            });
          });
          leads.sort(function (a, b) { return (a.mi == null ? 1e9 : a.mi) - (b.mi == null ? 1e9 : b.mi); });
          cb(null, leads);
        });
      });
    }
    function srRenderRows(listEl) {
      if (!SR_LEADS.length) { listEl.innerHTML = '<div style="font-size:11.5px;color:#64748b;padding:6px 2px;">No net-new vendors found nearby (all matches may already be in your network).</div>'; return; }
      listEl.innerHTML = SR_LEADS.map(function (l, i) {
        var rating = l.rating != null ? ('★ ' + l.rating.toFixed(1) + ' (' + (l.ratingCount || 0) + ')') : 'unrated';
        var miles = l.mi != null ? (l.mi.toFixed(1) + ' mi') : '';
        var site = l.website ? (/^https?:\/\//i.test(l.website) ? '<a href="' + srEsc(l.website) + '" target="_blank" rel="noopener noreferrer" style="color:#1a5f3e;">site</a>' : 'site') : '';
        return '<label style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #eef2f7;font-size:12px;cursor:pointer;">' +
          '<input type="checkbox" data-lead="' + i + '" checked style="flex:none;">' +
          '<span style="flex:1;min-width:0;"><span style="font-weight:500;color:#0d3d26;">' + srEsc(l.name) + '</span> <span style="color:#94a3b8;font-size:10px;">outside network</span></span>' +
          '<span style="color:#64748b;font-size:10.5px;white-space:nowrap;">' + miles + '</span>' +
          '<span style="color:#64748b;font-size:10.5px;white-space:nowrap;">' + rating + '</span>' +
          '<span style="font-size:10.5px;white-space:nowrap;">' + site + '</span></label>';
      }).join('');
    }
    function srLca(a, b) { var A = []; for (var x = a; x; x = x.parentElement) A.push(x); for (var y = b; y; y = y.parentElement) { if (A.indexOf(y) !== -1) return y; } return null; }
    function srUpdateInvite(sec) {
      var n = sec.querySelectorAll('[data-sr-list] input[data-lead]:checked').length;
      var b = sec.querySelector('[data-sr-invite]'); if (b) { b.textContent = 'Invite selected' + (n ? ' (' + n + ')' : '') + ' →'; b.disabled = !n; b.style.opacity = n ? '1' : '.5'; }
    }
    function ensureNetNewSection(panel) {
      if (document.getElementById('bwn-sr-netnew')) return;
      var sec = document.createElement('div');
      sec.id = 'bwn-sr-netnew';
      sec.style.cssText = 'margin:10px 2px 4px;padding:10px 12px;border:1px dashed #1a5f3e;border-radius:8px;background:#f7fbf9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;';
      sec.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<span style="font:600 11px ui-monospace,\'Segoe UI Mono\',monospace;letter-spacing:normal;text-transform:none;color:#0d3d26;">Net-new vendors (outside the network)</span>' +
        '<button type="button" data-sr-find style="margin-left:auto;font:500 11px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;padding:4px 10px;border:1px solid #1a5f3e;border-radius:6px;background:#fff;color:#0d3d26;cursor:pointer;">🔎 Find nearby</button>' +
        '</div>' +
        '<div data-sr-status style="font-size:11px;color:#64748b;margin-bottom:4px;">Google-sourced, de-duped against the vendors above. They go out via our review-before-send email (Umbrava can\'t dispatch them).</div>' +
        '<div data-sr-list></div>' +
        '<div data-sr-foot style="display:none;margin-top:8px;text-align:right;"><button type="button" data-sr-invite style="font:500 12px -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;padding:7px 14px;border:none;border-radius:6px;background:#1a5f3e;color:#fff;cursor:pointer;">Invite selected →</button></div>';
      var statusEl = sec.querySelector('[data-sr-status]'), listEl = sec.querySelector('[data-sr-list]'), footEl = sec.querySelector('[data-sr-foot]');
      sec.querySelector('[data-sr-find]').addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var fb = sec.querySelector('[data-sr-find]'); fb.disabled = true; fb.textContent = 'Searching…';
        statusEl.textContent = 'Searching Google for vendors near the job…';
        srFindNetNew(panel, function (err, leads) {
          fb.disabled = false; fb.textContent = '🔎 Find nearby';
          if (err) { statusEl.textContent = err.message || 'Search failed.'; return; }
          SR_LEADS = leads || [];
          statusEl.textContent = SR_LEADS.length + ' net-new vendor' + (SR_LEADS.length === 1 ? '' : 's') + ' found (not already in your network).';
          srRenderRows(listEl); footEl.style.display = SR_LEADS.length ? 'block' : 'none'; srUpdateInvite(sec);
        });
      });
      listEl.addEventListener('change', function () { srUpdateInvite(sec); });
      sec.querySelector('[data-sr-invite]').addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var chosen = [];
        listEl.querySelectorAll('input[data-lead]:checked').forEach(function (cb) { var l = SR_LEADS[+cb.getAttribute('data-lead')]; if (l) chosen.push(l); });
        if (!chosen.length) { srToast('Select at least one net-new vendor to invite.'); return; }
        try { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'bidout:invite', leads: chosen } })); } catch (x) { }
        srToast(chosen.length + ' net-new vendor' + (chosen.length === 1 ? '' : 's') + ' handed to the invite tool - review before anything sends.');
      });
      // Place just below Umbrava's network vendor list (sibling after the list container).
      var cards = panel.querySelectorAll('a[href^="/vendors/"]');
      if (cards.length) {
        var anchor = cards.length > 1 ? srLca(cards[0], cards[cards.length - 1]) : cards[0].parentElement;
        if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(sec, anchor.nextSibling);
        else if (anchor) anchor.appendChild(sec);
        else panel.appendChild(sec);
      } else { panel.appendChild(sec); }
      // Restore a prior search across a React-driven re-inject.
      if (SR_LEADS.length) { srRenderRows(listEl); footEl.style.display = 'block'; srUpdateInvite(sec); }
    }

    function scan() {
      if (!BWN.woId()) return;                 // Build Requests only exists on a WO page
      var panel = findModal();
      if (!panel) { var orphan = document.getElementById('bwn-sr-netnew'); if (orphan) orphan.remove(); return; }
      // Stage 1 (once per open): preset NTE + contact email on the Work Order Details step,
      // as soon as those fields have rendered (the modal mounts async).
      if (panel.getAttribute('data-bwn-sr') !== '1' && (fieldInput(panel, /^nte$/i) || fieldInput(panel, /^contact email$/i))) {
        panel.setAttribute('data-bwn-sr', '1');
        enhance(panel);
      }
      // Stage 2: only on the Select-Vendors step (matched by its stable labels).
      if (/Vendors in Area|Active Vendors Only|Select All/i.test(panel.textContent || '')) ensureNetNewSection(panel);
      else { var b = document.getElementById('bwn-sr-netnew'); if (b) b.remove(); }
    }

    var pending = null;
    var obs = new MutationObserver(BWN.guard(function () {
      clearTimeout(pending);
      pending = setTimeout(BWN.guard(scan, 'serviceRequest:scan'), 250);
    }, 'serviceRequest:observe'));
    obs.observe(document.body, { childList: true, subtree: true });
    scan();
  });

})();