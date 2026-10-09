// 「負けた方が勝った方に奢る」約束の集計（DOMに依存しない純粋関数）
// 奢りの対象にした試合だけを相手ごとに古い順に数え、先に「〇勝」した方の勝ち＝負けた方が奢る。
// 奢りが決まったら、その相手との勝数は2人とも0から数え直す。
// ブラウザでは window.TTTreat、Node では module.exports として使える。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTTreat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NEEDS = [1, 2, 3];

  function isNeed(n) {
    return NEEDS.includes(n);
  }

  function opponentKey(m) {
    return (m.opponent || '').trim();
  }

  function chronological(a, b) {
    return (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0);
  }

  // 相手ごとの状況を返す: Map(相手名 → { me, opp, need, decided: [{ matchId, date, winner, need }] })
  // winner === 'me' なら相手が自分に奢る、'opp' なら自分が相手に奢る
  function summarize(matches) {
    const byOpp = new Map();
    for (const m of matches.filter((x) => isNeed(x.treat)).sort(chronological)) {
      const key = opponentKey(m);
      if (!key) continue;
      const s = byOpp.get(key) || { me: 0, opp: 0, need: m.treat, decided: [] };
      const winner = m.mySets > m.oppSets ? 'me' : 'opp';
      s.need = m.treat;
      s[winner]++;
      if (s[winner] >= m.treat) {
        s.decided.push({ matchId: m.id, date: m.date, winner, need: m.treat, me: s.me, opp: s.opp });
        s.me = 0;
        s.opp = 0;
      }
      byOpp.set(key, s);
    }
    return byOpp;
  }

  // この試合で奢りが決まったなら、その内容を返す
  function decidedBy(matches, matchId) {
    for (const s of summarize(matches).values()) {
      const d = s.decided.find((x) => x.matchId === matchId);
      if (d) return d;
    }
    return null;
  }

  return { NEEDS, isNeed, summarize, decidedBy };
});
