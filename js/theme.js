// 画面が描かれる前にテーマ設定を反映する（ちらつき防止）。CSPのためインラインではなく別ファイルにしている
(function () {
  try {
    var t = (JSON.parse(localStorage.getItem('ttrecord.v1') || '{}').settings || {}).theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* 読めなければ端末の設定に従う */ }
})();
