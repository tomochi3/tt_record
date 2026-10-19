// 証拠の確認ページ：保存された証拠ファイル・刻印の元データの署名を、端末の中だけで確かめる
(function () {
  'use strict';
  const LG = window.TTLedger;
  const out = document.getElementById('result');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // 結果の表示：見出し・ひとことの説明・項目・次にできること（すべて文字列で受け取り、ここでエスケープする）
  // sections: 結果の下に続ける小見出しつきの段落 { h, lead?, items?, head?, rows?, note? }
  function show(ok, title, { lead = '', items = [], next = '', fp = '', sections = [] } = {}) {
    const dl = (list) => (list && list.length ? `<dl class="verify-items">${list.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '');
    const sec = (x) => `<div class="verify-section">
        <h4>${esc(x.h)}</h4>
        ${x.lead ? `<p>${esc(x.lead)}</p>` : ''}
        ${dl(x.items)}
        ${x.rows && x.rows.length ? `<table class="verify-table"><thead><tr>${x.head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${x.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
        ${x.note ? `<p class="small muted">${esc(x.note)}</p>` : ''}
      </div>`;
    out.innerHTML = `<section class="card verify-result ${ok ? 'ok' : 'ng'}">
      <h3>${ok ? '✅' : '⚠'} ${esc(title)}</h3>
      ${lead ? `<p>${esc(lead)}</p>` : ''}
      ${dl(items)}
      ${sections.map(sec).join('')}
      ${next ? `<p class="small verify-next">${esc(next)}</p>` : ''}
      ${fp ? `<p class="small muted">「鍵」は端末ごとの電子的なはんこで、${esc(fp)} はその番号（指紋）です。アプリの相手ごとの成績ページ「📒 帳簿」のいちばん下に出る「鍵の指紋」と同じなら、その人の端末が作ったものです。</p>` : ''}
    </section>`;
  }

  function parse(text) {
    try {
      return typeof text === 'string' ? JSON.parse(text) : null;
    } catch (e) {
      return null;
    }
  }

  function fmtDay(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : '日付なし';
  }

  // 帳簿の1行を、人が読める文に（「10/17 太郎さん 3-1 花子さん（太郎さんの勝ち）」）
  function describe(r, names) {
    if (!r) return '（読めない行）';
    const w = names[r.from] || '書いた人';
    const o = names[r.L && r.L.to] || '相手';
    if (r.t === 'match' && r.m && Number.isInteger(r.m.mySets) && Number.isInteger(r.m.oppSets)) {
      const win = r.m.mySets > r.m.oppSets ? w : o;
      return `${fmtDay(r.m.date)} の試合：${w}さん ${r.m.mySets}-${r.m.oppSets} ${o}さん（${win}さんの勝ち）`;
    }
    const n = (u) => (Number.isFinite(u) ? `${Math.round((u / 6) * 10) / 10}奢り` : '');
    if (r.t === 'treat') return `${w}さんが「${r.kind === 'paid' ? '奢った' : r.kind === 'got' ? '奢ってもらった' : '奢り'}」と記録（${n(r.amount)}）`;
    if (r.t === 'offset') return `奢りの相殺（${n(r.amount)}ずつ・${r.st === 'ask' ? '提案' : r.st === 'ok' ? '合意' : '見送り'}）`;
    const kinds = { del: '試合の取り消し', 'treat-del': '奢りの記録の取り消し', key: '帳簿の開始' };
    return kinds[r.t] || 'そのほかの記録';
  }

  // 2人の帳簿から対戦成績をまとめる。alt があれば「問題の行をもう一方の内容にした場合」も並べる
  async function recordSection(doc, r, conflictItem) {
    const lg = await LG.checkLedgers(doc);
    if (!lg.ok) return { names: {}, section: { h: '2人の対戦成績', lead: `成績は出せませんでした：${lg.why}。` } };
    const names = { [lg.a.key.id]: lg.a.name || '書いた人', [lg.b.key.id]: lg.b.name || '保存した人' };
    const A = names[lg.a.key.id], B = names[lg.b.key.id];
    const rec = lg.record;
    const items = [['帳簿の記録で数えると', `${A}さん ${rec.aWins}勝 − ${rec.bWins}勝 ${B}さん（${rec.matches.length}試合）`]];
    if (conflictItem && Number.isInteger(r.s)) {
      const alt = lg.a.rows.slice();
      alt[r.s - 1] = conflictItem;
      const rec2 = LG.headToHead(alt, lg.b.rows);
      items.push(['問題の行を2つ目の内容にすると', rec2.aWins === rec.aWins && rec2.bWins === rec.bWins
        ? '成績は変わりません'
        : `${A}さん ${rec2.aWins}勝 − ${rec2.bWins}勝 ${B}さん（${rec2.matches.length}試合）`]);
    }
    const by = { a: A, b: B, both: '2人' };
    const rows = rec.matches.slice(0, 100).map((x) => [fmtDay(x.date), `${x.a}-${x.b}`, x.a > x.b ? A : B, by[x.by]]);
    return {
      names,
      section: {
        h: '2人の対戦成績',
        items,
        head: ['日付', `${A}-${B}`, '勝ち', '記録'],
        rows,
        note: `2人の帳簿の全行の署名を確かめたうえで数えています（記録・変更・取り消しを順にたどり、2人が記録した同じ試合は1試合にまとめています）。帳簿ができる前（友だち連携の前）の試合は含まれません。${rec.matches.length > 100 ? '一覧は新しい100試合までです。' : ''}`,
      },
    };
  }

  function fmtAt(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${d.toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })}（この端末の時刻）`;
  }

  // 刻印の元データに入っている帳簿を、友だちごとに「刻んだ人が書いた分」「友だちが書いた分」にまとめる
  function chainItems(me, chains) {
    const byFriend = new Map();
    for (const c of chains) {
      const friend = c.from === me ? c.to : c.from;
      const e = byFriend.get(friend) || byFriend.set(friend, { mine: 0, theirs: 0 }).get(friend);
      if (c.from === me) e.mine = c.s;
      else e.theirs = c.s;
    }
    let n = 0;
    return [...byFriend.values()].map((e) => {
      n++;
      const parts = [];
      if (e.mine) parts.push(`刻んだ人が書いた記録 ${e.mine}行`);
      if (e.theirs) parts.push(`友だちが書いた記録 ${e.theirs}行`);
      return [`友だち${byFriend.size > 1 ? n : ''}との帳簿`, parts.join('・')];
    });
  }

  async function check(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return show(false, 'このファイルは読めませんでした', { lead: '卓球戦績メモで保存した .json ファイルを選んでください（.ots ファイルはここでは確かめられません）。' });
    }
    if (doc && doc.kind === 'ledger-root') {
      const r = await LG.checkRoot(doc);
      if (!r.ok) {
        return show(false, '本物かどうか確かめられませんでした', { lead: `${r.why}。ファイルが壊れているか、作られたあとに書き換えられている可能性があります。` });
      }
      return show(true, '本物の刻印データです', {
        lead: 'ある端末が「この日時に、友だちとの帳簿がこの状態だった」と記録し、電子的なはんこ（署名）を押したものです。作られたあと、1文字も書き換えられていません。試合の中身（相手・点数など）はこのファイルには入っていません。',
        items: [['作った日時', fmtAt(r.at)], ...chainItems(doc.me, r.chains), ['作った端末の鍵', r.fp]],
        next: 'この日時が本当か（あとから作ったものではないか）は、同じときに保存した証明ファイル（.ots）と一緒に opentimestamps.org の「Verify」に入れると確かめられます。ビットコインに記録されるまで、刻んでから数時間かかります。',
        fp: r.fp,
      });
    }
    const r = await LG.checkEvidence(doc);
    if (!r.ok) {
      return show(false, '証拠として確かめられませんでした', { lead: `${r.why}。ファイルが壊れているか、あとから書き換えられている可能性があります。` });
    }
    const conflict = doc.type === 'conflict';
    const items = (doc.items || []).map(parse);
    const extra = await recordSection(doc, r, doc.type === 'receipt-mismatch' ? null : items[1]);
    const names = Object.assign({}, extra.names);
    const keyName = (t) => { const k = parse(t); return k && typeof k.name === 'string' ? k.name.slice(0, 40) : ''; };
    if (!names[r.key.id] && keyName(doc.keyEntry)) names[r.key.id] = keyName(doc.keyEntry);
    if (r.other && !names[r.other.id] && keyName(doc.myKeyEntry)) names[r.other.id] = keyName(doc.myKeyEntry);
    const who = (id, fallback) => (names[id] ? `${names[id]}さん` : fallback);
    if (doc.type === 'receipt-mismatch') {
      return show(true, '記録が書き換えられた証拠です（本物）', {
        lead: `${who(r.key.id, '受け取った人')}の端末は「${r.s}行目をこの内容で受け取った」という受領証にはんこを押していますが、${who(r.other.id, '書いた人')}の端末の${r.s}行目は別の内容になっています。どちらかの端末の記録が、あとから書き換えられています。`,
        items: [['食い違っている行', `${r.s}行目`], [`${who(r.other.id, '書いた人')}の端末にある${r.s}行目`, describe(parse((doc.myItems || [])[0]), names)],
          ['受け取った人の鍵', r.key.fp], ['書いた人の鍵', r.other.fp]],
        sections: [extra.section],
        next: '受領証も行も、それぞれの端末のはんこつきなので、第三者が作ることはできません。どちらが書き換えたかは、2人の話し合いで確かめてください。',
        fp: r.key.fp,
      });
    }
    const writer = who(r.key.id, '同じ端末');
    return show(true, '記録が書き換えられた証拠です（本物）', {
      lead: conflict
        ? `${writer}の端末が、帳簿の同じ${r.s}行目に、違う内容を2回はんこを押して送っています。一度送った記録を、あとから別の内容に書き換えたことを示しています。`
        : `${writer}の端末が書いた${r.s}行目が、その前の行とつながっていません。途中の記録を書き換えたか消したことを示しています。`,
      items: conflict
        ? [['1回目に届いた内容', describe(items[0], names)], ['2回目に届いた内容', describe(items[1], names)], ['書き換えた端末の鍵', r.key.fp]]
        : [['前の行', describe(items[0], names)], ['つながらない行', describe(items[1], names)], ['書き換えた端末の鍵', r.key.fp]],
      sections: [extra.section],
      next: 'この2つの行には、どちらもその端末のはんこが押されています。はんこはその端末でしか押せないので、ほかの人が作った偽物ではありません。',
      fp: r.key.fp,
    });
  }

  function read(file) {
    if (!file) return;
    if (file.size > 5000000) return show(false, 'ファイルが大きすぎます', { lead: '卓球戦績メモで保存した .json ファイルを選んでください。' });
    file.text().then(check).catch(() => show(false, 'ファイルを読めませんでした'));
  }

  document.getElementById('file').addEventListener('change', (e) => read(e.target.files[0]));
  const drop = document.getElementById('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    read(e.dataTransfer.files[0]);
  });
})();
