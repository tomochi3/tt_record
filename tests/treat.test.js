'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/treat.js');

let n = 0;
const m = (opponent, my, opp, treat, date) => ({ id: 'm' + (++n), opponent, mySets: my, oppSets: opp, treat, date: date || '2026-10-0' + (n % 9 + 1), createdAt: n });

test('1勝で奢り: 対象試合ごとに奢りが決まる', () => {
  n = 0;
  const s = T.summarize([m('山田', 3, 1, 1), m('山田', 0, 3, 1), m('山田', 3, 0, 0)]).get('山田');
  assert.deepEqual(s.decided.map((d) => d.winner), ['me', 'opp']);
  assert.equal(s.me, 0);
  assert.equal(s.opp, 0);
});

test('3勝で奢り: 先に3勝した方の勝ち。途中経過と数え直し', () => {
  n = 0;
  const ms = [m('佐藤', 3, 0, 3), m('佐藤', 1, 3, 3), m('佐藤', 3, 2, 3), m('佐藤', 3, 1, 3), m('佐藤', 0, 3, 3)];
  const s = T.summarize(ms).get('佐藤');
  assert.equal(s.decided.length, 1);
  assert.equal(s.decided[0].winner, 'me');
  assert.equal(s.decided[0].matchId, ms[3].id);
  assert.deepEqual([s.decided[0].me, s.decided[0].opp], [3, 1]);
  assert.deepEqual([s.me, s.opp, s.need], [0, 1, 3]);
});

test('対象外の試合・別の相手は数えない。日付順に数える', () => {
  n = 0;
  const ms = [m('山田', 3, 0, 2, '2026-10-05'), m('鈴木', 3, 0, 2, '2026-10-01'), m('山田', 3, 1, 0, '2026-10-02'), m('山田', 3, 2, 2, '2026-10-01')];
  const sum = T.summarize(ms);
  assert.equal(sum.get('山田').decided.length, 1);
  assert.equal(sum.get('山田').decided[0].matchId, ms[0].id);
  assert.deepEqual([sum.get('鈴木').me, sum.get('鈴木').opp], [1, 0]);
  assert.equal(T.decidedBy(ms, ms[0].id).winner, 'me');
  assert.equal(T.decidedBy(ms, ms[3].id), null);
});
