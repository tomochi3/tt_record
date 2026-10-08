// 卓球のスコア計算ロジック（DOMに依存しない純粋関数）
// ブラウザでは window.TTScoring、Node では module.exports として使える。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTScoring = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const POINTS_TO_WIN = 11;
  const DEUCE_AT = POINTS_TO_WIN - 1; // 10-10 から1本交代

  function other(side) {
    return side === 'me' ? 'opp' : 'me';
  }

  // 何ゲーム先取か（5ゲームマッチなら3）
  function setsToWin(bestOf) {
    return Math.floor(bestOf / 2) + 1;
  }

  // 簡易モードで選べる最終セットカウント一覧（勝ち→負けの順）
  function possibleResults(bestOf) {
    const need = setsToWin(bestOf);
    const results = [];
    for (let l = 0; l < need; l++) results.push([need, l]);
    for (let w = need - 1; w >= 0; w--) results.push([w, need]);
    return results;
  }

  function isValidResult(bestOf, mySets, oppSets) {
    const need = setsToWin(bestOf);
    return (
      Number.isInteger(mySets) && Number.isInteger(oppSets) &&
      mySets >= 0 && oppSets >= 0 &&
      (mySets === need) !== (oppSets === need) &&
      mySets <= need && oppSets <= need
    );
  }

  function gameWinner(me, opp) {
    if (Math.max(me, opp) < POINTS_TO_WIN || Math.abs(me - opp) < 2) return null;
    return me > opp ? 'me' : 'opp';
  }

  // ゲームの最初のサーバー：1ゲーム目は試合の先サーブ、以降は交互
  function gameFirstServer(matchFirstServer, gameIndex) {
    return gameIndex % 2 === 0 ? matchFirstServer : other(matchFirstServer);
  }

  // 現在のスコアでのサーバー：2本ずつ交代、10-10以降は1本ずつ交代
  function serverAt(firstServer, me, opp) {
    const n = me + opp;
    const turn = n < DEUCE_AT * 2 ? Math.floor(n / 2) : n;
    return turn % 2 === 0 ? firstServer : other(firstServer);
  }

  // あと1点でゲームを取れるか
  function isGamePoint(own, rival) {
    return gameWinner(own + 1, rival) !== null;
  }

  function newGame(index, matchFirstServer) {
    return {
      index,
      me: 0,
      opp: 0,
      firstServer: gameFirstServer(matchFirstServer, index),
      points: [],
      winner: null,
    };
  }

  // rally: 1点ごとの得点者を 'm'(自分) / 'o'(相手) で並べた文字列
  function computeMatch(bestOf, firstServer, rally) {
    const need = setsToWin(bestOf);
    const games = [];
    let cur = newGame(0, firstServer);
    games.push(cur);
    let mySets = 0;
    let oppSets = 0;
    let winner = null;

    for (const ch of rally || '') {
      if (winner) break;
      if (ch !== 'm' && ch !== 'o') continue;
      const side = ch === 'm' ? 'me' : 'opp';
      const server = serverAt(cur.firstServer, cur.me, cur.opp);
      cur.points.push({ winner: side, server });
      cur[side]++;
      const gw = gameWinner(cur.me, cur.opp);
      if (!gw) continue;
      cur.winner = gw;
      if (gw === 'me') mySets++;
      else oppSets++;
      if (mySets === need) winner = 'me';
      else if (oppSets === need) winner = 'opp';
      else {
        cur = newGame(games.length, firstServer);
        games.push(cur);
      }
    }

    let current = null;
    if (!winner) {
      const myGP = isGamePoint(cur.me, cur.opp);
      const oppGP = isGamePoint(cur.opp, cur.me);
      current = {
        gameIndex: cur.index,
        me: cur.me,
        opp: cur.opp,
        server: serverAt(cur.firstServer, cur.me, cur.opp),
        gamePoint: myGP ? 'me' : oppGP ? 'opp' : null,
        matchPoint: (myGP && mySets + 1 === need) ? 'me' : (oppGP && oppSets + 1 === need) ? 'opp' : null,
      };
    }

    return {
      bestOf,
      need,
      games,
      completedGames: games.filter((g) => g.winner),
      mySets,
      oppSets,
      finished: winner !== null,
      winner,
      current,
    };
  }

  // 1点ごとの記録から集計（サーブ/レシーブ時の得点率、最大連続得点など）
  function rallyStats(computed) {
    const s = {
      serveWon: 0, serveTotal: 0,
      receiveWon: 0, receiveTotal: 0,
      pointsWon: 0, pointsTotal: 0,
      longestRun: { me: 0, opp: 0 },
      deuceGames: 0, deuceWon: 0,
    };
    let runSide = null;
    let run = 0;
    for (const g of computed.games) {
      for (const p of g.points) {
        s.pointsTotal++;
        const won = p.winner === 'me';
        if (won) s.pointsWon++;
        if (p.server === 'me') {
          s.serveTotal++;
          if (won) s.serveWon++;
        } else {
          s.receiveTotal++;
          if (won) s.receiveWon++;
        }
        if (p.winner === runSide) run++;
        else {
          runSide = p.winner;
          run = 1;
        }
        if (run > s.longestRun[runSide]) s.longestRun[runSide] = run;
      }
      if (g.winner && g.me >= DEUCE_AT && g.opp >= DEUCE_AT) {
        s.deuceGames++;
        if (g.winner === 'me') s.deuceWon++;
      }
      // 連続得点はゲームをまたいでも数えない
      runSide = null;
      run = 0;
    }
    return s;
  }

  return {
    POINTS_TO_WIN,
    other,
    setsToWin,
    possibleResults,
    isValidResult,
    gameWinner,
    gameFirstServer,
    serverAt,
    computeMatch,
    rallyStats,
  };
});
