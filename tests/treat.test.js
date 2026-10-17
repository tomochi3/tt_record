'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/treat.js');

let n = 0;
const m = (opponent, my, opp, treat, date) => ({ id: 'm' + (++n), opponent, mySets: my, oppSets: opp, treat, date: date || '2026-10-0' + (n % 9 + 1), createdAt: n });

test('balances: N勝で1奢りなら、1勝ごとに 1/N 奢りがたまる', () => {
  n = 0;
  const b = T.balances([
    m('山田', 3, 1, 1), // 山田から 1
    m('山田', 0, 3, 2), // 山田へ 0.5
    m('山田', 1, 3, 1), // 山田へ 1
    m('山田', 3, 0, 0), // 対象外
    m('佐藤', 3, 0, 3), // 佐藤から 1/3
  ]);
  assert.deepEqual(b.get('山田'), { owedToMe: 6, iOwe: 9 });
  assert.equal(T.format(b.get('山田').iOwe), '1.5');
  assert.equal(T.format(b.get('佐藤').owedToMe), '0.3');
  assert.equal(b.has('鈴木'), false);
});

test('balances: 奢った・奢ってもらった・相殺を差し引く（マイナスにはしない）', () => {
  n = 0;
  const ms = [m('山田', 3, 1, 1), m('山田', 3, 2, 1), m('山田', 0, 3, 2), m('山田', 0, 3, 2), m('山田', 0, 3, 2)];
  const log = [
    { name: '山田', kind: 'got', amount: 6 },
    { name: '山田', kind: 'offset', amount: 6 },
    { name: '鈴木', kind: 'paid', amount: 6 },
  ];
  const b = T.balances(ms, log).get('山田');
  assert.deepEqual(b, { owedToMe: 0, iOwe: 3 });
  assert.equal(T.offsetAmount(b), 0);
  assert.deepEqual(T.balances(ms, [{ name: '山田', kind: 'paid', amount: 60 }]).get('山田').iOwe, 0);
});

test('offsetAmount: お互いに残っている少ない方', () => {
  assert.equal(T.offsetAmount({ owedToMe: 9, iOwe: 4 }), 4);
  assert.equal(T.offsetAmount(undefined), 0);
});

test('format: 小数1桁までで表す', () => {
  assert.equal(T.format(0), '0');
  assert.equal(T.format(6), '1');
  assert.equal(T.format(9), '1.5');
  assert.equal(T.format(4), '0.7');
  assert.equal(T.format(14), '2.3');
});

test('isLogEntry: 不正な記録を弾く', () => {
  assert.equal(T.isLogEntry({ name: '山田', kind: 'got', amount: 6 }), true);
  assert.equal(T.isLogEntry({ name: '山田', kind: 'evil', amount: 6 }), false);
  assert.equal(T.isLogEntry({ name: '山田', kind: 'paid', amount: 0.5 }), false);
  assert.equal(T.isLogEntry({ name: '山田', kind: 'paid', amount: -6 }), false);
});

test('legacyDecided: 以前の「先にN勝」の決着を求める（済のメモの移行用）', () => {
  n = 0;
  const ms = [m('佐藤', 3, 0, 2), m('佐藤', 1, 3, 2), m('佐藤', 3, 2, 2), m('山田', 0, 3, 1)];
  const d = T.legacyDecided(ms);
  assert.deepEqual(d.map((x) => [x.name, x.winner, x.matchId]), [['佐藤', 'me', ms[2].id], ['山田', 'opp', ms[3].id]]);
});
