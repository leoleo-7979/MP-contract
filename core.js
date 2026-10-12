/* 근로계약서 갱신 도구 - 핵심 로직 (브라우저와 Node 양쪽에서 동작) */
var HC = (function () {
  'use strict';

  // ------------------------------------------------------------ 바이트 도우미
  var u16 = function (b, o) { return b[o] | (b[o + 1] << 8); };
  var u32 = function (b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; };
  var NOSTREAM = 0xFFFFFFFF;

  // ------------------------------------------------------------ CFB(복합 문서) 읽기/같은 크기로 쓰기
  function openCFB(u8) {
    var sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    for (var i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error('HWP(복합 문서) 파일이 아닙니다');
    var secSize = 1 << u16(u8, 30), miniSize = 1 << u16(u8, 32);
    var dirStart = u32(u8, 48), cutoff = u32(u8, 56), miniFatStart = u32(u8, 60);
    var difatStart = u32(u8, 68), nDifat = u32(u8, 72);
    var secOff = function (sid) { return (sid + 1) * secSize; };

    var fatSecs = [];
    for (var k = 0; k < 109; k++) { var v = u32(u8, 76 + 4 * k); if (v < 0xFFFFFFFA) fatSecs.push(v); }
    var d = difatStart;
    for (var n = 0; n < nDifat && d < 0xFFFFFFFA; n++) {
      var off = secOff(d);
      for (var j = 0; j < secSize / 4 - 1; j++) { var w = u32(u8, off + 4 * j); if (w < 0xFFFFFFFA) fatSecs.push(w); }
      d = u32(u8, off + secSize - 4);
    }
    var per = secSize / 4;
    var fat = new Uint32Array(fatSecs.length * per);
    fatSecs.forEach(function (s, idx) {
      var o = secOff(s);
      for (var q = 0; q < per; q++) fat[idx * per + q] = u32(u8, o + 4 * q);
    });
    function chain(start) {
      var arr = [], s = start;
      while (s < 0xFFFFFFFA) {
        arr.push(s);
        if (arr.length > fat.length + 1) throw new Error('파일 구조가 손상되어 있습니다(순환)');
        s = fat[s];
      }
      return arr;
    }
    function concat(secs) {
      var out = new Uint8Array(secs.length * secSize);
      secs.forEach(function (s, i) { out.set(u8.subarray(secOff(s), secOff(s) + secSize), i * secSize); });
      return out;
    }
    var dirChain = chain(dirStart);
    var dirBytes = concat(dirChain);
    var entries = [];
    for (var e = 0; e + 128 <= dirBytes.length; e += 128) {
      var nameLen = u16(dirBytes, e + 64);
      var name = '';
      for (var c = 0; c + 2 <= Math.max(0, nameLen - 2); c += 2) name += String.fromCharCode(u16(dirBytes, e + c));
      entries.push({
        name: name, type: dirBytes[e + 66], left: u32(dirBytes, e + 68), right: u32(dirBytes, e + 72),
        child: u32(dirBytes, e + 76), start: u32(dirBytes, e + 116), size: u32(dirBytes, e + 120),
        fileOff: secOff(dirChain[Math.floor(e / secSize)]) + (e % secSize)
      });
    }
    var root = entries[0];
    var containerChain = null, miniFat = null;
    function ensureMini() {
      if (miniFat) return;
      containerChain = chain(root.start);
      var mf = chain(miniFatStart), arr = [];
      mf.forEach(function (s) { var o = secOff(s); for (var q = 0; q < per; q++) arr.push(u32(u8, o + 4 * q)); });
      miniFat = arr;
    }
    function find(path) {
      var node = root;
      for (var p = 0; p < path.length; p++) {
        var seen = {}, stack = [node.child], hit = null;
        while (stack.length) {
          var sid = stack.pop();
          if (sid === NOSTREAM || sid === undefined || seen[sid] || !entries[sid]) continue;
          seen[sid] = true;
          var en = entries[sid];
          if (en.name === path[p]) { hit = en; break; }
          stack.push(en.left, en.right);
        }
        if (!hit) return null;
        node = hit;
      }
      return node;
    }
    function segments(entry) {
      var segs = [], remain = entry.size;
      if (entry.size < cutoff) {
        ensureMini();
        var m = entry.start;
        while (m < 0xFFFFFFFA && remain > 0) {
          var bi = m * miniSize, si = Math.floor(bi / secSize), inS = bi % secSize;
          var len = Math.min(miniSize, remain);
          segs.push([secOff(containerChain[si]) + inS, len]);
          remain -= len;
          m = miniFat[m];
        }
      } else {
        chain(entry.start).forEach(function (s) {
          if (remain <= 0) return;
          var len = Math.min(secSize, remain);
          segs.push([secOff(s), len]);
          remain -= len;
        });
      }
      return segs;
    }
    return {
      has: function (path) { return !!find(path); },
      read: function (path) {
        var en = find(path);
        if (!en) throw new Error('스트림을 찾을 수 없습니다: ' + path.join('/'));
        var out = new Uint8Array(en.size), o = 0;
        segments(en).forEach(function (sg) { out.set(u8.subarray(sg[0], sg[0] + sg[1]), o); o += sg[1]; });
        return out;
      },
      writeSameSize: function (path, bytes) {
        var en = find(path);
        if (!en) throw new Error('스트림을 찾을 수 없습니다: ' + path.join('/'));
        if (bytes.length !== en.size) throw new Error('크기가 달라 쓸 수 없습니다: ' + path.join('/'));
        var o = 0;
        segments(en).forEach(function (sg) { u8.set(bytes.subarray(o, o + sg[1]), sg[0]); o += sg[1]; });
      },
      // 스트림이 차지한 섹터 수는 그대로 두고, 그 안에서 크기만 바꿔 쓴다 (섹터를 새로 배정하지 않음)
      capacity: function (path) {
        var en = find(path);
        if (!en || en.size < cutoff) return null;
        var n = chain(en.start).length;
        return { n: n, low: (n - 1) * secSize, cap: n * secSize };
      },
      resizeInSectors: function (path, bytes) {
        var en = find(path);
        if (!en || en.size < cutoff) throw new Error('크기를 바꿀 수 없는 스트림입니다');
        var secs = chain(en.start);
        if (Math.ceil(bytes.length / secSize) !== secs.length) throw new Error('섹터 수가 달라 쓸 수 없습니다');
        var o = 0;
        secs.forEach(function (s) {
          var len = Math.min(secSize, bytes.length - o);
          if (len > 0) u8.set(bytes.subarray(o, o + len), secOff(s));
          o += len;
        });
        var L = bytes.length;
        u8[en.fileOff + 120] = L & 255; u8[en.fileOff + 121] = (L >>> 8) & 255;
        u8[en.fileOff + 122] = (L >>> 16) & 255; u8[en.fileOff + 123] = (L >>> 24) & 255;
        u8[en.fileOff + 124] = 0; u8[en.fileOff + 125] = 0; u8[en.fileOff + 126] = 0; u8[en.fileOff + 127] = 0;
        en.size = L;
      }
    };
  }

  // ------------------------------------------------------------ HWP 본문 읽기
  function parseRecords(data) {
    var out = [], pos = 0;
    while (pos + 4 <= data.length) {
      var start = pos, h = u32(data, pos); pos += 4;
      var tag = h & 0x3FF, level = (h >>> 10) & 0x3FF, size = (h >>> 20) & 0xFFF;
      if (size === 0xFFF) { size = u32(data, pos); pos += 4; }
      out.push({ tag: tag, level: level, start: start, off: pos, size: size, end: pos + size });
      pos += size;
    }
    return out;
  }
  function recBytes(tag, level, payload) {
    var big = payload.length >= 0xFFF, hl = big ? 8 : 4;
    var out = new Uint8Array(hl + payload.length);
    var h = (tag | (level << 10) | ((big ? 0xFFF : payload.length) << 20)) >>> 0;
    out[0] = h & 255; out[1] = (h >>> 8) & 255; out[2] = (h >>> 16) & 255; out[3] = (h >>> 24) & 255;
    if (big) { var L = payload.length; out[4] = L & 255; out[5] = (L >>> 8) & 255; out[6] = (L >>> 16) & 255; out[7] = (L >>> 24) & 255; }
    out.set(payload, hl);
    return out;
  }
  var EXT = {};
  [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function (c) { EXT[c] = true; });
  function decodeParaText(p) {
    var out = '', i = 0;
    while (i + 2 <= p.length) {
      var ch = p[i] | (p[i + 1] << 8);
      if (EXT[ch]) { i += 16; continue; }
      if (ch === 9) out += '\t';
      else if (ch === 10 || ch === 13) out += '\n';
      else if (ch === 24) out += '-';
      else if (ch === 30 || ch === 31) out += ' ';
      else if (ch >= 32) out += String.fromCharCode(ch);
      i += 2;
    }
    return out;
  }
  function loadSection0(u8) {
    var cfb = openCFB(u8);
    var header = cfb.read(['FileHeader']);
    var compressed = (u32(header, 36) & 1) === 1;
    if (u32(header, 36) & 2) throw new Error('암호가 걸린 파일입니다');
    var raw = cfb.read(['BodyText', 'Section0']);
    var data = compressed ? pako.inflateRaw(raw) : raw;
    return { cfb: cfb, compressed: compressed, raw: raw, data: data };
  }
  function extractParagraphs(data) {
    var out = [];
    parseRecords(data).forEach(function (r) {
      if (r.tag === 67) out.push(decodeParaText(data.subarray(r.off, r.off + r.size)).replace(/\n+$/, ''));
    });
    return out;
  }

  // ------------------------------------------------------------ 날짜 도우미
  var DRE = '(\\d{4})\\s*년\\s*(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일';
  var P1 = new RegExp(DRE + '\\s*부터\\s*' + DRE + '\\s*까지');
  var P2 = new RegExp('(임금계약기간은\\s*)' + DRE + '(\\s*부터)');
  var PSOLO = new RegExp('^(\\s*)' + DRE + '(\\s*)$');
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  function iso(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  function toISO(a, b, c) { return iso(+a, +b, +c); }
  function parseISO(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
  function dim(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function addDays(s, k) { var p = parseISO(s); var t = new Date(Date.UTC(p.y, p.m - 1, p.d + k)); return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  function diffDays(a, b) { var x = parseISO(a), y = parseISO(b); return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400000); }
  function addMonths(s, n) {
    var p = parseISO(s), tot = p.y * 12 + (p.m - 1) + n, ny = Math.floor(tot / 12), nm = (tot % 12) + 1;
    return iso(ny, nm, Math.min(p.d, dim(ny, nm)));
  }
  function looseDate(s) {
    if (s === null || s === undefined) return null;
    var m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(s));
    return m ? toISO(m[1], m[2], m[3]) : null;
  }
  function newPeriod(oldStart, oldEnd, monthsOpt) {
    var n;
    if (monthsOpt === 'same' || monthsOpt === undefined) {
      n = Math.round((diffDays(oldStart, oldEnd) + 1) / 30.44);
      if (!(n >= 1 && n <= 12)) n = 3;
    } else n = Number(monthsOpt);
    var ns = addDays(oldEnd, 1);
    return { ns: ns, ne: addDays(addMonths(ns, n), -1), n: n };
  }
  function kr(s) { var p = parseISO(s); return { y: String(p.y), m: String(p.m), d: String(p.d) }; }

  // ------------------------------------------------------------ 글자 수를 같게 맞춰 날짜 바꾸기
  function fit(old, nums) {
    var i = 0;
    var nw = old.replace(/\d+/g, function () { return nums[i++]; });
    var delta = old.length - nw.length;
    if (delta === 0) return nw;
    var runs = [], re = / +/g, m;
    while ((m = re.exec(nw))) runs.push([m.index, m.index + m[0].length]);
    if (!runs.length) return null;
    if (delta > 0) { var a = runs[0][0], b = runs[0][1]; return nw.slice(0, a) + new Array(b - a + delta + 1).join(' ') + nw.slice(b); }
    var need = -delta, chars = nw.split('');
    runs.slice().sort(function (x, y) { return (x[0] - x[1]) - (y[0] - y[1]); }).forEach(function (r) {
      if (need <= 0) return;
      var can = (r[1] - r[0]) - 1, take = Math.min(can, need);
      for (var k = 0; k < take; k++) chars[r[1] - 1 - k] = null;
      need -= take;
    });
    if (need) return null;
    return chars.filter(function (c) { return c !== null; }).join('');
  }
  function rewriteText(text, ns, ne, sign, log) {
    var nsN = kr(ns), neN = kr(ne), sgN = kr(sign), m, seg, nw;
    if ((m = P1.exec(text))) {
      seg = m[0];
      nw = fit(seg, [nsN.y, nsN.m, nsN.d, neN.y, neN.m, neN.d]);
      if (nw === null) { log.push('제1조 날짜를 같은 글자 수로 맞추지 못함'); return null; }
      log.push('제1조');
      return text.slice(0, m.index) + nw + text.slice(m.index + seg.length);
    }
    if ((m = P2.exec(text))) {
      var s0 = m.index + m[1].length, e0 = m.index + m[0].length - m[5].length;
      seg = text.slice(s0, e0);
      nw = fit(seg, [nsN.y, nsN.m, nsN.d]);
      if (nw === null) { log.push('제2조 날짜를 같은 글자 수로 맞추지 못함'); return null; }
      log.push('제2조');
      return text.slice(0, s0) + nw + text.slice(e0);
    }
    var core = text.replace(/\r+$/, '');
    if ((m = PSOLO.exec(core))) {
      var a0 = m[1].length, b0 = core.length - m[5].length;
      seg = core.slice(a0, b0);
      nw = fit(seg, [sgN.y, sgN.m, sgN.d]);
      if (nw === null) { log.push('날짜 단독 문단을 같은 글자 수로 맞추지 못함'); return null; }
      log.push('체결일/약정서 날짜');
      return core.slice(0, a0) + nw + core.slice(b0) + text.slice(core.length);
    }
    return null;
  }

  // ------------------------------------------------------------ 압축 크기를 원본과 똑같이 맞추기
  function deflateExact(data, target) {
    var padBlock = [0, 0, 0, 0xff, 0xff];
    for (var level = 9; level >= 1; level--) {
      for (var split = 1; split < 400; split++) {
        var k = Math.floor(data.length * split / 400);
        var chunks = [];
        var d = new pako.Deflate({ raw: true, level: level });
        d.onData = function (c) { chunks.push(c); };
        d.push(data.subarray(0, k), 2);
        var headCount = chunks.length;
        d.push(data.subarray(k), true);
        if (d.err) continue;
        var lens = chunks.map(function (c) { return c.length; });
        var total = lens.reduce(function (a, b) { return a + b; }, 0);
        var diff = target - total;
        if (diff >= 0 && diff % 5 === 0) {
          var res = new Uint8Array(target), o = 0;
          chunks.forEach(function (c, idx) {
            if (idx === headCount) for (var q = 0; q < diff / 5; q++) for (var z = 0; z < 5; z++) res[o++] = padBlock[z];
            res.set(c, o); o += c.length;
          });
          if (headCount === chunks.length) for (var q2 = 0; q2 < diff / 5; q2++) for (var z2 = 0; z2 < 5; z2++) res[o++] = padBlock[z2];
          var back = pako.inflateRaw(res);
          if (back.length === data.length && back.every(function (v, i) { return v === data[i]; })) return res;
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------ 계약서 한 부에서 정보 읽기
  function worker(ps) {
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].trim() === '근로자' && i + 1 < ps.length && ps[i + 1].trim() === '성명') {
        var v = ps.slice(i + 2, i + 12).map(function (x) { return x.trim(); });
        if (v[1] === '생년월일' && v[3] === '주소' && /^개설은행/.test(v[5] || '') && /^개설계좌/.test(v[7] || ''))
          return { name: v[0], birth: v[2], addr: v[4], bank: v[6], acct: v[8] };
        return null;
      }
    }
    return null;
  }
  function readContractInfo(u8) {
    var info = { isEmployment: false, p1: null, p2: null, solo: [], name: null, worker: null, rrn: null, terms: [], error: null };
    try {
      var sec = loadSection0(u8);
      var ps = extractParagraphs(sec.data);
      var hasDays = ps.some(function (p) { return /근로일\s*:/.test(p); });
      ps.forEach(function (p) {
        var m;
        if (!info.p1 && (m = P1.exec(p))) info.p1 = [toISO(m[1], m[2], m[3]), toISO(m[4], m[5], m[6])];
        if (!info.p2 && (m = P2.exec(p))) info.p2 = toISO(m[2], m[3], m[4]);
        if ((m = PSOLO.exec(p.replace(/\r/g, '')))) info.solo.push(toISO(m[2], m[3], m[4]));
      });
      for (var i = 0; i < ps.length; i++) {
        if (ps[i].trim() === '성명' && i + 1 < ps.length) { info.name = ps[i + 1].trim(); break; }
      }
      info.worker = worker(ps);
      for (var q = 0; q < ps.length && !info.rrn; q++) { var rm = /(\d{6})\s*-\s*(\d{7})/.exec(ps[q]); if (rm) info.rrn = rm[1] + rm[2]; }
      info.terms = [];
      [/월\s*임금은\s*[\d,]+\s*원/, /근로시간\s*:/, /근로일\s*:/, /업무내용\s*\/\s*직책/].forEach(function (re) {
        for (var q2 = 0; q2 < ps.length; q2++) if (re.test(ps[q2])) { info.terms.push(ps[q2].replace(/\s+/g, ' ').trim()); break; }
      });
      info.paras = ps;
      info.isEmployment = hasDays && !!info.p1 && !!info.p2;
    } catch (e) { info.error = e.message; }
    return info;
  }

  // ------------------------------------------------------------ 개인정보 반영: 글자 수가 달라지는 문단을 통째로 새로 쓴다
  function groupEnd(recs, i) {
    var L = recs[i].level;
    for (var j = i + 1; j < recs.length; j++) if (recs[j].level <= L) return j;
    return recs.length;
  }
  function textParas(data) {
    var recs = parseRecords(data), out = [];
    recs.forEach(function (r, i) {
      if (r.tag !== 67) return;
      var h = -1;
      for (var j = i - 1; j >= 0; j--) if (recs[j].tag === 66 && recs[j].level === r.level - 1) { h = j; break; }
      var raw = null;
      try { raw = new TextDecoder('utf-16le', { fatal: true }).decode(data.subarray(r.off, r.end)); } catch (e) { raw = null; }
      out.push({ rec: i, hdr: h, raw: raw, text: decodeParaText(data.subarray(r.off, r.end)).replace(/\n+$/, '') });
    });
    return { recs: recs, paras: out };
  }
  function utf16(str) {
    var out = new Uint8Array(str.length * 2);
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); out[2 * i] = c & 255; out[2 * i + 1] = c >> 8; }
    return out;
  }
  function buildParaBytes(data, recs, hdrIdx, newText) {
    var end = groupEnd(recs, hdrIdx), kids = recs.slice(hdrIdx, end);
    if (!kids.every(function (r) { return r.tag >= 66 && r.tag <= 70; })) return null;
    var hdr = kids[0];
    var txt = kids.filter(function (r) { return r.tag === 67; })[0];
    var cs = kids.filter(function (r) { return r.tag === 68; })[0];
    var ls = kids.filter(function (r) { return r.tag === 69; })[0];
    var rt = kids.filter(function (r) { return r.tag === 70; })[0];
    if (!txt || !cs || hdr.tag !== 66 || hdr.size < 18) return null;
    var hp = new Uint8Array(data.subarray(hdr.off, hdr.end));
    var oldN = u32(hp, 0), flag = oldN & 0x80000000;
    if ((oldN & 0x7FFFFFFF) * 2 !== txt.size) return null;
    if (u16(hp, 12) !== cs.size / 8 || u16(hp, 14) !== (rt ? rt.size / 12 : 0) || u16(hp, 16) !== (ls ? ls.size / 36 : 0)) return null;
    if (u32(data, cs.off) !== 0) return null;
    var chars = newText.length + 1;
    var nn = ((chars | 0) | flag) >>> 0;
    hp[0] = nn & 255; hp[1] = (nn >>> 8) & 255; hp[2] = (nn >>> 16) & 255; hp[3] = (nn >>> 24) & 255;
    hp[12] = 1; hp[13] = 0; hp[14] = 0; hp[15] = 0;
    var hasLs = !!ls && ls.size >= 36;
    hp[16] = hasLs ? 1 : 0; hp[17] = 0;
    var parts = [recBytes(66, hdr.level, hp), recBytes(67, txt.level, utf16(newText + '\r')), recBytes(68, cs.level, new Uint8Array(data.subarray(cs.off, cs.off + 8)))];
    if (hasLs) parts.push(recBytes(69, ls.level, new Uint8Array(data.subarray(ls.off, ls.off + 36))));
    var len = parts.reduce(function (a, p) { return a + p.length; }, 0), out = new Uint8Array(len), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return { start: hdr.start, end: kids[kids.length - 1].end, bytes: out };
  }
  function applyPersonalEdits(data, edits) {
    var tp = textParas(data), ps = tp.paras, log = [], applied = [], jobs = {}, i = -1;
    for (var k = 0; k + 1 < ps.length; k++) if (ps[k].text.trim() === '근로자' && ps[k + 1].text.trim() === '성명') { i = k; break; }
    if (i < 0) return { data: data, log: ['근로자 표를 찾지 못함'], applied: [] };
    var cell = { birth: i + 4, addr: i + 6, bank: i + 8, acct: i + 10 };
    edits.forEach(function (e) {
      if (e.field === 'name' || e.field === 'rrn') return;
      var idx = cell[e.field], p = ps[idx], old = String(e.old).trim();
      if (!p || !old || p.text.trim() !== old) { log.push(e.label + ' 칸을 찾지 못해 바꾸지 못함'); return; }
      jobs[idx] = (jobs[idx] !== undefined ? jobs[idx] : p.text).replace(old, function () { return e.new; });
      if (e.field === 'addr') {
        var nOld = old.replace(/[\s,.\-()]/g, '');
        ps.forEach(function (q, k2) {
          if (k2 === idx) return;
          var base = jobs[k2] !== undefined ? jobs[k2] : q.text;
          if (q.text.indexOf(old) >= 0) { jobs[k2] = base.replace(old, function () { return e.new; }); return; }
          // 별지의 '주소: …'가 칸의 주소보다 짧게(앞부분만) 적힌 경우도 같이 바꾼다
          var am = /^(\s*주소\s*:\s*)(\S.*?)(\s*)$/.exec(q.text);
          if (am) { var na = am[2].replace(/[\s,.\-()]/g, ''); var cp = 0; while (cp < na.length && cp < nOld.length && na.charAt(cp) === nOld.charAt(cp)) cp++; if (cp >= 8 || (na.length >= 6 && nOld.indexOf(na) === 0)) jobs[k2] = am[1] + e.new + am[3]; }
        });
      }
    });
    var nameEdit = edits.filter(function (e) { return e.field === 'name'; })[0];
    if (nameEdit) {
      var okey = String(nameEdit.old).replace(/\s+/g, ''), nn = String(nameEdit.new).replace(/\s+/g, '');
      var spRe = new RegExp('(^|[^가-힣])' + okey.split('').join('([ \\u00a0]{1,3})') + '(?![가-힣])', 'g'), ncnt = 0;
      ps.forEach(function (q, k3) {
        var t0 = jobs[k3] !== undefined ? jobs[k3] : q.text, t = t0;
        t = t.replace(spRe, function (m0, pre, g1) { return pre + nn.split('').join(g1 || ' '); });
        t = t.split(okey).join(nn);
        if (t !== t0) { jobs[k3] = t; ncnt++; }
      });
      log.push('이름 ' + ncnt + '곳 변경');
    }
    var rrnEdit = edits.filter(function (e) { return e.field === 'rrn'; })[0];
    if (rrnEdit) {
      var dd = String(rrnEdit.old).replace(/\D/g, ''), rre = new RegExp(dd.slice(0, 6) + '\\s*-\\s*' + dd.slice(6)), rcnt = 0;
      ps.forEach(function (q, k4) {
        var t1 = jobs[k4] !== undefined ? jobs[k4] : q.text;
        if (rre.test(t1)) { jobs[k4] = t1.replace(rre, function () { return rrnEdit.new; }); rcnt++; }
      });
      log.push('주민등록번호 ' + rcnt + '곳 변경');
    }
    var reps = [];
    Object.keys(jobs).forEach(function (key) {
      var idx = +key, p = ps[idx];
      if (p.raw !== p.text + '\r') { log.push('서식 문자가 섞인 문단이라 바꾸지 못함'); return; }
      if (p.hdr < 0) { log.push('문단 머리를 찾지 못함'); return; }
      var r = buildParaBytes(data, tp.recs, p.hdr, jobs[key]);
      if (!r) { log.push('지원하지 않는 문단 구조라 바꾸지 못함'); return; }
      reps.push(r);
      applied.push({ idx: idx, newText: jobs[key] });
    });
    reps.sort(function (a, b) { return a.start - b.start; });
    var parts = [], pos = 0, total = 0;
    reps.forEach(function (r) { parts.push(data.subarray(pos, r.start)); parts.push(r.bytes); pos = r.end; });
    parts.push(data.subarray(pos));
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return { data: out, log: log, applied: applied };
  }

  // 압축 결과가 원래 차지한 섹터 범위 안에 들어오도록 (필요하면 빈 블록으로 채워) 압축
  function deflateFlexible(data, low, cap) {
    var padBlock = [0, 0, 0, 0xff, 0xff];
    for (var level = 9; level >= 1; level--) {
      var k = Math.floor(data.length / 2), chunks = [];
      var d = new pako.Deflate({ raw: true, level: level });
      d.onData = function (c) { chunks.push(c); };
      d.push(data.subarray(0, k), 2);
      var headCount = chunks.length;
      d.push(data.subarray(k), true);
      if (d.err) continue;
      var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
      if (total > cap) continue;
      var kk = total > low ? 0 : Math.ceil((low + 1 - total) / 5);
      if (total + 5 * kk > cap) continue;
      var res = new Uint8Array(total + 5 * kk), o = 0;
      chunks.forEach(function (c, idx) {
        if (idx === headCount) for (var q = 0; q < kk; q++) for (var z = 0; z < 5; z++) res[o++] = padBlock[z];
        res.set(c, o); o += c.length;
      });
      var back = pako.inflateRaw(res);
      if (back.length === data.length && back.every(function (v, i2) { return v === data[i2]; })) return res;
    }
    return null;
  }

  // ------------------------------------------------------------ 계약서 고치기 (날짜 / 개인정보)
  // o = { ns, ne, sign, edits:[{field,label,old,new}] }  ns 가 없으면 날짜는 그대로 둔다
  function patchContract(u8, o) {
    var copy = new Uint8Array(u8), sec = loadSection0(copy), log = [], applied = [];
    var wantEdits = !!(o.edits && o.edits.length);
    if (wantEdits && !sec.compressed) throw new Error('압축되지 않은 파일은 개인정보를 바꿀 수 없습니다');
    var data = new Uint8Array(sec.data);
    if (o.ns) {
      parseRecords(data).forEach(function (r) {
        if (r.tag !== 67) return;
        var payload = data.subarray(r.off, r.off + r.size), text;
        try { text = new TextDecoder('utf-16le', { fatal: true }).decode(payload); } catch (e) { return; }
        var nw = rewriteText(text, o.ns, o.ne, o.sign, log);
        if (nw === null) return;
        if (nw.length * 2 !== r.size) { log.push('길이 불일치로 건너뜀'); return; }
        for (var i = 0; i < nw.length; i++) { var c = nw.charCodeAt(i); data[r.off + 2 * i] = c & 255; data[r.off + 2 * i + 1] = c >> 8; }
      });
    }
    if (wantEdits) {
      var r2 = applyPersonalEdits(data, o.edits);
      data = r2.data; log = log.concat(r2.log); applied = r2.applied;
      var capy = sec.cfb.capacity(['BodyText', 'Section0']);
      var nr = capy ? deflateFlexible(data, capy.low, capy.cap) : null;
      if (!nr) throw new Error('수정한 내용이 들어갈 공간이 부족합니다(한글에서 직접 수정이 필요)');
      sec.cfb.resizeInSectors(['BodyText', 'Section0'], nr);
    } else if (o.ns) {
      var newRaw = sec.compressed ? deflateExact(data, sec.raw.length) : data;
      if (!newRaw) throw new Error('압축 크기를 원본과 같게 맞추지 못했습니다');
      sec.cfb.writeSameSize(['BodyText', 'Section0'], newRaw);
    }
    if (o.ns) updatePrvText(sec.cfb, o.ns, o.ne);
    if (wantEdits) updatePrvPersonal(sec.cfb, o.edits);
    return { bytes: copy, log: log, applied: applied };
  }
  // 미리보기(PrvText)에도 이전 사람 정보가 있으므로 같은 글자 수로 맞춰(모자라면 공백, 넘치면 뒤를 자름) 바꾼다
  function updatePrvPersonal(cfb, edits) {
    try {
      if (!cfb.has(['PrvText'])) return;
      var pb = cfb.read(['PrvText']), prv = new TextDecoder('utf-16le').decode(pb);
      edits.forEach(function (e) {
        var old = String(e.old).trim(), nw = String(e.new);
        if (!old) return;
        if (e.field === 'rrn') {
          var dd = old.replace(/\D/g, '');
          prv = prv.replace(new RegExp(dd.slice(0, 6) + '\\s*-\\s*' + dd.slice(6), 'g'), function () { return nw; });
        } else if (e.field === 'name') {
          var key = old.replace(/\s+/g, ''), nn2 = nw.replace(/\s+/g, '');
          prv = prv.replace(new RegExp('(^|[^가-힣])' + key.split('').join('([ \\u00a0]{1,3})') + '(?![가-힣])', 'g'), function (m0, pre, g1) { return pre + nn2.split('').join(g1 || ' '); });
          prv = prv.split(key).join(nn2);
        } else prv = prv.split(old).join(nw);
      });
      var L = pb.length / 2;
      prv = prv.length > L ? prv.slice(0, L) : prv + new Array(L - prv.length + 1).join(' ');
      cfb.writeSameSize(['PrvText'], utf16(prv));
    } catch (e) { /* 미리보기만 못 바꾼 경우 */ }
  }
  function updatePrvText(cfb, ns, ne) {
    try {
      if (!cfb.has(['PrvText'])) return;
      var pb = cfb.read(['PrvText']);
      var prv = new TextDecoder('utf-16le').decode(pb), m, changed = false;
      var nsN = kr(ns), neN = kr(ne);
      if ((m = P1.exec(prv))) {
        var nw1 = fit(m[0], [nsN.y, nsN.m, nsN.d, neN.y, neN.m, neN.d]);
        if (nw1) { prv = prv.slice(0, m.index) + nw1 + prv.slice(m.index + m[0].length); changed = true; }
      }
      if ((m = P2.exec(prv))) {
        var s0 = m.index + m[1].length, e0 = m.index + m[0].length - m[5].length;
        var nw2 = fit(prv.slice(s0, e0), [nsN.y, nsN.m, nsN.d]);
        if (nw2) { prv = prv.slice(0, s0) + nw2 + prv.slice(e0); changed = true; }
      }
      if (changed && prv.length * 2 === pb.length) cfb.writeSameSize(['PrvText'], utf16(prv));
    } catch (e) { /* 미리보기 글자만 못 바꾼 경우: 무시 */ }
  }

  // 만든 파일이 원본과 '의도한 곳'만 다른지 스스로 검사 (문제가 있으면 이유를 돌려줌)
  var DMASK = /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/g;
  function verifyPatched(orig, patched, o, applied) {
    var a = readContractInfo(orig), b = readContractInfo(patched);
    if (!b.isEmployment) return '만든 파일을 다시 읽지 못함';
    var wp1 = o.ns ? [o.ns, o.ne] : a.p1;
    if (b.p1[0] !== wp1[0] || b.p1[1] !== wp1[1]) return '제1조 기간이 예상과 다름';
    if (o.ns) {
      if (b.p2 !== o.ns) return '제2조 시작일이 예상과 다름';
      if (b.solo.length !== 2 || b.solo[0] !== o.sign || b.solo[1] !== o.sign) return '체결일/약정서 날짜가 예상과 다름';
    } else if (b.p2 !== a.p2 || b.solo.join() !== a.solo.join()) return '날짜가 의도치 않게 바뀜';
    if (a.paras.length !== b.paras.length) return '문단 수가 달라짐';
    var want = {}, dateChanged = 0;
    (applied || []).forEach(function (x) { want[x.idx] = x.newText; });
    for (var i = 0; i < a.paras.length; i++) {
      if (a.paras[i] === b.paras[i]) continue;
      if (want[i] !== undefined) {
        if (b.paras[i] !== want[i]) return '개인정보 문단이 예상과 다름';
        if ((a.paras[i].match(DMASK) || []).join('|') !== (b.paras[i].match(DMASK) || []).join('|')) dateChanged++;
        continue;
      }
      if (a.paras[i].replace(DMASK, 'D').replace(/\s+/g, ' ') !== b.paras[i].replace(DMASK, 'D').replace(/\s+/g, ' ')) return '의도하지 않은 글자가 달라짐';
      dateChanged++;
    }
    if (o.ns ? dateChanged > 4 : dateChanged !== 0) return '바뀐 날짜 문단 수가 예상과 다름(' + dateChanged + '개)';
    return null;
  }

  // ------------------------------------------------------------ 시트 읽기와 조회
  var clean = function (s) { return String(s === null || s === undefined ? '' : s).replace(/\s*\n\s*/g, ' ').trim(); };
  function parseSheetArrays(arr) {
    var hi = -1;
    for (var i = 0; i < Math.min(arr.length, 15); i++) {
      var cells = arr[i].map(clean);
      if (cells.indexOf('성명') >= 0 && (cells.indexOf('정해진 계약기간') >= 0 || cells.indexOf('입사일') >= 0)) { hi = i; break; }
    }
    if (hi < 0) throw new Error("제목 줄을 찾지 못했습니다. '성명'과 '정해진 계약기간' 열이 있는 시트를 선택해 주세요.");
    var headers = arr[hi].map(clean), idx = {};
    headers.forEach(function (h, i) { if (h && !(h in idx)) idx[h] = i; });
    ['성명', '정해진 계약기간'].forEach(function (h) { if (!(h in idx)) throw new Error("'" + h + "' 열이 없습니다."); });
    var rows = [];
    for (var r = hi + 1; r < arr.length; r++) {
      var cs = arr[r];
      if (!cs.some(function (c) { return String(c === undefined || c === null ? '' : c).trim() !== ''; })) continue;
      var v = {};
      Object.keys(idx).forEach(function (h) { v[h] = clean(cs[idx[h]]); });
      rows.push({ n: r + 1, v: v, col0: String(cs[0] === undefined || cs[0] === null ? '' : cs[0]) });
    }
    return { headers: headers.filter(function (h) { return h; }), idx: idx, rows: rows };
  }
  function cmpVals(a, b) {
    var da = looseDate(a), db = looseDate(b);
    if (da && db) return da < db ? -1 : da > db ? 1 : 0;
    var na = parseFloat(String(a).replace(/,/g, '')), nb = parseFloat(String(b).replace(/,/g, ''));
    if (!isNaN(na) && !isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
    return String(a).localeCompare(String(b), 'ko');
  }
  function applyFilters(rows, filters) {
    return rows.filter(function (r) {
      return filters.every(function (f) {
        if (!f.col) return true;
        var val = r.v[f.col] === undefined ? '' : r.v[f.col], q = String(f.val === undefined ? '' : f.val).trim();
        var low = val.toLowerCase(), ql = q.toLowerCase();
        switch (f.op) {
          case 'contains': return q === '' || low.indexOf(ql) >= 0;
          case 'notcontains': return q === '' || low.indexOf(ql) < 0;
          case 'eq': return low === ql;
          case 'in': return q === '' || q.split(/[,\n]/).map(function (x) { return x.replace(/\s+/g, '').toLowerCase(); }).filter(Boolean).indexOf(low.replace(/\s+/g, '')) >= 0;
          case 'gte': return q === '' || (val !== '' && cmpVals(val, q) >= 0);
          case 'lte': return q === '' || (val !== '' && cmpVals(val, q) <= 0);
          case 'empty': return val === '';
          case 'nonempty': return val !== '';
        }
        return true;
      });
    });
  }

  // ------------------------------------------------------------ 계획 세우기(누구를, 어떤 기간으로)
  var normName = function (s) { return String(s || '').replace(/\s+/g, ''); };
  var normAddr = function (s) { return String(s || '').replace(/[\s,.\-()]/g, ''); };
  var digits = function (s) { return String(s || '').replace(/\D/g, ''); };
  function birthKey(s) { var m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(s || '')); return m ? (+m[1]) + '-' + (+m[2]) + '-' + (+m[3]) : String(s || '').trim(); }

  function fmtBirth(oldVal, sheetVal) {
    var s = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(sheetVal || ''));
    if (!s) return null;
    var o = /^(\d{4})(\.\s*)(\d{1,2})(\.\s*)(\d{1,2})$/.exec(String(oldVal || '').trim());
    var sep1 = o ? o[2] : '.', sep2 = o ? o[4] : '.';
    var pad = o ? !(o[3].length === 1 || o[5].length === 1) : true;
    var mm = pad ? pad2(+s[2]) : String(+s[2]), dd = pad ? pad2(+s[3]) : String(+s[3]);
    return s[1] + sep1 + mm + sep2 + dd;
  }

  function buildPlan(sheet, rowsToPlan, contracts, st) {
    var nameCount = {};
    sheet.rows.forEach(function (r) { var k = normName(r.v['성명']); nameCount[k] = (nameCount[k] || 0) + 1; });
    var byName = {};
    contracts.forEach(function (c) { if (c.isEmployment && c.name) (byName[normName(c.name)] = byName[normName(c.name)] || []).push(c); });
    var words = (st.leaveWords || '').split(/[,\s]+/).filter(Boolean);
    var leaveRe = words.length ? new RegExp(words.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|')) : null;
    return rowsToPlan.map(function (r) {
      var v = r.v, key = normName(v['성명']);
      var it = { rowNo: r.n, name: v['성명'], office: v['office'] || '', kind: v['구분'] || '', old: null, nw: null, n: null, status: 'no', reasons: [], warns: [], edits: [], contract: null, sign: null };
      var pm = /(\d{4}-\d{2}-\d{2})\s*[_~]\s*(\d{4}-\d{2}-\d{2})/.exec(v['정해진 계약기간'] || '');
      if (!pm) { it.reasons.push('정해진 계약기간이 없음(' + ((v['계약기간 만료일'] || '').replace(/\d{4}-\d{2}-\d{2}/, '') || '무기계약 등') + ')'); return it; }
      it.old = [pm[1], pm[2]];
      var cands = byName[key] || [];
      if (!cands.length) { it.reasons.push('계약서 파일을 찾지 못함'); return it; }
      var c = cands.filter(function (x) { return x.p1[0] === pm[1] && x.p1[1] === pm[2]; })[0];
      if (!c) {
        var lt = cands.slice().sort(function (x, y) { return x.p1[1] < y.p1[1] ? 1 : -1; })[0];
        it.reasons.push('계약서 파일의 기간(' + lt.p1[0] + '~' + lt.p1[1] + ')이 시트와 다름');
        return it;
      }
      it.contract = c;
      if (st.doPeriod) {
        var np;
        if (st.mode === 'custom') np = { ns: st.customStart, ne: st.customEnd, n: st.customStart && st.customEnd ? Math.round((diffDays(st.customStart, st.customEnd) + 1) / 30.44) : 0 };
        else np = newPeriod(pm[1], pm[2], st.months);
        if (!(np.ns && np.ne) || np.ne < np.ns) { it.reasons.push('새 계약기간이 올바르지 않음'); return it; }
        it.nw = [np.ns, np.ne]; it.n = np.n;
        var hire = looseDate(v['입사일']);
        if (hire && addMonths(hire, 24) <= np.ne) it.warns.push('입사 2년(' + addMonths(hire, 24) + ')이 새 계약기간 안에 있거나 지남 - 기간제 2년 초과(무기계약 전환) 여부 확인');
        it.sign = st.signMode === 'custom' && st.signDate ? st.signDate : np.ns;
        if (c.p2 !== c.p1[0]) it.reasons.push('제2조 시작일이 제1조 시작일과 다름');
        if (!(c.solo.length === 2 && c.solo[0] === c.p1[0] && c.solo[1] === c.p1[0])) it.reasons.push('체결일·약정서 날짜가 계약시작일과 다름');
      }
      if (nameCount[key] > 1) it.reasons.push('시트에 같은 이름이 2명 이상');
      var note = (r.col0 || '') + ' ' + (v['메모'] || '');
      if (st.excludeLeave && leaveRe && leaveRe.test(note)) it.reasons.push('시트 메모에 퇴사·종료 표시');
      if (c.worker) {
        var w = c.worker, diffs = [];
        var chk = function (field, label, same, oldVal, newVal) {
          if (!newVal || same) return;
          if (st.doPersonal) {
            if (!String(oldVal || '').trim()) it.warns.push(label + ': 계약서 칸이 비어 있어 바꾸지 못함');
            else { it.edits.push({ field: field, label: label, old: oldVal, new: newVal }); }
          } else diffs.push(label + '이(가) 시트와 다름(반영하지 않음)');
        };
        var sb = v['생년월일'];
        chk('birth', '생년월일', birthKey(w.birth) === birthKey(sb), w.birth, fmtBirth(w.birth, sb));
        chk('addr', '주소', normAddr(w.addr) === normAddr(v['주소']), w.addr, String(v['주소'] || '').trim());
        chk('bank', '은행', normAddr(w.bank) === normAddr(v['은행']), w.bank, String(v['은행'] || '').trim());
        chk('acct', '계좌번호', digits(w.acct) === digits(v['계좌번호']), w.acct, String(v['계좌번호'] || '').trim());
        diffs.forEach(function (d) { it.warns.push(d); });
        if (it.edits.length) it.warns.push('개인정보 ' + it.edits.map(function (e) { return e.label; }).join('·') + ' 반영 - 한글에서 열어 확인');
      }
      if (!st.doPeriod && !it.edits.length && !it.reasons.length) it.reasons.push('반영할 변경 사항이 없음');
      if (it.reasons.length) { it.status = 'no'; return it; }
      it.status = it.warns.length ? 'warn' : 'ok';
      return it;
    });
  }

  function newFileName(oldName, ns) {
    var ymd = ns.slice(2, 4) + ns.slice(5, 7) + ns.slice(8, 10);
    if (/_\d{6}(?=\.hwp$)/i.test(oldName)) return oldName.replace(/_\d{6}(?=\.hwp$)/i, '_' + ymd);
    return oldName.replace(/\.hwp$/i, '') + '_' + ymd + '.hwp';
  }
  function csvEscape(x) { x = String(x === undefined || x === null ? '' : x); return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }
  function summaryCSV(items) {
    var head = ['이름', '센터', '구분', '지난 계약기간', '새 계약기간', '개월', '결과', '확인할 점', '파일 위치'];
    var lines = [head.map(csvEscape).join(',')];
    items.forEach(function (it) {
      lines.push([it.name, it.office, it.kind, it.old ? it.old[0] + ' ~ ' + it.old[1] : '', it.nw ? it.nw[0] + ' ~ ' + it.nw[1] : '', it.n || '',
        it.result || '', it.reasons.concat(it.warns).join('; '), it.outPath || ''].map(csvEscape).join(','));
    });
    return '﻿' + lines.join('\r\n');
  }


  // ------------------------------------------------------------ 신규 입사: 기존 계약서를 본보기로 새 사람 계약서 만들기
  function fmtRrn(v) { var d = digits(v); return d.length === 13 ? d.slice(0, 6) + '-' + d.slice(6) : null; }
  function birthFromRrn(d) {
    var c = d.charAt(6), yy = d.slice(0, 2), cen = { '1': 1900, '2': 1900, '5': 1900, '6': 1900, '3': 2000, '4': 2000, '7': 2000, '8': 2000, '9': 1800, '0': 1800 }[c];
    return cen ? (cen + (+yy)) + '-' + d.slice(2, 4) + '-' + d.slice(4, 6) : null;
  }
  function pickTemplate(contracts, v) {
    var office = String(v['office'] || '').trim(), kind = String(v['구분'] || '').trim(), best = null, bs = -1;
    contracts.forEach(function (c) {
      if (!c.isEmployment || !c.worker || !c.rrn) return;
      var sc = 0;
      if (office && c.rel.indexOf(office) >= 0) sc += 4;
      kind.split(/[\/,\s]+/).filter(Boolean).forEach(function (k) { if (c.rel.indexOf(k) >= 0) sc += 2; });
      var end = c.p1[1];
      if (sc > bs || (sc === bs && best && end > best.p1[1])) { best = c; bs = sc; }
    });
    return best;
  }
  function newHireFileName(oldFile, oldName, newName, ns) {
    var key = String(oldName).replace(/\s+/g, ''), f = oldFile;
    if (key && f.indexOf(key) >= 0) f = f.split(key).join(String(newName).replace(/\s+/g, ''));
    else f = String(newName).replace(/\s+/g, '') + '_' + f;
    return newFileName(f, ns);
  }
  function buildNewHirePlan(sheet, rowsToPlan, contracts, st) {
    var rrnCol = sheet.headers.filter(function (h) { return /주민/.test(h); })[0];
    var existing = {};
    contracts.forEach(function (c) { if (c.isEmployment && c.name) existing[normName(c.name)] = 1; });
    var nameCount = {};
    sheet.rows.forEach(function (r) { var k = normName(r.v['성명']); nameCount[k] = (nameCount[k] || 0) + 1; });
    return rowsToPlan.map(function (r) {
      var v = r.v, nm = String(v['성명'] || '').trim();
      var it = { rowNo: r.n, name: nm, office: v['office'] || '', kind: v['구분'] || '', old: null, nw: null, n: null, status: 'no', reasons: [], warns: [], edits: [], contract: null, sign: null, newHire: true };
      if (!nm) { it.reasons.push('성명이 없음'); return it; }
      var t = st.templateMode === 'fixed' ? st.template : pickTemplate(contracts, v);
      if (!t || !t.isEmployment || !t.worker || !t.rrn) { it.reasons.push('본보기로 쓸 계약서가 없음(근로자 표·주민번호가 있는 근로계약서가 필요)'); return it; }
      it.contract = t;
      var rrn = rrnCol ? fmtRrn(v[rrnCol]) : null;
      if (!rrn) { it.reasons.push('시트의 주민등록번호가 없거나 13자리가 아님'); return it; }
      var rd = digits(rrn);
      // 기간
      var ns = null, ne = null;
      if (st.periodMode === 'sheet') {
        var pm = /(\d{4}-\d{2}-\d{2})\s*[_~]\s*(\d{4}-\d{2}-\d{2})/.exec(v['정해진 계약기간'] || '');
        if (pm) { ns = pm[1]; ne = pm[2]; } else it.reasons.push("시트의 '정해진 계약기간'이 없음");
      } else if (st.periodMode === 'hire') {
        var hs = looseDate(v['입사일']);
        if (hs) { ns = hs; ne = addDays(addMonths(hs, Number(st.hireMonths) || 3), -1); } else it.reasons.push('시트의 입사일이 없음');
      } else { ns = st.customStart; ne = st.customEnd; }
      if (!it.reasons.length && !(ns && ne && ne >= ns)) it.reasons.push('계약기간이 올바르지 않음');
      if (it.reasons.length) return it;
      it.nw = [ns, ne]; it.n = Math.round((diffDays(ns, ne) + 1) / 30.44);
      it.sign = st.signMode === 'custom' && st.signDate ? st.signDate : ns;
      // 근로자 정보
      var w = t.worker, sb = v['생년월일'];
      var nb = fmtBirth(w.birth, sb) || fmtBirth(w.birth, birthFromRrn(rd));
      var addr = String(v['주소'] || '').trim(), bank = String(v['은행'] || '').trim(), acct = String(v['계좌번호'] || '').trim();
      it.edits.push({ field: 'name', label: '이름', old: w.name, new: nm });
      it.edits.push({ field: 'rrn', label: '주민등록번호', old: t.rrn, new: rrn });
      var add = function (field, label, oldV, newV) {
        if (!String(oldV || '').trim()) { it.warns.push(label + ': 본보기 계약서 칸이 비어 있음'); return; }
        if (!newV) { it.warns.push(label + ': 시트에 값이 없어 칸을 비워 둠'); }
        if (String(oldV).trim() !== newV) it.edits.push({ field: field, label: label, old: oldV, new: newV });
      };
      add('birth', '생년월일', w.birth, nb || '');
      add('addr', '주소', w.addr, addr);
      add('bank', '은행', w.bank, bank);
      add('acct', '계좌번호', w.acct, acct);
      if (nameCount[normName(nm)] > 1) it.warns.push('시트에 같은 이름이 2명 이상');
      if (existing[normName(nm)]) it.warns.push('같은 이름의 계약서 파일이 이미 있음');
      if (normName(t.name) === normName(nm)) it.warns.push('본보기 계약서가 본인 것임');
      if (t.p2 !== t.p1[0] || !(t.solo.length === 2 && t.solo[0] === t.p1[0] && t.solo[1] === t.p1[0])) it.warns.push('본보기 계약서의 제2조·체결일 날짜가 계약시작일과 다름 - 확인 필요');
      it.warns.push('본보기: ' + t.rel.split('/').slice(-2).join('/') + ' (임금·근무시간·직책은 이 계약서 그대로)');
      it.status = 'warn';
      return it;
    });
  }
  // 만든 계약서에 이전 사람 정보가 남았는지 검사 (남은 항목 이름을 돌려줌)
  function findLeftovers(bytes, tmpl, nw) {
    var b = readContractInfo(bytes), text = (b.paras || []).join('\n'), flat = text.replace(/\s+/g, ''), out = [];
    var nm = String(tmpl.worker.name).replace(/\s+/g, '');
    if (nm && String(nw.name).replace(/\s+/g, '').indexOf(nm) < 0 && flat.indexOf(nm) >= 0) out.push('이전 사람 이름');
    var tr = String(tmpl.rrn || ''), nr = digits(nw.rrn);
    if (tr && tr !== nr && digits(text).indexOf(tr) >= 0) out.push('이전 사람 주민등록번호');
    var ta = digits(tmpl.worker.acct);
    if (ta.length >= 8 && ta !== digits(nw.acct) && digits(text).indexOf(ta) >= 0) out.push('이전 사람 계좌번호');
    var tadr = normAddr(tmpl.worker.addr);
    var tpre = tadr.slice(0, 10), nadr = normAddr(nw.addr);
    if (tadr.length >= 6 && tadr !== nadr && (normAddr(text).indexOf(tadr) >= 0 || (tpre.length >= 8 && nadr.indexOf(tpre) < 0 && normAddr(text).indexOf(tpre) >= 0))) out.push('이전 사람 주소');
    var tb = birthKey(tmpl.worker.birth);
    if (tb && tb !== birthKey(nw.birth)) { var bm = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(tmpl.worker.birth || ''); if (bm && b.worker && birthKey(b.worker.birth) === tb) out.push('이전 사람 생년월일'); }
    return out;
  }

  return {
    openCFB: openCFB, readContractInfo: readContractInfo, patchContract: patchContract, verifyPatched: verifyPatched,
    parseSheetArrays: parseSheetArrays, applyFilters: applyFilters, buildPlan: buildPlan, newPeriod: newPeriod,
    newFileName: newFileName, summaryCSV: summaryCSV, looseDate: looseDate, addDays: addDays, addMonths: addMonths, fit: fit,
    deflateExact: deflateExact, parseRecords: parseRecords, fmtBirth: fmtBirth,
    buildNewHirePlan: buildNewHirePlan, newHireFileName: newHireFileName, findLeftovers: findLeftovers, pickTemplate: pickTemplate
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = HC;
