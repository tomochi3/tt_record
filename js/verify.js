// 証拠の確認ページ：保存された証拠ファイル・刻印の元データの署名を、端末の中だけで確かめる
(function () {
  'use strict';
  const LG = window.TTLedger;
  const out = document.getElementById('result');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // 結果の表示：見出し・ひとことの説明・項目・次にできること（すべて文字列で受け取り、ここでエスケープする）
  function show(ok, title, { lead = '', items = [], next = '', fp = '' } = {}) {
    out.innerHTML = `<section class="card verify-result ${ok ? 'ok' : 'ng'}">
      <h3>${ok ? '✅' : '⚠'} ${esc(title)}</h3>
      ${lead ? `<p>${esc(lead)}</p>` : ''}
      ${items.length ? `<dl class="verify-items">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${next ? `<p class="small verify-next">${esc(next)}</p>` : ''}
      ${fp ? `<p class="small muted">「鍵」は端末ごとの電子的なはんこで、${esc(fp)} はその番号（指紋）です。アプリの相手ごとの成績ページ「📒 帳簿」のいちばん下に出る「鍵の指紋」と同じなら、その人の端末が作ったものです。</p>` : ''}
    </section>`;
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
    if (doc.type === 'receipt-mismatch') {
      return show(true, '記録が書き換えられた証拠です（本物）', {
        lead: `受け取った人の端末は「${r.s}行目をこの内容で受け取った」という受領証にはんこを押していますが、書いた人の端末の${r.s}行目は別の内容になっています。どちらかの端末の記録が、あとから書き換えられています。`,
        items: [['食い違っている行', `${r.s}行目`], ['受け取った人の鍵', r.key.fp], ['書いた人の鍵', r.other.fp]],
        next: '受領証も行も、それぞれの端末のはんこつきなので、第三者が作ることはできません。どちらが書き換えたかは、2人の話し合いで確かめてください。',
        fp: r.key.fp,
      });
    }
    const conflict = doc.type === 'conflict';
    return show(true, '記録が書き換えられた証拠です（本物）', {
      lead: conflict
        ? `同じ端末が、帳簿の同じ${r.s}行目に、違う内容を2回はんこを押して送っています。一度送った記録を、あとから別の内容に書き換えたことを示しています。`
        : `同じ端末が書いた${r.s}行目が、その前の行とつながっていません。途中の記録を書き換えたか消したことを示しています。`,
      items: [['問題の行', `${r.s}行目`], ['書き換えた端末の鍵', r.key.fp]],
      next: 'この2つの行には、どちらもその端末のはんこが押されています。はんこはその端末でしか押せないので、ほかの人が作った偽物ではありません。',
      fp: r.key.fp,
    });
  }

  function read(file) {
    if (!file) return;
    if (file.size > 200000) return show(false, 'ファイルが大きすぎます', { lead: '卓球戦績メモで保存した .json ファイルを選んでください。' });
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
