'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/scoring.js');

test('setsToWin', () => {
  assert.equal(S.setsToWin(3), 2);
  assert.equal(S.setsToWin(5), 3);
  assert.equal(S.setsToWin(7), 4);
});

test('possibleResults (5ゲームマッチ)', () => {
  assert.deepEqual(S.possibleResults(5), [
    [3, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 3],
  ]);
});

test('isValidResult', () => {
  assert.ok(S.isValidResult(5, 3, 1));
  assert.ok(S.isValidResult(5, 2, 3));
  assert.ok(!S.isValidResult(5, 3, 3));
  assert.ok(!S.isValidResult(5, 2, 2));
  assert.ok(!S.isValidResult(5, 4, 0));
});

test('gameWinner: 11点先取・2点差', () => {
  assert.equal(S.gameWinner(11, 9), 'me');
  assert.equal(S.gameWinner(10, 11), null);
  assert.equal(S.gameWinner(11, 10), null);
  assert.equal(S.gameWinner(12, 10), 'me');
  assert.equal(S.gameWinner(13, 15), 'opp');
});

test('serverAt: 2本交代、10-10から1本交代', () => {
  assert.equal(S.serverAt('me', 0, 0), 'me');
  assert.equal(S.serverAt('me', 1, 0), 'me');
  assert.equal(S.serverAt('me', 1, 1), 'opp');
  assert.equal(S.serverAt('me', 2, 1), 'opp');
  assert.equal(S.serverAt('me', 2, 2), 'me');
  assert.equal(S.serverAt('me', 10, 9), 'opp');
  assert.equal(S.serverAt('me', 10, 10), 'me');
  assert.equal(S.serverAt('me', 11, 10), 'opp');
  assert.equal(S.serverAt('me', 11, 11), 'me');
});

test('gameFirstServer: ゲームごとに交代', () => {
  assert.equal(S.gameFirstServer('me', 0), 'me');
  assert.equal(S.gameFirstServer('me', 1), 'opp');
  assert.equal(S.gameFirstServer('opp', 2), 'opp');
});

test('computeMatch: ストレート勝ち', () => {
  const rally = 'm'.repeat(11).repeat(3);
  const r = S.computeMatch(5, 'me', rally);
  assert.equal(r.finished, true);
  assert.equal(r.winner, 'me');
  assert.equal(r.mySets, 3);
  assert.equal(r.oppSets, 0);
  assert.equal(r.games.length, 3);
  assert.equal(r.current, null);
});

test('computeMatch: 試合終了後の点は無視', () => {
  const rally = 'o'.repeat(11 * 2) + 'mmm';
  const r = S.computeMatch(3, 'me', rally);
  assert.equal(r.winner, 'opp');
  assert.equal(r.games.length, 2);
});

test('computeMatch: ゲーム終了直後は次のゲームが始まっている', () => {
  const r = S.computeMatch(5, 'me', 'm'.repeat(11));
  assert.equal(r.mySets, 1);
  assert.equal(r.games.length, 2);
  assert.equal(r.current.gameIndex, 1);
  assert.equal(r.current.server, 'opp');
  assert.equal(r.completedGames.length, 1);
});

test('computeMatch: ジュースとゲーム/マッチポイント', () => {
  // 2ゲーム先取の2ゲーム目で 10-10 → 11-10
  let rally = 'm'.repeat(11) + 'mo'.repeat(10) + 'm';
  let r = S.computeMatch(3, 'me', rally);
  assert.equal(r.current.me, 11);
  assert.equal(r.current.opp, 10);
  assert.equal(r.current.gamePoint, 'me');
  assert.equal(r.current.matchPoint, 'me');
  r = S.computeMatch(3, 'me', rally + 'm');
  assert.equal(r.winner, 'me');
  assert.deepEqual(r.games.map((g) => [g.me, g.opp]), [[11, 0], [12, 10]]);
});

test('rallyStats', () => {
  // 先サーブ自分: サーブ2本取って相手サーブ2本落とす → 10-10 から自分サーブ・相手サーブを連取して 12-10。
  // 2ゲーム目は相手サーブを2本落とす。
  const r = S.computeMatch(3, 'me', 'mmoo'.repeat(5) + 'mm' + 'oo');
  const st = S.rallyStats(r);
  assert.equal(st.pointsTotal, 24);
  assert.equal(st.serveTotal, 11);
  assert.equal(st.serveWon, 11);
  assert.equal(st.receiveTotal, 13);
  assert.equal(st.receiveWon, 1);
  assert.equal(st.longestRun.opp, 2);
  assert.equal(st.longestRun.me, 2);
  assert.equal(st.deuceGames, 1);
  assert.equal(st.deuceWon, 1);
});
