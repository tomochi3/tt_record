'use strict';
(function () {
  const S = window.TTScoring;
  const STORE_KEY = 'ttrecord.v1';
  const LIVE_KEY = 'ttrecord.live';

  // ---------- データ保存（localStorage） ----------

  function loadDb() {
    const empty = { settings: { myName: '自分' }, matches: [] };
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return empty;
      const d = JSON.parse(raw);
      return {
        settings: Object.assign({}, empty.settings, d.settings),
        matches: Array.isArray(d.matches) ? d.matches.filter(isMatchLike) : [],
      };
    } catch (e) {
      return empty;
    }
  }

  function saveDb() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, settings: db.settings, matches: db.matches }));
    } catch (e) {
      toast('保存に失敗しました');
    }
  }

  function loadLive() {
    try {
      const raw = localStorage.getItem(LIVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveLive() {
    try {
      if (live) localStorage.setItem(LIVE_KEY, JSON.stringify(live));
      else localStorage.removeItem(LIVE_KEY);
    } catch (e) {
      /* 端末のストレージが使えなくても試合は続けられる */
    }
  }

  function isMatchLike(m) {
    return m && typeof m === 'object' && typeof m.id === 'string' &&
      Number.isInteger(m.mySets) && Number.isInteger(m.oppSets);
  }

  // ---------- ユーティリティ ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function fmtDate(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y) return '';
    const wd = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
    return `${m}/${d}(${wd})`;
  }

  function pct(won, total) {
    return total ? `${((won / total) * 100).toFixed(1)}%` : '—';
  }

  function sortedMatches() {
    return db.matches.slice().sort((a, b) =>
      (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function uniqueValues(key) {
    const seen = new Map();
    for (const m of sortedMatches()) {
      const v = (m[key] || '').trim();
      if (v && !seen.has(v)) seen.set(v, true);
    }
    return [...seen.keys()];
  }

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  function buzz() {
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function myName() {
    return db.settings.myName || '自分';
  }

  // ---------- 状態 ----------

  const db = loadDb();
  let live = loadLive();
  let view = 'list';
  let params = {};
  let draft = null;
  let listQuery = '';
  let statsRange = 'all';

  function go(v, p) {
    view = v;
    params = p || {};
    if (v === 'new') {
      if (live) {
        view = 'live';
      } else if (!params.keepDraft || !draft || draft.id) {
        draft = newDraft();
      }
    }
    if (v === 'edit') {
      const m = db.matches.find((x) => x.id === params.id);
      if (!m) return go('list');
      draft = Object.assign({}, m, { result: [m.mySets, m.oppSets] });
    }
    render();
    window.scrollTo(0, 0);
  }

  function newDraft() {
    return {
      date: today(),
      opponent: '',
      event: '',
      bestOf: 5,
      mode: 'simple', // デフォルトはセット数のみ記録
      result: null,
      firstServer: 'me',
      memo: '',
    };
  }

  // ---------- 描画 ----------

  const main = document.getElementById('main');

  function render() {
    const views = { list: viewList, new: viewForm, edit: viewForm, live: viewLive, match: viewMatch, stats: viewStats, settings: viewSettings };
    main.innerHTML = (views[view] || viewList)();
    document.body.classList.toggle('is-live', view === 'live');
    const activeTab = view === 'edit' || view === 'live' ? 'new' : view === 'match' ? 'list' : view;
    for (const b of document.querySelectorAll('#tabbar button')) {
      b.classList.toggle('active', b.dataset.view === activeTab);
    }
    const tabNew = document.querySelector('#tabbar [data-view="new"]');
    tabNew.classList.toggle('has-live', !!live);
    afterRender();
  }

  function resultBadge(m) {
    const win = m.mySets > m.oppSets;
    return `<span class="badge ${win ? 'win' : 'lose'}">${win ? '勝' : '負'}</span>`;
  }

  function liveBanner() {
    if (!live || view === 'live') return '';
    const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    return `<button type="button" class="live-banner" data-action="nav" data-view="live">
      <span class="dot"></span>試合中: vs ${esc(live.opponent)}（${c.mySets}-${c.oppSets}）<span class="go">再開 ›</span>
    </button>`;
  }

  // 履歴
  function viewList() {
    const all = sortedMatches();
    const q = listQuery.trim().toLowerCase();
    const items = q
      ? all.filter((m) => `${m.opponent} ${m.event} ${m.memo}`.toLowerCase().includes(q))
      : all;
    const wins = all.filter((m) => m.mySets > m.oppSets).length;

    let html = liveBanner();
    html += `<section class="card summary">
      <div><div class="big">${wins}<small>勝</small> ${all.length - wins}<small>敗</small></div><div class="muted">通算 ${all.length}試合</div></div>
      <div class="rate"><div class="big">${pct(wins, all.length)}</div><div class="muted">勝率</div></div>
    </section>`;

    if (!all.length) {
      html += `<div class="empty">
        <p>まだ記録がありません。</p>
        <button type="button" class="btn primary" data-action="nav" data-view="new">最初の試合を記録する</button>
      </div>`;
      return html;
    }

    html += `<input type="search" class="search" id="listSearch" placeholder="相手・大会名・メモで検索" value="${esc(listQuery)}">`;

    let month = '';
    html += '<ul class="match-list">';
    for (const m of items) {
      const mo = (m.date || '').slice(0, 7);
      if (mo !== month) {
        month = mo;
        const [y, mm] = mo.split('-');
        html += `<li class="month">${y ? `${y}年${Number(mm)}月` : '日付なし'}</li>`;
      }
      html += `<li><button type="button" class="match-item" data-action="open" data-id="${esc(m.id)}">
        ${resultBadge(m)}
        <span class="score">${m.mySets}-${m.oppSets}</span>
        <span class="who">
          <span class="opp">vs ${esc(m.opponent)}</span>
          ${m.event ? `<span class="event">${esc(m.event)}</span>` : ''}
        </span>
        <span class="meta">${m.mode === 'detail' ? '<span class="chip">詳細</span>' : ''}<span class="date">${fmtDate(m.date)}</span></span>
      </button></li>`;
    }
    html += '</ul>';
    if (!items.length) html += '<p class="empty">該当する試合がありません。</p>';
    return html;
  }

  function segmented(name, options, value) {
    return `<div class="seg" role="radiogroup">${options.map(([v, label]) =>
      `<button type="button" role="radio" aria-checked="${String(v) === String(value)}" class="${String(v) === String(value) ? 'on' : ''}" data-action="draft" data-key="${name}" data-value="${esc(v)}">${label}</button>`).join('')}</div>`;
  }

  function datalist(id, values) {
    return `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  }

  // 新規記録・編集フォーム
  function viewForm() {
    const d = draft;
    const editing = view === 'edit';
    const detailLocked = editing && d.mode === 'detail';
    let html = `<h2 class="view-title">${editing ? '試合を編集' : '試合を記録'}</h2>`;

    if (!editing) {
      html += `<div class="mode-switch">
        ${segmented('mode', [['simple', 'セット数のみ'], ['detail', '詳細（1点ごと）']], d.mode)}
        <p class="hint">${d.mode === 'simple'
          ? '最終的なゲームカウントだけを記録します。'
          : '試合中に1点ずつ入力します。サーブ順やゲームポイントも自動で表示します。'}</p>
      </div>`;
    }

    html += `<div class="card form">
      <label>日付<input type="date" data-field="date" value="${esc(d.date)}"></label>
      <label>対戦相手<input type="text" data-field="opponent" list="dl-opp" placeholder="例: 山田 太郎" value="${esc(d.opponent)}" autocomplete="off"></label>
      ${datalist('dl-opp', uniqueValues('opponent'))}
      <label>大会・練習名 <span class="opt">任意</span><input type="text" data-field="event" list="dl-event" placeholder="例: 市民大会 / 練習試合" value="${esc(d.event)}" autocomplete="off"></label>
      ${datalist('dl-event', uniqueValues('event'))}
      <div class="field"><span class="label">試合形式</span>
        ${detailLocked
          ? `<div class="locked">${d.bestOf}ゲームマッチ</div>`
          : segmented('bestOf', [[3, '3ゲーム'], [5, '5ゲーム'], [7, '7ゲーム']], d.bestOf)}
      </div>`;

    if (d.mode === 'simple') {
      const rs = S.possibleResults(d.bestOf);
      const sel = d.result ? `${d.result[0]}-${d.result[1]}` : '';
      html += `<div class="field"><span class="label">結果（${esc(myName())} - 相手）</span>
        <div class="results">${rs.map(([a, b]) => {
          const k = `${a}-${b}`;
          return `<button type="button" class="result-btn ${a > b ? 'w' : 'l'} ${k === sel ? 'on' : ''}" data-action="pick-result" data-me="${a}" data-opp="${b}">
            <span>${a > b ? '勝' : '負'}</span>${a} - ${b}</button>`;
        }).join('')}</div>
      </div>`;
    } else if (detailLocked) {
      html += `<div class="field"><span class="label">結果</span><div class="locked">${d.mySets} - ${d.oppSets}（詳細モードで記録した試合はスコアを変更できません）</div></div>`;
    } else {
      html += `<div class="field"><span class="label">最初のサーブ</span>
        ${segmented('firstServer', [['me', esc(myName())], ['opp', '相手']], d.firstServer)}
      </div>`;
    }

    html += `<label>メモ <span class="opt">任意</span><textarea data-field="memo" rows="3" placeholder="戦型、気づいたことなど">${esc(d.memo)}</textarea></label>
    </div>`;

    if (d.mode === 'detail' && !editing) {
      html += `<button type="button" class="btn primary block" data-action="start-live">試合開始</button>`;
    } else {
      html += `<button type="button" class="btn primary block" data-action="save-form">${editing ? '変更を保存' : '保存'}</button>`;
    }
    if (editing) {
      html += `<button type="button" class="btn block" data-action="open" data-id="${esc(d.id)}">キャンセル</button>`;
    }
    return html;
  }

  // 詳細モードのスコアボード
  function viewLive() {
    if (!live) return viewList();
    const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    const names = { me: myName(), opp: live.opponent };

    const chips = c.completedGames.map((g) =>
      `<span class="game-chip ${g.winner === 'me' ? 'w' : 'l'}">${g.me}-${g.opp}</span>`).join('');

    let html = `<div class="live-head">
      <div class="live-sets">
        <span class="name me">${esc(names.me)}</span>
        <span class="sets">${c.mySets} - ${c.oppSets}</span>
        <span class="name opp">${esc(names.opp)}</span>
      </div>
      <div class="live-info">${live.bestOf}ゲームマッチ${live.event ? ` ・ ${esc(live.event)}` : ''}</div>
      <div class="game-chips">${chips || '<span class="muted">第1ゲーム</span>'}</div>
    </div>`;

    if (c.finished) {
      const win = c.winner === 'me';
      html += `<div class="card finished ${win ? 'win' : 'lose'}">
        <div class="finished-title">${win ? '勝利！' : '敗戦'}</div>
        <div class="finished-score">${c.mySets} - ${c.oppSets}</div>
        <div class="finished-games">${c.games.map((g) => `${g.me}-${g.opp}`).join(' / ')}</div>
        <button type="button" class="btn primary block" data-action="live-save">記録を保存</button>
        <button type="button" class="btn block" data-action="live-undo">1点戻す</button>
      </div>`;
      return html;
    }

    const cur = c.current;
    const label = (side) => {
      if (cur.matchPoint === side) return '<span class="flag mp">マッチポイント</span>';
      if (cur.gamePoint === side) return '<span class="flag gp">ゲームポイント</span>';
      return '<span class="flag"></span>';
    };
    const pad = (side) => `<button type="button" class="pad ${side}" data-action="point" data-side="${side}" aria-label="${esc(names[side])}に1点">
        <span class="pad-name">${esc(names[side])}</span>
        <span class="pad-score">${cur[side]}</span>
        <span class="serve ${cur.server === side ? 'on' : ''}">● サーブ</span>
        ${label(side)}
      </button>`;

    html += `<div class="game-label">第${cur.gameIndex + 1}ゲーム${cur.me >= 10 && cur.opp >= 10 ? ' ・ ジュース' : ''}</div>
      <div class="pads">${pad('me')}${pad('opp')}</div>
      <div class="live-actions">
        <button type="button" class="btn" data-action="live-undo" ${live.rally.length ? '' : 'disabled'}>↶ 1点戻す</button>
        <button type="button" class="btn" data-action="live-swap-serve" title="最初のサーブを入れ替える">⇄ サーブ修正</button>
      </div>
      <div class="live-actions">
        <button type="button" class="btn ghost" data-action="nav" data-view="list">一時中断</button>
        <button type="button" class="btn ghost danger" data-action="live-discard">試合を破棄</button>
      </div>`;
    return html;
  }

  // 試合詳細
  function viewMatch() {
    const m = db.matches.find((x) => x.id === params.id);
    if (!m) return viewList();
    const win = m.mySets > m.oppSets;
    let html = `<button type="button" class="back" data-action="nav" data-view="list">‹ 履歴</button>
      <section class="card match-head ${win ? 'win' : 'lose'}">
        <div class="mh-result">${win ? '勝ち' : '負け'}</div>
        <div class="mh-score">${m.mySets} - ${m.oppSets}</div>
        <div class="mh-opp">vs ${esc(m.opponent)}</div>
        <div class="muted">${esc(m.date)}${m.event ? ` ・ ${esc(m.event)}` : ''} ・ ${m.bestOf}ゲームマッチ ・ ${m.mode === 'detail' ? '詳細記録' : 'セット数のみ'}</div>
      </section>`;

    if (m.mode === 'detail' && m.rally) {
      const c = S.computeMatch(m.bestOf, m.firstServer, m.rally);
      const st = S.rallyStats(c);
      html += `<section class="card"><h3>ゲームスコア</h3><table class="games">
        <tr><th></th>${c.games.map((g) => `<th>${g.index + 1}</th>`).join('')}</tr>
        <tr><td>${esc(myName())}</td>${c.games.map((g) => `<td class="${g.winner === 'me' ? 'won' : ''}">${g.me}</td>`).join('')}</tr>
        <tr><td>${esc(m.opponent)}</td>${c.games.map((g) => `<td class="${g.winner === 'opp' ? 'won' : ''}">${g.opp}</td>`).join('')}</tr>
      </table></section>`;

      html += `<section class="card"><h3>データ</h3><dl class="kv">
        <dt>総得点</dt><dd>${st.pointsWon} / ${st.pointsTotal}（${pct(st.pointsWon, st.pointsTotal)}）</dd>
        <dt>自分のサーブ時の得点</dt><dd>${st.serveWon} / ${st.serveTotal}（${pct(st.serveWon, st.serveTotal)}）</dd>
        <dt>相手のサーブ時の得点</dt><dd>${st.receiveWon} / ${st.receiveTotal}（${pct(st.receiveWon, st.receiveTotal)}）</dd>
        <dt>最大連続得点</dt><dd>自分 ${st.longestRun.me} / 相手 ${st.longestRun.opp}</dd>
        ${st.deuceGames ? `<dt>ジュース</dt><dd>${st.deuceWon}勝 ${st.deuceGames - st.deuceWon}敗</dd>` : ''}
      </dl></section>`;

      html += `<section class="card"><h3>得点の流れ</h3>
        <p class="legend"><span class="pt me"></span>自分の得点 <span class="pt opp"></span>相手の得点 <span class="pt me sv"></span>枠付き＝自分のサーブ</p>
        ${c.games.map((g) => `<div class="flow"><div class="flow-label">第${g.index + 1}G <b>${g.me}-${g.opp}</b></div>
          <div class="flow-points">${g.points.map((p) => `<span class="pt ${p.winner}${p.server === 'me' ? ' sv' : ''}"></span>`).join('')}</div></div>`).join('')}
      </section>`;
    }

    if (m.memo) html += `<section class="card"><h3>メモ</h3><p class="memo">${esc(m.memo)}</p></section>`;

    html += `<div class="row-actions">
      <button type="button" class="btn" data-action="nav" data-view="edit" data-id="${esc(m.id)}">編集</button>
      <button type="button" class="btn danger" data-action="delete" data-id="${esc(m.id)}">削除</button>
    </div>`;
    return html;
  }

  // 成績
  function inRange(m) {
    if (statsRange === 'all') return true;
    const d = new Date();
    if (statsRange === 'year') return (m.date || '').startsWith(String(d.getFullYear()));
    const days = Number(statsRange);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - days + 1);
    const iso = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
    return (m.date || '') >= iso;
  }

  function viewStats() {
    const ms = sortedMatches().filter(inRange);
    let html = `<h2 class="view-title">成績</h2>
      <select id="statsRange" class="range">
        ${[['all', '全期間'], ['year', '今年'], ['90', '直近90日'], ['30', '直近30日']].map(([v, l]) =>
          `<option value="${v}" ${v === statsRange ? 'selected' : ''}>${l}</option>`).join('')}
      </select>`;

    if (!ms.length) return html + '<p class="empty">この期間の記録はありません。</p>';

    const wins = ms.filter((m) => m.mySets > m.oppSets).length;
    const setsWon = ms.reduce((a, m) => a + m.mySets, 0);
    const setsLost = ms.reduce((a, m) => a + m.oppSets, 0);
    const fullGame = ms.filter((m) => m.mySets + m.oppSets === m.bestOf);
    const fullWins = fullGame.filter((m) => m.mySets > m.oppSets).length;

    html += `<div class="tiles">
      <div class="tile"><div class="t-val">${ms.length}</div><div class="t-lbl">試合</div></div>
      <div class="tile"><div class="t-val">${wins}-${ms.length - wins}</div><div class="t-lbl">勝-敗</div></div>
      <div class="tile"><div class="t-val">${pct(wins, ms.length)}</div><div class="t-lbl">勝率</div></div>
      <div class="tile"><div class="t-val">${pct(setsWon, setsWon + setsLost)}</div><div class="t-lbl">ゲーム取得率</div></div>
    </div>`;

    const recent = ms.slice(0, 10).reverse();
    html += `<section class="card"><h3>直近${recent.length}試合 <span class="muted small">（左が古い）</span></h3>
      <div class="form-dots">${recent.map((m) => `<span class="fd ${m.mySets > m.oppSets ? 'w' : 'l'}" title="${esc(m.date)} vs ${esc(m.opponent)} ${m.mySets}-${m.oppSets}">${m.mySets > m.oppSets ? '○' : '●'}</span>`).join('')}</div>
      ${fullGame.length ? `<p class="muted small">フルゲームの試合: ${fullWins}勝 ${fullGame.length - fullWins}敗</p>` : ''}
    </section>`;

    // 詳細モードで記録した試合の集計
    const detail = ms.filter((m) => m.mode === 'detail' && m.rally);
    if (detail.length) {
      const agg = { serveWon: 0, serveTotal: 0, receiveWon: 0, receiveTotal: 0, pointsWon: 0, pointsTotal: 0, deuceGames: 0, deuceWon: 0 };
      for (const m of detail) {
        const st = S.rallyStats(S.computeMatch(m.bestOf, m.firstServer, m.rally));
        for (const k of Object.keys(agg)) agg[k] += st[k];
      }
      html += `<section class="card"><h3>1点ごとのデータ <span class="muted small">（詳細記録 ${detail.length}試合）</span></h3><dl class="kv">
        <dt>総得点率</dt><dd>${pct(agg.pointsWon, agg.pointsTotal)}</dd>
        <dt>自分のサーブ時の得点率</dt><dd>${pct(agg.serveWon, agg.serveTotal)}</dd>
        <dt>相手のサーブ時の得点率</dt><dd>${pct(agg.receiveWon, agg.receiveTotal)}</dd>
        <dt>ジュースの勝敗</dt><dd>${agg.deuceGames ? `${agg.deuceWon}勝 ${agg.deuceGames - agg.deuceWon}敗` : '—'}</dd>
      </dl></section>`;
    }

    html += groupTable('対戦相手別', ms, 'opponent');
    if (ms.some((m) => m.event)) html += groupTable('大会・練習別', ms, 'event');
    return html;
  }

  function groupTable(title, ms, key) {
    const groups = new Map();
    for (const m of ms) {
      const k = (m[key] || '').trim() || '（未入力）';
      const g = groups.get(k) || { n: 0, w: 0, sw: 0, sl: 0 };
      g.n++;
      if (m.mySets > m.oppSets) g.w++;
      g.sw += m.mySets;
      g.sl += m.oppSets;
      groups.set(k, g);
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0], 'ja'));
    return `<section class="card"><h3>${title}</h3><table class="table">
      <thead><tr><th>${key === 'opponent' ? '相手' : '名前'}</th><th>勝-敗</th><th>勝率</th><th>ゲーム</th></tr></thead>
      <tbody>${rows.map(([k, g]) => `<tr><td>${esc(k)}</td><td>${g.w}-${g.n - g.w}</td><td>${pct(g.w, g.n)}</td><td>${g.sw}-${g.sl}</td></tr>`).join('')}</tbody>
    </table></section>`;
  }

  // 設定
  function viewSettings() {
    return `<h2 class="view-title">設定</h2>
      <div class="card form">
        <label>自分の名前（スコアボードに表示）<input type="text" id="myName" value="${esc(db.settings.myName)}" maxlength="20"></label>
      </div>
      <div class="card">
        <h3>データ</h3>
        <p class="muted small">記録はこの端末のブラウザ内に保存されます。機種変更やバックアップにはエクスポートを使ってください。</p>
        <button type="button" class="btn block" data-action="export">エクスポート（JSON）</button>
        <label class="btn block file-btn">インポート（JSON）<input type="file" id="importFile" accept="application/json,.json"></label>
        <button type="button" class="btn block danger" data-action="wipe">すべての記録を削除</button>
      </div>
      <p class="muted small center">保存済み ${db.matches.length}試合</p>`;
  }

  // ---------- 描画後のイベント（入力欄） ----------

  function afterRender() {
    for (const el of main.querySelectorAll('[data-field]')) {
      el.addEventListener('input', () => { draft[el.dataset.field] = el.value; });
    }
    const search = document.getElementById('listSearch');
    if (search) {
      search.addEventListener('input', () => {
        listQuery = search.value;
        const pos = search.selectionStart;
        render();
        const s2 = document.getElementById('listSearch');
        s2.focus();
        s2.setSelectionRange(pos, pos);
      });
    }
    const range = document.getElementById('statsRange');
    if (range) range.addEventListener('change', () => { statsRange = range.value; render(); });
    const name = document.getElementById('myName');
    if (name) {
      name.addEventListener('change', () => {
        db.settings.myName = name.value.trim() || '自分';
        saveDb();
        toast('保存しました');
      });
    }
    const file = document.getElementById('importFile');
    if (file) file.addEventListener('change', () => importFile(file.files[0]));
  }

  // ---------- 操作 ----------

  function validateDraft() {
    draft.opponent = (draft.opponent || '').trim();
    draft.event = (draft.event || '').trim();
    if (!draft.opponent) {
      toast('対戦相手を入力してください');
      return false;
    }
    if (!draft.date) {
      toast('日付を入力してください');
      return false;
    }
    return true;
  }

  function saveForm() {
    if (!validateDraft()) return;
    const d = draft;
    if (d.mode === 'simple' && (!d.result || !S.isValidResult(d.bestOf, d.result[0], d.result[1]))) {
      toast('結果を選んでください');
      return;
    }
    if (view === 'edit') {
      const m = db.matches.find((x) => x.id === d.id);
      if (!m) return go('list');
      Object.assign(m, { date: d.date, opponent: d.opponent, event: d.event, memo: d.memo, updatedAt: Date.now() });
      if (m.mode !== 'detail') Object.assign(m, { bestOf: d.bestOf, mySets: d.result[0], oppSets: d.result[1] });
      saveDb();
      toast('更新しました');
      go('match', { id: m.id });
      return;
    }
    const m = {
      id: uid(),
      date: d.date,
      opponent: d.opponent,
      event: d.event,
      bestOf: d.bestOf,
      mode: 'simple',
      mySets: d.result[0],
      oppSets: d.result[1],
      memo: d.memo,
      createdAt: Date.now(),
    };
    db.matches.push(m);
    saveDb();
    draft = null;
    toast(`${m.mySets > m.oppSets ? '勝ち' : '負け'}（${m.mySets}-${m.oppSets}）を記録しました`);
    go('list');
  }

  function startLive() {
    if (!validateDraft()) return;
    live = {
      date: draft.date,
      opponent: draft.opponent,
      event: draft.event,
      memo: draft.memo,
      bestOf: draft.bestOf,
      firstServer: draft.firstServer,
      rally: '',
      startedAt: Date.now(),
    };
    draft = null;
    saveLive();
    go('live');
  }

  function addPoint(side) {
    const before = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    if (before.finished) return;
    live.rally += side === 'me' ? 'm' : 'o';
    saveLive();
    buzz();
    const after = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    if (!after.finished && after.completedGames.length > before.completedGames.length) {
      const g = after.completedGames[after.completedGames.length - 1];
      toast(`第${g.index + 1}ゲーム ${g.me}-${g.opp} ${g.winner === 'me' ? '取得' : '失う'}`);
    }
    render();
  }

  function saveLiveMatch() {
    const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    if (!c.finished) return;
    const m = {
      id: uid(),
      date: live.date,
      opponent: live.opponent,
      event: live.event,
      bestOf: live.bestOf,
      mode: 'detail',
      mySets: c.mySets,
      oppSets: c.oppSets,
      games: c.games.map((g) => ({ me: g.me, opp: g.opp })),
      firstServer: live.firstServer,
      // 試合終了後の余分な入力は保存しない
      rally: c.games.map((g) => g.points.map((p) => (p.winner === 'me' ? 'm' : 'o')).join('')).join(''),
      memo: live.memo,
      createdAt: Date.now(),
    };
    db.matches.push(m);
    saveDb();
    live = null;
    saveLive();
    toast('試合を保存しました');
    go('match', { id: m.id });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings: db.settings, matches: db.matches }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tt-record-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = (Array.isArray(data) ? data : data.matches || []).filter(isMatchLike);
        const ids = new Set(db.matches.map((m) => m.id));
        const added = incoming.filter((m) => !ids.has(m.id));
        db.matches.push(...added);
        saveDb();
        toast(`${added.length}試合を読み込みました`);
        render();
      } catch (e) {
        toast('ファイルを読み込めませんでした');
      }
    };
    reader.readAsText(file);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled) return;
    const a = t.dataset.action;
    switch (a) {
      case 'nav':
        go(t.dataset.view, { id: t.dataset.id });
        break;
      case 'open':
        go('match', { id: t.dataset.id });
        break;
      case 'draft': {
        const k = t.dataset.key;
        let v = t.dataset.value;
        if (k === 'bestOf') {
          v = Number(v);
          if (draft.result && !S.isValidResult(v, draft.result[0], draft.result[1])) draft.result = null;
        }
        draft[k] = v;
        render();
        break;
      }
      case 'pick-result':
        draft.result = [Number(t.dataset.me), Number(t.dataset.opp)];
        render();
        break;
      case 'save-form':
        saveForm();
        break;
      case 'start-live':
        startLive();
        break;
      case 'point':
        addPoint(t.dataset.side);
        break;
      case 'live-undo':
        if (live && live.rally) {
          const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
          // 試合終了後に押された余分な点があれば先に取り除く
          const used = c.games.reduce((n, g) => n + g.points.length, 0);
          live.rally = live.rally.slice(0, used - 1);
          saveLive();
          render();
        }
        break;
      case 'live-swap-serve':
        live.firstServer = S.other(live.firstServer);
        saveLive();
        toast('サーブ順を入れ替えました');
        render();
        break;
      case 'live-discard':
        if (confirm('この試合の記録を破棄しますか？')) {
          live = null;
          saveLive();
          go('list');
        }
        break;
      case 'live-save':
        saveLiveMatch();
        break;
      case 'delete':
        if (confirm('この試合を削除しますか？')) {
          db.matches = db.matches.filter((m) => m.id !== t.dataset.id);
          saveDb();
          toast('削除しました');
          go('list');
        }
        break;
      case 'export':
        exportData();
        break;
      case 'wipe':
        if (confirm('すべての記録を削除します。元に戻せません。よろしいですか？')) {
          db.matches = [];
          saveDb();
          toast('削除しました');
          render();
        }
        break;
      default:
        break;
    }
  });

  // 入力中のフォームから別タブへ移動しても、下書きは「記録」タブで残す
  document.querySelector('#tabbar [data-view="new"]').addEventListener('click', (e) => {
    e.stopPropagation();
    go('new', { keepDraft: view !== 'new' && view !== 'edit' });
  });

  go(live ? 'live' : 'list');
})();
