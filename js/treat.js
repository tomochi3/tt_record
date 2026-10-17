// 「負けた方が勝った方に奢る」約束の集計（DOMに依存しない純粋関数）
// 奢りの対象にした試合は「N勝で1奢り」。勝つたびに相手から 1/N 奢り、負けるたびに相手へ 1/N 奢りがたまる。
// 1/2 や 1/3 を誤差なく足せるよう、1奢り = 6 の整数で数える。
// 奢った・奢ってもらった記録や、お互いの奢りの相殺は log で差し引く。
// ブラウザでは window.TTTreat、Node では module.exports として使える。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTTreat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NEEDS = [1, 2, 3];
  const UNIT = 6; // 1奢り
  const KINDS = ['got', 'paid', 'offset']; // 奢ってもらった / 奢った / 相殺

  function isNeed(n) {
    return NEEDS.includes(n);
  }

  function opponentKey(m) {
    return (m.opponent || '').trim();
  }

  // その試合で動く奢り（勝てば相手から、負ければ相手へ）
  function matchShare(m) {
    if (!isNeed(m.treat)) return null;
    return { units: UNIT / m.treat, toMe: m.mySets > m.oppSets };
  }

  // 相手ごとの残り: Map(相手名 → { owedToMe: 相手が自分に奢る分, iOwe: 自分が相手に奢る分 })
  function balances(matches, log) {
    const out = new Map();
    const get = (k) => out.get(k) || out.set(k, { owedToMe: 0, iOwe: 0 }).get(k);
    for (const m of matches) {
      const s = matchShare(m);
      const key = opponentKey(m);
      if (!s || !key) continue;
      get(key)[s.toMe ? 'owedToMe' : 'iOwe'] += s.units;
    }
    for (const e of log || []) {
      const key = (e.name || '').trim();
      if (!key || !out.has(key)) continue;
      const b = out.get(key);
      if (e.kind === 'got' || e.kind === 'offset') b.owedToMe -= e.amount;
      if (e.kind === 'paid' || e.kind === 'offset') b.iOwe -= e.amount;
    }
    // 試合を消したあとなどで記録の方が多くなっても、マイナスにはしない
    for (const b of out.values()) {
      b.owedToMe = Math.max(0, b.owedToMe);
      b.iOwe = Math.max(0, b.iOwe);
    }
    return out;
  }

  // 相殺できる量（お互いに残っている少ない方）
  function offsetAmount(b) {
    return b ? Math.min(b.owedToMe, b.iOwe) : 0;
  }

  // 6 → "1"、9 → "1.5"、2 → "0.3"（小数1桁まで）
  function format(units) {
    const v = Math.round((units / UNIT) * 10) / 10;
    return String(v);
  }

  function isLogEntry(e) {
    return !!e && typeof e.name === 'string' && KINDS.includes(e.kind) &&
      Number.isInteger(e.amount) && e.amount > 0 && e.amount <= 1000 * UNIT;
  }

  // 以前の「先に N勝した方が1奢り」の決着（済のメモを新しい記録に移すためだけに使う）
  function legacyDecided(matches) {
    const out = [];
    const state = new Map();
    const sorted = matches.filter((x) => isNeed(x.treat)).sort((a, b) =>
      (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0));
    for (const m of sorted) {
      const key = opponentKey(m);
      if (!key) continue;
      const s = state.get(key) || { me: 0, opp: 0 };
      const winner = m.mySets > m.oppSets ? 'me' : 'opp';
      s[winner]++;
      if (s[winner] >= m.treat) {
        out.push({ matchId: m.id, name: key, winner });
        s.me = 0;
        s.opp = 0;
      }
      state.set(key, s);
    }
    return out;
  }

  return { NEEDS, UNIT, KINDS, isNeed, matchShare, balances, offsetAmount, format, isLogEntry, legacyDecided };
});
