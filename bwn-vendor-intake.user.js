// ==UserScript==
// @name         BWN Vendor Intake (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.8.7
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-vendor-intake.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts-public/main/bwn-vendor-intake.user.js
// @description  Prefills Umbrava's Create Vendor form (and the detail-page Tax ID) from a Prospect Set-Up Form or a W-9. Fillable PDFs are read straight from their form fields; SCANNED W-9s are read by on-device OCR (Tesseract + pdf.js, fetched once at install, run entirely in the browser). The document and its tax ID never leave your machine. Adds a "Prefill from document" button; every extracted field is a suggestion to review before saving - the TIN especially, since OCR can misread digits.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getResourceURL
// @require      https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js#sha384=ff5a940921b04eeafdbe37ffcfd966bbf7825186e93938128e6a5b310675fc2b57daffd670020aa91bfe5350d4086e9e
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js#sha384=af5aeeded71fe8586708547807ba48146f8184517d2e516dcff3f5cb8a5b9569f7006b3dcb7941c7948a2cd7f8fab103
// @resource     pdfWorker   https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js#sha384=4a7ccea1ba5130b5d9e76889bd99bf0b47d8c343907a64d7cd38c8b1db1f31cac2b4211ef6a833c537774529253b9c76
// @resource     tessWorker  https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js#sha384=5f3f1cb47b59807fde5b03aa77a8a0394fe47a99e2973e1da305bce11104d8a2fd0ed0dbc449ddff1c58873061342cdd
// @resource     tessCore    https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js#sha384=2176b458e83f5d52c4fa75c9bc420c1c30f382ab1d5458cd2c12887b01566795e7ebfff455f1cceaf595f7388afa9b2e
// @resource     tessCoreFb  https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-lstm.wasm.js#sha384=95608c64032d98e5eea0a6aba5a5a92c0ad78903ef61983ed1fab103ebc5827c1b1e125a1ee2692bf0eb8616c43e0540
// @resource     tessLangEng https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz#sha384=248f9fada180a1ce460462258aeab31d19cfd67272aee920e6080d481bff4cef983958fee937ba5d740ec7b89ad74c6a
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.8.7';
  // v0.4.0 - real IRS fillable W-9 support: map by FIELD NAME (UTF-16BE-decoded f1_/c1_1 names)
  // after inflating compressed object streams, since the IRS form carries no /TU tooltips; the
  // tooltip mapping stays as a fallback for other fillable forms. Also fixed stream inflation to
  // survive the browser DecompressionStream's strict "trailing junk" error. TIN still never egressed.
  console.info('[BWN VENDOR INTAKE] v' + VER + ' - prefill Create Vendor from a Prospect Set-Up Form, fillable W-9, or SCANNED W-9 (on-device OCR); document + TIN stay local');

  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";

  // ---- Toast --------------------------------------------------------------
  function toast(msg, ms) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:24px;right:18px;z-index:2147483647;background:#0d3d26;color:#fff;padding:11px 16px;border-radius:8px;font:400 14px ' + FONT + ';box-shadow:0 6px 24px rgba(13,38,26,.3);max-width:440px;line-height:1.45;';
    t.textContent = 'Vendor Intake: ' + msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 8000);
  }

  // ---- PDF field read (local; fillable AcroForm /T name /V value) ---------
  // The Prospect Set-Up Form is a fillable PDF, so its values live in the form
  // fields. Read the raw bytes and pull /T(name) .. /V(value) pairs; if the form
  // was saved compressed, inflate the FlateDecode streams and read those too.
  function latin1(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; }
  function unesc(x) { return String(x).replace(/\\([()\\])/g, '$1').replace(/\\([0-7]{1,3})/g, function (_, o) { return String.fromCharCode(parseInt(o, 8)); }); }
  function fieldsFromStr(s) {
    var out = {}, re = /\/T\s*\(((?:\\.|[^)\\])*)\)[\s\S]{0,900}?\/V\s*\(((?:\\.|[^)\\])*)\)/g, m;
    while ((m = re.exec(s))) { var k = unesc(m[1]).trim(), v = unesc(m[2]).trim(); if (k && v && !(k in out)) out[k] = v; }
    return out;
  }
  // Inflate one stream. PDF stream slices routinely carry a few trailing bytes past the real
  // deflate end (we cut at the next "endstream", not at the exact /Length), and the browser's
  // DecompressionStream is STRICT - it throws "trailing junk" at flush. So pump the decoder by
  // hand and keep the output collected BEFORE that error fires (all real data is already out by
  // then). This is what lets us read the IRS fillable W-9, whose fields live in compressed
  // object streams. (A single pipeThrough(...).arrayBuffer() would reject and lose everything.)
  async function inflateOne(bytes, fmt) {
    var ds, writer, reader;
    try { ds = new DecompressionStream(fmt); writer = ds.writable.getWriter(); reader = ds.readable.getReader(); }
    catch (e) { return null; }
    writer.write(bytes).catch(function () { }); writer.close().catch(function () { });
    var chunks = [], total = 0;
    try { while (true) { var r = await reader.read(); if (r.done) break; chunks.push(r.value); total += r.value.length; } }
    catch (e) { /* trailing junk after the valid data - keep what decompressed */ }
    if (!total) return null;
    var all = new Uint8Array(total), off = 0;
    chunks.forEach(function (c) { all.set(c, off); off += c.length; });
    return all;
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') return null;
    return (await inflateOne(bytes, 'deflate')) || (await inflateOne(bytes, 'deflate-raw'));
  }
  async function inflateAll(u8) {
    var s = latin1(u8), re = /stream\r?\n/g, m, chunks = [];
    while ((m = re.exec(s))) {
      var start = m.index + m[0].length, end = s.indexOf('endstream', start);
      if (end < 0) continue;
      var inf = await inflate(u8.subarray(start, end));
      if (inf) chunks.push(inf);
    }
    if (!chunks.length) return null;
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0), all = new Uint8Array(total), off = 0;
    chunks.forEach(function (c) { all.set(c, off); off += c.length; });
    return all;
  }
  async function parseProspect(file) {
    var u8 = new Uint8Array(await file.arrayBuffer());
    var f = fieldsFromStr(latin1(u8));
    if (!f.company_name && !f.email && !f.contact_names) {
      var infl = await inflateAll(u8);
      if (infl) Object.assign(f, fieldsFromStr(latin1(infl)));
    }
    return f;
  }

  // ---- W-9 (best-effort, local) -------------------------------------------
  // Two kinds of W-9 we can read locally:
  //  (1) The REAL IRS fillable W-9. Its fields have cryptic XFA names (f1_1, c1_1[..]) with NO
  //      /TU tooltips, UTF-16BE-encoded, and the values sit in compressed object streams. We map
  //      by FIELD NAME after inflating (extractW9Fillable) - see the IRS convention there.
  //  (2) A non-IRS fillable form that DOES carry /TU tooltips. We map by tooltip (extractW9) as a
  //      fallback, the way Core reads MUI fields by label.
  // A SIGNED/SCANNED W-9 is an image with no form fields: it yields nothing here and is handled
  // by on-device OCR (the separate stage below).
  // Everything stays local; the TIN is never logged, toasted, or sent anywhere.
  function acroFieldsFromStr(s) {
    // For each /T(name), look a short window ahead for its /TU(tooltip) + /V(value) (same
    // dict; key order varies). Best-effort: a miss just leaves that field empty.
    var out = { byTip: [], text: '' }, re = /\/T\s*\(((?:\\.|[^)\\])*)\)/g, m;
    while ((m = re.exec(s))) {
      var win = s.slice(m.index, m.index + 1600);
      var tu = win.match(/\/TU\s*\(((?:\\.|[^)\\])*)\)/);
      var v = win.match(/\/V\s*\(((?:\\.|[^)\\])*)\)/);
      var tip = tu ? unesc(tu[1]).trim() : '';
      var val = v ? unesc(v[1]).trim() : '';
      if (tip) out.byTip.push({ tip: tip, value: val });
      if (val) out.text += ' ' + val;
    }
    return out;
  }
  function looksLikeW9(af) {
    return af.byTip.some(function (t) {
      return /income tax return|employer identification|backup withholding|taxpayer identification|federal tax classification|\bw-?9\b/i.test(t.tip);
    });
  }
  function classToEntity(c) {
    var s = String(c || '').toLowerCase();
    if (!s) return '';
    // Individual / sole-prop / SINGLE-member LLC is its own W-9 box - check BEFORE the
    // generic LLC branch (which is for LLCs taxed as C / S / Partnership).
    if (/individual|sole\s*propriet|single[\s-]*member/.test(s)) return 'Individual_Or_Single_Member_LLC';
    if (/\bllc\b|limited liability/.test(s)) {
      if (/\bc\b|c[\s-]*corp/.test(s)) return 'LLC_C_Corp';
      if (/\bs\b|s[\s-]*corp/.test(s)) return 'LLC_S_Corp';
      if (/\bp\b|partnership/.test(s)) return 'LLC_Partnership';
      return 'LLC';
    }
    if (/c[\s-]*corp/.test(s)) return 'C_Corp';
    if (/s[\s-]*corp/.test(s)) return 'S_Corp';
    if (/partnership/.test(s)) return 'Partnership';
    if (/trust|estate/.test(s)) return 'Trust_Estate';
    if (/other/.test(s)) return 'Other';
    return '';
  }
  function findTIN(text) {
    var s = String(text || '');
    var ein = s.match(/\b(\d{2}-\d{7})\b/); if (ein) return { tin: ein[1], kind: 'ein' };
    var ssn = s.match(/\b(\d{3}-\d{2}-\d{4})\b/); if (ssn) return { tin: ssn[1], kind: 'ssn' };
    // Scanned forms: the TIN is written in per-digit comb boxes, so OCR emits digits split by
    // spaces/box artifacts under the caption. Probe a short window AFTER each caption (EIN first:
    // it is the last caption before Part II, so anything in its window is the EIN). The window is
    // cut at the other caption so a probe can never claim digits that sit under the other one,
    // and digit-confusion fixups apply only INSIDE the window - never to the captions themselves.
    // Pipes are box edges first, digit 1s second (two-pass).
    // Captions are matched at LINE START and EVERY occurrence is probed: Part I's instruction
    // paragraph ("...generally your social security number (SSN)... your employer identification
    // number (EIN)...") repeats both phrases MID-LINE and ahead of the real box captions, so a
    // first-match-only unanchored probe windowed onto prose and read nothing. Line-anchoring also
    // keeps this off the fillable/tooltip path, whose af.text is one newline-free joined string
    // (there the 120-char window could otherwise reach past a caption-ish label to a ZIP+4).
    function run9(w) { var r = w.match(/(?<!\d)\d(?:[\s|.,_\/\\-]{0,3}\d){8}(?!\d)/); return r ? r[0].replace(/\D/g, '') : ''; }
    // An EMPTY comb box is not a TIN: its edges OCR to artifact runs (`| | | |`, `I l I l`) that the
    // fixups would happily turn into 111111111. So require a real digit in the RAW window before
    // trusting substitutions, and never accept an all-one-digit result.
    function boxed(capRe, kind) {
      var re = new RegExp(capRe.source, capRe.flags.indexOf('g') >= 0 ? capRe.flags : capRe.flags + 'g');
      var m;
      while ((m = re.exec(s)) !== null) {
        var rawWin = s.slice(m.index + m[0].length, m.index + m[0].length + 120)
          .split(/social security|employer identification/i)[0];
        if (!/\d/.test(rawWin)) continue;
        var win = rawWin
          .replace(/[OoQ]/g, '0').replace(/[lI]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
        var d = run9(win) || run9(win.replace(/\|/g, '1'));
        if (d.length === 9 && !/^(\d)\1{8}$/.test(d)) {
          return { tin: kind === 'ssn' ? d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5) : d.slice(0, 2) + '-' + d.slice(2), kind: kind };
        }
      }
      return null;
    }
    var r = boxed(/^\s*employer identification number/im, 'ein') || boxed(/^\s*social security number/im, 'ssn');
    if (r) return r;
    var m = s.match(/(?:EIN|employer identification|TIN|tax\s*id)\D{0,12}(\d[\d\s-]{7,}\d)/i);
    if (m) { var d = m[1].replace(/\D/g, ''); if (d.length === 9) return { tin: d.slice(0, 2) + '-' + d.slice(2), kind: 'ein' }; }
    return { tin: '', kind: '' };
  }
  function extractW9(af) {
    var out = { name: '', dba: '', entity: '', street: '', city: '', state: '', zip: '', tin: '', tinKind: '' };
    function byTip(reArr) {
      for (var i = 0; i < reArr.length; i++) {
        var h = af.byTip.filter(function (t) { return reArr[i].test(t.tip) && t.value; });
        if (h.length) return h[0].value;
      }
      return '';
    }
    out.name = byTip([/name.*(income tax|shown on|line 1)/i, /^name\b/i]);
    out.dba = byTip([/business name|disregarded entity|line 2|doing business/i]);
    out.street = byTip([/address.*(number|street|apt|suite)/i, /^address\b/i]);
    var csz = byTip([/city.*state.*zip/i]);
    if (csz) {
      var mz = csz.match(/(.+?),?\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
      if (mz) { out.city = mz[1].replace(/,\s*$/, '').trim(); out.state = mz[2].toUpperCase(); out.zip = mz[3]; }
      else out.city = csz;
    }
    // Classification: a checked box has a set value (not "Off"); read its tooltip/value.
    var cls = af.byTip.filter(function (t) {
      return t.value && !/^off$/i.test(t.value) && /tax classification|c corp|s corp|partnership|sole propriet|single.member|trust|estate|limited liability|individual/i.test(t.tip);
    });
    if (cls.length) out.entity = classToEntity(cls[0].tip) || classToEntity(cls[0].value);
    var tt = findTIN(af.text); out.tin = tt.tin; out.tinKind = tt.kind;
    return out;
  }

  // ---- Fillable IRS W-9: map by FIELD NAME --------------------------------
  // The real IRS fillable W-9 has no /TU tooltips, UTF-16BE field names, and its values live in
  // compressed object streams (so inflateAll must run first). We decode each field's /T name and
  // read its scoped /V. The name-to-meaning map is the IRS convention verified against a real
  // 2024 W-9 (see extractW9Fillable). Numbering is revision-specific, so we normalize leading
  // zeros (2018 "f1_01" -> "f1_1") and validate lengths before trusting a TIN.
  function decodeName(bytes) {
    // bytes: a latin1 string (PDF escapes already resolved). UTF-16BE if it starts with a BE BOM.
    if (bytes.charCodeAt(0) === 0xFE && bytes.charCodeAt(1) === 0xFF) {
      var out = '';
      for (var i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
      return out;
    }
    return bytes;
  }
  function fieldOccurrences(s) {
    // Every /T name occurrence (literal (..) or hex <..>) with its byte span, in document order.
    var occ = [], re = /\/T\s*(?:\(((?:\\.|[^)\\])*)\)|<([0-9A-Fa-f\s]+)>)/g, m;
    while ((m = re.exec(s))) {
      var bytes;
      if (m[1] !== undefined) bytes = unesc(m[1]);
      else { var hx = m[2].replace(/\s+/g, ''), b = ''; for (var i = 0; i + 1 < hx.length; i += 2) b += String.fromCharCode(parseInt(hx.substr(i, 2), 16)); bytes = b; }
      occ.push({ name: decodeName(bytes), start: m.index, end: re.lastIndex });
    }
    return occ;
  }
  function normKey(name) {
    var m = /^f1_0*(\d+)\b/.exec(name);   // f1_01[0] / f1_1[0] -> f1_1 (revision-proof)
    return m ? 'f1_' + m[1] : name;
  }
  function fillableFields(s) {
    var occ = fieldOccurrences(s), text = {};
    for (var i = 0; i < occ.length; i++) {
      // Scope /V to THIS field's own dict: stop at the next /T (and cap the window) so a value
      // never bleeds in from a neighboring field.
      var next = (i + 1 < occ.length) ? occ[i + 1].start : s.length;
      var region = s.slice(occ[i].end, Math.min(next, occ[i].end + 600));
      var vm = region.match(/\/V\s*\(((?:\\.|[^)\\])*)\)/);
      var val = vm ? unesc(vm[1]).trim() : '';
      if (!val) continue;
      var k = normKey(occ[i].name);
      if (!(k in text)) text[k] = val;   // first non-empty copy wins (fields recur across revisions)
    }
    // Federal tax classification is a RADIO group (c1_1[0..6]); its selection is a NAME object
    // (/V /2), which the string-only /V regex above can't see. Read it from the c1_1 span only:
    // prefer the group value /V, fall back to the selected widget's /AS.
    var radioN = '', c = occ.filter(function (o) { return /^c1_1\[/.test(o.name); });
    if (c.length) {
      var span = s.slice(c[0].start, Math.min(c[c.length - 1].end + 300, s.length));
      var gv = span.match(/\/V\s*\/([1-9])\b/), as = span.match(/\/AS\s*\/([1-9])\b/);
      radioN = gv ? gv[1] : (as ? as[1] : '');
    }
    return { text: text, radioN: radioN, names: occ.map(function (o) { return o.name; }) };
  }
  // The IRS fillable W-9 uses c1_1[..] (classification radio) + f1_1[..] (name). That name
  // signature is what tells us it is a W-9 even though there are no tooltips.
  function looksLikeW9Fields(names) {
    var hasRadio = names.some(function (n) { return /^c1_1\[/.test(n); });
    var hasName = names.some(function (n) { return /^f1_0*1\[/.test(n); });
    return hasRadio && hasName;
  }
  // Radio export value N -> classification (2024 W-9 box order, verified against a real form):
  // 1 Individual/sole-prop, 2 C corp, 3 S corp, 4 Partnership, 5 Trust/estate, 6 LLC, 7 Other.
  var W9_CLASS = { '1': 'individual', '2': 'c corp', '3': 's corp', '4': 'partnership', '5': 'trust estate', '6': 'llc', '7': 'other' };
  function extractW9Fillable(ff) {
    // IRS 2024 W-9 field map (verified): f1_1 Name (line 1), f1_2 Business name/DBA (line 2),
    // f1_3 LLC tax-classification letter, f1_7 Address, f1_8 City/State/ZIP, f1_11+f1_12+f1_13 SSN,
    // f1_14+f1_15 EIN. TIN parts are concatenated and length-checked so a shifted revision degrades
    // to empty (manual) rather than a wrong number.
    var out = { name: '', dba: '', entity: '', street: '', city: '', state: '', zip: '', tin: '', tinKind: '' };
    var t = ff.text;
    out.name = t.f1_1 || '';
    out.dba = t.f1_2 || '';
    out.street = t.f1_7 || '';
    var csz = t.f1_8 || '';
    if (csz) {
      var mz = csz.match(/(.+?),?\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
      if (mz) { out.city = mz[1].replace(/,\s*$/, '').trim(); out.state = mz[2].toUpperCase(); out.zip = mz[3]; }
      else out.city = csz;
    }
    var e1 = (t.f1_14 || '').replace(/\D/g, ''), e2 = (t.f1_15 || '').replace(/\D/g, '');
    var s1 = (t.f1_11 || '').replace(/\D/g, ''), s2 = (t.f1_12 || '').replace(/\D/g, ''), s3 = (t.f1_13 || '').replace(/\D/g, '');
    if (e1.length === 2 && e2.length === 7) { out.tin = e1 + '-' + e2; out.tinKind = 'ein'; }
    else if (s1.length === 3 && s2.length === 2 && s3.length === 4) { out.tin = s1 + '-' + s2 + '-' + s3; out.tinKind = 'ssn'; }
    else {
      var eA = e1 + e2, sA = s1 + s2 + s3;   // last resort: 9 digits total, split by kind
      if (eA.length === 9) { out.tin = eA.slice(0, 2) + '-' + eA.slice(2); out.tinKind = 'ein'; }
      else if (sA.length === 9) { out.tin = sA.slice(0, 3) + '-' + sA.slice(3, 5) + '-' + sA.slice(5); out.tinKind = 'ssn'; }
    }
    if (ff.radioN) {
      var desc = W9_CLASS[ff.radioN] || '';
      if (ff.radioN === '6') { var letter = (t.f1_3 || '').trim(); if (letter) desc = 'llc ' + letter; }   // LLC taxed as C/S/P
      out.entity = classToEntity(desc);
    }
    return out;
  }
  function mergeW9(a, b) {   // fill only the fields a is missing, from b (tooltip fallback)
    ['name', 'dba', 'entity', 'street', 'city', 'state', 'zip', 'tin', 'tinKind'].forEach(function (k) { if (!a[k] && b[k]) a[k] = b[k]; });
    return a;
  }

  async function readDoc(file) {
    var u8 = new Uint8Array(await file.arrayBuffer());
    var raw = latin1(u8);
    var prospect = fieldsFromStr(raw);
    var af = acroFieldsFromStr(raw);            // tooltip path (fallback)
    var ff = fillableFields(raw);               // field-name path (IRS W-9)
    // Only inflate if this is actually a fillable form (has an AcroForm). A scanned/image PDF has
    // none, so we skip inflating its (large) image streams and fall straight to 'scan' -> OCR.
    // The real IRS W-9 keeps its field values in compressed object streams, so we inflate unless
    // we've already recognised the doc from the raw bytes.
    var hasForm = /\/AcroForm|\/FT\s*\/(?:Tx|Btn|Ch)|\/TU\s*\(/.test(raw);
    if (hasForm && !prospect.company_name && !looksLikeW9(af) && !looksLikeW9Fields(ff.names)) {
      var infl = await inflateAll(u8);
      if (infl) {
        var r2 = latin1(infl);
        Object.assign(prospect, fieldsFromStr(r2));
        var af2 = acroFieldsFromStr(r2); af.byTip = af.byTip.concat(af2.byTip); af.text += af2.text;
        ff = fillableFields(raw + '\n' + r2);
      }
    }
    var isW9 = looksLikeW9Fields(ff.names) || looksLikeW9(af);
    var w9 = extractW9Fillable(ff);             // field-name first
    if (isW9) w9 = mergeW9(w9, extractW9(af));  // then backfill any gaps from tooltips
    var kind = isW9 ? 'w9'
      : (prospect.company_name || prospect.email || prospect.contact_names) ? 'prospect'
        : (af.byTip.length ? 'unknown' : 'scan');
    return { kind: kind, prospect: prospect, w9: w9 };
  }

  // ---- Scanned-W-9 OCR (on-device, zero-egress) ---------------------------
  // pdf.js rasterizes each page to a canvas; Tesseract (WASM in a Web Worker) OCRs it. The
  // image + TIN never leave the browser - only the engine assets were fetched once at install
  // via @require/@resource. The traineddata is served to the worker from a local @resource blob
  // through a fetch-shim (langPath can't be a blob directly - naptha/tesseract.js#965).
  // HEAVY libs load lazily: the worker + WASM only spin up the first time a scan is dropped.
  var _tessWorker = null;
  function wasmSimdOk() {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
  }
  async function ocrWorker(onProgress) {
    if (_tessWorker) return _tessWorker;
    if (typeof Tesseract === 'undefined') throw new Error('OCR engine not loaded - reinstall this script from its URL so @require/@resource fetch the engine.');
    // GM_getResourceURL returns a data:/blob: URL, which doesn't end in "js" - tesseract's getCore
    // then treats corePath as a DIRECTORY and appends /tesseract-core-*.wasm.js onto the data URL
    // (NetworkError). A fragment ending in .js forces its load-as-file branch; fetch ignores fragments.
    var coreURL = GM_getResourceURL(wasmSimdOk() ? 'tessCore' : 'tessCoreFb') + '#tesseract-core.wasm.js';
    var trainedURL = GM_getResourceURL('tessLangEng');   // .gz bytes, local blob (same-origin)
    var realWorker = GM_getResourceURL('tessWorker');
    // Wrapper worker: intercept any *.traineddata* fetch and serve the local blob instead.
    var shim = 'var T=' + JSON.stringify(trainedURL) + ';var _f=self.fetch.bind(self);' +
      'self.fetch=function(u,o){return String(u).indexOf(".traineddata")>=0?_f(T,o):_f(u,o);};' +
      'importScripts(' + JSON.stringify(realWorker) + ');';
    var workerURL = URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
    _tessWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: workerURL, corePath: coreURL, langPath: 'https://local/', gzip: true,
      logger: onProgress ? function (m) { try { if (m && m.status === 'recognizing text') onProgress(m.progress); } catch (e) { } } : undefined
    });
    return _tessWorker;
  }
  async function rasterizePages(file, maxPages) {
    var buf = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = GM_getResourceURL('pdfWorker');
    var task = pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true });
    var pdf = await task.promise, canvases = [];
    try {
      var pages = Math.min(pdf.numPages, maxPages || 2);   // a W-9 is 1 page; cap for safety
      for (var n = 1; n <= pages; n++) {
        var page = await pdf.getPage(n);
        var base = page.getViewport({ scale: 1 });
        var scale = Math.min(300 / 72, 4000 / Math.max(base.width, base.height));   // ~300 DPI, capped so canvas stays sane
        var vp = page.getViewport({ scale: scale });
        var cv = document.createElement('canvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        var ctx = cv.getContext('2d', { willReadFrequently: true, alpha: false });
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
        var img = ctx.getImageData(0, 0, cv.width, cv.height), d = img.data;   // grayscale helps OCR
        for (var i = 0; i < d.length; i += 4) { var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = d[i + 1] = d[i + 2] = g; }
        ctx.putImageData(img, 0, 0);
        canvases.push(cv);
        page.cleanup();
      }
    } finally { try { await task.destroy(); } catch (e) { } }
    return canvases;
  }
  async function ocrPdf(file, onProgress) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF engine not loaded - reinstall this script from its URL.');
    var canvases = await rasterizePages(file, 2);
    var worker = await ocrWorker(onProgress);
    var text = '';
    for (var i = 0; i < canvases.length; i++) {
      var r = await worker.recognize(canvases[i]);
      text += '\n' + ((r && r.data && r.data.text) || '');
      canvases[i].width = canvases[i].height = 0;   // release the backing store
    }
    return text;
  }
  // Pull W-9 fields from OCR (or any) free text. Best-effort + label-anchored; digit-confusion
  // fixups happen inside findTIN's caption windows. Everything is a SUGGESTION.
  function extractW9FromText(text) {
    var raw = String(text || '').replace(/\r/g, '');
    var out = { name: '', dba: '', entity: '', street: '', city: '', state: '', zip: '', tin: '', tinKind: '' };
    // On a scanned W-9 the value is on the line(s) AFTER the label, so skip past the label's
    // own line, then return the first substantive line that isn't itself label boilerplate.
    // The noise list covers BOTH the Oct-2018 and Mar-2024 revisions - 2024 moved a wrapping
    // "(For a sole proprietor or disregarded entity, ... name on line 2.)" instruction into the
    // line-1 label, and its fragments land on their own OCR lines wherever the wrap falls.
    // ^\d+[ab]?$ also swallows the bare "3a"/"3b" item numbers 2024 introduced.
    var LABEL_NOISE = /required on this line|as shown on|do not leave|this line blank|if different|disregarded entity|name on line \d|owner'?s name|entry is required|sole propriet|check (the )?appropriate|number, street|apt\.?\s*or suite|see instructions|^\d+[ab]?$/i;
    function seg(startRe, stopRe) {
      var m = startRe.exec(raw); if (!m) return '';
      var rest = raw.slice(m.index + m[0].length);
      var nl = rest.indexOf('\n');
      var after = nl >= 0 ? rest.slice(nl + 1) : '';
      var stop = stopRe ? after.search(stopRe) : -1;
      var chunk = (stop >= 0 ? after.slice(0, stop) : after);
      // Tesseract puts blank lines between a label block and its typed value, so stopping at a
      // paragraph break loses the value - instead cap the scan at 4 candidate lines.
      var lines = chunk.split(/\n/).map(function (l) { return l.replace(/^[\s:.\-]+/, '').trim(); }).filter(Boolean).slice(0, 4);
      for (var i = 0; i < lines.length; i++) { if (!LABEL_NOISE.test(lines[i])) return lines[i]; }
      return '';
    }
    var NEXT = /business name|federal tax|check (the )?appropriate|exempt|address|city,|requester|part i|taxpayer identification|social security|employer identification/i;
    out.name = seg(/name\s*\(as shown[^)]*\)|^\s*1\s+name\b|name of entity\/individual/im, NEXT);
    // Anchor DBA to the real line-2 label: the 2024 line-1 instruction also contains
    // "business/disregarded entity's name", and a loose match latched onto it.
    out.dba = seg(/^\s*2\s*business name[^\n]*|business name\s*\/\s*disregarded[^\n]*|^\s*2\s*disregarded entity[^\n]*/im, /federal tax|check (the )?appropriate|exempt|address|city,/i);
    out.street = seg(/address\s*\(number[^)]*\)|^\s*5\s+address\b/im, /city,|requester|part/i);
    var csz = seg(/city,\s*state,?\s*and\s*zip[^\n]*|^\s*6\s+city\b/im, /requester|part/i);
    if (csz) { var mz = csz.match(/(.+?),?\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)/); if (mz) { out.city = mz[1].replace(/,\s*$/, '').trim(); out.state = mz[2].toUpperCase(); out.zip = mz[3]; } else out.city = csz; }
    var mk = raw.match(/(?:\[x\]|\bx\b\s*|☒|■|✔|✓)\s*(individual|sole propriet|c corporation|s corporation|partnership|trust|estate|limited liability|llc)/i);
    if (mk) out.entity = classToEntity(mk[1]);
    var tt = findTIN(raw); out.tin = tt.tin; out.tinKind = tt.kind;
    return out;
  }

  // ---- Field mapping ------------------------------------------------------
  function firstEmail(s) { var m = String(s || '').match(/[^\s,;<>]+@[^\s,;<>]+\.[A-Za-z]{2,}/); return m ? m[0] : ''; }
  function firstName(s) { return String(s || '').split(/[,;\/]|\band\b/i)[0].trim(); }
  function firstTrade(s) { return String(s || '').split(/[,;\/]/)[0].trim(); }
  function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }
  function splitAddr(a) {
    a = String(a || '').trim();
    var out = { street: '', city: '', state: '', zip: '' };
    if (!a) return out;
    var parts = a.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    var last = parts[parts.length - 1] || '';
    var mz = last.match(/\b([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b/);
    if (mz) { out.state = mz[1].toUpperCase(); out.zip = mz[2]; }
    if (parts.length >= 3) { out.street = parts[0]; out.city = parts[1]; }
    else if (parts.length === 2) { out.street = parts[0]; out.city = parts[1].replace(/\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\s*$/, '').trim(); }
    else { out.street = parts[0] || ''; }
    return out;
  }

  // ---- Form fill helpers (validated live 2026-07-14) ----------------------
  function setNativeValue(el, val) {
    var proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function modalRoot() {
    var c = document.querySelector('input[name="details.companyName"]');
    return c ? (c.closest('.MuiDialog-container, [role="dialog"], .MuiPaper-root') || document) : null;
  }
  function fieldByLabel(root, re) {
    var lbls = [...root.querySelectorAll('label')];
    var lbl = lbls.find(function (l) { return re.test((l.textContent || '').trim()); });
    if (!lbl) return null;
    var fc = lbl.closest('.MuiFormControl-root') || lbl.parentElement;
    return fc ? fc.querySelector('input,select,textarea') : null;
  }
  function setSelectByText(sel, txt) {
    var t = String(txt || '').toLowerCase();
    if (!t) return false;
    var opt = [...sel.options].find(function (o) {
      var ov = (o.value || '').toLowerCase(), ot = (o.textContent || '').trim().toLowerCase();
      return ov === t || ot === t || ot.indexOf(t) === 0;
    });
    if (opt) { setNativeValue(sel, opt.value); return true; }
    return false;
  }
  // ---- Custom-autocomplete selection (Trade(s)) ---------------------------
  // Umbrava's Trade(s) is a custom autocomplete (an <input aria-autocomplete="list">, options as
  // [role="option"] in a portal listbox, MULTI-select + grouped). Pre-typing sets the text but does
  // NOT select - you must CLICK an option. This is the same engine used in BWN WO Intake.
  function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Best option for a target string: exact, then starts-with, then contains (case-insensitive).
  // Contains handles the grouped Trade text (option label = group + subtrade, e.g. "LightingExterior Lighting").
  function bestOption(opts, target) {
    var t = normText(target).toLowerCase(); if (!t) return null;
    var txt = opts.map(function (o) { return normText(o.textContent).toLowerCase(); });
    var i;
    for (i = 0; i < opts.length; i++) if (txt[i] === t) return opts[i];
    for (i = 0; i < opts.length; i++) if (txt[i].indexOf(t) === 0) return opts[i];
    for (i = 0; i < opts.length; i++) if (txt[i].indexOf(t) >= 0) return opts[i];
    return null;
  }
  // Type into an autocomplete WITHOUT blurring - a blur closes the option list before we can click.
  function acType(el, val) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }
  // Open, filter by searchTerm, then POLL until the MATCHING option renders and click it. Umbrava's
  // option lists can be network-fetched (>1s) and a stray/transient option may flash first, so we
  // must wait for a real match rather than resolve on the first option that appears. Returns
  // 'selected' | 'typed' | 'disabled' | 'skip'.
  function selectAC(el, searchTerm, matchTarget) {
    return new Promise(function (resolve) {
      if (!el) return resolve('skip');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return resolve('disabled');
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      if (searchTerm) acType(el, searchTerm);
      var target = matchTarget || searchTerm, t0 = Date.now();
      (function poll() {
        var pick = bestOption([].slice.call(document.querySelectorAll('[role="option"]')), target);
        if (pick) {
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { pick.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
          return resolve('selected');
        }
        if (Date.now() - t0 > 2500) return resolve(searchTerm ? 'typed' : 'skip');
        setTimeout(poll, 70);
      })();
    });
  }
  // Type is a MUI multi-select. Open on MOUSEDOWN (a plain .click() never opens the menu), click the
  // option, close with Escape, then VERIFY the hidden value actually took and RETRY up to 3x. A real
  // Create Vendor modal renders slower than a test one, so a single open can miss - the menu may not
  // be mounted yet, or the Trade listbox portal can collide with it and eat the click. Waits for the
  // menu to UNMOUNT before returning so the caller can open the Trade list without a collision.
  // Never clicks the backdrop (that can close the whole dialog). Returns Promise<bool> = committed.
  function setType(label) {
    var want = new RegExp('^\\s*' + label + '\\s*$', 'i');
    function hidden() { return document.querySelector('input[name="details.vendorTypes"]'); }
    function committed() { var h = hidden(); return !!(h && new RegExp(label, 'i').test(h.value || '')); }
    return (async function () {
      for (var attempt = 0; attempt < 3; attempt++) {
        if (committed()) return true;
        var trig = document.getElementById('mui-component-select-details.vendorTypes'), w = 0;
        while (!trig && w++ < 20) { await delay(60); trig = document.getElementById('mui-component-select-details.vendorTypes'); }
        if (!trig) return false;
        try {
          trig.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          var opt = null, n = 0;
          while (n++ < 20 && !opt) {
            var menu = document.querySelector('ul[role="listbox"], .MuiMenu-list');
            opt = menu ? [].slice.call(menu.querySelectorAll('[role="option"],li,.MuiMenuItem-root')).find(function (o) { return want.test((o.textContent || '').trim()); }) : null;
            if (!opt) await delay(70);
          }
          if (opt) {
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
            await delay(120);
            (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            var u = 0; while (document.querySelector('ul[role="listbox"], .MuiMenu-list') && u++ < 15) await delay(60);
          }
        } catch (e) { /* retry */ }
        await delay(120);
        if (committed()) return true;
      }
      return committed();
    })();
  }
  // Trade(s) is a custom autocomplete with a nested taxonomy. Actually SELECT it by clicking the
  // matching option (typing alone never registers the pick). Returns 'selected'|'typed'|'disabled'|'skip'.
  function selectTrade(root, trade) {
    if (!trade) return Promise.resolve('skip');
    var input = fieldByLabel(root, /^Trade\(s\)/) || (root.querySelector('.MuiAutocomplete-root input'));
    return selectAC(input, trade, trade);
  }

  function fillStep1(root, f) {
    var done = [];
    var q = function (n) { return root.querySelector('input[name="' + n + '"]'); };
    var set = function (n, v, lbl) { var el = q(n); if (el && v) { setNativeValue(el, v); done.push(lbl); } };
    set('details.companyName', f.company_name, 'Company');
    set('details.contactName', firstName(f.contact_names), 'Name');
    set('details.contactEmail', firstEmail(f.email), 'Email');
    var tel = root.querySelector('input[type="tel"]');
    if (tel && f.phone) { setNativeValue(tel, digits(f.phone)); done.push('Phone'); }
    return done;   // Type is set (and awaited) by the caller, so a slow/failed Type can't stop it
  }

  // Step 2 (Address) renders after Next. Watch for its fields, then fill ONCE they appear.
  function watchStep2(addr) {
    if (!addr.street && !addr.city && !addr.zip) return;
    var filled = false;
    var obs = new MutationObserver(function () {
      if (filled) return;
      var root = document.querySelector('.MuiDialog-container, [role="dialog"]');
      if (!root || !fieldByLabel(root, /^Street/)) return;
      filled = true; obs.disconnect();
      fillAddress(addr);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { obs.disconnect(); }, 300000);
  }
  // Fill the step-2 address. Wait for the step to finish mounting FIRST: React re-renders the
  // freshly-mounted controlled inputs right after they appear and would clobber an instant fill
  // (this was the #1 reason the address looked "not filled" even though the fields exist). Then
  // fill, and re-check + re-fill once in case React still reset a value.
  async function fillAddress(addr) {
    await delay(350);
    var root = document.querySelector('.MuiDialog-container, [role="dialog"]');
    if (!root) return;
    var setL = function (re, v) { var el = fieldByLabel(root, re); if (el && v) { if (el.tagName === 'SELECT') setSelectByText(el, v); else setNativeValue(el, v); } };
    setL(/^Street/, addr.street);
    setL(/^City/, addr.city);
    setL(/^Postal Code|^Zip/, addr.zip);
    // State/Province is a custom autocomplete whose options are the 2-letter code (typing "PA"
    // -> option "PA"; a full name matches nothing) - so CLICK the option, not just type. Both the
    // W-9 and prospect extractors already give a 2-letter code. Handle a native <select> too.
    var st = fieldByLabel(root, /^State\/Province|^State/);
    if (st && addr.state) {
      if (st.tagName === 'SELECT') setSelectByText(st, addr.state);
      else if (st.getAttribute('aria-autocomplete') === 'list') await selectAC(st, addr.state, addr.state);
      else setNativeValue(st, addr.state);
    }
    var nm = fieldByLabel(root, /^Name/); if (nm && !nm.value) setNativeValue(nm, 'Business');
    // Verify the text fields stuck; a too-early fill can be reset by React - re-fill once if so.
    await delay(200);
    var chk = fieldByLabel(root, /^Street/);
    if (chk && addr.street && chk.value !== addr.street) { setL(/^Street/, addr.street); setL(/^City/, addr.city); setL(/^Postal Code|^Zip/, addr.zip); }
    toast('Filled the address on step 2 (State selected). Set Country, then Validate.', 9000);
  }

  // Umbrava shows its own "Vendor may already exist" banner; surface it so a dup
  // isn't created by accident.
  function surfaceDup(root) {
    setTimeout(function () {
      var hit = [...root.querySelectorAll('*')].find(function (e) { return /may already exist/i.test(e.textContent || '') && e.children.length < 6; });
      if (hit) toast('Umbrava flags a possible existing vendor - check the banner before saving.', 10000);
    }, 400);
  }

  // Watch for the Create-flow Billing step (step 3) and fill its Tax ID once. Separate from
  // watchStep2 (address). The TIN is filled straight in and never logged/toasted as a value.
  function watchBillingStep(tin) {
    if (!tin) return;
    var filled = false;
    var obs = new MutationObserver(function () {
      if (filled) return;
      var el = document.querySelector('input[name="billing.taxId"]');
      if (!el) return;
      filled = true; obs.disconnect();
      setNativeValue(el, tin);
      toast('Filled the Tax ID on the Billing step (kept local - not sent anywhere).', 8000);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { obs.disconnect(); }, 300000);
  }

  async function fillFromProspect(root, f) {
    var addr = splitAddr(f.mailing_addr);
    var done = fillStep1(root, f);          // text fields only (Type is awaited below)
    // Arm the step-2 watcher and dup-check BEFORE the fragile dropdowns, so a Type/Trade hiccup can
    // never stop the address from filling when the user reaches step 2.
    watchStep2(addr);
    surfaceDup(root);
    // Type first, fully awaited (its menu portal is closed before we open the Trade list, so the two
    // portaled option lists cannot collide). Then Trade, guarded so a failure can't abort anything.
    var typeOk = false;
    try { typeOk = await setType('Contractor'); } catch (e) { }
    var trade = firstTrade(f.trades);
    var tradeRes = 'skip';
    if (trade) { try { tradeRes = await selectTrade(root, trade); } catch (e) { tradeRes = 'typed'; } }
    var notes = [];
    if (done.length) notes.push('Filled ' + done.join(', '));
    notes.push(typeOk ? 'Type=Contractor' : 'set Type yourself');
    if (tradeRes === 'selected') notes.push('selected Trade(s) "' + trade + '"');
    else if (tradeRes === 'typed') notes.push('typed Trade(s) "' + trade + '" - pick it from the list');
    else if (trade) notes.push('set Trade(s) "' + trade + '" yourself');
    notes.push('set Entity yourself (C vs S corp)');
    if (addr.street) notes.push('address fills on step 2');
    toast(notes.join(' · '), 12000);
  }

  function fillFromW9(root, w9) {
    var done = [];
    var q = function (n) { return root.querySelector('input[name="' + n + '"]'); };
    if (w9.name) { var c = q('details.companyName'); if (c) { setNativeValue(c, w9.name); done.push('Company'); } }
    if (w9.dba) { var d = q('details.doingBusinessAs'); if (d) { setNativeValue(d, w9.dba); done.push('DBA'); } }
    if (w9.entity) { var e = root.querySelector('select[name="details.entity"]'); if (e) { setNativeValue(e, w9.entity); done.push('Entity'); } }
    surfaceDup(root);
    if (w9.street || w9.city || w9.zip) watchStep2({ street: w9.street, city: w9.city, state: w9.state, zip: w9.zip });
    if (w9.tin) watchBillingStep(w9.tin);   // Billing step, step 3
    var notes = ['From W-9:'];
    if (done.length) notes.push('filled ' + done.join(', '));
    if (w9.street) notes.push('address on step 2');
    if (w9.tin) notes.push('Tax ID on the Billing step (kept local)');  // never the value
    if (!w9.entity) notes.push('confirm Entity');
    notes.push('review before Create');
    toast(notes.join(' · '), 13000);
  }

  // Short list of the fields a parsed doc contributes - shown in the drop-zone's held-files list.
  function w9Fields(w9) {
    var f = [];
    if (w9.name) f.push('Company'); if (w9.dba) f.push('DBA'); if (w9.entity) f.push('Entity');
    if (w9.street || w9.city || w9.zip) f.push('Address'); if (w9.tin) f.push('Tax ID (local)');
    return f;
  }
  function prospectFields(p) {
    var f = [];
    if (p.company_name) f.push('Company'); if (firstName(p.contact_names)) f.push('Contact'); if (firstEmail(p.email)) f.push('Email');
    if (p.phone) f.push('Phone'); if (firstTrade(p.trades)) f.push('Trade'); if (p.mailing_addr) f.push('Address');
    return f;
  }

  // Read ONE dropped/picked file, fill the form, and RETURN a summary for the held-files list.
  async function handleFile(file) {
    try {
      var doc = await readDoc(file);
      var root = modalRoot();
      if (!root) { toast('Open the Create Vendor form first, then drop the document.', 8000); return { ok: false, msg: 'open Create Vendor first' }; }
      if (doc.kind === 'w9') { fillFromW9(root, doc.w9); return { ok: true, label: 'W-9', fields: w9Fields(doc.w9) }; }
      if (doc.kind === 'prospect') { fillFromProspect(root, doc.prospect); return { ok: true, label: 'Prospect Form', fields: prospectFields(doc.prospect) }; }
      if (doc.kind === 'scan') {
        toast('Scanned W-9 - running on-device OCR (~10-30s; the file stays in your browser)...', 45000);
        var text = await ocrPdf(file);
        var w9 = extractW9FromText(text);
        if (w9.name || w9.tin || w9.dba || w9.street) {
          fillFromW9(root, w9);
          toast('OCR done - REVIEW every field before saving, the Tax ID especially (OCR can misread digits).', 15000);
          return { ok: true, label: 'Scanned W-9 (OCR)', fields: w9Fields(w9) };
        }
        toast('OCR ran but could not confidently read the W-9 fields - enter them manually.', 12000);
        return { ok: false, msg: 'OCR could not read the fields' };
      }
      toast('Could not read fields from that PDF. Use the filled Prospect Set-Up Form, a fillable IRS W-9, or a scanned W-9.', 12000);
      return { ok: false, msg: 'unrecognized PDF' };
    } catch (e) { toast('Prefill failed: ' + ((e && e.message) || e), 10000); return { ok: false, msg: (e && e.message) || 'read failed' }; }
  }

  // Add a dropped/picked file to the drop-zone's held list, fill from it, then show what it gave.
  function addVIFile(file) {
    var list = document.getElementById('bwn-vi-files'); if (!list) return;
    var rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;align-items:baseline;gap:8px;padding:5px 6px;border-top:1px solid #eef2f0;font:400 12px ' + FONT + ';';
    var icon = document.createElement('span'); icon.textContent = '⏳';
    var nm = document.createElement('span'); nm.textContent = file.name; nm.title = file.name; nm.style.cssText = 'font-weight:600;color:#0d3d26;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var sum = document.createElement('span'); sum.textContent = 'reading...'; sum.style.cssText = 'color:#5a6b62;flex:1;';
    rowEl.appendChild(icon); rowEl.appendChild(nm); rowEl.appendChild(sum); list.appendChild(rowEl);
    Promise.resolve(handleFile(file)).then(function (res) {
      if (res && res.ok) {
        icon.textContent = '✓';
        sum.textContent = res.label + (res.fields && res.fields.length ? ' · ' + res.fields.join(', ') : ' · read');
        sum.style.color = '#166534';
      } else { icon.textContent = '⚠'; sum.textContent = (res && res.msg) || 'could not read fields'; sum.style.color = '#b45309'; }
    }).catch(function (e) { icon.textContent = '⚠'; sum.textContent = (e && e.message) || 'read failed'; sum.style.color = '#b45309'; });
  }

  // ---- Inject the button into the Create Vendor modal ---------------------
  // Drop zone at the top of the Create Vendor modal: drag or click to add one or more documents
  // (Prospect Form / fillable W-9 / scanned W-9). Each file fills the form and is HELD in a list
  // below the zone showing what it contributed, so several docs can prefill one vendor together.
  function injectButton() {
    var company = document.querySelector('input[name="details.companyName"]');
    if (!company) return;
    var modal = company.closest('.MuiPaper-root') || company.closest('.MuiDialog-container, [role="dialog"]');
    if (!modal || modal.querySelector('#bwn-vi-bar')) return;
    var wrap = document.createElement('div'); wrap.id = 'bwn-vi-bar';
    wrap.style.cssText = 'margin:0 0 12px;border:1px solid #cfe0d8;border-radius:10px;overflow:hidden;background:#fff;';
    var drop = document.createElement('div');
    drop.style.cssText = 'margin:8px;padding:14px 16px;border:2px dashed #1a5f3e;border-radius:8px;background:#f3f7f5;color:#0d3d26;text-align:center;cursor:pointer;line-height:1.5;transition:background .15s;';
    drop.innerHTML = '📄 <b style="font:600 14px ' + FONT + ';">Drop a Prospect Form or W-9 here to prefill</b>' +
      '<div style="font:400 12px ' + FONT + ';color:#5a6b62;margin-top:3px;">PDF - drag files or click. Read on your device; the Tax ID never leaves your browser.</div>';
    var file = document.createElement('input'); file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.multiple = true; file.style.display = 'none';
    var list = document.createElement('div'); list.id = 'bwn-vi-files'; list.style.cssText = 'padding:0 8px 6px;';
    drop.addEventListener('click', function (e) { if (e.target !== file) { file.value = ''; file.click(); } });
    file.addEventListener('change', function () { if (file.files) [].slice.call(file.files).forEach(addVIFile); });
    function stop(e) { e.preventDefault(); e.stopPropagation(); }
    drop.addEventListener('dragover', function (e) { stop(e); drop.style.background = '#e2efe9'; });
    drop.addEventListener('dragleave', function (e) { stop(e); drop.style.background = '#f3f7f5'; });
    drop.addEventListener('drop', function (e) {
      stop(e); drop.style.background = '#f3f7f5';
      var fs = e.dataTransfer && e.dataTransfer.files;
      if (fs && fs.length) [].slice.call(fs).forEach(addVIFile);
      else toast('No file came through - save the document as a PDF and drop that file (or click the box to pick it).', 10000);
    });
    wrap.appendChild(drop); wrap.appendChild(list); wrap.appendChild(file);
    // Top of the modal body, just above the first field row.
    var row = company.closest('.MuiGrid-container') || company.closest('form') || company.parentElement;
    if (row && row.parentElement) row.parentElement.insertBefore(wrap, row);
    else modal.insertBefore(wrap, modal.firstChild);
  }

  // For an EXISTING vendor: the detail-page "Edit Billing" dialog has input[name="taxId"]
  // (note: no "billing." prefix, unlike the create flow). Inject a button that reads a W-9
  // locally and fills just the Tax ID there. TIN stays local; never persisted or sent.
  function injectBillingButton() {
    var tax = document.querySelector('input[name="taxId"]');
    if (!tax) return;
    var modal = tax.closest('.MuiPaper-root') || tax.closest('.MuiDialog-container, [role="dialog"]');
    if (!modal || modal.querySelector('#bwn-vi-bill-bar')) return;
    var bar = document.createElement('div'); bar.id = 'bwn-vi-bill-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 0 10px;';
    var btn = document.createElement('button'); btn.type = 'button';
    btn.textContent = '📄 Fill Tax ID from W-9';
    btn.style.cssText = 'background:#1a5f3e;color:#fff;border:none;border-radius:8px;padding:6px 12px;font:500 13px ' + FONT + ';cursor:pointer;';
    var hint = document.createElement('span'); hint.textContent = 'reads the W-9 locally'; hint.style.cssText = 'font:400 12px ' + FONT + ';color:#5a6b62;';
    var file = document.createElement('input'); file.type = 'file'; file.accept = 'application/pdf,.pdf'; file.style.display = 'none';
    btn.addEventListener('click', function () { file.value = ''; file.click(); });
    file.addEventListener('change', function () {
      if (!file.files || !file.files[0]) return;
      var f = file.files[0];
      function fillTax(tin, note) { var el = document.querySelector('input[name="taxId"]'); if (el && tin) { setNativeValue(el, tin); toast('Filled Tax ID (' + note + ') - kept local. Verify before saving.', 9000); } else toast('No Tax ID found to fill.', 7000); }
      readDoc(f).then(function (doc) {
        if (doc.w9 && doc.w9.tin) return fillTax(doc.w9.tin, 'from W-9');
        if (doc.kind === 'scan') {
          toast('Scanned W-9 - running on-device OCR (~10-30s, stays local)...', 45000);
          return ocrPdf(f).then(function (text) { var w9 = extractW9FromText(text); if (w9.tin) fillTax(w9.tin, 'OCR - verify the digits'); else toast('OCR could not read a Tax ID - enter it manually.', 10000); });
        }
        toast('Could not read a Tax ID from that file. Use a fillable IRS W-9 or a scanned W-9.', 9000);
      }).catch(function (e) { toast('Read failed: ' + ((e && e.message) || e), 9000); });
    });
    bar.appendChild(btn); bar.appendChild(hint); bar.appendChild(file);
    var fc = tax.closest('.MuiFormControl-root, .MuiTextField-root') || tax.parentElement;
    if (fc && fc.parentElement) fc.parentElement.insertBefore(bar, fc);
    else modal.insertBefore(bar, modal.firstChild);
  }

  var obs = new MutationObserver(function () { injectButton(); injectBillingButton(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(function () { injectButton(); injectBillingButton(); }, 800);
  injectButton(); injectBillingButton();
})();
