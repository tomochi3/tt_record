// 証拠の確認ページ：保存された証拠ファイル・刻印の元データの署名を、端末の中だけで確かめる
(function () {
  'use strict';
  const LG = window.TTLedger;
  const out = document.getElementById('result');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function show(ok, title, lines) {
    out.innerHTML = `<section class="card verify-result ${ok ? 'ok' : 'ng'}">
      <h3>${ok ? '✅' : '⚠'} ${esc(title)}</h3>
      ${lines.map((l) => `<p class="small">${esc(l)}</p>`).join('')}
    </section>`;
  }

  async function check(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return show(false, 'JSON ファイルとして読めません', []);
    }
    if (doc && doc.kind === 'ledger-root') {
      const r = await LG.checkRoot(doc);
      if (!r.ok) return show(false, '確かめられませんでした', [r.why]);
      const chains = r.chains.map((c) => `・帳簿 ${c.s}行目まで（先頭のハッシュ ${String(c.h).slice(0, 12)}…）`);
      return show(true, `鍵 ${r.fp} の署名つきの刻印の元データです`, [
        `作成日時：${r.at}`,
        ...chains,
        'この内容がいつからあったかは、.ots ファイルと一緒に opentimestamps.org で確かめてください。',
      ]);
    }
    const r = await LG.checkEvidence(doc);
    if (!r.ok) return show(false, '証拠として確かめられませんでした', [r.why]);
    return show(true, r.title, [r.detail, `署名した鍵の指紋：${r.key.fp}（相手のアプリの帳簿に出る指紋と見比べられます）`]);
  }

  function read(file) {
    if (!file) return;
    if (file.size > 200000) return show(false, 'ファイルが大きすぎます', []);
    file.text().then(check).catch(() => show(false, 'ファイルを読めませんでした', []));
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
