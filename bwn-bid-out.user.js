// ==UserScript==
// @name         BWN Bid-Out (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.26.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-bid-out.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-bid-out.user.js
// @description  Email RFP to outside / net-new vendors, launched from a caret on Umbrava's own "See Who Is Available" button (network-vendor bidding stays native - no separate Bid-Out button). The caret menu opens the tracked email RFP wizard: finds net-new vendors nearby through Google Places, looks up their emails via the BWN scrape-contacts function, takes pasted outside addresses, and can still include assignable Umbrava vendors in the same email. You pick who's included, then review the exact recipient list and the rendered email before anything sends. Send from your own mailbox via the SWA send-bid function (Microsoft Graph), or open a plain Outlook draft. Vendors are BCC'd; nothing sends until you click Send. Network access is limited to Umbrava (same-origin), Google Places, and your SWA host.
// @match        https://app.umbrava.com/work-orders/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      places.googleapis.com
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// @require       https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js#sha384=bed8dab3289d528d245bde0ae4c5c35e7b73389a50801297984eded866b82c6d2c9134cb7818bdede1405eca9ec098f0
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.26.0';
  console.info('[BWN BID-OUT] v' + VER + ' - 3-step Build Requests wizard (WO details -> select vendors -> review) · Umbrava vendors + Places net-new discovery + email scrape · one-click Graph send via SWA (Outlook-draft fallback)');

  var COMPANY_ADDR = 'Broadway National Group, 100 Davids Dr, Hauppauge, NY 11788';
  var DEFAULT_MILES = 50;
  var MAX_BCC = 60;
  var PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
  var SCRAPE_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/scrape-contacts';
  var ENRICH_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/enrich-contacts';
  var PROSPECTS_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/vendor-prospects';
  var SEND_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/send-bid';
  var STATUS_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/bid-status';
  var HVAC_BENCH_URL = 'https://green-stone-0717dab0f.7.azurestaticapps.net/api/hvac-benchmark';
  var LOGO_SRC = 'https://green-stone-0717dab0f.7.azurestaticapps.net/assets/bwn-logo.png';
  var COMPANY_PHONE = '1.631.737.3140';

  // ---- Umbrava in-page GraphQL (same-origin, Auth0 bearer) -------------------
  // Token picked by CONTENT, not just key: the audience-keyed Auth0 cache slot transiently
  // holds NON-Umbrava tokens (seen live 2026-07-21: an Azure Functions/SCM runtime token,
  // iss *.scm.azurewebsites.net, HS256), which Umbrava's GraphQL rejects as UNAUTHENTICATED.
  // Only an unexpired token with an Umbrava issuer is usable; otherwise report signed-out.
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
      var keys = Object.keys(localStorage).filter(function (x) { return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x); });
      for (var i = 0; i < keys.length; i++) {
        var v = JSON.parse(localStorage.getItem(keys[i]));
        var tok = (v && v.body && v.body.access_token) || null;
        if (tok && isUmbravaToken(tok)) return tok;
      }
      return null;
    } catch (e) { return null; }
  }
  function actor() {
    try {
      var k = Object.keys(localStorage).find(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); });
      var u = k ? ((JSON.parse(localStorage.getItem(k)) || {}).decodedToken || {}).user : null;
      return { name: (u && u.name) || '', email: (u && u.email) || '' };
    } catch (e) { return { name: '', email: '' }; }
  }
  function gql(query, variables) {
    var tok = authToken();
    if (!tok) return Promise.reject(new Error('Not signed in to Umbrava (no session token found).'));
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      return j.data;
    });
  }

  function woNumber() {
    var m = location.pathname.match(/\/work-orders\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  var WO_Q =
    'query($n:Int!){ workOrder(workOrderNumber:$n){ number trackingNumber scopeOfWork serviceInstructions ' +
    'locationId locationName workOrderTypeId address{ latitude longitude addressLine1 city state postalCode } ' +
    'trades{ id name } priority{ label } doNotExceed{ amount } } }';
  function loadWO(n) { return gql(WO_Q, { n: n }).then(function (d) { return d && d.workOrder; }); }

  var VEND_Q =
    'query($t:[ID!]!,$loc:ID!,$type:Int!,$lat:Float,$lng:Float,$take:Int!){ ' +
    'getAssignableVendors(tradeIds:$t, tradeFilterOption:Any, locationId:$loc, workOrderTypeId:$type, ' +
    'locationLatitude:$lat, locationLongitude:$lng, page:{skip:0,take:$take}, ' +
    'sortBy:[{columnName:"distanceFromLocation",direction:ASC}], filter:[]){ value{ rowCount items{ ' +
    'id name distanceFromLocation averageRating ratingCount mainContactInfo{ emailAddress mainPhoneNumber } } } } }';
  function loadVendors(wo, take) {
    var trades = (wo.trades || []).map(function (t) { return t.id; }).filter(Boolean);
    var lat = wo.address ? wo.address.latitude : null;
    var lng = wo.address ? wo.address.longitude : null;
    return gql(VEND_Q, { t: trades, loc: wo.locationId, type: wo.workOrderTypeId || 8, lat: lat, lng: lng, take: take || 60 })
      .then(function (d) {
        var v = d && d.getAssignableVendors && d.getAssignableVendors.value;
        return { rowCount: (v && v.rowCount) || 0, items: (v && v.items) || [] };
      });
  }

  function parseEmails(text) {
    var out = [], seen = {};
    (String(text || '').match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []).forEach(function (e) {
      var k = e.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(e); }
    });
    return out;
  }

  // ---- Net-new discovery: Google Places (own key) + our SWA email scraper -----
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
  function gmGet(url, headers, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: url, headers: headers, timeout: timeoutMs || 30000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }
  // Small stable string hash (cyrb53) for the idempotency key - see the send handler.
  function cyrb53(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function haversineMi(aLat, aLng, bLat, bLng) {
    if ([aLat, aLng, bLat, bLng].some(function (x) { return typeof x !== 'number'; })) return null;
    var R = 3958.8, dLat = (bLat - aLat) * Math.PI / 180, dLng = (bLng - aLng) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function normName(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(inc|llc|corp|co|company|ltd|the|and|of)\b/g, ' ').replace(/[^a-z0-9]+/g, ''); }
  function domainOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } }

  function placesSearch(wo, miles) {
    var key = GM_getValue('places_key', '');
    if (!key) return Promise.reject(new Error('NO_PLACES_KEY'));
    if (!wo.address || typeof wo.address.latitude !== 'number') return Promise.reject(new Error('This WO has no map coordinates to search around.'));
    var trade = (wo.trades && wo.trades[0] && wo.trades[0].name) || '';
    var body = {
      textQuery: (trade ? trade + ' ' : '') + 'contractor',
      maxResultCount: 20,
      locationBias: { circle: { center: { latitude: wo.address.latitude, longitude: wo.address.longitude }, radius: Math.min(50000, Math.max(1000, Math.round((miles || 25) * 1609))) } }
    };
    var headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.location' };
    return gmPost(PLACES_URL, headers, body, 20000).then(function (r) {
      if (r.status < 200 || r.status >= 300) throw new Error('Places API ' + r.status + (r.json && r.json.error ? ': ' + r.json.error.message : ''));
      return (r.json && r.json.places) || [];
    });
  }
  function scrapeEmails(urls) {
    var key = GM_getValue('ingest_key', '');
    if (!key) return Promise.resolve({ map: {}, skipped: true });
    if (!urls.length) return Promise.resolve({ map: {}, skipped: false });
    return gmPost(SCRAPE_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { urls: urls }, 90000).then(function (r) {
      if (r.status < 200 || r.status >= 300 || !r.json || !r.json.ok) return { map: {}, skipped: false, err: (r.json && r.json.error) || ('HTTP ' + r.status) };
      var map = {}, res = r.json.results || {};
      Object.keys(res).forEach(function (u) { map[u] = (res[u].emails || [])[0] || ''; });
      return { map: map, skipped: false };
    }).catch(function (e) { return { map: {}, skipped: false, err: e.message }; });
  }
  // ZoomInfo named-contact fallback (via the key-gated SWA enrich-contacts function, which
  // rides Broadway's existing ZoomInfo subscription). Only called for leads whose websites
  // published no email; results are server-cached 30 days + daily-capped to protect the
  // credit pool shared with the sales team. Degrades silently until credentials land.
  var ZI_EMAIL_OK = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[A-Za-z]{2,}$/;   // strict (mirrors send-bid) - a "," or ";" in an address could smuggle recipients
  function enrichContacts(companies) {
    var key = GM_getValue('ingest_key', '');
    if (!key || !companies.length) return Promise.resolve({ map: {}, note: '' });
    return gmPost(ENRICH_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { companies: companies }, 90000).then(function (r) {
      if (r.status === 503 && r.json && r.json.code === 'ZI_UNCONFIGURED') return { map: {}, note: 'ZoomInfo enrichment pending credentials (ask the ZoomInfo admin).' };
      if (r.status < 200 || r.status >= 300 || !r.json || !r.json.ok) return { map: {}, note: '' };
      var map = {}, res = r.json.results || {};
      Object.keys(res).forEach(function (k) { var c = ((res[k] || {}).contacts || [])[0]; if (c && c.email && ZI_EMAIL_OK.test(c.email)) map[k] = c; });
      var bits = [];
      if (r.json.skippedForCap && r.json.skippedForCap.length) bits.push('ZoomInfo daily credit cap reached - ' + r.json.skippedForCap.length + ' lead(s) not enriched today.');
      if (r.json.skippedForTime && r.json.skippedForTime.length) bits.push(r.json.skippedForTime.length + ' lead(s) deferred for time - Find again to continue.');
      return { map: map, note: bits.join(' ') };
    }).catch(function () { return { map: {}, note: '' }; });
  }
  // Shared ZoomInfo fallback: enrich the leads that still have no email, in batches of 4 (the
  // server caps a call at 8 companies and budgets ~30s - small batches keep every response well
  // inside the SWA gateway window and never silently strand leads 9+). Mutates the leads.
  function ziKey(l) { return domainOf(l.website) || normName(l.name) || String(l.name || '').toLowerCase().replace(/\s+/g, ' ').trim(); }   // must mirror the server's keyOf
  function ziFallback(leads) {
    var need = (leads || []).filter(function (l) { return !l.email && l.name; });
    if (!need.length) return Promise.resolve({ note: '' });
    var chunks = [];
    for (var i = 0; i < need.length; i += 4) chunks.push(need.slice(i, i + 4));
    var map = {}, notes = [];
    return chunks.reduce(function (p, chunk) {
      return p.then(function () {
        return enrichContacts(chunk.map(function (l) { return { name: l.name, website: l.website || '' }; })).then(function (er) {
          Object.keys(er.map).forEach(function (k) { map[k] = er.map[k]; });
          if (er.note && notes.indexOf(er.note) === -1) notes.push(er.note);
        });
      });
    }, Promise.resolve()).then(function () {
      need.forEach(function (l) {
        var c = map[ziKey(l)];
        if (c) { l.email = c.email; l.contact = c.name || ''; l.title = c.title || ''; l.src = 'zoominfo'; }
      });
      return { note: notes.join(' ') };
    });
  }
  // ---- BWN vendor-prospect PIPELINE (shared with Find Techs / Find Suppliers) --------------
  // Every paid discovery is SAVED (upsert) and every search READS the pipeline first - a
  // prospect found once is never paid for again, and outcome history (declined / joined /
  // do-not-contact, with the WO and note) follows the prospect into future searches.
  function pipelineFetch(wo, miles) {
    var key = GM_getValue('ingest_key', '');
    if (!key || !wo.address || typeof wo.address.latitude !== 'number') return Promise.resolve([]);
    var url = PROSPECTS_URL + '?near=' + wo.address.latitude + ',' + wo.address.longitude + '&mi=' + (miles || 50) + '&kind=contractor';
    return gmGet(url, { 'x-bwn-key': key }, 30000).then(function (r) {
      if (r.status < 200 || r.status >= 300 || !r.json || !r.json.ok) return [];
      return (r.json.prospects || []).map(function (p) {
        return { name: p.name, phone: p.phone || '', website: p.website || '', rating: p.rating, ratingCount: p.ratingCount,
                 mi: p.miles, email: p.email || '', contact: p.contactName || '', title: p.contactTitle || '',
                 src: 'pipeline', key: p.key, lastOutcome: p.lastOutcome || null,
                 dnc: !!(p.lastOutcome && p.lastOutcome.status === 'do-not-contact') };
      });
    }).catch(function () { return []; });
  }
  function prospectsUpsert(leads, wo) {
    var key = GM_getValue('ingest_key', '');
    if (!key || !leads.length) return Promise.resolve();
    var trade = (wo.trades && wo.trades[0] && wo.trades[0].name) || '';
    var recs = leads.filter(function (l) { return l.name && l.src !== 'pipeline'; }).map(function (l) {
      return { name: l.name, website: l.website || '', phone: l.phone || '', email: l.email || '',
               contactName: l.contact || '', contactTitle: l.title || '', emailSrc: l.src === 'zoominfo' ? 'zoominfo' : (l.email ? 'scrape' : ''),
               addr: l.addr || '', lat: l.lat, lng: l.lng, rating: l.rating, ratingCount: l.ratingCount,
               kind: 'contractor', trades: trade ? [trade] : [], source: 'bidout' };
    });
    var chunks = []; for (var i = 0; i < recs.length; i += 40) chunks.push(recs.slice(i, i + 40));
    return chunks.reduce(function (p, chunk) {
      return p.then(function () { return gmPost(PROSPECTS_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { upsert: chunk }, 30000).catch(function () { }); });
    }, Promise.resolve());
  }
  function prospectsOutcomes(list) {   // [{key, status, wo, note}] - fire-and-forget, batched
    var key = GM_getValue('ingest_key', '');
    if (!key || !list.length) return Promise.resolve();
    var me = actor();
    var outs = list.slice(0, 60).map(function (o) { return { key: o.key, status: o.status, wo: o.wo || '', note: o.note || '', by: me.email || me.name || '' }; });
    return gmPost(PROSPECTS_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { outcomes: outs }, 30000).catch(function () { });
  }
  function outcomeBadge(l) {
    var o = l.lastOutcome; if (!o) return '';
    var d = new Date(o.ts || 0); var when = isNaN(d.getTime()) ? '' : ((d.getMonth() + 1) + '/' + d.getDate());
    var lbl = o.status + (when ? ' ' + when : '') + (o.wo ? ' · WO ' + o.wo : '');
    var col = o.status === 'joined' ? '#166534' : (o.status === 'do-not-contact' || o.status === 'declined') ? '#b91c1c' : '#92400e';
    return '<span class="mi" style="color:' + col + ';font-weight:600;" title="' + esc((o.note || '') + (o.by ? ' - ' + o.by : '')) + '">' + esc(lbl) + '</span>';
  }
  // Places discovery → dedupe vs the Umbrava list (+ self) → scrape emails.
  function discoverNetNew(wo, miles, umbravaItems) {
    var umbNames = {}, umbDomains = {};
    (umbravaItems || []).forEach(function (v) {
      umbNames[normName(v.name)] = 1;
      var em = v.mainContactInfo && v.mainContactInfo.emailAddress; var d = em ? (em.split('@')[1] || '').toLowerCase() : '';
      if (d) umbDomains[d] = 1;
    });
    return placesSearch(wo, miles).then(function (places) {
      var seen = {}, leads = [];
      places.forEach(function (p) {
        var name = (p.displayName && p.displayName.text) || '';
        if (!name) return;
        var web = p.websiteUri || '', dom = domainOf(web), nn = normName(name);
        if (umbNames[nn] || (dom && umbDomains[dom])) return;   // already in Umbrava → omit redundant
        var key = dom || nn; if (seen[key]) return; seen[key] = 1; // dedupe Places against itself
        var mi = p.location ? haversineMi(wo.address.latitude, wo.address.longitude, p.location.latitude, p.location.longitude) : null;
        leads.push({ name: name, phone: p.nationalPhoneNumber || '', website: web, rating: p.rating, ratingCount: p.userRatingCount, mi: mi, email: '', addr: p.formattedAddress || '', lat: p.location ? p.location.latitude : null, lng: p.location ? p.location.longitude : null });
      });
      var urls = leads.map(function (l) { return l.website; }).filter(Boolean);
      return scrapeEmails(urls).then(function (sr) {
        leads.forEach(function (l) { if (l.website && sr.map[l.website]) l.email = sr.map[l.website]; });
        // ZoomInfo fallback for the leads the scrape couldn't email (site publishes none).
        return ziFallback(leads).then(function (zr) {
          // Save the paid discovery to the shared pipeline. Keep the promise so outcome POSTs
          // (bid-sent / declined / DNC) can wait for the records to exist server-side first.
          openState.upsertP = prospectsUpsert(leads, wo);
          return { leads: leads, scrapeSkipped: sr.skipped, scrapeErr: sr.err, ziNote: zr.note };
        });
      });
    });
  }

  // ---- Email assembly (BCC blast - recipients must not see each other) --------
  // ==== HVAC PM benchmark ====================================================
  // Drop a "HVAC PM Price Benchmarking" workbook once (parsed with SheetJS, stored in GM).
  // Two sheets: a pivot summary (State/City/Equipment/Count/Target Annual Contract Price) and a
  // per-unit asset detail (City/State/Zip/Equipment/Manufacturer/Year/...). Indexed by CITY|STATE
  // (verified 49/50 sites unique; Tempe AZ is the lone 2-zip city, disambiguated by the WO zip).
  // On a bid whose WO city/state matches, we prefill the editable Asset field with the equipment
  // summary and attach the site's target annual price + full per-unit list to the RFP.
  var HVAC_GM_KEY = 'bwn:hvacpm';
  var _hvacIndex;   // module cache
  var _hvacScope = null;    // 'team' | 'private' | null (unknown) - from the SWA on share/fetch
  var _hvacTeamId = null;
  var _hvacTeamTried = false;   // fetch the team-shared index at most once per page load
  function hvacNormKey(city, st) { return String(st || '').trim().toUpperCase() + '|' + String(city || '').trim().toUpperCase(); }
  function hvacTitle(s) { return String(s || '').toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function hvacMoney(n) { var x = Math.round((+n || 0) * 100) / 100; var s = x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return s.replace(/\.00$/, ''); }
  function hvacBuildIndex(rows6, rows1) {
    var price = {}, curState = '';
    for (var i = 1; i < rows6.length; i++) {
      var r = rows6[i]; if (!r) continue;
      var a = (r[0] == null ? '' : String(r[0])).trim();
      var b = (r[1] == null ? '' : String(r[1])).trim();
      if (a && !/ Total$/.test(a) && a.length === 2) curState = a;                 // state header e.g. "AZ"
      if (b && / Total$/.test(b)) {                                                 // "<City> Total" row carries the price
        var city = b.replace(/ Total$/, ''), cnt = +r[3] || 0, pr = +r[4] || 0;
        if (pr > 0) price[hvacNormKey(city, curState)] = { units: cnt, annual: pr, perUnit: cnt ? pr / cnt : 0, city: city, st: curState };
      }
    }
    var assets = {};
    for (var j = 1; j < rows1.length; j++) {
      var d = rows1[j]; if (!d || !d[0]) continue;
      var c2 = String(d[0]).trim(), s2 = String(d[1] || '').trim(), zip = String(d[2] || '').split('-')[0].trim();
      var k = hvacNormKey(c2, s2);
      var rec = assets[k] || (assets[k] = { city: c2, st: s2, zips: {}, units: [] });
      rec.zips[zip] = true;
      rec.units.push({ type: String(d[3] || '').trim(), mfr: String(d[4] || '').trim(), year: d[5] || '', loc: String(d[6] || '').trim(), voltage: String(d[7] || '').trim(), tons: d[8] || '', heat: String(d[9] || '').trim(), fan: d[10] || '', zip: zip });
    }
    return { price: price, assets: assets };
  }
  function hvacMatch(index, wo) {
    if (!index || !wo || !wo.address) return null;
    var k = hvacNormKey(wo.address.city, wo.address.state);
    var a = index.assets[k], p = index.price[k];
    if (!a && !p) return null;
    var units = (a && a.units) || [], zips = a ? Object.keys(a.zips) : [], multiZip = zips.length > 1;
    var woZip = String((wo.address && wo.address.postalCode) || '').split('-')[0].trim();
    var list = units, filtered = false;
    if (multiZip && woZip && units.some(function (u) { return u.zip === woZip; })) { list = units.filter(function (u) { return u.zip === woZip; }); filtered = true; }
    var counts = {};
    list.forEach(function (u) { if (u.type) counts[u.type] = (counts[u.type] || 0) + 1; });
    // The pivot carries price only at the CITY level (no per-zip price). For a multi-store city
    // narrowed to one store, the city-total annual would OVERSTATE this store - pro-rate it from
    // the city per-unit rate and flag it estimated. Single-store cities keep the exact total.
    var annual = p ? p.annual : null, perUnit = p ? p.perUnit : null, estimated = false;
    if (p && filtered && list.length !== p.units) { annual = (perUnit != null) ? Math.round(perUnit * list.length) : null; estimated = true; }
    return {
      city: (a && a.city) || (p && p.city) || (wo.address && wo.address.city) || '', st: (a && a.st) || (p && p.st) || (wo.address && wo.address.state) || '',
      annual: annual, perUnit: perUnit, estimated: estimated, cityUnits: p ? p.units : null, cityAnnual: p ? p.annual : null,
      counts: Object.keys(counts).map(function (t) { return { type: t, n: counts[t] }; }).sort(function (x, y) { return y.n - x.n; }),
      list: list, siteUnits: list.length, multiZip: multiZip, zipUsed: (multiZip && woZip) ? woZip : null, allZips: zips
    };
  }
  function hvacSummaryLine(m) {
    var parts = m.counts.map(function (c) { return c.n + 'x ' + hvacTitle(c.type); });
    return m.siteUnits + ' unit' + (m.siteUnits === 1 ? '' : 's') + ': ' + parts.join(', ');
  }
  // Detect the two sheets by header content (don't hardcode sheet names).
  function hvacParseAndStore(arrayBuffer) {
    if (typeof XLSX === 'undefined') throw new Error('spreadsheet library not loaded - reload the page');
    var wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
    var rows6 = null, rows1 = null;
    wb.SheetNames.forEach(function (nm) {
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, blankrows: false });
      var hdr = (rows[0] || []).map(function (x) { return String(x || '').toLowerCase(); }).join('|');
      if (/target annual contract price/.test(hdr)) rows6 = rows;
      else if (/manufacturer/.test(hdr) && /equipment type/.test(hdr)) rows1 = rows;
    });
    if (!rows6 || !rows1) throw new Error('workbook missing the expected summary + asset sheets');
    var index = hvacBuildIndex(rows6, rows1);
    var meta = { sites: Object.keys(index.price).length, units: Object.keys(index.assets).reduce(function (s, k) { return s + index.assets[k].units.length; }, 0), loadedAt: Date.now() };
    var payload = { v: 1, price: index.price, assets: index.assets, meta: meta };
    GM_setValue(HVAC_GM_KEY, JSON.stringify(payload));
    _hvacIndex = payload;
    return meta;
  }
  function hvacLoadIndex() {
    if (_hvacIndex !== undefined) return _hvacIndex;
    try { var raw = GM_getValue(HVAC_GM_KEY, ''); _hvacIndex = raw ? JSON.parse(raw) : null; } catch (e) { _hvacIndex = null; }
    return _hvacIndex;
  }
  // Shared-via-SWA layer (Phase A of team isolation). The server resolves the caller's TEAM from
  // their VERIFIED Umbrava token (never client-supplied) and stores the index under that team;
  // teammates read the same copy, other teams cannot. Degrades to LOCAL GM when the key/token is
  // absent or the tab is offline/throttled - the tool never depends on the network to function.
  // The token rides in the JSON BODY, not the Authorization header: the SWA edge REPLACES
  // Authorization with its own platform token on every proxied /api/* request (proven
  // 2026-07-21 - it is why team resolution never worked), so reads are POSTs too
  // (?action=read) - a GET cannot carry the body token.
  function hvacBenchAuth() {
    var key = GM_getValue('ingest_key', ''); var tok = authToken();
    if (!key || !tok) return null;
    return { headers: { 'Content-Type': 'application/json', 'x-bwn-key': key }, token: tok };
  }
  function hvacShareIndex(payload) {
    var a = hvacBenchAuth(); if (!a || !payload) return Promise.resolve({ shared: false, reason: 'no-auth' });
    return gmPost(HVAC_BENCH_URL, a.headers, { token: a.token, index: payload }, 30000).then(function (r) {
      if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) { _hvacScope = r.json.scope; _hvacTeamId = r.json.teamId; return { shared: true, scope: r.json.scope, teamId: r.json.teamId }; }
      return { shared: false, reason: (r.json && r.json.error) || ('HTTP ' + r.status) };
    }).catch(function (e) { return { shared: false, reason: (e && e.message) || 'network' }; });
  }
  function hvacFetchTeamIndex() {
    var a = hvacBenchAuth(); if (!a) return Promise.resolve(null);
    return gmPost(HVAC_BENCH_URL + '?action=read', a.headers, { token: a.token }, 30000).then(function (r) {
      if (r.status < 200 || r.status >= 300 || !r.json || !r.json.ok) return null;
      _hvacScope = r.json.scope; _hvacTeamId = r.json.teamId;
      var ix = r.json.index;
      if (ix && ix.price && ix.assets) {
        if (!ix.meta) ix.meta = { sites: Object.keys(ix.price).length, units: Object.keys(ix.assets).reduce(function (s, k) { return s + ((ix.assets[k] && ix.assets[k].units) ? ix.assets[k].units.length : 0); }, 0) };
        GM_setValue(HVAC_GM_KEY, JSON.stringify(ix)); _hvacIndex = ix; return ix;
      }
      return null;
    }).catch(function () { return null; });
  }
  // RFP renderings of the target price + full per-unit appendix (city/state only - no zip/address in vendor copy).
  function hvacPriceLineText(b) {
    if (!b || b.annual == null) return '';
    var est = b.estimated ? ' (estimated for this location from the area per-unit rate)' : '';
    return 'Proposed annual PM price for this site' + est + ': $' + hvacMoney(b.annual) + (b.perUnit ? ' (about $' + hvacMoney(b.perUnit) + ' per unit)' : '') +
      ' - please confirm you can meet this price, or reply with your counter.';
  }
  function hvacFullListText(b) {
    if (!b || !b.list || !b.list.length) return '';
    var L = ['Full equipment list (' + b.list.length + ' units):'];
    b.list.forEach(function (u, i) {
      var bits = [hvacTitle(u.type)];
      if (u.mfr) bits.push(hvacTitle(u.mfr));
      if (u.year) bits.push(String(u.year));
      if (u.tons) bits.push(u.tons + ' ton');
      if (u.voltage) bits.push(String(u.voltage));
      if (u.heat) bits.push(hvacTitle(u.heat));
      if (u.loc) bits.push(hvacTitle(u.loc));
      L.push('  ' + (i + 1) + '. ' + bits.join(' | '));
    });
    return L.join('\n');
  }
  // The full per-unit list rides along as a freshly-built, per-LOCATION Excel workbook (Graph
  // send). This is NOT the uploaded master workbook - it is a clean equipment schedule scoped
  // to this one site (city/state header + this site's units only, NO pricing, NO other sites,
  // NO zip/address - hard rule: city/state only). The plaintext/draft path keeps the inline
  // list (hvacFullListText) since mailto cannot attach.
  var HVAC_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var HVAC_XLSX_COLS = [
    { wch: 4 }, { wch: 26 }, { wch: 20 }, { wch: 7 }, { wch: 13 }, { wch: 16 }, { wch: 16 }, { wch: 13 }
  ];
  function hvacFullListAoa(b) {
    var aoa = [
      ['HVAC Preventive Maintenance - Equipment Schedule'],
      ['Location', (b.city || '') + ', ' + (b.st || '')],
      ['Units on this schedule', b.list.length],
      [],
      ['#', 'Equipment Type', 'Manufacturer', 'Year', 'Cooling Tons', 'Voltage / Phase', 'Factory Heat', 'Mounting']
    ];
    b.list.forEach(function (u, i) {
      aoa.push([i + 1, hvacTitle(u.type), hvacTitle(u.mfr), u.year || '', u.tons || '', u.voltage || '', hvacTitle(u.heat), hvacTitle(u.loc)]);
    });
    return aoa;
  }
  // CSV fallback (only used if the XLSX writer is unavailable / throws) so a send never loses
  // the list. Same columns, minus the metadata header rows.
  function hvacCsvCell(v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function hvacFullListCsv(b) {
    if (!b || !b.list || !b.list.length) return '';
    var lines = [['#', 'Equipment Type', 'Manufacturer', 'Year', 'Cooling Tons', 'Voltage/Phase', 'Factory Heat', 'Mounting'].join(',')];
    b.list.forEach(function (u, i) { lines.push([i + 1, hvacTitle(u.type), hvacTitle(u.mfr), u.year, u.tons, u.voltage, hvacTitle(u.heat), hvacTitle(u.loc)].map(hvacCsvCell).join(',')); });
    return lines.join('\r\n');
  }
  function hvacBaseName(b) {
    return ('HVAC PM Equipment - ' + (b.city || '') + ' ' + (b.st || '')).replace(/[^A-Za-z0-9 ._()\-]/g, '').replace(/\s+/g, ' ').trim() || 'HVAC PM Equipment';
  }
  // True when the in-page SheetJS writer is usable - drives BOTH the produced attachment format
  // and the body copy, so the "attached as ..." note always matches the file that ships.
  function hvacXlsxAvailable() { return typeof XLSX !== 'undefined' && !!(XLSX.utils && XLSX.write); }
  function hvacAttachments(b) {
    if (!b || !b.list || !b.list.length) return [];
    var base = hvacBaseName(b);
    // Preferred: a real .xlsx built in-page by SheetJS (already @require'd). base64 direct from
    // XLSX.write - binary-safe, no btoa round-trip.
    try {
      if (hvacXlsxAvailable()) {
        var ws = XLSX.utils.aoa_to_sheet(hvacFullListAoa(b));
        ws['!cols'] = HVAC_XLSX_COLS;
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Equipment');
        var xb64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        if (xb64) return [{ name: base + '.xlsx', contentType: HVAC_XLSX_MIME, contentBase64: xb64 }];
      }
    } catch (e) { /* fall through to CSV */ }
    var csv = hvacFullListCsv(b); if (!csv) return [];
    var cb64; try { cb64 = btoa(unescape(encodeURIComponent(csv))); } catch (e2) { return []; }
    return [{ name: base + '.csv', contentType: 'text/csv', contentBase64: cb64 }];
  }

  // ==== Coordinator-curated attachments =======================================
  // Files the coordinator manually picks (a clean spec sheet, a site photo THEY exported) to
  // ride along on the send. Deliberately NOT sourced from the Umbrava WO document store - those
  // are internal .msg threads carrying client name / address / our pricing. Extension+MIME are
  // constrained to match the server allowlist (send-bid ATTACH_ALLOW); city/state-only is the
  // coordinator's responsibility (a visible warning sits on the picker).
  var MANUAL_ATTACH_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' };
  var MANUAL_MAX_FILES = 5;             // server MAX_ATTACH is 6; reserve 1 for the HVAC schedule
  var MANUAL_MAX_BYTES = 10000000;      // ~10MB total curated (server total cap is 12MB)
  function attachExtOf(name) { var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function attachSafeName(name) {
    var ext = attachExtOf(name);
    var base = String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[^A-Za-z0-9 ._()\-]/g, '_').replace(/\s+/g, ' ').trim() || 'attachment';
    return base + '.' + ext;
  }
  function attachHumanSize(n) { n = +n || 0; return n >= 1000000 ? (Math.round(n / 100000) / 10 + ' MB') : (Math.max(1, Math.round(n / 1000)) + ' KB'); }
  function attachReadFile(file) {
    return new Promise(function (resolve, reject) {
      var ext = attachExtOf(file.name);
      if (!MANUAL_ATTACH_MIME[ext]) { reject(new Error(file.name + ': type not allowed (PDF/JPG/PNG/HEIC only)')); return; }
      if (file.size > MANUAL_MAX_BYTES) { reject(new Error(file.name + ': over the ' + Math.round(MANUAL_MAX_BYTES / 1000000) + 'MB limit')); return; }   // reject BEFORE reading the whole file into memory
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || ''), i = s.indexOf('base64,');
        if (i === -1) { reject(new Error('could not read ' + file.name)); return; }
        resolve({ name: attachSafeName(file.name), contentType: MANUAL_ATTACH_MIME[ext], contentBase64: s.slice(i + 7), size: file.size });
      };
      fr.onerror = function () { reject(new Error('could not read ' + file.name)); };
      fr.readAsDataURL(file);
    });
  }

  // Plain-text fallback body (Outlook draft). Mirrors the HTML: honors the include toggles
  // + additional info, city/state only (NO client name or street address - hard rule).
  function buildBidEmail(wo, recipients, req) {
    var me = actor();
    var inc = req.include || {};
    var tradeLbl = (wo.trades || []).map(function (t) { return t.name; }).join(', ') || 'Service';
    var cityState = wo.address ? ((wo.address.city || '') + (wo.address.state ? ', ' + wo.address.state : '')) : '';
    var subject = req.subject || bidSubject(wo, req);
    var L = [];
    L.push('Hello,');
    L.push('');
    L.push('Broadway National Group is requesting competitive pricing for the work below. Please reply with your best bid.');
    L.push('');
    if (inc.priority !== false && wo.priority && wo.priority.label) L.push('Priority: ' + wo.priority.label);
    if (inc.trades !== false) L.push('Trade(s): ' + tradeLbl);
    if (inc.location !== false && cityState) L.push('Location: ' + cityState);
    if (inc.respond !== false && req.respondBy) L.push('Please respond by: ' + fmtRespondBy(req.respondBy));
    if (inc.arrive !== false && req.arrive) L.push('Arrive by: ' + fmtRespondBy(req.arrive));
    if (inc.nte !== false && req.nte) L.push('NTE (not-to-exceed): $' + req.nte);
    if (inc.techs !== false && req.techs) L.push('# of Techs: ' + req.techs);
    if (inc.travel !== false && req.travelRate) L.push('Travel Rate: $' + req.travelRate + ' / hr');
    if (inc.rate !== false && req.rate) L.push('Rate: $' + req.rate + ' / hr');
    if (inc.reference !== false) L.push('Reference: Tracking #' + (wo.trackingNumber || ''));
    L.push('Scope: ' + (req.scope || wo.scopeOfWork || ''));
    if ((req.asset || '').trim()) { L.push(''); L.push('Asset / equipment: ' + req.asset.trim()); }
    if (req.benchmark && req.benchmark.annual != null) { L.push(''); L.push(hvacPriceLineText(req.benchmark)); }
    if ((req.history || '').trim()) { L.push(''); L.push('Site / service history: ' + req.history.trim()); }
    var addl = (req.addl || '').trim();
    if (addl) { L.push(''); L.push('Additional information: ' + addl); }
    if (inc.service !== false && (wo.serviceInstructions || '').trim()) { L.push(''); L.push('Service instructions: ' + wo.serviceInstructions.trim()); }
    if (req.benchmark && req.benchmark.list && req.benchmark.list.length) { L.push(''); L.push(hvacFullListText(req.benchmark)); }
    if (req.rateOffer) { L.push(''); L.push('Please include your current rate offer (labor + trip rates).'); }
    L.push('');
    L.push('Please reply to this email with your quote - labor rate, trip charge, and any material/parts costs. Thank you.');
    L.push('');
    var sigName = req.contactName || me.name || 'Broadway National Group';
    var sigEmail = req.contactEmail || me.email || '';
    L.push('- ' + sigName + (sigEmail ? ' · ' + sigEmail : ''));
    L.push('');
    L.push('--');
    L.push(COMPANY_ADDR + '. This is a request for pricing sent to service vendors. To stop receiving bid requests, reply "UNSUBSCRIBE".');
    var bcc = recipients.map(function (v) { return v.email; }).filter(Boolean);
    return { subject: subject, body: L.join('\n'), bcc: bcc, tracking: String(wo.trackingNumber || '') };
  }
  function openDraft(mail) {
    try { navigator.clipboard.writeText(mail.body).catch(function () { }); } catch (e) { }
    var url = 'mailto:?bcc=' + encodeURIComponent(mail.bcc.join(',')) +
      '&subject=' + encodeURIComponent(mail.subject) + '&body=' + encodeURIComponent(mail.body);
    var a = document.createElement('a'); a.href = url; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 0);
  }

  // ---- Branded HTML email (the Phase-B one-click send body) --------------------
  // The scratchpad bidout-email-template, embedded. Outlook-safe: tables + inline CSS +
  // bgcolor attrs, 600px card, BWN design system (green #1a5f3e, system stack, 400/500).
  // OMITS the client name and street address (city/state only) - hard rule.
  var BID_TEMPLATE =
    '<div style="display:none;max-height:0;overflow:hidden;">Broadway National - request for competitive pricing. Please reply with your best bid.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eef3f0" style="background:#eef3f0;margin:0;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;font-size:16px;font-weight:400;color:#1f2a24;"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #dde6e1;">' +
    '<tr><td align="center" bgcolor="#1a5f3e" style="background:#1a5f3e;padding:22px 24px 8px;"><img src="{{LOGO_SRC}}" alt="Broadway National" width="300" height="36" style="display:block;border:0;width:300px;height:36px;margin:0 auto;" /></td></tr>' +
    '<tr><td bgcolor="#1a5f3e" style="background:#1a5f3e;padding:2px 24px 18px;">' +
    '<div style="color:#ffffff;font-size:20px;font-weight:500;line-height:32px;text-align:center;">Request for Pricing</div>' +
    '<div style="color:#c3e2d1;font-size:14px;font-weight:400;text-align:center;margin-top:2px;">Broadway National Group</div>' +
    '<div style="color:#c3e2d1;font-size:12px;font-weight:500;text-align:right;margin-top:6px;">Reference #{{TRACKING}}</div></td></tr>' +
    '<tr><td style="padding:14px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td bgcolor="#fff4e8" style="background:#fff4e8;border:1px solid #f2dcbd;border-radius:8px;padding:11px 14px;color:#8a4b12;font-size:14px;font-weight:400;text-align:center;line-height:1.5;">' +
    'This is a request for <span style="font-weight:500;">competitive pricing</span> - it is not a work order. Please reply to this email with your best bid.</td></tr></table></td></tr>' +
    '{{DETAILS}}' +
    '<tr><td style="padding:16px 24px 0;"><div style="color:#0d3d26;font-size:12px;font-weight:500;">Scope</div>' +
    '<div style="color:#1f2a24;font-size:16px;font-weight:400;margin-top:4px;line-height:1.55;">{{SCOPE}}</div></td></tr>' +
    '{{ASSET_BLOCK}}' +
    '{{BENCHMARK_BLOCK}}' +
    '{{HISTORY_BLOCK}}' +
    '<tr><td style="padding:18px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td bgcolor="#1a5f3e" style="background:#1a5f3e;border-radius:8px;padding:13px 16px;text-align:center;color:#ffffff;font-size:14px;font-weight:500;line-height:1.5;">' +
    'Interested? Reply to this email with your quote -<br>labor rate, trip charge, and any material/parts costs.</td></tr></table></td></tr>' +
    '{{ADDL_BLOCK}}' +
    '{{SERVICE_BLOCK}}' +
    '{{FULLLIST_BLOCK}}' +
    '<tr><td style="padding:14px 24px 0;"><hr style="border:0;border-top:1px solid #dde6e1;margin:0;"></td></tr>' +
    '<tr><td style="padding:14px 24px 0;"><div style="color:#0d3d26;font-size:14px;font-weight:500;margin-bottom:6px;">Broadway National Contact</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td width="34%" style="vertical-align:top;"><div style="color:#66786e;font-size:12px;font-weight:500;">Requester</div><div style="color:#1f2a24;font-size:14px;font-weight:400;margin-top:2px;">{{REQUESTER}}</div></td>' +
    '<td width="40%" style="vertical-align:top;"><div style="color:#66786e;font-size:12px;font-weight:500;">Email</div><div style="font-size:14px;font-weight:400;margin-top:2px;"><a href="mailto:{{REQ_EMAIL}}" style="color:#1a5f3e;text-decoration:none;">{{REQ_EMAIL}}</a></div></td>' +
    '<td width="26%" style="vertical-align:top;"><div style="color:#66786e;font-size:12px;font-weight:500;">Phone</div><div style="color:#1f2a24;font-size:14px;font-weight:400;margin-top:2px;">{{REQ_PHONE}}</div></td></tr></table></td></tr>' +
    '<tr><td style="padding:18px 24px 22px;"><div style="color:#66786e;font-size:12px;font-weight:400;line-height:1.55;text-align:center;">' +
    'Broadway National Group · 100 Davids Dr, Hauppauge, NY 11788<br>' +
    'This is a request for pricing sent to service vendors. To stop receiving bid requests, reply &quot;UNSUBSCRIBE&quot;.</div></td></tr>' +
    '</table></td></tr></table>';

  // Accepts a date-only 'YYYY-MM-DD' OR a datetime-local 'YYYY-MM-DDTHH:mm'. Date-only
  // output is byte-for-byte what it always was; when a time is present it is appended.
  function fmtRespondBy(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(iso || '');
    if (!m) return 'At your earliest convenience';
    var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MONS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var hasTime = m[4] != null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], hasTime ? +m[4] : 0, hasTime ? +m[5] : 0);   // local, not UTC - a date input must not shift a day
    var base = DAYS[d.getDay()] + ', ' + MONS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    if (!hasTime) return base;
    var h12 = d.getHours() % 12; if (h12 === 0) h12 = 12;
    var mm = d.getMinutes() < 10 ? '0' + d.getMinutes() : '' + d.getMinutes();
    return base + ' at ' + h12 + ':' + mm + ' ' + (d.getHours() < 12 ? 'AM' : 'PM');
  }
  function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

  function detailCell(label, value) {
    return '<td width="50%" style="vertical-align:top;padding-right:10px;">' +
      '<div style="color:#0d3d26;font-size:12px;font-weight:500;">' + esc(label) + '</div>' +
      '<div style="color:#1f2a24;font-size:14px;font-weight:400;margin-top:3px;">' + esc(value) + '</div></td>';
  }
  function detailRows(pairs) {
    var out = '';
    for (var i = 0; i < pairs.length; i += 2) {
      out += '<tr><td style="padding:14px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
        detailCell(pairs[i].label, pairs[i].value) +
        (pairs[i + 1] ? detailCell(pairs[i + 1].label, pairs[i + 1].value) : '<td width="50%"></td>') +
        '</tr></table></td></tr>';
    }
    return out;
  }
  // Subject built from the info actually being sent (honors the include toggles).
  function bidSubject(wo, req) {
    var inc = req.include || {};
    var tl = (wo.trades || []).map(function (t) { return t.name; }).join(', ');
    var cs = wo.address ? ((wo.address.city || '') + (wo.address.state ? ', ' + wo.address.state : '')) : '';
    var bits = [];
    if (inc.trades !== false && tl) bits.push(tl);
    if (inc.location !== false && cs) bits.push(cs);
    return 'Request for Pricing' + (bits.length ? ': ' + bits.join(' - ') : '') + ' (Ref #' + (wo.trackingNumber || '') + ')';
  }

  // Fill the template. EVERY interpolated value is HTML-escaped (esc/nl2br). The detail
  // grid, subject, and sections reflect ONLY the fields the coordinator chose to include,
  // plus any free-text "Additional information".
  function buildBidHtml(wo, req, fromEmail) {
    var me = actor();
    var inc = req.include || {};
    var tradeLbl = (wo.trades || []).map(function (t) { return t.name; }).join(', ') || 'Service';
    var cityState = wo.address ? ((wo.address.city || '') + (wo.address.state ? ', ' + wo.address.state : '')) : '';
    var pairs = [];
    if (inc.priority !== false && wo.priority && wo.priority.label) pairs.push({ label: 'Priority', value: wo.priority.label });
    if (inc.respond !== false && req.respondBy) pairs.push({ label: 'Respond By', value: fmtRespondBy(req.respondBy) });
    if (inc.arrive !== false && req.arrive) pairs.push({ label: 'Arrive By', value: fmtRespondBy(req.arrive) });
    if (inc.nte !== false && req.nte) pairs.push({ label: 'NTE', value: '$' + req.nte });
    if (inc.techs !== false && req.techs) pairs.push({ label: '# of Techs', value: req.techs });
    if (inc.travel !== false && req.travelRate) pairs.push({ label: 'Travel Rate', value: '$' + req.travelRate + ' / hr' });
    if (inc.rate !== false && req.rate) pairs.push({ label: 'Rate', value: '$' + req.rate + ' / hr' });
    if (inc.trades !== false) pairs.push({ label: 'Trade(s)', value: tradeLbl });
    if (inc.location !== false && cityState) pairs.push({ label: 'Location', value: cityState });
    if (inc.reference !== false) pairs.push({ label: 'Reference', value: 'Tracking #' + (wo.trackingNumber || '') });
    var details = pairs.length ? (detailRows(pairs) + '<tr><td style="padding:16px 24px 0;"><hr style="border:0;border-top:1px solid #dde6e1;margin:0;"></td></tr>') : '';
    var addl = (req.addl || '').trim();
    var addlBlock = addl
      ? '<tr><td style="padding:16px 24px 0;"><div style="color:#0d3d26;font-size:12px;font-weight:500;">Additional Information</div>' +
        '<div style="color:#1f2a24;font-size:14px;font-weight:400;margin-top:4px;line-height:1.55;">' + nl2br(addl) + '</div></td></tr>'
      : '';
    var rateOfferBlock = req.rateOffer
      ? '<tr><td style="padding:14px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td bgcolor="#e8f3ed" style="background:#e8f3ed;border:1px solid #cfe6da;border-radius:8px;padding:11px 14px;color:#0d3d26;font-size:14px;font-weight:400;line-height:1.5;">' +
        'Please include your current rate offer (labor + trip rates).</td></tr></table></td></tr>'
      : '';
    var svc = (wo.serviceInstructions || '').trim();
    var svcBlock = (inc.service !== false && svc)
      ? '<tr><td style="padding:0 24px 4px;"><div style="color:#0d3d26;font-size:14px;font-weight:500;">Service Instructions</div>' +
        '<div style="color:#5a6b62;font-size:12px;font-weight:400;margin-top:4px;line-height:1.5;">' + nl2br(svc) + '</div></td></tr>'
      : '';
    // PM/project enrichment (coordinator-entered): asset/equipment + site service history.
    var asset = (req.asset || '').trim();
    var assetBlock = asset
      ? '<tr><td style="padding:16px 24px 0;"><div style="color:#0d3d26;font-size:12px;font-weight:500;">Asset / Equipment</div>' +
        '<div style="color:#1f2a24;font-size:14px;font-weight:400;margin-top:4px;line-height:1.55;">' + nl2br(asset) + '</div></td></tr>'
      : '';
    var hist = (req.history || '').trim();
    var historyBlock = hist
      ? '<tr><td style="padding:16px 24px 0;"><div style="color:#0d3d26;font-size:12px;font-weight:500;">Site / Service History</div>' +
        '<div style="color:#1f2a24;font-size:14px;font-weight:400;margin-top:4px;line-height:1.55;">' + nl2br(hist) + '</div></td></tr>'
      : '';
    // HVAC PM benchmark (from the dropped workbook): the target annual price callout + full per-unit list.
    var bm = req.benchmark;
    var benchmarkBlock = (bm && bm.annual != null)
      ? '<tr><td style="padding:16px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td bgcolor="#e8f3ed" style="background:#e8f3ed;border:1px solid #cfe6da;border-radius:8px;padding:12px 14px;color:#0d3d26;font-size:14px;font-weight:400;line-height:1.5;">' +
        '<span style="font-weight:600;">Proposed annual PM price for this site' + (bm.estimated ? ' (estimated for this location)' : '') + ': $' + esc(hvacMoney(bm.annual)) + '</span>' +
        (bm.perUnit ? ' <span style="color:#5a6b62;">(about $' + esc(hvacMoney(bm.perUnit)) + ' per unit)</span>' : '') +
        '<br>Please confirm you can meet this price, or reply with your counter.</td></tr></table></td></tr>'
      : '';
    // The full per-unit list rides along as a per-location Excel workbook on the Graph send
    // (built in the send handler). In the HTML body we only note it - no giant inline table.
    var fullListBlock = (bm && bm.list && bm.list.length)
      ? '<tr><td style="padding:14px 24px 0;"><div style="color:#5a6b62;font-size:12px;font-weight:400;line-height:1.5;">Equipment schedule for this location (' + bm.list.length + ' unit' + (bm.list.length === 1 ? '' : 's') + ') attached as ' + (hvacXlsxAvailable() ? 'an Excel workbook.' : 'a CSV.') + '</div></td></tr>'
      : '';
    // FUNCTION replacers throughout - a literal `$` in user text (e.g. a scope dollar amount)
    // would otherwise be mangled by String.replace's `$&`/`$1` substitution rules.
    return BID_TEMPLATE
      .replace(/\{\{LOGO_SRC\}\}/g, function () { return LOGO_SRC; })
      .replace(/\{\{TRACKING\}\}/g, function () { return esc(wo.trackingNumber || ''); })
      .replace(/\{\{DETAILS\}\}/g, function () { return details; })
      .replace(/\{\{SCOPE\}\}/g, function () { return nl2br(req.scope || wo.scopeOfWork || '') || '-'; })
      .replace(/\{\{ASSET_BLOCK\}\}/g, function () { return assetBlock; })
      .replace(/\{\{BENCHMARK_BLOCK\}\}/g, function () { return benchmarkBlock; })
      .replace(/\{\{FULLLIST_BLOCK\}\}/g, function () { return fullListBlock; })
      .replace(/\{\{HISTORY_BLOCK\}\}/g, function () { return historyBlock; })
      .replace(/\{\{ADDL_BLOCK\}\}/g, function () { return addlBlock + rateOfferBlock; })
      .replace(/\{\{SERVICE_BLOCK\}\}/g, function () { return svcBlock; })
      .replace(/\{\{REQUESTER\}\}/g, function () { return esc(req.contactName || me.name || 'Broadway National Group'); })
      .replace(/\{\{REQ_EMAIL\}\}/g, function () { return esc(fromEmail || req.contactEmail || me.email || ''); })
      .replace(/\{\{REQ_PHONE\}\}/g, function () { return esc(req.contactPhone || GM_getValue('sender_phone', '') || COMPANY_PHONE); });
  }

  // One-click send via the SWA send-bid function (Microsoft Graph, from the coordinator's
  // own mailbox). Same x-bwn-key gate as scrape-contacts, PLUS the sender's Umbrava access
  // token as `userToken` in the BODY (the SWA edge overwrites the Authorization header) -
  // since 2026-07-21 the server vouches the token with Umbrava's own current-user API and
  // refuses to send without a real, named Broadway identity (the shared key alone no longer
  // sends email). The server independently enforces the from-allowlist, BCC cap, and a
  // daily recipient ceiling.
  // idem = a STABLE per-attempt key (see the send handler). The server dedupes on it, so a
  // retry after a client timeout can NEVER double-send. Timeout is generous (180s) because
  // the per-vendor server path sends one email per vendor; a socket that closes early does
  // NOT stop the server, hence the idem guard.
  function sendBid(fromEmail, mail, html, idem, attachments) {
    var key = GM_getValue('ingest_key', '');
    if (!key) return Promise.resolve({ ok: false, code: 'NO_KEY' });
    var tok = authToken();
    if (!tok) return Promise.resolve({ ok: false, code: 'NO_TOKEN', msg: 'No usable Umbrava session token - reload the tab and retry.' });
    return gmPost(SEND_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key },
      { userToken: tok, from: fromEmail, bcc: mail.bcc, subject: mail.subject, html: html, tracking: mail.tracking || null, idem: idem || null, attachments: attachments || [] }, 180000)
      .then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) {
          // tracked/sendId/failed present only in per-vendor mode (server TRACK_BASE_URL set).
          return { ok: true, sent: r.json.sent, tracked: !!r.json.tracked, sendId: r.json.sendId || null, failed: r.json.failed || 0, duplicate: !!r.json.duplicate };
        }
        if (r.status === 409) return { ok: false, code: 'IN_PROGRESS' };   // our 409 always means in-flight, even if the body didn't parse
        return { ok: false, code: r.status, msg: (r.json && r.json.error) || ('HTTP ' + r.status) };
      })
      .catch(function (e) { return { ok: false, code: 'NET', msg: e.message }; });
  }

  // Read side of per-vendor read-receipts: ask the SWA which vendors opened our bid for
  // this WO (resolved by tracking #). Same x-bwn-key gate as send. Returns [] gracefully
  // when tracking isn't live yet (503/404) so the UI can say "no data" instead of erroring.
  function bidStatus(tracking) {
    var key = GM_getValue('ingest_key', '');
    if (!key) return Promise.resolve({ ok: false, code: 'NO_KEY' });
    if (!tracking) return Promise.resolve({ ok: true, sends: [] });
    return gmGet(STATUS_URL + '?tracking=' + encodeURIComponent(tracking), { 'x-bwn-key': key }, 30000)
      .then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) return { ok: true, sends: r.json.sends || [] };
        if (r.status === 404) return { ok: true, sends: [] };
        return { ok: false, code: r.status, msg: (r.json && r.json.error) || ('HTTP ' + r.status) };
      })
      .catch(function (e) { return { ok: false, code: 'NET', msg: e.message }; });
  }

  // ---- UI ---------------------------------------------------------------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // BWN design system: system font stack; 16/14/20-500/12-500 scale; weights 400/500 only;
  // buttons text-transform:none; brand tokens (green #1a5f3e / dk #0d3d26, text #1f2a24 /
  // muted #5a6b62, border #dde6e1, tint #e8f3ed, warn #8a4b12). See memory bwn-design-system.
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  function ensureStyle() {
    if (document.getElementById('bwn-bidout-style')) return;
    var st = document.createElement('style'); st.id = 'bwn-bidout-style';
    st.textContent =
      // Inline anchor: injected next to the "Service Requests" card heading (no floating).
      '#bwn-bidout-inline{margin-left:10px;vertical-align:middle;background:#1a5f3e;color:#fff;border:none;border-radius:16px;padding:5px 12px;font:500 12px/1.2 ' + FONT + ';text-transform:none;cursor:pointer;white-space:nowrap;}' +
      '#bwn-bidout-inline:hover{background:#0d3d26;}' +
      // The caret rides Umbrava's own "See Who Is Available" button as a split-button: the flex
      // row has gap:16px, so a -12px margin pulls the caret to ~4px off the native button; its
      // background + height are copied from the native button at mount so it always matches.
      '.bwn-bo-dd{position:relative;display:inline-block;margin-left:-12px;vertical-align:middle;align-self:center;}' +
      '.bwn-bo-caret{color:#fff;border:none;border-radius:4px;padding:0 9px;font:500 14px/1 ' + FONT + ';text-transform:none;cursor:pointer;}' +
      '.bwn-bo-ddmenu{position:absolute;top:100%;left:0;margin-top:4px;background:#fff;border:1px solid #dde6e1;border-radius:8px;box-shadow:0 8px 24px rgba(13,38,26,.14);min-width:230px;z-index:2147483000;overflow:hidden;}' +
      '.bwn-bo-dditem{display:block;width:100%;text-align:left;background:#fff;border:none;padding:10px 14px;font:400 14px ' + FONT + ';color:#1f2a24;cursor:pointer;white-space:nowrap;text-transform:none;}' +
      '.bwn-bo-dditem:hover{background:#eef3f0;}' +
      // Suite drawer geometry: the wizard rides the dock rail edge like every other
      // tool, so there is no centred overlay and no backdrop over the work order.
      '#bwn-bidout-ov{position:fixed;top:0;bottom:0;left:var(--bwn-dock-w,158px);z-index:2147483001;display:flex;font-family:' + FONT + ';}' +
      '.bwn-bo{width:560px;max-width:calc(100vw - var(--bwn-dock-w,158px) - 8px);display:flex;flex-direction:column;overflow:auto;background:#fff;border-radius:0 14px 14px 0;box-shadow:10px 0 34px rgba(13,38,26,.22);color:#1f2a24;font-size:16px;}' +
      '.bwn-bo-hd{background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;padding:15px 16px 14px 18px;font:600 16px/24px ' + FONT + ';display:flex;align-items:center;gap:10px;border-radius:0 14px 0 0;position:sticky;top:0;z-index:1;}' +
      '.bwn-bo-hd .x{margin-left:auto;background:transparent;border:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;}' +
      '.bwn-bo-bd{padding:14px 18px;}' +
      '.bwn-bo-wo{font:500 14px ' + FONT + ';color:#0d3d26;margin-bottom:8px;}' +
      '.bwn-bo-sub{font:400 12px ' + FONT + ';color:#5a6b62;margin-bottom:10px;}' +
      '.bwn-bo-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0;}' +
      '.bwn-bo-row label{font:500 12px ' + FONT + ';color:#5a6b62;}' +
      '.bwn-bo-row input,.bwn-bo textarea{border:1px solid #dde6e1;border-radius:8px;padding:7px 9px;font:400 14px ' + FONT + ';color:#1f2a24;box-sizing:border-box;}' +
      '.bwn-bo textarea{width:100%;resize:vertical;}' +
      '.bwn-bo-list{border:1px solid #dde6e1;border-radius:10px;max-height:260px;overflow:auto;margin:6px 0;}' +
      '.bwn-bo-v{display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #eef2f4;font:400 14px ' + FONT + ';}' +
      '.bwn-bo-v:last-child{border-bottom:none;}' +
      '.bwn-bo-v .nm{font-weight:500;flex:1;}' +
      '.bwn-bo-v .mi{color:#5a6b62;font-size:12px;white-space:nowrap;}' +
      '.bwn-bo-v .em{color:#1a5f3e;font-size:12px;}' +
      '.bwn-bo-v .noem{color:#8a4b12;font-size:12px;text-decoration:none;}' +
      '.bwn-bo-v a.noem:hover{text-decoration:underline;}' +
      '.bwn-bo-mini{border:none;background:#e8f3ed;color:#1a5f3e;border-radius:8px;padding:7px 12px;font:500 14px ' + FONT + ';text-transform:none;cursor:pointer;}' +
      '.bwn-bo-ft{display:flex;gap:10px;align-items:center;padding:12px 18px;border-top:1px solid #dde6e1;background:#f7faf8;}' +
      '.bwn-bo-ft .sp{margin-right:auto;font:400 12px ' + FONT + ';color:#5a6b62;}' +
      '.bwn-bo-ft button{border:1px solid #dde6e1;background:#fff;border-radius:8px;padding:8px 14px;font:500 14px ' + FONT + ';text-transform:none;cursor:pointer;}' +
      '.bwn-bo-ft button.pri{background:#1a5f3e;border-color:#1a5f3e;color:#fff;}' +
      '.bwn-bo-note{font:400 12px ' + FONT + ';color:#5a6b62;margin-top:6px;line-height:1.4;}' +
      '.bwn-bo-inc{display:flex;gap:6px 16px;flex-wrap:wrap;margin:2px 0 6px;}' +
      '.bwn-bo-chk{display:inline-flex;align-items:center;gap:6px;font:400 14px ' + FONT + ';color:#1f2a24;cursor:pointer;}' +
      '.bwn-bo-chk input{margin:0;}' +
      '.bwn-bo-pv{border:1px solid #dde6e1;border-radius:10px;overflow:hidden;margin:8px 0;background:#eef3f0;}' +
      '.bwn-bo-pv iframe{display:block;width:100%;height:430px;border:none;background:#eef3f0;}' +
      '.bwn-bo-bcc{max-height:76px;overflow:auto;border:1px solid #dde6e1;border-radius:8px;padding:6px 9px;font:400 12px ' + FONT + ';color:#1f2a24;background:#f7faf8;line-height:1.7;margin:4px 0 8px;}' +
      '.bwn-bo-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0;font:500 12px ' + FONT + ';color:#5a6b62;}' +
      '.bwn-bo-meta input{border:1px solid #dde6e1;border-radius:8px;padding:7px 9px;font:400 14px ' + FONT + ';color:#1f2a24;min-width:260px;}' +
      '.bwn-bo-meta .sj{font:400 14px ' + FONT + ';color:#1f2a24;}' +
      '.bwn-bo-steps{display:flex;align-items:center;gap:6px;margin:0 0 16px;flex-wrap:wrap;}' +
      '.bwn-bo-step{display:flex;align-items:center;gap:7px;}' +
      '.bwn-bo-step .dot{width:24px;height:24px;border-radius:50%;background:#e8f3ed;border:1px solid #dde6e1;color:#5a6b62;display:inline-flex;align-items:center;justify-content:center;font:500 12px ' + FONT + ';}' +
      '.bwn-bo-step .lbl{font:500 13px ' + FONT + ';color:#5a6b62;}' +
      '.bwn-bo-step.on .dot,.bwn-bo-step.done .dot{background:#1a5f3e;border-color:#1a5f3e;color:#fff;}' +
      '.bwn-bo-step.on .lbl{color:#0d3d26;}' +
      '.bwn-bo-bar{flex:1;min-width:16px;height:2px;background:#dde6e1;}' +
      '.bwn-bo-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;margin:6px 0;}' +
      '.bwn-bo-fld{display:flex;flex-direction:column;gap:4px;min-width:0;}' +
      '.bwn-bo-fld label{font:500 12px ' + FONT + ';color:#5a6b62;}' +
      '.bwn-bo-fld input{border:1px solid #dde6e1;border-radius:8px;padding:7px 9px;font:400 14px ' + FONT + ';color:#1f2a24;box-sizing:border-box;width:100%;}' +
      '.bwn-bo-ro{font:400 14px ' + FONT + ';color:#1f2a24;padding:7px 0;}' +
      '.bwn-bo-chips{display:flex;gap:6px;flex-wrap:wrap;}' +
      '.bwn-bo-chip{display:inline-block;background:#e8f3ed;color:#0d3d26;border:1px solid #cfe6da;border-radius:999px;padding:4px 11px;font:600 12px ' + FONT + ';}' +
      '.bwn-bo-sum{border:1px solid #dde6e1;border-radius:10px;background:#f7faf8;padding:12px 14px;margin:2px 0 12px;}' +
      '.bwn-bo-sumhd{font:500 14px ' + FONT + ';color:#0d3d26;margin-bottom:8px;}' +
      '.bwn-bo-sumfld{display:flex;gap:12px;padding:6px 0;border-top:1px solid #eef2f4;}' +
      '.bwn-bo-sumfld:first-of-type{border-top:none;}' +
      '.bwn-bo-sumfld .k{flex:0 0 128px;font:500 12px ' + FONT + ';color:#5a6b62;}' +
      '.bwn-bo-sumfld .v{flex:1;font:400 14px ' + FONT + ';color:#1f2a24;white-space:pre-wrap;min-width:0;}' +
      '.bwn-bo-sumnote{font:500 12px ' + FONT + ';color:#1a5f3e;margin:8px 0 2px;}';
    document.head.appendChild(st);
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:120px;right:18px;z-index:2147483002;background:#0d3d26;color:#fff;padding:10px 16px;border-radius:8px;font:500 14px ' + FONT + ';box-shadow:0 6px 24px rgba(13,38,26,.3);max-width:380px;';
    t.textContent = 'Bid-Out: ' + msg; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 5500);
  }

  var openState = null;

  // Bid-Out registers a dock entry on WO detail pages (see the Dock presence block
  // below) and shares the one drawer slot: fold away when another tool claims it.
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:drawer:open' && d.key !== 'bidout') {
        var o = document.getElementById('bwn-bidout-ov'); if (o) o.remove();
      }
    });
  } catch (e) { }

  function openPanel() {
    var n = woNumber();
    if (!n) { toast('Open a work order first.'); return; }
    ensureStyle();
    var old = document.getElementById('bwn-bidout-ov'); if (old) old.remove();
    // Claim the shared drawer slot so a tool already open folds away.
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: 'bidout' } })); } catch (e) { }
    var ov = document.createElement('div'); ov.id = 'bwn-bidout-ov';
    var box = document.createElement('div'); box.className = 'bwn-bo';
    box.innerHTML =
      '<div class="bwn-bo-hd">📤 Bid-Out - competitive pricing request<button class="x" title="Close">×</button></div>' +
      '<div class="bwn-bo-bd"><div id="bwn-bo-body">Loading work order + area vendors…</div></div>';
    ov.appendChild(box); document.body.appendChild(ov);
    function close() { ov.remove(); openState = null; }
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    box.querySelector('.x').addEventListener('click', close);

    loadWO(n).then(function (wo) {
      if (!wo) throw new Error('Work order ' + n + ' not found.');
      return loadVendors(wo, 60).then(function (res) {
        var seed = openState.seedLeads;
        if (seed && seed.length) {
          // Seeded from the Service Request modal (net-new the coordinator picked inline): scrape
          // emails for those leads, seed them into the wizard (pre-picked), open on Select Vendors.
          var b0 = box.querySelector('#bwn-bo-body'); if (b0) b0.textContent = 'Finding emails for the selected net-new vendors…';
          var urls = seed.map(function (l) { return l.website; }).filter(Boolean);
          return scrapeEmails(urls).then(function (sr) {
            var seeded = seed.map(function (l) { return { name: l.name, phone: l.phone || '', website: l.website || '', rating: l.rating, ratingCount: l.ratingCount, mi: l.mi, email: (l.website && sr.map[l.website]) || l.email || '' }; });
            // Same ZoomInfo fallback as the wizard's own Find - seeded leads must not behave worse.
            return ziFallback(seeded).then(function (zr) {
              openState.netNew = seeded;
              if (zr.note) openState.netNewMsg = zr.note;
              openState.seedLeads = null;
              openState.step = 2;   // land on Select Vendors with the seeded net-new pre-picked
              renderPanel(box, wo, res, close);
            });
          });
        }
        renderPanel(box, wo, res, close);
      });
    }).catch(function (e) {
      var b = box.querySelector('#bwn-bo-body');
      if (b) b.innerHTML = '<div style="color:#b91c1c;font:600 13px system-ui;">Couldn’t load: ' + esc(e.message) + '</div>';
    });
  }

  // ---- 3-step wizard modeled on Umbrava's "Build Requests" flow ----------------
  // Step 1 Work Order Details -> Step 2 Select Vendors -> Step 3 Review. Every field
  // lives in openState so values persist across Back/Next (re-render reads openState).
  // HARD RULES: never auto-send (Send is the only trigger, on step 3); vendors BCC-only;
  // city/state only (no client name / street address); CAN-SPAM footer; MAX_BCC cap.
  function renderPanel(box, wo, res, close) {
    var body = box.querySelector('#bwn-bo-body');
    var me = actor();
    var tradeLbl = (wo.trades || []).map(function (t) { return t.name; }).join(', ') || 'Service';
    var priorityLbl = (wo.priority && wo.priority.label) || '';
    var hasService = !!((wo.serviceInstructions || '').trim());

    if (openState.step == null) openState.step = 1;
    if (openState.miles == null) openState.miles = DEFAULT_MILES;
    if (openState.scope == null) openState.scope = wo.scopeOfWork || '';
    if (openState.respond == null) openState.respond = '';
    if (openState.arrive == null) openState.arrive = '';
    if (openState.nte == null) openState.nte = '';
    if (openState.techs == null) openState.techs = '';
    if (openState.travelRate == null) openState.travelRate = '';
    if (openState.rate == null) openState.rate = '';
    if (openState.rateOffer == null) openState.rateOffer = false;
    if (openState.inviteText == null) openState.inviteText = '';
    if (openState.netNew == null) openState.netNew = [];
    if (openState.netNewMsg == null) openState.netNewMsg = '';
    if (openState.include == null) openState.include = { priority: true, trades: true, location: true, service: hasService, reference: true, respond: true, arrive: true, nte: true, techs: true, travel: true, rate: true };
    if (openState.addl == null) openState.addl = '';
    if (openState.attachments == null) openState.attachments = [];   // coordinator-curated files [{name,contentType,contentBase64,size}]
    if (openState.asset == null) openState.asset = '';       // PM/project: asset + equipment (make/model/spec, e.g. R34 vs R41)
    if (openState.history == null) openState.history = '';   // PM/project: site / prior-service context
    if (openState.picked == null) openState.picked = {};   // email(lc) -> bool; absent = default checked
    if (openState.contactName == null) openState.contactName = me.name || '';
    if (openState.contactEmail == null) openState.contactEmail = GM_getValue('send_from', '') || me.email || '';
    if (openState.contactPhone == null) openState.contactPhone = GM_getValue('sender_phone', '') || '';

    function val(id) { var e = document.getElementById(id); return e ? e.value : undefined; }
    function chk(id) { var e = document.getElementById(id); return e ? e.checked : undefined; }
    function isPicked(email) { if (!email) return false; var k = email.toLowerCase(); return (k in openState.picked) ? openState.picked[k] : true; }

    // Read whatever step-scoped fields are on screen; only present ids are captured.
    function capture() {
      var v;
      if ((v = val('bo-scope')) !== undefined) openState.scope = v;
      if ((v = val('bo-respond')) !== undefined) openState.respond = v;
      if ((v = val('bo-arrive')) !== undefined) openState.arrive = v;
      if ((v = val('bo-nte')) !== undefined) openState.nte = v;
      if ((v = val('bo-techs')) !== undefined) openState.techs = v;
      if ((v = val('bo-travel')) !== undefined) openState.travelRate = v;
      if ((v = val('bo-rate')) !== undefined) openState.rate = v;
      if ((v = val('bo-addl')) !== undefined) openState.addl = v;
      if ((v = val('bo-asset')) !== undefined) openState.asset = v;
      if ((v = val('bo-history')) !== undefined) openState.history = v;
      if ((v = val('bo-invite')) !== undefined) openState.inviteText = v;
      if ((v = val('bo-cname')) !== undefined) openState.contactName = v;
      if ((v = val('bo-cemail')) !== undefined) openState.contactEmail = v;
      if ((v = val('bo-cphone')) !== undefined) openState.contactPhone = v;
      if ((v = chk('bo-rateoffer')) !== undefined) openState.rateOffer = v;
      if ((v = chk('bo-inc-service')) !== undefined) openState.include.service = v;
      body.querySelectorAll('input[data-inc]').forEach(function (cb) { openState.include[cb.getAttribute('data-inc')] = cb.checked; });
    }

    // Dedup recipient list from picked vendors + net-new + pasted emails (openState-driven).
    function collectRecipients() {
      var recips = [], seen = {};
      function add(email) { if (!email) return; var k = email.toLowerCase(); if (!seen[k]) { seen[k] = 1; recips.push({ email: email }); } }
      (openState.rowVendors || []).forEach(function (v) { if (v.email && isPicked(v.email)) add(v.email); });
      // HARD RULE: a do-not-contact prospect is NEVER a recipient (isPicked defaults true, and the
      // DNC checkbox renders disabled so its change handler can never write picked=false).
      (openState.netNew || []).forEach(function (l) { if (l.email && !l.dnc && isPicked(l.email)) add(l.email); });
      parseEmails(openState.inviteText || '').forEach(add);
      return recips;
    }

    function vendorRows() {
      var items = (res.items || []).filter(function (v) { return v.distanceFromLocation == null || v.distanceFromLocation <= openState.miles; });
      openState.rowVendors = items.map(function (v) {
        return { id: v.id, name: v.name, mi: v.distanceFromLocation, rating: v.averageRating, ratingCount: v.ratingCount, email: (v.mainContactInfo && v.mainContactInfo.emailAddress) || '' };
      });
      return openState.rowVendors.map(function (v, i) {
        var hasEmail = !!v.email;
        return '<div class="bwn-bo-v">' +
          '<input type="checkbox" data-i="' + i + '"' + (hasEmail ? (isPicked(v.email) ? ' checked' : '') : ' disabled') + '>' +
          '<span class="nm">' + esc(v.name) + '</span>' +
          (v.rating ? '<span class="mi">★ ' + v.rating.toFixed(1) + ' (' + (v.ratingCount || 0) + ')</span>' : '') +
          '<span class="mi">' + (v.mi != null ? v.mi.toFixed(1) + ' mi' : '-') + '</span>' +
          (hasEmail ? '<span class="em">' + esc(v.email) + '</span>' : '<span class="noem">no email - phone only</span>') +
          '</div>';
      }).join('');
    }

    function incChk(key, label) {
      return '<label class="bwn-bo-chk"><input type="checkbox" data-inc="' + key + '"' + (openState.include[key] !== false ? ' checked' : '') + '> ' + esc(label) + '</label>';
    }
    function tradeChipsHtml() {
      return (wo.trades || []).length
        ? (wo.trades || []).map(function (t) { return '<span class="bwn-bo-chip">' + esc(t.name) + '</span>'; }).join('')
        : '<span class="bwn-bo-chip">Service</span>';
    }
    function stepperHtml() {
      var labels = ['Work Order Details', 'Select Vendors', 'Review'];
      var h = '<div class="bwn-bo-steps">';
      for (var i = 0; i < labels.length; i++) {
        var num = i + 1;
        var cls = num === openState.step ? ' on' : (num < openState.step ? ' done' : '');
        h += '<div class="bwn-bo-step' + cls + '"><span class="dot">' + (num < openState.step ? '✓' : num) + '</span><span class="lbl">' + esc(labels[i]) + '</span></div>';
        if (i < labels.length - 1) h += '<span class="bwn-bo-bar"></span>';
      }
      return h + '</div>';
    }
    function woLineHtml() {
      return '<div class="bwn-bo-wo">Tracking #' + esc(wo.trackingNumber) + ' · ' + esc(tradeLbl) + ' · ' + esc(wo.locationName || '') + '</div>' +
        '<div class="bwn-bo-sub">' + esc((wo.address ? (wo.address.city + ', ' + wo.address.state) : '')) + ' · ' + esc(res.rowCount) + ' assignable vendors for this trade</div>';
    }
    function clearFooter() { var ex = box.querySelector('.bwn-bo-ft'); if (ex) ex.remove(); }
    function footer(html) { var ft = document.createElement('div'); ft.className = 'bwn-bo-ft'; ft.innerHTML = html; body.parentNode.appendChild(ft); return ft; }

    function draw() {
      clearFooter();
      if (openState.step === 2) return drawVendors();
      if (openState.step === 3) return drawReview();
      return drawDetails();
    }

    // ---- Step 1: Work Order Details (all optional except Scope) -----------------
    function drawDetails() {
      // HVAC PM benchmark bar: drop/load the workbook, and (on a city/state match) apply the
      // site's assets + target price to this bid.
      function hvacBarHtml() {
        var idx = hvacLoadIndex();
        var m = idx ? hvacMatch(idx, wo) : null;
        var applied = !!openState.benchmark;
        var srcNote = (_hvacScope === 'team') ? ' · shared with your team' : ((_hvacScope === 'private') ? ' · local to you' : '');
        var s = '<div id="bo-hvac-bar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;margin:2px 0 8px;background:#f3f7f5;border:1px dashed #cfd9d3;border-radius:8px;font-size:12px;">';
        if (!idx) {
          s += '<span style="color:#5a6b62;font-weight:500;">HVAC PM benchmark - no workbook loaded.</span>' +
            '<button type="button" id="bo-hvac-load" class="bwn-bo-mini">Load workbook</button>' +
            '<span style="color:#93a29a;">or drop an .xlsx here</span>';
        } else if (m) {
          var cs = esc(m.city + ', ' + m.st);
          var priceTxt = (m.annual != null) ? ('$' + hvacMoney(m.annual) + '/yr' + (m.estimated ? ' est.' : '') + (m.perUnit ? (' (~$' + hvacMoney(m.perUnit) + '/unit)') : '')) : 'no price on file';
          var note = m.multiZip ? (' · multi-store city' + (m.zipUsed ? (' - zip ' + esc(m.zipUsed)) : '')) : '';
          s += '<span style="color:#0d3d26;font-weight:600;">HVAC PM benchmark - ' + cs + '</span>' +
            '<span style="color:#5a6b62;">' + m.siteUnits + ' unit(s) · ' + priceTxt + note + srcNote + '</span>' +
            (applied
              ? '<span style="color:#166534;font-weight:600;">Applied &#10003;</span><button type="button" id="bo-hvac-remove" class="bwn-bo-mini">Remove</button>'
              : '<button type="button" id="bo-hvac-apply" class="bwn-bo-mini">Apply to this bid</button>') +
            '<a href="#" id="bo-hvac-load" style="color:#5a6b62;">replace</a>';
        } else {
          s += '<span style="color:#92400e;font-weight:500;">HVAC PM benchmark loaded (' + (((idx.meta && idx.meta.sites) != null) ? idx.meta.sites : Object.keys(idx.price || {}).length) + ' sites) - no entry for ' + esc(((wo.address && wo.address.city) || '?') + ', ' + ((wo.address && wo.address.state) || '')) + '.</span>' +
            '<a href="#" id="bo-hvac-load" style="color:#5a6b62;">replace</a>';
        }
        s += '<input type="file" id="bo-hvac-file" accept=".xlsx" style="display:none;"></div>';
        return s;
      }
      function hvacWire() {
        var bar = body.querySelector('#bo-hvac-bar'); if (!bar) return;
        var fileInput = body.querySelector('#bo-hvac-file');
        // Remove a previously auto-inserted summary line from the Asset field (so re-Apply,
        // Remove, or a workbook replace never stacks or strands it). Run after capture().
        function hvacStripSummary() {
          var s = openState._hvacSummary;
          if (s && openState.asset && openState.asset.indexOf(s) === 0) openState.asset = openState.asset.slice(s.length).replace(/^\n/, '');
          openState._hvacSummary = null;
        }
        function handleFile(file) {
          if (!file) return;
          file.arrayBuffer().then(function (buf) {
            var meta;
            try { meta = hvacParseAndStore(buf); } catch (e) { toast('Could not read workbook: ' + (e && e.message || e)); return; }
            toast('HVAC PM benchmark loaded: ' + meta.sites + ' sites, ' + meta.units + ' assets.');
            capture(); hvacStripSummary(); openState.benchmark = null; draw();   // a replaced workbook forces a fresh Apply
            // Share to the team (best-effort). Server derives the team from the verified token.
            hvacShareIndex(hvacLoadIndex()).then(function (res) {
              if (res.shared && res.scope === 'team') toast('Shared with your team' + (res.teamId ? ' (' + res.teamId + ')' : '') + '.');
              else if (res.shared) toast('Saved to your account (not on a team roster yet).');
              draw();   // reflect the resolved scope in the bar
            });
          }).catch(function (e) { toast('Could not read file: ' + (e && e.message || e)); });
        }
        var loadLink = body.querySelector('#bo-hvac-load'); if (loadLink) loadLink.addEventListener('click', function (e) { e.preventDefault(); fileInput.click(); });
        if (fileInput) fileInput.addEventListener('change', function () { handleFile(fileInput.files && fileInput.files[0]); });
        bar.addEventListener('dragover', function (e) { e.preventDefault(); bar.style.background = '#e8f3ed'; });
        bar.addEventListener('dragleave', function () { bar.style.background = '#f3f7f5'; });
        bar.addEventListener('drop', function (e) { e.preventDefault(); bar.style.background = '#f3f7f5'; handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
        var applyBtn = body.querySelector('#bo-hvac-apply');
        if (applyBtn) applyBtn.addEventListener('click', function () {
          var idx = hvacLoadIndex(); var m = idx ? hvacMatch(idx, wo) : null; if (!m) { toast('No benchmark entry for this site.'); return; }
          capture();
          hvacStripSummary();   // drop any prior auto-summary so re-Apply/replace can't stack it
          var summary = hvacSummaryLine(m);
          openState.asset = (openState.asset && openState.asset.trim()) ? (summary + '\n' + openState.asset.trim()) : summary;
          openState._hvacSummary = summary;
          openState.benchmark = { annual: m.annual, perUnit: m.perUnit, estimated: m.estimated, cityUnits: m.cityUnits, siteUnits: m.siteUnits, multiZip: m.multiZip, zipUsed: m.zipUsed, city: m.city, st: m.st, counts: m.counts, list: m.list };
          toast('Applied HVAC PM benchmark to this bid.'); draw();
        });
        var rmBtn = body.querySelector('#bo-hvac-remove');
        if (rmBtn) rmBtn.addEventListener('click', function () { capture(); hvacStripSummary(); openState.benchmark = null; toast('Removed benchmark from this bid.'); draw(); });
        // Once per page load, pull the team-shared index (it wins over a stale local copy).
        if (!_hvacTeamTried) { _hvacTeamTried = true; hvacFetchTeamIndex().then(function (ix) { if (ix) draw(); }); }
      }
      // Coordinator-curated attachments: a per-file picker with a city/state-only warning.
      function attachListHtml() {
        var list = openState.attachments || [];
        if (!list.length) return '';
        return '<div style="margin:4px 0 2px;">' + list.map(function (a, i) {
          return '<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#1f2a24;padding:2px 0;">' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(a.name) + '</span>' +
            '<span style="color:#93a29a;">' + esc(attachHumanSize(a.size)) + '</span>' +
            '<a href="#" class="bo-attach-rm" data-ai="' + i + '" style="color:#b91c1c;">remove</a></div>';
        }).join('') + '</div>';
      }
      function attachBarHtml() {
        var n = (openState.attachments || []).length;
        var s = '<div class="bwn-bo-row" style="margin-bottom:2px;"><label>Attachments for vendors (optional)</label></div>' +
          '<div style="color:#92400e;font-size:11px;font-weight:500;line-height:1.4;margin:0 0 4px;">Goes to every vendor - city/state only. Do NOT attach anything that names the client or the site address.</div>' +
          '<div id="bo-attach-bar" style="padding:8px 10px;background:#f3f7f5;border:1px dashed #cfd9d3;border-radius:8px;font-size:12px;">' +
          attachListHtml() +
          '<button type="button" id="bo-attach-add" class="bwn-bo-mini">Attach files</button> ' +
          '<span style="color:#93a29a;">PDF / JPG / PNG / HEIC - up to ' + MANUAL_MAX_FILES + ', or drop here</span>' +
          '<input type="file" id="bo-attach-file" accept=".pdf,.jpg,.jpeg,.png,.heic" multiple style="display:none;"></div>';
        return s;
      }
      function attachWire() {
        var bar = body.querySelector('#bo-attach-bar'); if (!bar) return;
        var fileInput = body.querySelector('#bo-attach-file');
        function addFiles(fileList) {
          var files = Array.prototype.slice.call(fileList || []); if (!files.length) return;
          var slots = MANUAL_MAX_FILES - (openState.attachments || []).length;
          if (slots <= 0) { toast('Up to ' + MANUAL_MAX_FILES + ' files.'); return; }
          if (files.length > slots) { toast('Only ' + slots + ' more file(s) can be added.'); files = files.slice(0, slots); }
          capture();   // preserve typed text across the re-render
          var chain = Promise.resolve();
          files.forEach(function (f) {
            chain = chain.then(function () {
              return attachReadFile(f).then(function (rec) {
                var total = (openState.attachments || []).reduce(function (s, a) { return s + (a.size || 0); }, 0) + rec.size;
                if (total > MANUAL_MAX_BYTES) { toast(f.name + ': over the ' + Math.round(MANUAL_MAX_BYTES / 1000000) + 'MB total limit - skipped.'); return; }
                openState.attachments.push(rec);
              }).catch(function (e) { toast((e && e.message) || 'could not add file'); });
            });
          });
          chain.then(function () { draw(); });
        }
        var addBtn = body.querySelector('#bo-attach-add'); if (addBtn) addBtn.addEventListener('click', function () { fileInput.click(); });
        if (fileInput) fileInput.addEventListener('change', function () { addFiles(fileInput.files); });
        bar.addEventListener('dragover', function (e) { e.preventDefault(); bar.style.background = '#e8f3ed'; });
        bar.addEventListener('dragleave', function () { bar.style.background = '#f3f7f5'; });
        bar.addEventListener('drop', function (e) { e.preventDefault(); bar.style.background = '#f3f7f5'; addFiles(e.dataTransfer && e.dataTransfer.files); });
        body.querySelectorAll('.bo-attach-rm').forEach(function (a) {
          a.addEventListener('click', function (e) { e.preventDefault(); capture(); openState.attachments.splice(+a.getAttribute('data-ai'), 1); draw(); });
        });
      }
      var svcChk = hasService
        ? '<label class="bwn-bo-chk" style="margin-left:auto;"><input type="checkbox" id="bo-inc-service"' + (openState.include.service !== false ? ' checked' : '') + '> Include Service Instructions</label>'
        : '';
      body.innerHTML =
        stepperHtml() +
        woLineHtml() +
        '<div class="bwn-bo-grid2">' +
          '<div class="bwn-bo-fld"><label>Trade(s)</label><div class="bwn-bo-chips">' + tradeChipsHtml() + '</div></div>' +
          '<div class="bwn-bo-fld"><label>Priority</label><div class="bwn-bo-ro">' + esc(priorityLbl || 'Not set') + '</div></div>' +
        '</div>' +
        '<div class="bwn-bo-row" style="margin-bottom:0;"><label>Scope</label>' + svcChk + '</div>' +
        '<textarea id="bo-scope" rows="3" placeholder="Describe the work to be priced">' + esc(openState.scope) + '</textarea>' +
        '<div class="bwn-bo-grid2">' +
          '<div class="bwn-bo-fld"><label>Respond By</label><input id="bo-respond" type="datetime-local" value="' + esc(openState.respond) + '"></div>' +
          '<div class="bwn-bo-fld"><label>Arrive By</label><input id="bo-arrive" type="datetime-local" value="' + esc(openState.arrive) + '"></div>' +
        '</div>' +
        '<div class="bwn-bo-grid2">' +
          '<div class="bwn-bo-fld"><label>NTE $</label><input id="bo-nte" type="number" min="0" step="1" value="' + esc(openState.nte) + '"></div>' +
          '<div class="bwn-bo-fld"><label># of Techs</label><input id="bo-techs" type="number" min="0" step="1" value="' + esc(openState.techs) + '"></div>' +
          '<div class="bwn-bo-fld"><label>Travel Rate $ /hr</label><input id="bo-travel" type="number" min="0" step="1" value="' + esc(openState.travelRate) + '"></div>' +
          '<div class="bwn-bo-fld"><label>Rate $ /hr</label><input id="bo-rate" type="number" min="0" step="1" value="' + esc(openState.rate) + '"></div>' +
        '</div>' +
        '<label class="bwn-bo-chk" style="margin:2px 0 8px;"><input type="checkbox" id="bo-rateoffer"' + (openState.rateOffer ? ' checked' : '') + '> Receive Rate Offer</label>' +
        // Section order (per request): Site/service history, then Asset (with the benchmark drop
        // zone directly under the Asset field), then Additional information.
        '<div class="bwn-bo-row"><label>Site / service history (optional)</label></div>' +
        '<textarea id="bo-history" rows="2" placeholder="Prior work or recurring issues at this site: last PM date, open deficiencies, warranty status, what a previous vendor found.">' + esc(openState.history) + '</textarea>' +
        '<div class="bwn-bo-row"><label>Asset / equipment (optional)</label></div>' +
        '<textarea id="bo-asset" rows="2" placeholder="Make, model, and spec vendors need to bid accurately - e.g. Bohn condenser, refrigerant R448A (not R22), 3-ton RTU, panel amperage.">' + esc(openState.asset) + '</textarea>' +
        hvacBarHtml() +
        '<div class="bwn-bo-row"><label>Additional information (optional)</label></div>' +
        '<textarea id="bo-addl" rows="2" placeholder="Anything pertinent to include: access hours, # of units, parking, on-site contact, equipment make/model, etc.">' + esc(openState.addl) + '</textarea>' +
        attachBarHtml() +
        '<div class="bwn-bo-row"><label>Include in request</label></div>' +
        // Core WO fields always offered; the entered bid fields appear as toggles once they have
        // a value. Location is city/state only - there is deliberately NO client-name/address toggle.
        '<div class="bwn-bo-inc">' +
          incChk('priority', 'Priority') + incChk('trades', 'Trade(s)') + incChk('location', 'Location (city/state)') + incChk('reference', 'Reference #') +
          (openState.respond ? incChk('respond', 'Respond by') : '') +
          (openState.arrive ? incChk('arrive', 'Arrive by') : '') +
          (openState.nte ? incChk('nte', 'NTE') : '') +
          (openState.techs ? incChk('techs', '# of Techs') : '') +
          (openState.travelRate ? incChk('travel', 'Travel rate') : '') +
          (openState.rate ? incChk('rate', 'Rate') : '') +
        '</div>' +
        '<div class="bwn-bo-row"><label>Your contact details (shown in the request)</label></div>' +
        '<div class="bwn-bo-grid2">' +
          '<div class="bwn-bo-fld"><label>Name</label><input id="bo-cname" type="text" value="' + esc(openState.contactName) + '"></div>' +
          '<div class="bwn-bo-fld"><label>Email</label><input id="bo-cemail" type="email" value="' + esc(openState.contactEmail) + '"></div>' +
          '<div class="bwn-bo-fld"><label>Phone</label><input id="bo-cphone" type="text" value="' + esc(openState.contactPhone) + '" placeholder="' + esc(COMPANY_PHONE) + '"></div>' +
        '</div>';
      hvacWire();
      attachWire();
      var ft = footer('<span class="sp"></span><button id="bo-cancel">Cancel</button><button class="pri" id="bo-next">Next →</button>');
      ft.querySelector('#bo-cancel').addEventListener('click', close);
      ft.querySelector('#bo-next').addEventListener('click', function () {
        capture();
        if (!(openState.scope || '').trim()) { toast('Add a Scope before continuing.'); return; }
        openState.step = 2; draw();
      });
    }

    // ---- Step 2: Select Vendors (the existing picker, unchanged behavior) --------
    function drawVendors() {
      body.innerHTML =
        stepperHtml() +
        woLineHtml() +
        '<div class="bwn-bo-row"><label>Distance</label>' +
        '<label>Within</label><input id="bo-miles" type="number" min="1" step="5" value="' + openState.miles + '" style="width:70px;"> mi ' +
        '<button id="bo-reload" class="bwn-bo-mini">Apply</button></div>' +
        '<div class="bwn-bo-row"><label>Our vendors near this WO</label>' +
        '<button id="bo-all" style="border:none;background:transparent;color:#1b4d3e;font:600 12px system-ui;cursor:pointer;">Select all with email</button></div>' +
        '<div class="bwn-bo-list">' + vendorRows() + '</div>' +
        '<div class="bwn-bo-row"><label>Net-new vendors near here (pipeline first, then Google Places)</label>' +
        '<button id="bo-find" class="bwn-bo-mini">' + (openState.pipelineChecked ? '🔎 Search Google for more' : '🔎 Find area vendors') + '</button></div>' +
        '<div id="bo-netnew"></div>' +
        '<div class="bwn-bo-row"><label>Invite others - paste emails</label></div>' +
        '<textarea id="bo-invite" rows="2" placeholder="Add any outside vendor emails - one per line or comma-separated: name &lt;email@co.com&gt; or just email@co.com">' + esc(openState.inviteText) + '</textarea>' +
        '<div class="bwn-bo-note" id="bo-invite-note"></div>' +
        '<div class="bwn-bo-note">Everyone is BCC’d (they can’t see each other). Next: review the branded email + exact recipients, then send one-click from your mailbox (or open an Outlook draft). Nothing sends without your click. A CAN-SPAM footer + opt-out is included.</div>';
      var ft = footer('<span class="sp" id="bo-count"></span><button id="bo-back">← Back</button><button class="pri" id="bo-next">Next →</button>');

      function refreshCount() {
        var u = body.querySelectorAll('input[data-i]:checked').length;
        var nn = body.querySelectorAll('input[data-nn]:checked').length;
        var extra = parseEmails(val('bo-invite') || '').length;
        var total = u + nn + extra;
        var el = document.getElementById('bo-count');
        if (el) el.textContent = total + ' recipient' + (total === 1 ? '' : 's') + ' (' + u + ' our vendors' + (nn ? ', ' + nn + ' net-new' : '') + (extra ? ', ' + extra + ' pasted' : '') + ')';
      }
      function renderNetNew() {
        var c = document.getElementById('bo-netnew'); if (!c) return;
        var leads = openState.netNew || [];
        var head = openState.netNewMsg ? '<div class="bwn-bo-note">' + esc(openState.netNewMsg) + '</div>' : '';
        if (!leads.length) { c.innerHTML = head; return; }
        var withEmail = leads.filter(function (l) { return l.email; }).length;
        c.innerHTML = '<div class="bwn-bo-note">' + leads.length + ' prospect(s) · ' + withEmail + ' with email (rest are website/phone - grab their email into the box below).</div>' +
          '<div class="bwn-bo-list">' + leads.map(function (l, i) {
            var he = !!l.email;
            var srcTag = l.src === 'zoominfo' ? 'ZoomInfo' : (l.src === 'pipeline' ? 'pipeline' : '');
            return '<div class="bwn-bo-v"' + (l.dnc ? ' style="opacity:.55;"' : '') + '>' +
              '<input type="checkbox" data-nn="' + i + '"' + ((!he || l.dnc) ? ' disabled' : (isPicked(l.email) ? ' checked' : '')) + '>' +
              '<span class="nm">' + esc(l.name) + '</span>' +
              (l.src === 'pipeline' ? '<span class="mi" title="From the BWN prospect pipeline - no API cost">📇</span>' : '') +
              (l.rating ? '<span class="mi">★ ' + (+l.rating).toFixed(1) + '</span>' : '') +
              '<span class="mi">' + (l.mi != null ? (+l.mi).toFixed(1) + ' mi' : '') + '</span>' +
              outcomeBadge(l) +
              (he ? '<span class="em">' + esc(l.email) + ((l.contact || l.title || srcTag) ? ' <span class="mi" title="Named contact">' + esc((l.contact || '') + (l.title ? ' · ' + l.title : '')) + ((l.contact || l.title) && srcTag ? ' · ' : '') + esc(srcTag) + '</span>' : '') + '</span>'
                : (l.website && /^https?:\/\//i.test(l.website) ? '<a class="noem" href="' + esc(l.website) + '" target="_blank" rel="noopener">open site ↗</a>' : '<span class="noem">no site/email</span>')) +
              '<select data-oc="' + i + '" title="Record an outcome for this prospect (saved to the shared pipeline)" style="margin-left:auto;font:400 11px ' + FONT + ';color:#5a6b62;border:1px solid #dde6e1;border-radius:6px;padding:2px 4px;background:#fff;max-width:110px;">' +
                '<option value="">outcome…</option><option value="declined">Declined</option><option value="no-response">No response</option><option value="joined">Joined network</option><option value="do-not-contact">Do not contact</option>' +
              '</select>' +
              '</div>';
          }).join('') + '</div>' + head;
        c.querySelectorAll('input[data-nn]').forEach(function (cb) {
          cb.addEventListener('change', function () {
            var v = openState.netNew[+cb.getAttribute('data-nn')];
            if (v && v.email) openState.picked[v.email.toLowerCase()] = cb.checked;
            refreshCount();
          });
        });
        c.querySelectorAll('select[data-oc]').forEach(function (sel) {
          sel.addEventListener('change', function () {
            var l = openState.netNew[+sel.getAttribute('data-oc')];
            var status = sel.value;
            if (!l || !status) return;
            var note = prompt('Optional note for "' + l.name + '" (' + status + ') - e.g. why they declined:', '');
            if (note === null) { sel.value = ''; return; }   // Cancel = abort (outcome appends have no undo)
            note = note || '';
            (openState.upsertP || Promise.resolve()).then(function () {   // after the upsert lands, so the key exists server-side
              return prospectsOutcomes([{ key: l.key || ziKey(l), status: status, wo: String(woNumber() || ''), note: note }]);
            });
            l.lastOutcome = { status: status, ts: Date.now(), wo: String(woNumber() || ''), note: note };
            if (status === 'do-not-contact') { l.dnc = true; if (l.email) openState.picked[l.email.toLowerCase()] = false; }
            renderNetNew(); refreshCount();
          });
        });
      }

      body.querySelectorAll('input[data-i]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var v = openState.rowVendors[+cb.getAttribute('data-i')];
          if (v && v.email) openState.picked[v.email.toLowerCase()] = cb.checked;
          refreshCount();
        });
      });
      var inviteEl = document.getElementById('bo-invite');
      function refreshInvite() {
        var em = parseEmails(val('bo-invite') || '');
        var el = document.getElementById('bo-invite-note');
        if (el) el.textContent = em.length ? (em.length + ' pasted email' + (em.length === 1 ? '' : 's') + ' will be added.') : '';
        refreshCount();
      }
      inviteEl.addEventListener('input', refreshInvite);
      renderNetNew(); refreshInvite();
      if (openState.focusInvite) { openState.focusInvite = false; try { inviteEl.scrollIntoView({ block: 'center' }); inviteEl.focus(); } catch (e) { } }

      document.getElementById('bo-all').addEventListener('click', function () {
        body.querySelectorAll('input[data-i]:not([disabled])').forEach(function (cb) {
          cb.checked = true;
          var v = openState.rowVendors[+cb.getAttribute('data-i')];
          if (v && v.email) openState.picked[v.email.toLowerCase()] = true;
        });
        refreshCount();
      });
      document.getElementById('bo-reload').addEventListener('click', function () {
        capture(); var m = parseInt(val('bo-miles'), 10); if (m > 0) openState.miles = m;
        openState.pipelineChecked = false;   // a changed radius gets a fresh FREE pipeline read first
        draw();
      });
      function runPlacesDiscovery() {
        if (!GM_getValue('places_key', '')) { openState.netNewMsg = 'Set your Google Places API key: Tampermonkey menu → "Set Google Places API key", then try again.'; renderNetNew(); return; }
        var btn = document.getElementById('bo-find'); if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; }
        openState.netNewMsg = 'Searching Google Places + looking up emails… (up to ~1 min)';
        renderNetNew();
        discoverNetNew(wo, openState.miles, res.items).then(function (out) {
          // Keep ALL existing rows (pipeline rows carry outcome history; SR-seeded rows are the
          // coordinator's explicit picks); add only genuinely new discoveries. When a fresh row
          // collides with an email-less existing row, graft the freshly-paid-for email onto it.
          var byKey = {}; (openState.netNew || []).forEach(function (l) { byKey[ziKey(l)] = l; });
          var existing = (openState.netNew || []).slice();
          var fresh = [];
          (out.leads || []).forEach(function (f) {
            var hit = byKey[ziKey(f)];
            if (!hit) { fresh.push(f); return; }
            ['email', 'contact', 'title', 'website', 'src'].forEach(function (k) { if (!hit[k] && f[k]) hit[k] = f[k]; });
          });
          out.leads = existing.concat(fresh);
          openState.netNew = out.leads || [];
          openState.netNewMsg = out.scrapeSkipped ? 'Emails skipped - set the SWA ingest key (menu) to auto-fill them. Leads show website/phone for now.'
            : (out.scrapeErr ? ('Email lookup issue (' + out.scrapeErr + ') - leads shown; you can still open sites for emails.') : '');
          if (out.ziNote) openState.netNewMsg = (openState.netNewMsg ? openState.netNewMsg + ' ' : '') + out.ziNote;
          renderNetNew(); refreshCount();
        }).catch(function (e) {
          openState.netNew = [];
          openState.netNewMsg = e && e.message === 'NO_PLACES_KEY' ? 'Set your Google Places API key via the Tampermonkey menu, then try again.' : ('Search failed: ' + (e && e.message));
          renderNetNew();
        }).then(function () { var b = document.getElementById('bo-find'); if (b) { b.disabled = false; b.textContent = '🔎 Search Google for more'; } });
      }
      document.getElementById('bo-find').addEventListener('click', function () {
        capture();
        // FIRST click: read the FREE shared prospect pipeline (saved by every earlier Bid-Out /
        // Find Techs / Find Suppliers search) before spending Places / scrape / ZoomInfo money.
        if (!openState.pipelineChecked) {
          openState.pipelineChecked = true;
          var btn = document.getElementById('bo-find'); if (btn) { btn.disabled = true; btn.textContent = 'Checking the BWN pipeline…'; }
          pipelineFetch(wo, openState.miles).then(function (known) {
            if (known.length) {
              // Merge with anything already listed (e.g. SR-seeded picks) - never replace it.
              var kk = {}; known.forEach(function (l) { kk[ziKey(l)] = 1; });
              openState.netNew = known.concat((openState.netNew || []).filter(function (l) { return !kk[ziKey(l)]; }));
              known.forEach(function (l) { if (l.dnc && l.email) openState.picked[l.email.toLowerCase()] = false; });   // belt+suspenders vs the default-true pick
              var dec = known.filter(function (l) { return l.lastOutcome && l.lastOutcome.status === 'declined'; }).length;
              var dnc = known.filter(function (l) { return l.dnc; }).length;
              openState.netNewMsg = known.length + ' known prospect(s) from the BWN pipeline - no API cost' +
                (dec ? ' · ' + dec + ' previously declined' : '') + (dnc ? ' · ' + dnc + ' do-not-contact' : '') +
                '. "Search Google for more" runs a fresh paid search.';
              var b2 = document.getElementById('bo-find'); if (b2) { b2.disabled = false; b2.textContent = '🔎 Search Google for more'; }
              renderNetNew(); refreshCount();
            } else {
              runPlacesDiscovery();   // nothing known near here yet - go straight to the paid search
            }
          }).catch(function () { runPlacesDiscovery(); });
          return;
        }
        runPlacesDiscovery();
      });
      ft.querySelector('#bo-back').addEventListener('click', function () { capture(); openState.step = 1; draw(); });
      ft.querySelector('#bo-next').addEventListener('click', function () {
        capture();
        var recips = collectRecipients();
        if (!recips.length) { toast('Select at least one vendor, or add an outside email.'); return; }
        if (recips.length > MAX_BCC) { toast('Too many (' + recips.length + '); cap is ' + MAX_BCC + ' per blast.'); return; }
        openState.step = 3; draw();
      });
      refreshCount();
    }

    // ---- Step 3: Review - Umbrava-style summary + branded email + the ONLY Send gate
    // HARD RULE: never auto-send. Graph fires the moment we POST, so the human review
    // that used to happen in the Outlook draft happens HERE - recipients + rendered
    // body + editable From, and nothing sends until the coordinator clicks Send.
    function drawReview() {
      var req = {
        scope: (openState.scope || '').trim(),
        respondBy: openState.respond,
        arrive: openState.arrive,
        nte: openState.nte,
        techs: openState.techs,
        travelRate: openState.travelRate,
        rate: openState.rate,
        rateOffer: openState.rateOffer,
        include: openState.include,
        addl: (openState.addl || '').trim(),
        asset: (openState.asset || '').trim(),
        history: (openState.history || '').trim(),
        benchmark: openState.benchmark || null,
        contactName: openState.contactName,
        contactEmail: openState.contactEmail,
        contactPhone: openState.contactPhone
      };
      req.subject = openState.subject || bidSubject(wo, req);   // keep a coordinator-edited subject across Back/Next
      var recips = collectRecipients();
      var mail = buildBidEmail(wo, recips, req);
      var fromDefault = openState.contactEmail || GM_getValue('send_from', '') || me.email || '';
      function htmlFor(from) { return buildBidHtml(wo, req, from); }

      function sfld(k, v) { return '<div class="bwn-bo-sumfld"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; }
      var n = recips.length;
      var rinc = req.include || {};
      var sum = '<div class="bwn-bo-sum"><div class="bwn-bo-sumhd">Request summary</div>' +
        ((rinc.respond !== false && req.respondBy) ? sfld('Respond By', fmtRespondBy(req.respondBy)) : '') +
        sfld('Send to', n + ' vendor' + (n === 1 ? '' : 's')) +
        ((rinc.priority !== false && priorityLbl) ? sfld('Priority', priorityLbl) : '') +
        ((rinc.arrive !== false && req.arrive) ? sfld('Arrive By', fmtRespondBy(req.arrive)) : '') +
        (rinc.trades !== false ? '<div class="bwn-bo-sumfld"><div class="k">Trade(s)</div><div class="v"><div class="bwn-bo-chips">' + tradeChipsHtml() + '</div></div></div>' : '') +
        '<div class="bwn-bo-sumfld"><div class="k">Scope</div><div class="v">' + esc(req.scope || '-') + '</div></div>' +
        ((openState.include.service !== false && hasService) ? '<div class="bwn-bo-sumnote">Service Instructions Included</div>' : '') +
        ((rinc.nte !== false && req.nte) ? sfld('NTE', '$' + req.nte) : '') +
        ((rinc.techs !== false && req.techs) ? sfld('# of Techs', req.techs) : '') +
        ((rinc.travel !== false && req.travelRate) ? sfld('Travel Rate', '$' + req.travelRate + ' / hr') : '') +
        ((rinc.rate !== false && req.rate) ? sfld('Rate', '$' + req.rate + ' / hr') : '') +
        (req.rateOffer ? sfld('Rate Offer', 'Requested') : '') +
        sfld('Contact Name', req.contactName || me.name || 'Broadway National Group') +
        sfld('Contact Email', fromDefault) +
        sfld('Contact Phone', req.contactPhone || GM_getValue('sender_phone', '') || COMPANY_PHONE) +
        (function () {
          var names = (req.benchmark && req.benchmark.list && req.benchmark.list.length) ? [hvacBaseName(req.benchmark) + (hvacXlsxAvailable() ? '.xlsx' : '.csv')] : [];
          names = names.concat((openState.attachments || []).map(function (a) { return a.name; }));
          return names.length
            ? '<div class="bwn-bo-sumfld"><div class="k">Attachments</div><div class="v">' + esc(names.join(', ')) +
              '<div style="color:#92400e;font-size:11px;font-weight:500;margin-top:2px;">These files go to every vendor - confirm none names the client or the site address.</div></div></div>'
            : '';
        })() +
        '</div>';

      body.innerHTML =
        stepperHtml() +
        '<div class="bwn-bo-wo">Review - nothing has been sent yet</div>' +
        sum +
        '<div class="bwn-bo-meta"><span>From</span><input id="bo-from" type="email" value="' + esc(fromDefault) + '" placeholder="you@broadwaynational.com"></div>' +
        '<div class="bwn-bo-meta"><span>Subject</span><input id="bo-subj" type="text" value="' + esc(mail.subject) + '" style="flex:1;min-width:300px;"></div>' +
        '<div class="bwn-bo-meta"><span>BCC - ' + mail.bcc.length + ' vendor' + (mail.bcc.length === 1 ? '' : 's') + ' (they can’t see each other)</span></div>' +
        '<div class="bwn-bo-bcc">' + mail.bcc.map(esc).join(' · ') + '</div>' +
        '<div class="bwn-bo-pv"><iframe id="bo-pv" sandbox=""></iframe></div>' +
        '<div class="bwn-bo-note">Sent one-click from YOUR mailbox via Microsoft Graph (lands in your Sent Items; replies come to you). ' +
        'If one-click send isn’t configured yet, use "Outlook draft instead" - same recipients, plain-text body.</div>';
      var pv = document.getElementById('bo-pv');
      pv.srcdoc = htmlFor(fromDefault);
      var fromEl = document.getElementById('bo-from');
      fromEl.addEventListener('change', function () { pv.srcdoc = htmlFor(fromEl.value.trim()); });

      // draftBlocked persists in openState so the "maybe-sent -> disable the un-deduped Outlook
      // draft" guard survives a Back/Next re-render (a fresh footer would otherwise re-enable it).
      var draftDis = openState.draftBlocked
        ? ' disabled title="Disabled - this bid may already have sent. Check &quot;Who opened&quot; before any resend."'
        : '';
      var pft = footer('<span class="sp">' + mail.bcc.length + ' recipient' + (mail.bcc.length === 1 ? '' : 's') + ', all BCC</span>' +
        '<button id="bo-back">← Back</button>' +
        '<button id="bo-draft"' + draftDis + '>Outlook draft instead</button>' +
        '<button class="pri" id="bo-send">⚡ Send now (' + mail.bcc.length + ')</button>');
      function syncSubject() { var s = (document.getElementById('bo-subj') || {}).value; if (s != null && s.trim()) { mail.subject = s.trim(); openState.subject = s.trim(); } }
      pft.querySelector('#bo-back').addEventListener('click', function () {
        var f = val('bo-from'); if (f !== undefined) openState.contactEmail = f.trim();
        var sj = val('bo-subj'); if (sj !== undefined && sj.trim()) openState.subject = sj.trim();   // persist an edited subject like From
        openState.step = 2; draw();
      });
      pft.querySelector('#bo-draft').addEventListener('click', function () {
        syncSubject();
        var nAtt = (openState.attachments || []).length + (req.benchmark && req.benchmark.list && req.benchmark.list.length ? 1 : 0);
        openDraft(mail);
        toast('Draft opened for ' + mail.bcc.length + ' recipient' + (mail.bcc.length === 1 ? '' : 's') + ' (BCC). Review + send in your mail client. Body also copied to clipboard.' +
          (nAtt ? ' Note: attachments (' + nAtt + ') are NOT carried into an Outlook draft - use one-click Send for those, or attach them manually.' : ''));
        close();
      });
      pft.querySelector('#bo-send').addEventListener('click', function () {
        var from = (fromEl.value || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(from)) { toast('Enter your send-from email first.'); return; }
        if (!GM_getValue('ingest_key', '')) { toast('Set the SWA ingest key first (Tampermonkey menu → "Set SWA ingest key") - or use "Outlook draft instead".'); return; }
        syncSubject();
        var html = htmlFor(from);
        // Idempotency key derived PURELY from the bid content (from + sorted recipients +
        // subject + body). No per-panel nonce on purpose: the same bid MUST dedup no matter how
        // it is re-sent - a Back/Next retry, a reopened panel, even a second browser tab or
        // device. The server's audit log is date-pruned to ~today+yesterday, so that becomes
        // the natural dedup window: an identical re-bid days later finds no entry and is allowed,
        // while an EDITED bid hashes differently and is always allowed.
        // from + recipients are LOWERCASED to mirror the server's normalization (it lowercases
        // before sending) - otherwise "Vendor@Co.com" vs "vendor@co.com" would miss dedup.
        var idemFrom = from.toLowerCase();
        var idemBcc = (mail.bcc || []).map(function (e) { return String(e || '').trim().toLowerCase(); }).sort().join(',');
        // Attachments: the HVAC per-location schedule + any coordinator-curated files.
        var manualAttach = (openState.attachments || []).map(function (a) { return { name: a.name, contentType: a.contentType, contentBase64: a.contentBase64 }; });
        var allAttach = hvacAttachments(req.benchmark).concat(manualAttach);
        // Fold an attachment fingerprint into the idem key so adding/removing a file counts as an
        // edited bid (otherwise a resend with different files would dedup against the prior send).
        var attachFp = allAttach.map(function (a) { var b = a.contentBase64 || ''; return a.name + ':' + b.length + ':' + b.slice(0, 24); }).join(',');
        var idem = 'b' + cyrb53([idemFrom, idemBcc, mail.subject || '', html, attachFp].join('|'));
        var btn = document.getElementById('bo-send');
        btn.disabled = true; btn.textContent = 'Sending…';
        sendBid(from, mail, html, idem, allAttach).then(function (r) {
          if (r.ok) {
            GM_setValue('send_from', from);
            if (r.duplicate) { toast('This bid was already submitted - not re-sent. Use the "📊 Who opened" menu item to check status.'); close(); return; }
            // Record "bid-sent" in the shared prospect pipeline for every net-new recipient, so a
            // future search near here shows who was already asked (and their reply outcome).
            try {
              var sentSet = {}; (mail.bcc || []).forEach(function (e2) { sentSet[String(e2).toLowerCase()] = 1; });
              var outs = (openState.netNew || []).filter(function (l) { return l.email && sentSet[l.email.toLowerCase()]; })
                .map(function (l) { return { key: l.key || ziKey(l), status: 'bid-sent', wo: String(woNumber() || '') }; });
              (openState.upsertP || Promise.resolve()).then(function () { return prospectsOutcomes(outs); });   // after the upsert lands
            } catch (e3) { }
            var failNote = (r.failed > 0) ? (' (' + r.failed + ' could not be sent)') : '';
            var trackNote = r.tracked ? ' Per-vendor open tracking is on - use the "📊 Who opened" menu item to see who has viewed it.' : '';
            toast('✅ Sent to ' + r.sent + ' vendor' + (r.sent === 1 ? '' : 's') + failNote + ' from ' + from + '. Replies come to your inbox; the email is in your Sent Items.' + trackNote);
            close(); return;
          }
          btn.disabled = false; btn.textContent = '⚡ Send now (' + mail.bcc.length + ')';
          if (r.code === 'NO_KEY') { toast('Set the SWA ingest key first (Tampermonkey menu).'); return; }
          if (r.code === 'NO_TOKEN' || r.code === 401) { toast('Umbrava could not verify your session' + (r.msg ? ' - ' + r.msg : '') + '. Reload the tab and retry; the send did not go out.'); return; }
          // "Maybe sent" outcomes: the request may have reached Graph and delivered some/all
          // emails (timeout, still-in-flight, or a 5xx AFTER a possible send). We must NOT nudge
          // the user to the Outlook draft - a mailto to every recipient with no dedup - so we
          // DISABLE it and steer to the open-tracking view. A server resend of the unchanged
          // bid is idempotent (safe); the draft is not.
          var maybeSent = (r.code === 'NET' || r.code === 'IN_PROGRESS' || r.code === 500 || r.code === 502 || r.code === 504);
          if (maybeSent) {
            openState.draftBlocked = true;   // persist so a Back/Next re-render keeps the draft disabled
            var draftBtn = document.getElementById('bo-draft');
            if (draftBtn) { draftBtn.disabled = true; draftBtn.title = 'Disabled - this bid may already have sent. Check "Who opened" before any resend.'; }
            if (r.code === 'IN_PROGRESS') { toast('This bid is still sending - give it a moment, then use "📊 Who opened" to confirm. Please don’t resend, and don’t use the Outlook draft (it would duplicate).'); return; }
            toast('The send may have already gone out (server was slow or the connection dropped). Check "📊 Who opened" before resending. A server resend of the unchanged bid is de-duplicated; the Outlook draft is not, so it’s disabled.'); return;
          }
          if (r.code === 503 && /awaiting/i.test(r.msg || '')) { toast('One-click send isn’t live yet - the Graph app registration is still pending with IT. Use "Outlook draft instead" for now.'); return; }
          if (r.code === 403 && /allowlist/i.test(r.msg || '')) { toast('That send-from address isn’t on the server allowlist - ask IT/admin to add it (BID_FROM_ALLOWED).'); return; }
          if (r.code === 429) { toast('Daily send ceiling reached - try again tomorrow or use the Outlook draft.'); return; }
          toast('Send failed: ' + (r.msg || 'unknown error') + ' - you can still use "Outlook draft instead".');
        });
      });
    }

    draw();
  }

  // ---- Read-receipts: "who opened our bid" (per-vendor tracking) ---------------
  function fmtWhen(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); } }
  function openStatusPanel() {
    if (!woNumber()) { toast('Open a work order first.'); return; }
    if (!GM_getValue('ingest_key', '')) { toast('Set the SWA ingest key first (Tampermonkey menu -> "Set SWA ingest key").'); return; }
    ensureStyle();
    var prev = document.getElementById('bwn-bo-statusov'); if (prev) prev.remove();
    var ov = document.createElement('div'); ov.id = 'bwn-bo-statusov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(15,30,22,.45);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;font-family:' + FONT + ';';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:12px;max-width:560px;width:100%;max-height:84vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.28);';
    card.innerHTML = '<div style="padding:16px 20px;border-bottom:1px solid #dde6e1;display:flex;align-items:center;gap:10px;">' +
      '<div style="font-size:16px;font-weight:500;color:#0d3d26;">Who opened our bid</div><span style="flex:1;"></span>' +
      '<button id="bwn-bo-stclose" style="border:0;background:#eef2f0;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:14px;color:#1f2a24;">Close</button></div>' +
      '<div id="bwn-bo-stbody" style="padding:16px 20px;color:#1f2a24;font-size:14px;">Loading…</div>';
    ov.appendChild(card); document.body.appendChild(ov);
    function close() { ov.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    card.querySelector('#bwn-bo-stclose').addEventListener('click', close);
    var body = card.querySelector('#bwn-bo-stbody');
    loadWO(woNumber()).then(function (wo) {
      var tracking = wo && wo.trackingNumber;
      return bidStatus(tracking).then(function (res) { renderStatus(body, res, tracking); });
    }).catch(function (e) { body.innerHTML = '<div style="color:#b91c1c;">Could not load: ' + esc(e.message) + '</div>'; });
  }
  function renderStatus(body, res, tracking) {
    if (!res.ok) {
      if (res.code === 'NO_KEY') { body.innerHTML = 'Set the SWA ingest key first (Tampermonkey menu).'; return; }
      if (res.code === 503) { body.innerHTML = '<div style="color:#8a4b12;">Open tracking isn\'t live yet - it turns on once IT sets the tracking base URL on the SWA. Sends still go out; only this read-receipt view is dark.</div>'; return; }
      body.innerHTML = '<div style="color:#b91c1c;">Could not load status: ' + esc(res.msg || ('HTTP ' + res.code)) + '</div>'; return;
    }
    var sends = res.sends || [];
    if (!sends.length) {
      body.innerHTML = '<div style="color:#5a6b62;">No tracked bid sends yet for ' + (tracking ? ('Tracking #' + esc(tracking)) : 'this work order') + '.<br><span style="font-size:12px;">Per-vendor tracking only records opens for bids sent after it was enabled.</span></div>';
      return;
    }
    var html = '';
    sends.forEach(function (s) {
      var vs = s.vendors || [];
      var openedN = vs.filter(function (v) { return v.opened; }).length;
      var sentN = vs.filter(function (v) { return v.sendOk !== false; }).length;
      html += '<div style="border:1px solid #dde6e1;border-radius:8px;margin-bottom:12px;overflow:hidden;">' +
        '<div style="padding:10px 12px;background:#f3f7f5;border-bottom:1px solid #dde6e1;">' +
        '<div style="font-weight:500;color:#0d3d26;">' + esc(s.subject || 'Bid request') + '</div>' +
        '<div style="font-size:12px;color:#5a6b62;margin-top:2px;">Sent ' + esc(fmtWhen(s.ts)) + ' · ' + openedN + ' of ' + sentN + ' opened</div></div><div>';
      vs.forEach(function (v) {
        var icon, color, note;
        if (v.sendOk === false) { icon = '⚠'; color = '#8a4b12'; note = 'not delivered'; }
        else if (v.opened) { icon = '👁'; color = '#1a5f3e'; note = 'opened' + (v.openCount > 1 ? (' x' + v.openCount) : '') + (v.firstOpenTs ? (' · ' + fmtWhen(v.firstOpenTs)) : ''); }
        else { icon = '○'; color = '#9aa8a1'; note = 'not opened yet'; }
        html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid #eef2f0;">' +
          '<span style="font-size:15px;width:18px;text-align:center;">' + icon + '</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(v.email || v.name || '(unknown)') + '</span>' +
          '<span style="font-size:12px;color:' + color + ';white-space:nowrap;">' + esc(note) + '</span></div>';
      });
      html += '</div></div>';
    });
    html += '<div style="font-size:11px;color:#9aa8a1;line-height:1.5;">Open tracking is a soft signal: some mail apps (Apple Mail Privacy, Gmail image proxy) pre-load images and can show an open the recipient never made. Use it to prioritize follow-up, not as proof of reading.</div>';
    body.innerHTML = html;
  }

  // ---- Launcher: a caret ON Umbrava's own "See Who Is Available" button --------
  // Bidding OUR network vendors is native Umbrava (See Who Is Available -> Build Requests), so
  // the old separate "Bid-Out" button + its "Bid out to our vendors" entry were redundant. The
  // caret extends the native button with only what native CANNOT do: the tracked email RFP to
  // outside / net-new vendors, and the read-receipt status. The native click stays untouched.
  function launchPanel(opts) { openState = {}; if (opts && opts.invite) openState.focusInvite = true; if (opts && opts.seedLeads && opts.seedLeads.length) openState.seedLeads = opts.seedLeads; openPanel(); }
  function seeWhoBtn() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (/see who is available/i.test((btns[i].textContent || '').trim())) return btns[i];
    }
    return null;
  }
  function buildCaret(nativeBtn) {
    var wrap = document.createElement('span'); wrap.id = 'bwn-bidout-dd'; wrap.className = 'bwn-bo-dd';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'bwn-bo-caret';
    btn.textContent = '▾';
    btn.title = 'More bid options: email RFP to outside / net-new vendors, read receipts';
    btn.setAttribute('aria-label', 'More bid options');
    // Match the native button so the pair reads as one split control (survives theme changes).
    try {
      var cs = getComputedStyle(nativeBtn);
      btn.style.background = cs.backgroundColor;
      btn.style.height = nativeBtn.offsetHeight + 'px';
    } catch (e) { btn.style.background = '#0731a5'; btn.style.height = '36px'; }
    var menu = document.createElement('div'); menu.className = 'bwn-bo-ddmenu'; menu.style.display = 'none';
    function item(label, onClick) {
      var it = document.createElement('button'); it.type = 'button'; it.className = 'bwn-bo-dditem'; it.textContent = label;
      it.addEventListener('click', function (e) { e.stopPropagation(); menu.style.display = 'none'; onClick(); });
      return it;
    }
    menu.appendChild(item('✉ Email RFP - outside / net-new vendors…', function () { launchPanel({ invite: true }); }));
    menu.appendChild(item('📊 Who opened our bids', function () { openStatusPanel(); }));
    function onDoc(e) { if (!wrap.contains(e.target)) { menu.style.display = 'none'; document.removeEventListener('mousedown', onDoc, true); } }
    btn.addEventListener('click', function (e) {
      e.stopPropagation(); e.preventDefault();
      var show = menu.style.display === 'none'; menu.style.display = show ? 'block' : 'none';
      if (show) document.addEventListener('mousedown', onDoc, true);
    });
    wrap.appendChild(btn); wrap.appendChild(menu);
    return wrap;
  }
  // The Service Requests card heading. No testids exist on this section and the MUI/JSS
  // class names are build-unstable (jss####), so anchor on the user-facing "Service
  // Requests" heading TEXT and navigate relative to it (verified via __bwnSRRecon on WO
  // 1242525, 2026-07-23). Returns the heading element or null.
  function srHeader() {
    var hs = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < hs.length; i++) {
      if (/^service requests?$/i.test((hs[i].textContent || '').replace(/\s+/g, ' ').trim())) return hs[i];
    }
    return null;
  }
  function mountInline(hdr) {
    if (document.getElementById('bwn-bidout-inline')) return;
    var b = document.createElement('button'); b.id = 'bwn-bidout-inline'; b.type = 'button';
    b.textContent = '📤 Email RFP'; b.title = 'Email RFP to outside / net-new vendors (bids for this work order)';
    b.addEventListener('click', function () { launchPanel({ invite: true }); });
    hdr.insertAdjacentElement('afterend', b);   // sits right after the "Service Requests" heading
  }
  // Launcher cascade (see the bwn-email-rfp-inline-anchor spec): 1) caret on Umbrava's
  // native "See Who Is Available" button when present; else 2) an inline control on the
  // Service Requests card. There is no third tier: a floating corner button is exactly
  // the kind of stray anchor the dock tab replaced, so when neither host exists the RFP
  // is reached from the tab instead.
  function mountLauncher() {
    if (!woNumber()) return;
    ensureStyle();
    var nb = seeWhoBtn();
    if (nb) {   // tier 1: split-button caret on the native button
      var i1 = document.getElementById('bwn-bidout-inline'); if (i1) i1.remove();
      if (!document.getElementById('bwn-bidout-dd')) nb.parentElement.insertBefore(buildCaret(nb), nb.nextSibling);
      return;
    }
    var dd = document.getElementById('bwn-bidout-dd'); if (dd) dd.remove();   // native button gone -> drop its orphaned caret
    var hdr = srHeader();
    if (hdr) {   // tier 2: inline on the Service Requests card
      mountInline(hdr);
      return;
    }
  }

  // ---- SR recon: console-only probe to pin the Service Requests inline anchor -----
  // Email RFP today rides a caret on Umbrava's native "See Who Is Available" button and
  // falls back to a floating FAB when that button is absent (the "reverts after send"
  // bug). To re-anchor it to the Service Requests card we need the stable container /
  // testids captured live. This probe only DUMPS candidates - nothing automatic depends
  // on it. Run __bwnSRRecon() in the console on a WO that has a Service Requests section,
  // BEFORE and AFTER an RFP send, and compare (esp. seeWhoPresent + the SR-row state
  // chips). See the bwn-email-rfp-inline-anchor spec.
  function srReconEl(el) {
    if (!el || !el.tagName) return null;
    var cls = typeof el.className === 'string' ? el.className : '';
    return {
      tag: el.tagName.toLowerCase(),
      testid: (el.getAttribute && el.getAttribute('data-testid')) || '',
      id: el.id || '',
      role: (el.getAttribute && el.getAttribute('role')) || '',
      aria: (el.getAttribute && el.getAttribute('aria-label')) || '',
      cls: cls.slice(0, 80),
      txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50)
    };
  }
  function srReconChain(el, depth) {
    var chain = [], n = 0;
    while (el && n < (depth || 8)) { chain.push(srReconEl(el)); el = el.parentElement; n++; }
    return chain;
  }
  function srRecon() {
    var out = { path: location.pathname, wo: woNumber(), seeWhoPresent: false, seeWhoChain: [], srHeaders: [], srHeaderChain: [], viewChain: [], srTestids: {}, viewCtrls: [], stateChips: [] };
    // 1. ancestor chain of the native button the caret rides today (present only in the
    //    "See Who Is Available" WO state) - reveals its enclosing card + any testid.
    var nb = seeWhoBtn();
    out.seeWhoPresent = !!nb;
    if (nb) out.seeWhoChain = srReconChain(nb, 9);
    // 2. testids mentioning a service request / bid / request (section + rows).
    document.querySelectorAll('[data-testid*="service-request" i],[data-testid*="servicerequest" i],[data-testid*="bid" i],[data-testid*="request" i]').forEach(function (el) {
      var t = el.getAttribute('data-testid'); if (t && !(t in out.srTestids)) out.srTestids[t] = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    });
    // 3. "Service Request(s)" header candidates + the ancestor chain of the FIRST one -
    //    this is the tier-2 anchor (the SR card container + its stable testid). Needed
    //    because in the SR-present-but-no-See-Who state (the bug), seeWhoChain is empty.
    var hdrEl = null;
    document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p').forEach(function (el) {
      var tx = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^service requests?\b/i.test(tx) && tx.length < 40 && el.querySelectorAll('*').length <= 4) { out.srHeaders.push(srReconEl(el)); if (!hdrEl) hdrEl = el; }
    });
    if (hdrEl) out.srHeaderChain = srReconChain(hdrEl, 8);
    // 4. "View" controls (per-row anchor candidates) + the ancestor chain of the first
    //    (the SR row container, for the per-row granularity option).
    var viewEl = null;
    document.querySelectorAll('button,a').forEach(function (el) {
      if (/^view$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim())) { out.viewCtrls.push(srReconEl(el)); if (!viewEl) viewEl = el; }
    });
    if (viewEl) out.viewChain = srReconChain(viewEl, 8);
    // 5. per-request state chips - Umbrava's OWN row lifecycle (not our RFP), captured to
    //    confirm no "RFP sent" signal lives in the DOM.
    var chips = {};
    document.querySelectorAll('[data-testid*="status" i],[class*="chip" i],[class*="badge" i],[class*="status" i],[class*="tag" i]').forEach(function (el) {
      var tx = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (tx && tx.length < 30 && /sent|pending|await|bid|request|declin|award|receiv|complete|open/i.test(tx)) chips[tx] = 1;
    });
    out.stateChips = Object.keys(chips).slice(0, 30);
    out.viewCtrls = out.viewCtrls.slice(0, 20);
    console.info('[BWN BID-OUT] SR recon:', out);
    return out;
  }
  try { window.__bwnSRRecon = srRecon; } catch (e) { }
  // Bid-Out is sandboxed (@grant GM_*), so `window` is the TM sandbox, not the page. The
  // devtools console runs in the PAGE context by default, so also expose on unsafeWindow
  // or __bwnSRRecon() would be undefined there. (Core's docsRecon needs only `window`
  // because Core is @grant none.)
  try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) unsafeWindow.__bwnSRRecon = srRecon; } catch (e) { }

  function removeLaunchers() {
    // -fab is no longer mounted; the id stays here to sweep one left over on a tab that
    // was open across the upgrade.
    ['bwn-bidout-dd', 'bwn-bidout-fab', 'bwn-bidout-inline'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.remove();
    });
  }
  var lastPath = '';
  function tick() {
    if (location.pathname !== lastPath) { lastPath = location.pathname; removeLaunchers(); dockReeval(); }
    // Idempotent + cheap: re-run every tick so the inline anchor re-injects after Umbrava
    // repaints the Service Requests card (each mount* checks for its own node first).
    if (woNumber()) mountLauncher();
    else removeLaunchers();
  }
  setInterval(tick, 800);
  tick();

  // ---- Command bus: let the Service Request helper (AI script) open this invite wizard
  // from inside Umbrava's native "Build Requests" modal, so a coordinator can add net-new
  // (outside-network) vendors without leaving that screen. Reuses the FULL review-before-send
  // flow here - net-new de-dup, BCC-only, city/state-only, CAN-SPAM, human review. Nothing
  // auto-sends. No-op off a WO page.
  document.addEventListener('bwn:cmd', function (e) {
    var d = e && e.detail; if (!d || !woNumber()) return;
    if (d.id === 'bidout:invite') launchPanel({ invite: true, seedLeads: (d.leads && d.leads.length) ? d.leads : null });
    else if (d.id === 'bidout:open') launchPanel({});
    else if (d.id === 'bidout:status') openStatusPanel();
  }, false);

  // ---- Dock presence (bwn:dock:*): register into the shared launcher dock so
  // presence-gated consumers can SEE this tool. Core's Next Actions checklist only
  // renders its "Email RFP..." step button while a `bidout` registration is live
  // (ACT_TOOL in bwn-suite-core; registrant table in the bwn-launcher-dock spec), and
  // the rail shows one "Email RFP" row on WO detail pages. Presence is DYNAMIC like
  // bwn-dispatch: a WO number in the path registers, leaving it unregisters - the RFP
  // wizard is WO-scoped, so a row on the list page would be a dead control. The inline
  // SR-card anchor stays untouched: the record-anchored control lives on the record
  // (bwn-email-rfp-inline-anchor spec); the dock row is the WO-level opener of the
  // same wizard. Register re-emits on every host ping (the roster TTL-prunes silent
  // entries) and is idempotent by key; unregister emits only on the WO -> non-WO
  // transition so the list page is not a spam source.
  var DOCK_KEY = 'bidout';
  var dockRegistered = false;
  function dockEmit(detail) {
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail })); } catch (e) { }
  }
  function dockReeval() {
    if (woNumber()) {
      dockRegistered = true;
      dockEmit({ id: 'bwn:dock:register', key: DOCK_KEY, label: 'Email RFP', icon: '📧', weight: 35, title: 'Email RFP to outside / net-new vendors' });
    } else if (dockRegistered) {
      dockRegistered = false;
      dockEmit({ id: 'bwn:dock:unregister', key: DOCK_KEY });
    }
  }
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail; if (!d) return;
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') dockReeval();
    else if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY && woNumber()) launchPanel({ invite: true });
  }, false);

  // ---- Key management (Tampermonkey menu) ------------------------------------
  try {
    GM_registerMenuCommand('Set Google Places API key', function () {
      var v = prompt('Google Places API key (for net-new vendor discovery):', GM_getValue('places_key', '') || '');
      if (v !== null) { GM_setValue('places_key', v.trim()); toast(v.trim() ? 'Places key saved.' : 'Places key cleared.'); }
    });
    GM_registerMenuCommand('Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used to fetch net-new emails + one-click send):', GM_getValue('ingest_key', '') || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
    GM_registerMenuCommand('Set send-from email (one-click send)', function () {
      var v = prompt('Your send-from mailbox (must be on the server allowlist; the bid email sends from + replies to this):', GM_getValue('send_from', '') || (actor().email || ''));
      if (v !== null) { GM_setValue('send_from', v.trim()); toast(v.trim() ? 'Send-from saved.' : 'Send-from cleared.'); }
    });
    GM_registerMenuCommand('Set your phone (bid email contact)', function () {
      var v = prompt('Phone shown in the bid email contact block (blank = company main ' + COMPANY_PHONE + '):', GM_getValue('sender_phone', '') || '');
      if (v !== null) { GM_setValue('sender_phone', v.trim()); toast(v.trim() ? 'Phone saved.' : 'Phone cleared (company main used).'); }
    });
    // Recon launcher for the Service Requests inline anchor (bwn-email-rfp-inline-anchor
    // spec). Runs entirely in the sandbox (no unsafeWindow needed), logs to the page
    // console, and copies the JSON to the clipboard so it can be pasted straight back.
    GM_registerMenuCommand('Recon: Service Requests DOM', function () {
      try {
        var o = srRecon();
        var j = JSON.stringify(o, null, 2);
        try { navigator.clipboard.writeText(j).then(function () { }, function () { }); } catch (e2) { }
        toast('SR recon done: ' + (o.srHeaders.length) + ' header hit(s), ' + o.viewCtrls.length + ' View ctrl(s), See-Who=' + o.seeWhoPresent + '. Copied to clipboard + logged to console.');
      } catch (e) { toast('SR recon failed: ' + (e && e.message)); }
    });
  } catch (e) { /* GM menu unavailable */ }
})();
