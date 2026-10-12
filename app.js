(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fd(s) { return s ? String(s).slice(2).replace(/-/g, '.') : ''; }
function nn(s) { return String(s || '').replace(/\s+/g, ''); }

var S = {
  screen: 'home', sheet: null, contracts: [], loaded: false, loading: false, loadMsg: '', loadPct: 0, err: '',
  q: 15, batch: 'same', months: {}, picked: {}, doPersonal: true,
  npicked: {}, nedit: {}, np: { mode: 'hire', months: 3, start: '', end: '' }, tplMode: 'auto', tplRel: '',
  made: [], sel: 0, acks: {}, busy: '', note: ''
};
var rrnCol = '';

// ---------- 통신
function api(path, opt) {
  return fetch(path, Object.assign({ credentials: 'same-origin' }, opt || {})).then(function (r) {
    if (r.status === 401) { showLogin(); throw new Error('login'); }
    return r;
  });
}
function apiJson(path, opt) { return api(path, opt).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); }); }

// ---------- 로그인
function showLogin() { $('app').classList.add('hide'); $('login').classList.remove('hide'); $('pw').focus(); }
$('loginForm').onsubmit = function (e) {
  e.preventDefault(); $('loginMsg').textContent = '';
  fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
    .then(function () { $('pw').value = ''; start(); })
    .catch(function (e) { $('loginMsg').textContent = e.message; });
};
function start() {
  apiJson('/api/me').then(function () {
    $('login').classList.add('hide'); $('app').classList.remove('hide');
    render(); if (!S.loaded && !S.loading) loadAll();
  }).catch(function () {});
}

// ---------- 시트·계약서 불러오기
function loadAll() {
  S.loading = true; S.loaded = false; S.err = ''; S.loadMsg = '시트를 읽는 중...'; S.loadPct = 0; render();
  apiJson('/api/sheet').then(function (j) {
    S.sheet = HC.parseSheetArrays(j.values);
    rrnCol = S.sheet.headers.filter(function (h) { return /주민/.test(h); })[0] || '';
    S.loadMsg = '계약서 목록을 읽는 중...'; render();
    return apiJson('/api/contracts');
  }).then(function (j) {
    var files = j.files, i = 0, done = 0; S.contracts = [];
    function one() {
      if (i >= files.length) return Promise.resolve();
      var f = files[i++];
      return api('/api/file?id=' + encodeURIComponent(f.id)).then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
        var u8 = new Uint8Array(ab), info;
        try { info = HC.readContractInfo(u8); } catch (e) { info = { isEmployment: false, error: String(e) }; }
        info.rel = f.rel; info.u8 = u8; info.id = f.id; S.contracts.push(info);
      }).catch(function (e) { if (e.message === 'login') throw e; }).then(function () {
        done++; S.loadPct = Math.round(done * 100 / files.length); S.loadMsg = '계약서 읽는 중 ' + done + ' / ' + files.length;
        if (done % 5 === 0 || done === files.length) render();
        return one();
      });
    }
    var w = []; for (var k = 0; k < 6; k++) w.push(one());
    return Promise.all(w);
  }).then(function () { S.loaded = true; S.loading = false; render(); })
    .catch(function (e) { S.loading = false; if (e.message !== 'login') { S.err = e.message; render(); } });
}

// ---------- 계산
function dDay(v) { var m = /^D\s*-\s*(\d+)$/i.exec(String(v['D데이'] || '').trim()); return m ? +m[1] : null; }
function isNew(v) { return String(v['D데이'] || '').trim() === '신규'; }
function renewRows() {
  return S.sheet.rows.filter(function (r) { var d = dDay(r.v); return d !== null && d <= S.q; })
    .sort(function (a, b) { return dDay(a.v) - dDay(b.v); });
}
function planRenew(row) {
  var st = { doPeriod: true, doPersonal: S.doPersonal, mode: 'next', months: S.months[row.n] || S.batch, signMode: 'start', excludeLeave: false, leaveWords: '' };
  return HC.buildPlan(S.sheet, [row], S.contracts, st)[0];
}
function newRows() { return S.sheet.rows.filter(function (r) { return isNew(r.v); }); }
var EDIT_COLS = ['입사일', '생년월일', '주소', '은행', '계좌번호'];
function editedRow(row) {
  var o = S.nedit[row.n] || {}, v = Object.assign({}, row.v);
  Object.keys(o).forEach(function (k) { v[k] = o[k]; });
  return { n: row.n, v: v, col0: row.col0 };
}
function tplList() {
  return S.contracts.filter(function (c) { return c.isEmployment && c.worker && c.rrn; })
    .sort(function (a, b) { return a.rel < b.rel ? -1 : 1; });
}
function nSettings() {
  var st = { templateMode: S.tplMode, template: null, periodMode: S.np.mode, hireMonths: S.np.months, customStart: S.np.start, customEnd: S.np.end, signMode: 'start' };
  if (S.tplMode === 'fixed') st.template = tplList().filter(function (c) { return c.rel === S.tplRel; })[0] || null;
  return st;
}
function planNew(row) { return HC.buildNewHirePlan(S.sheet, [editedRow(row)], S.contracts, nSettings())[0]; }

// ---------- 화면
var TITLES = { home: '메인 메뉴', renew: '재직자 갱신', new: '신규 입사', confirm: '만든 계약서 확인' };
function render() {
  if ($('app').classList.contains('hide')) return;
  ['home', 'renew', 'new', 'confirm'].forEach(function (k) { $('nav-' + k).classList.toggle('on', S.screen === k); });
  $('title').textContent = TITLES[S.screen];
  $('stat').innerHTML = S.loaded ? '시트 ' + S.sheet.rows.length + '행<br>계약서 ' + S.contracts.length + '개 읽음' : '불러오는 중...';
  $('topchips').innerHTML = '<span class="tag ' + (S.loaded ? 'ok' : 'warn') + '">' + (S.loaded ? '시트 연결됨' : '불러오는 중') + '</span> <span class="tag new">오늘 ' + todayStr() + '</span>';
  var v = $('view');
  if (S.err) { v.innerHTML = '<div class="card"><b>불러오지 못했습니다</b><p class="msg err">' + esc(S.err) + '</p><button class="btn pri" data-act="reload">다시 시도</button></div>'; return; }
  if (!S.loaded) {
    v.innerHTML = '<div class="card"><b>' + esc(S.loadMsg) + '</b><div class="bar" style="margin-top:12px"><i style="width:' + S.loadPct + '%"></i></div><p class="msg">처음 한 번만 오래 걸립니다. 화면을 닫지 마세요.</p></div>';
    return;
  }
  v.innerHTML = { home: rHome, renew: rRenew, new: rNew, confirm: rConfirm }[S.screen]();
}
function todayStr() { var d = new Date(); return d.getFullYear() + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + ('0' + d.getDate()).slice(-2); }
function ddTag(d) { return '<span class="tag ' + (d <= 3 ? 'd0' : d <= 9 ? 'd1' : 'd2') + '">D-' + d + '</span>'; }

function rHome() {
  var rr = renewRows().map(planRenew), warn = rr.filter(function (p) { return p.warns.some(function (w) { return /2년/.test(w); }); }).length;
  return '<div class="cards4">' +
    '<div class="card" style="background:#FDE6EF"><div class="lbl">D-' + S.q + ' 이내 만료</div><div class="num" style="color:#7A2A55">' + rr.length + '명</div></div>' +
    '<div class="card" style="background:#EADCF8"><div class="lbl">신규 입사 대기</div><div class="num" style="color:#3A2470">' + newRows().length + '명</div></div>' +
    '<div class="card" style="background:#FFF1DD"><div class="lbl">2년 경고</div><div class="num" style="color:#8A4310">' + warn + '명</div></div>' +
    '<div class="card" style="background:#E4F1E4"><div class="lbl">이번에 만든 계약서</div><div class="num" style="color:#285A2C">' + S.made.length + '건</div></div></div>' +
    '<div class="cards3">' +
    '<button class="menucard" data-act="go" data-v="renew"><b style="color:#7A2A55">재직자 갱신</b><span>D데이로 조회하고, 고른 매니저만 갱신 기간(1~12개월)을 정해 계약서를 만듭니다.</span></button>' +
    '<button class="menucard" data-act="go" data-v="new"><b style="color:#3A2470">신규 입사</b><span>D데이가 &quot;신규&quot;인 사람의 정보만 넣어 본보기 계약서로 만듭니다.</span></button>' +
    '<button class="menucard" data-act="go" data-v="confirm"><b style="color:#285A2C">만든 계약서 확인</b><span>바뀐 부분을 화면에서 확인하고, 맞으면 내려받기와 드라이브 저장을 합니다.</span></button></div>' +
    '<div class="note">화면에서 보이는 것은 글자 내용입니다. 한글 프로그램에서의 줄바꿈·쪽 나눔은 다를 수 있으니, 내려받은 뒤 한글로 한 번 열어 확인해 주세요.</div>';
}

function rRenew() {
  var rows = renewRows(), plans = rows.map(planRenew);
  var pk = rows.filter(function (r, i) { return S.picked[r.n] && plans[i].status !== 'no'; }).length;
  var monthOpts = function (sel, same) {
    var o = same ? '<option value="same"' + (sel === 'same' ? ' selected' : '') + '>지난 기간과 같게</option>' : '';
    for (var m = 1; m <= 12; m++) o += '<option value="' + m + '"' + (String(sel) === String(m) ? ' selected' : '') + '>' + m + '개월</option>';
    return o;
  };
  var body = rows.map(function (r, i) {
    var p = plans[i], no = p.status === 'no', on = !!S.picked[r.n] && !no, d = dDay(r.v);
    var info = p.edits.length ? p.edits.map(function (e) { return '<span class="tag warn">' + esc(e.label) + ' 변경</span>'; }).join(' ') : '<span class="tag ok">변경 없음</span>';
    var memo = p.reasons.concat(p.warns).map(function (w) { return '<div>' + esc(w) + '</div>'; }).join('');
    return '<tr class="' + (no ? 'no' : on ? 'sel' : '') + '"><td><button class="ck' + (on ? ' on' : '') + '"' + (no ? ' disabled' : '') + ' data-act="pick" data-n="' + r.n + '" aria-label="선택">' + (on ? '✓' : '') + '</button></td>' +
      '<td class="nw"><b>' + esc(p.name) + '</b></td><td class="nw">' + esc(p.office) + '</td><td>' + ddTag(d) + '</td>' +
      '<td class="nw">' + (p.old ? fd(p.old[0]) + ' ~ ' + fd(p.old[1]) : '') + '</td>' +
      '<td style="min-width:120px">' + (no ? '' : '<select data-act="months" data-n="' + r.n + '">' + monthOpts(p.n, false) + '</select>') + '</td>' +
      '<td class="nw"><b style="color:#3A2470">' + (p.nw ? fd(p.nw[0]) + ' ~ ' + fd(p.nw[1]) : '') + '</b></td>' +
      '<td>' + (no ? '' : info) + '</td><td style="font-size:13px;min-width:200px">' + memo + '</td></tr>';
  }).join('');
  return '<div class="card row">' +
    '<div class="field" style="width:150px"><label for="dq">D데이 조회 (D-0 ~ D-N)</label><input id="dq" value="D-' + S.q + '" data-act="dq"></div>' +
    '<div class="row" style="gap:8px">' + [7, 15, 30].map(function (n) { return '<button class="chip' + (S.q === n ? ' on' : '') + '" data-act="dqset" data-q="' + n + '">D-' + n + '</button>'; }).join('') + '</div>' +
    '<div class="grow" style="flex:1"></div>' +
    '<label class="row" style="gap:6px"><input type="checkbox" data-act="personal"' + (S.doPersonal ? ' checked' : '') + '> 시트와 다른 개인정보도 반영</label>' +
    '<div class="row" style="gap:8px"><span class="lbl">일괄 기간</span><select class="sel" data-act="batch">' + monthOpts(S.batch, true) + '</select>' +
    '<button class="btn sec" data-act="applybatch">선택한 사람에게 적용</button></div></div>' +
    '<div class="card" style="padding:12px 22px 22px"><div class="tw"><table><thead><tr><th>선택</th><th>이름</th><th>센터</th><th>D데이</th><th>현재 계약기간</th><th>갱신 기간</th><th>새 계약기간</th><th>개인정보</th><th>안내</th></tr></thead><tbody>' +
    (body || '<tr><td colspan="9" class="lbl">D-' + S.q + ' 이내인 사람이 없습니다.</td></tr>') + '</tbody></table></div></div>' +
    '<div class="row" style="justify-content:space-between"><div><button class="btn ghost" data-act="pickall">만들 수 있는 사람 모두 선택</button> <button class="btn ghost" data-act="pickclear">선택 해제</button> &nbsp; 선택 <b>' + pk + '명</b> · 체결일은 새 계약 시작일로 입력됩니다' + (S.busy ? ' · <span class="msg">' + esc(S.busy) + '</span>' : '') + '</div>' +
    '<button class="btn pri" data-act="makeRenew"' + (pk ? '' : ' disabled') + '>계약서 만들기 · 확인 화면으로</button></div>';
}

function rNew() {
  var rows = newRows(), plans = rows.map(planNew), lst = tplList();
  var tplSel = '<select class="sel" data-act="tpl" style="max-width:380px"' + (S.tplMode === 'fixed' ? '' : ' disabled') + '>' + lst.map(function (c) { return '<option value="' + esc(c.rel) + '"' + (c.rel === S.tplRel ? ' selected' : '') + '>' + esc(c.worker.name + ' | ' + c.rel.split('/').slice(-2).join('/')) + '</option>'; }).join('') + '</select>';
  var first = plans.filter(function (p) { return p.contract; })[0];
  var cols = (rrnCol ? [rrnCol] : []).concat(EDIT_COLS);
  var body = rows.map(function (r, i) {
    var p = plans[i], er = editedRow(r), no = p.status === 'no', on = !!S.npicked[r.n] && !no;
    var cells = cols.map(function (c) {
      var val = er.v[c] || '';
      return '<td><input class="' + (val ? '' : 'miss') + '" data-act="nedit" data-n="' + r.n + '" data-col="' + esc(c) + '" value="' + esc(val) + '" aria-label="' + esc(c) + '"></td>';
    }).join('');
    var memo = p.reasons.concat(p.warns.filter(function (w) { return w.indexOf('본보기:') !== 0; })).map(function (w) { return '<div>' + esc(w) + '</div>'; }).join('');
    return '<tr class="' + (no ? 'no' : on ? 'sel' : '') + '"><td><button class="ck' + (on ? ' on' : '') + '"' + (no ? ' disabled' : '') + ' data-act="npick" data-n="' + r.n + '" aria-label="선택">' + (on ? '✓' : '') + '</button></td>' +
      '<td class="nw"><b>' + esc(er.v['성명']) + '</b></td><td class="nw">' + esc(er.v['office']) + '</td>' + cells +
      '<td class="nw"><b style="color:#3A2470">' + (p.nw ? fd(p.nw[0]) + ' ~ ' + fd(p.nw[1]) : '') + '</b></td><td style="font-size:13px;min-width:200px">' + memo + '</td></tr>';
  }).join('');
  var pk = rows.filter(function (r, i) { return S.npicked[r.n] && plans[i].status !== 'no'; }).length;
  var modeBtn = function (m, t) { return '<button class="chip' + (S.np.mode === m ? ' on' : '') + '" data-act="npmode" data-m="' + m + '">' + t + '</button>'; };
  return '<div class="card"><div class="row" style="gap:10px"><b>본보기 계약서</b>' +
    '<button class="chip' + (S.tplMode === 'auto' ? ' on' : '') + '" data-act="tplmode" data-m="auto">자동 선택 (센터·구분이 비슷한 최신)</button>' +
    '<button class="chip' + (S.tplMode === 'fixed' ? ' on' : '') + '" data-act="tplmode" data-m="fixed">직접 고르기</button>' + tplSel + '</div></div>' +
    '<div class="card"><div class="row" style="gap:10px"><b>계약기간</b>' + modeBtn('hire', '입사일부터') + modeBtn('sheet', '시트의 정해진 계약기간') + modeBtn('custom', '직접 입력') +
    (S.np.mode === 'hire' ? '<select class="sel" data-act="npmonths">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (m) { return '<option value="' + m + '"' + (+S.np.months === m ? ' selected' : '') + '>' + m + '개월</option>'; }).join('') + '</select>' : '') +
    (S.np.mode === 'custom' ? '<input type="date" class="sel" data-act="npstart" value="' + esc(S.np.start) + '"> ~ <input type="date" class="sel" data-act="npend" value="' + esc(S.np.end) + '">' : '') + '</div></div>' +
    '<div class="card" style="padding:12px 22px 22px"><div class="tw"><table><thead><tr><th>선택</th><th>이름</th><th>센터</th>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '<th>새 계약기간</th><th>안내</th></tr></thead><tbody>' +
    (body || '<tr><td colspan="' + (cols.length + 5) + '" class="lbl">D데이가 &quot;신규&quot;인 사람이 없습니다.</td></tr>') + '</tbody></table></div></div>' +
    (first ? '<div class="card" style="background:#FBF1F7"><b>본보기 그대로 유지되는 부분</b><div class="note" style="margin-top:8px;background:#fff">본보기: ' + esc(first.contract.worker.name) + ' (' + esc(first.contract.rel.split('/').slice(-2).join('/')) + ')<br>' + (first.contract.terms || []).map(esc).join('<br>') + '<br><span class="msg">이름·주민번호·주소·계좌·기간·체결일만 바꾸고 나머지는 그대로입니다.</span></div></div>' : '') +
    '<div class="row" style="justify-content:space-between"><div>선택 <b>' + pk + '명</b>' + (S.busy ? ' · <span class="msg">' + esc(S.busy) + '</span>' : '') + '</div>' +
    '<button class="btn pri" data-act="makeNew"' + (pk ? '' : ' disabled') + '>계약서 만들기 · 확인 화면으로</button></div>';
}

// ---------- 만들기
function makeOne(kind, p) {
  var c = p.contract, o = { ns: p.nw[0], ne: p.nw[1], sign: p.sign, edits: p.edits };
  var r = HC.patchContract(c.u8, o), why = HC.verifyPatched(c.u8, r.bytes, o, r.applied);
  if (why) throw new Error(why);
  var ni = HC.readContractInfo(r.bytes), checks = [];
  var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  checks.push({ ok: ni.p1 && ni.p1[0] === p.nw[0] && ni.p1[1] === p.nw[1], t: '제1조 계약기간이 ' + fd(p.nw[0]) + ' ~ ' + fd(p.nw[1]) + '로 바뀜' });
  checks.push({ ok: ni.p2 === p.nw[0], t: '제2조 시작일이 새 계약 시작일과 같음' });
  checks.push({ ok: (ni.solo || []).length > 0 && ni.solo.every(function (x) { return x === p.sign; }), t: '체결일·약정서 날짜가 ' + fd(p.sign) + '로 바뀜' });
  checks.push({ ok: same(ni.terms, c.terms), t: '직책·임금·근로시간 등은 변경 없음' });
  var nm = kind === 'new' ? p.name : c.worker && c.worker.name;
  checks.push({ ok: !nm || nn(ni.worker && ni.worker.name) === nn(nm), t: '근로자 이름이 ' + nm + '으로 되어 있음' });
  var left = [];
  if (kind === 'new') {
    var g = function (f) { var e = p.edits.filter(function (x) { return x.field === f; })[0]; return e ? e.new : (f === 'birth' ? c.worker.birth : f === 'addr' ? c.worker.addr : f === 'acct' ? c.worker.acct : ''); };
    left = HC.findLeftovers(r.bytes, c, { name: p.name, rrn: g('rrn'), birth: g('birth'), addr: g('addr'), acct: g('acct') });
    checks.push({ ok: !left.length, t: left.length ? '본보기 사람 정보가 남아 있음: ' + left.join(', ') : '본보기(이전) 사람의 정보가 남아 있지 않음' });
  }
  var base = c.rel.split('/').pop(), parts = c.rel.split('/'), office = parts.length > 1 ? parts[parts.length - 2] : '';
  var fname = kind === 'new' ? HC.newHireFileName(base, c.worker.name, p.name, p.nw[0]) : HC.newFileName(base, p.nw[0]);
  return { kind: kind, name: p.name, office: p.office, p: p, bytes: r.bytes, fname: fname, zipPath: (kind === 'new' ? '신규입사/' : '갱신계약서/') + (office && kind !== 'new' ? office + '/' : '') + fname,
    oldParas: c.paras || [], newParas: ni.paras || [], checks: checks, bad: checks.some(function (x) { return !x.ok; }), saved: '' };
}
function makeList(kind, list) {
  var i = 0, out = [], errs = [];
  S.busy = '만드는 중...'; render();
  function step() {
    if (i >= list.length) return Promise.resolve();
    var p = list[i++]; S.busy = '만드는 중 ' + i + ' / ' + list.length + ' ' + p.name; render();
    return new Promise(function (r) { setTimeout(r, 0); }).then(function () {
      try { out.push(makeOne(kind, p)); } catch (e) { errs.push(p.name + ': ' + e.message); }
    }).then(step);
  }
  return step().then(function () {
    S.busy = ''; S.made = out; S.sel = 0; S.acks = {}; S.note = errs.length ? '만들지 못한 사람: ' + errs.join(' / ') : '';
    S.screen = 'confirm'; render(); window.scrollTo(0, 0);
  });
}

// ---------- 확인 화면: 바뀐 부분 비교
function toks(s) { return s.match(/\d+|[가-힣]+|[A-Za-z]+|\s+|./g) || []; }
function diffTok(a, b) {
  var x = toks(a), y = toks(b), n = x.length, m = y.length, L = [], i, j;
  for (i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
  for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  var oldH = '', newH = ''; i = 0; j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { oldH += esc(x[i]); newH += esc(y[j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { oldH += '<span class="del">' + esc(x[i]) + '</span>'; i++; }
    else { newH += '<span class="hl">' + esc(y[j]) + '</span>'; j++; }
  }
  while (i < n) { oldH += '<span class="del">' + esc(x[i++]) + '</span>'; }
  while (j < m) { newH += '<span class="hl">' + esc(y[j++]) + '</span>'; }
  return { o: oldH, n: newH };
}
function diffParas(m) {
  if (m._d) return m._d;
  var a = m.oldParas, b = m.newParas, ch = [], full = [];
  if (a.length === b.length) {
    b.forEach(function (t, i) { if (a[i] !== t) { var d = diffTok(a[i], t); ch.push(d); full.push(d.n); } else full.push(esc(t)); });
  } else {
    var sa = {}, sb = {}; a.forEach(function (t) { sa[t] = 1; }); b.forEach(function (t) { sb[t] = 1; });
    var ra = a.filter(function (t) { return !sb[t]; }), k = 0;
    b.forEach(function (t) {
      if (sa[t]) { full.push(esc(t)); return; }
      var old = ra[k++] || '', d = diffTok(old, t); ch.push(d); full.push(d.n);
    });
  }
  return (m._d = { changed: ch, full: full });
}
function rConfirm() {
  if (!S.made.length) return '<div class="card"><b>만든 계약서가 없습니다.</b><p class="msg">재직자 갱신 또는 신규 입사에서 사람을 골라 &quot;계약서 만들기&quot;를 누르세요.</p></div>';
  var m = S.made[S.sel] || S.made[0], d = diffParas(m), allAck = S.made.every(function (x, i) { return S.acks[i]; });
  var okAll = S.made.every(function (x) { return !x.bad; });
  var list = S.made.map(function (x, i) {
    return '<button class="nav' + (i === S.sel ? ' on' : '') + '" data-act="sel" data-i="' + i + '"><span style="display:flex;gap:8px;align-items:center"><b>' + esc(x.name) + '</b>' +
      (x.bad ? '<span class="tag bad">점검 실패</span>' : S.acks[i] ? '<span class="tag ok">확인함</span>' : '') + '</span><small>' + fd(x.p.nw[0]) + ' ~ ' + fd(x.p.nw[1]) + (x.kind === 'new' ? ' · 신규' : '') + '</small></button>';
  }).join('');
  var chg = d.changed.map(function (c) { return '<div class="chg"><span class="b">변경 전</span> ' + c.o + '<br><span class="b">변경 후</span> ' + c.n + '</div>'; }).join('');
  var checks = m.checks.map(function (c) { return '<div class="row" style="gap:10px;margin-bottom:6px"><span class="tag ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '통과' : '실패') + '</span><span style="font-size:14px">' + esc(c.t) + '</span></div>'; }).join('') +
    m.p.warns.filter(function (w) { return w.indexOf('본보기:') !== 0; }).map(function (w) { return '<div class="row" style="gap:10px;margin-bottom:6px"><span class="tag warn">주의</span><span style="font-size:14px">' + esc(w) + '</span></div>'; }).join('');
  var dis = m.bad || !S.acks[S.sel];
  return (S.note ? '<div class="note">' + esc(S.note) + '</div>' : '') +
    '<div class="split"><div class="card list"><b>만든 계약서 ' + S.made.length + '건</b>' + list + '</div>' +
    '<div style="flex:1 1 520px;min-width:0;display:flex;flex-direction:column;gap:18px">' +
    '<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:12px"><b style="font-size:18px">' + esc(m.name) + ' 계약서 (' + esc(m.fname) + ')</b><span class="tag new">실제 줄바꿈은 한글에서 확인</span></div>' +
    '<div style="margin-bottom:6px"><b>바뀐 곳 ' + d.changed.length + '곳</b></div>' + chg +
    '<details style="margin-top:10px"><summary>계약서 전체 글자 보기</summary><div class="doc" style="margin-top:8px">' + d.full.map(function (h) { return '<p>' + h + '</p>'; }).join('') + '</div></details></div>' +
    '<div class="cards3" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="card"><b>자동 점검</b><div style="margin-top:12px">' + checks + '</div></div>' +
    '<div class="card"><b>내려받기 · 저장</b><div class="row" style="margin:14px 0"><button class="ck' + (S.acks[S.sel] ? ' on' : '') + '" data-act="ack" aria-label="확인했습니다">' + (S.acks[S.sel] ? '✓' : '') + '</button><span>바뀐 부분을 확인했습니다</span></div>' +
    '<div class="row" style="gap:10px"><button class="btn pri" data-act="dlone"' + (dis ? ' disabled' : '') + '>이 파일 받기</button>' +
    '<button class="btn sec" data-act="saveone"' + (dis ? ' disabled' : '') + '>드라이브에 저장</button></div>' +
    (m.saved ? '<p class="msg">' + esc(m.saved) + '</p>' : '') +
    '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><div class="row" style="gap:10px"><button class="btn ghost" data-act="ackall">모두 확인함으로 표시</button>' +
    '<button class="btn pri" data-act="dlall"' + (allAck && okAll ? '' : ' disabled') + '>전체 zip 받기</button><button class="btn sec" data-act="saveall"' + (allAck && okAll ? '' : ' disabled') + '>전체 드라이브 저장</button></div>' +
    (S.busy ? '<p class="msg">' + esc(S.busy) + '</p>' : '') + '</div></div></div></div>';
}

// ---------- 내려받기·저장
function dl(blob, name) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
function saveDrive(m) {
  return api('/api/save?name=' + encodeURIComponent(m.fname), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: m.bytes })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); m.saved = '드라이브(작업완료 폴더)에 저장됨 ' + new Date().toLocaleTimeString('ko-KR'); }); })
    .catch(function (e) { m.saved = '저장 실패: ' + e.message; });
}

// ---------- 이벤트
function allowed() { return true; }
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-act]'); if (!t || t.tagName === 'SELECT' || t.tagName === 'INPUT') return;
  var a = t.dataset.act, n = +t.dataset.n;
  if (a === 'go') { S.screen = t.dataset.v; render(); }
  else if (a === 'logout') { fetch('/api/logout', { credentials: 'same-origin' }).then(function () { S.loaded = false; S.contracts = []; S.made = []; showLogin(); }); }
  else if (a === 'reload') { loadAll(); }
  else if (a === 'pick') { S.picked[n] = !S.picked[n]; render(); }
  else if (a === 'npick') { S.npicked[n] = !S.npicked[n]; render(); }
  else if (a === 'dqset') { S.q = +t.dataset.q; render(); }
  else if (a === 'pickall') { renewRows().forEach(function (r) { if (planRenew(r).status !== 'no') S.picked[r.n] = true; }); render(); }
  else if (a === 'pickclear') { S.picked = {}; render(); }
  else if (a === 'applybatch') { renewRows().forEach(function (r) { if (S.picked[r.n]) S.months[r.n] = S.batch === 'same' ? 0 : +S.batch; }); render(); }
  else if (a === 'tplmode') { S.tplMode = t.dataset.m; if (S.tplMode === 'fixed' && !S.tplRel && tplList().length) S.tplRel = tplList()[0].rel; render(); }
  else if (a === 'npmode') { S.np.mode = t.dataset.m; render(); }
  else if (a === 'makeRenew') {
    var ps = renewRows().filter(function (r) { return S.picked[r.n]; }).map(planRenew).filter(function (p) { return p.status !== 'no'; });
    if (ps.length) makeList('renew', ps);
  } else if (a === 'makeNew') {
    var ns = newRows().filter(function (r) { return S.npicked[r.n]; }).map(planNew).filter(function (p) { return p.status !== 'no'; });
    if (ns.length) makeList('new', ns);
  } else if (a === 'sel') { S.sel = +t.dataset.i; render(); }
  else if (a === 'ack') { S.acks[S.sel] = !S.acks[S.sel]; render(); }
  else if (a === 'ackall') { S.made.forEach(function (x, i) { if (!x.bad) S.acks[i] = true; }); render(); }
  else if (a === 'dlone') { var m = S.made[S.sel]; dl(new Blob([m.bytes]), m.fname); }
  else if (a === 'saveone') { var m1 = S.made[S.sel]; S.busy = '저장 중...'; render(); saveDrive(m1).then(function () { S.busy = ''; render(); }); }
  else if (a === 'dlall') {
    var z = new JSZip(), used = {};
    S.made.forEach(function (x) { var p = x.zipPath; while (used[p]) p = p.replace(/\.hwp$/i, '_2.hwp'); used[p] = 1; z.file(p, x.bytes); });
    z.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(function (b) { var d = new Date(); dl(b, '계약서_' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.zip'); });
  } else if (a === 'saveall') {
    var i = 0; S.busy = '저장 중...'; render();
    (function next() { if (i >= S.made.length) { S.busy = '전체 저장 시도 끝'; render(); return; } var m2 = S.made[i++]; S.busy = '저장 중 ' + i + ' / ' + S.made.length; render(); saveDrive(m2).then(next); })();
  }
});
document.addEventListener('change', function (e) {
  var t = e.target; if (!t.dataset || !t.dataset.act) return;
  var a = t.dataset.act, n = +t.dataset.n;
  if (a === 'dq') { var m = /(\d+)/.exec(t.value); S.q = m ? Math.min(365, +m[1]) : S.q; render(); }
  else if (a === 'personal') { S.doPersonal = t.checked; render(); }
  else if (a === 'batch') { S.batch = t.value === 'same' ? 'same' : +t.value; render(); }
  else if (a === 'months') { S.months[n] = +t.value; render(); }
  else if (a === 'tpl') { S.tplRel = t.value; render(); }
  else if (a === 'npmonths') { S.np.months = +t.value; render(); }
  else if (a === 'npstart') { S.np.start = t.value; render(); }
  else if (a === 'npend') { S.np.end = t.value; render(); }
  else if (a === 'nedit') { (S.nedit[n] = S.nedit[n] || {})[t.dataset.col] = t.value.trim(); render(); }
});
document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.act === 'dq') e.target.blur(); });

start();
})();
