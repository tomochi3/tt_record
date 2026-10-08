'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/link.js');

const A = 'AAAAAAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBBBBBB';

test('newId: 20文字の英数字', () => {
  const id = L.newId((n) => Uint8Array.from({ length: n }, (_, i) => i * 7));
  assert.equal(id.length, 20);
  assert.ok(L.isId(id));
});

test('parseFriendInput: リンクとIDの両方を受け付ける', () => {
  const link = L.friendLink('https://example.com/tt_record/#old', A, '山田 太郎');
  assert.deepEqual(L.parseFriendInput(link), { id: A, name: '山田 太郎', pub: '' });
  assert.deepEqual(L.parseFriendInput(`  ${A} `), { id: A, name: '', pub: '' });
  assert.equal(L.parseFriendInput('https://example.com/#add=short'), null);
  assert.equal(L.parseFriendInput('こんにちは'), null);
});

test('decode: 名前の変更通知は変更時刻つきのものだけ受け付ける', () => {
  const d = L.decode(L.encode({ t: 'name', from: A, name: '山田 花子', key: 'n:1', at: 123 }));
  assert.equal(d.t, 'name');
  assert.equal(d.name, '山田 花子');
  assert.equal(d.at, 123);
  assert.equal(L.decode(L.encode({ t: 'name', from: A, name: '山田' })), null);
  assert.equal(L.decode(L.encode({ t: 'name', from: A, name: '', at: 1 })), null);
});

test('encode/decode: 試合を送ってメモは含めない', () => {
  const m = { id: 'abc123', date: '2026-10-08', event: '市民大会', bestOf: 5, mode: 'simple', mySets: 3, oppSets: 1, memo: '秘密', createdAt: 5 };
  const text = L.encode({ t: 'match', from: A, name: '山田', m: L.matchPayload(m) });
  assert.ok(!text.includes('秘密'));
  const d = L.decode(text);
  assert.equal(d.t, 'match');
  assert.equal(d.from, A);
  assert.equal(d.m.mySets, 3);
  assert.equal(d.m.rev, 5);
});

test('decode: 不正なメッセージは捨てる', () => {
  assert.equal(L.decode('not json'), null);
  assert.equal(L.decode(JSON.stringify({ v: 1, t: 'hello', from: 'bad' })), null);
  assert.equal(L.decode(JSON.stringify({ v: 1, t: 'match', from: A, m: { id: 'x', date: '2026-01-01', bestOf: 5, mySets: 3, oppSets: 3 } })), null);
  assert.equal(L.decode(JSON.stringify({ v: 1, t: 'evil', from: A })), null);
  // 1点ごとの記録が結果と食い違う場合は結果だけ残す
  const d = L.decode(JSON.stringify({ v: 1, t: 'match', from: A, m: { id: 'x', date: '2026-01-01', bestOf: 3, mode: 'detail', mySets: 2, oppSets: 0, firstServer: 'me', rally: 'o'.repeat(22) } }));
  assert.equal(d.m.rally, undefined);
});

test('encode: 長すぎる試合は1点ごとの記録を省く', () => {
  const rally = 'mo'.repeat(1000) + 'mm';
  const m = { id: 'long', date: '2026-10-08', bestOf: 3, mode: 'detail', mySets: 2, oppSets: 0, firstServer: 'me', rally };
  const text = L.encode({ t: 'match', from: A, name: 'x', m });
  assert.ok(text.length < 3900);
  assert.equal(L.decode(text).m.mySets, 2);
});

test('toLocalMatch: 相手の記録を自分視点に反転する', () => {
  const rally = 'm'.repeat(11) + 'o'.repeat(11) + 'm'.repeat(11);
  const d = L.decode(L.encode({ t: 'match', from: A, name: '山田', m: { id: 'm1', date: '2026-10-08', bestOf: 3, mode: 'detail', mySets: 2, oppSets: 1, firstServer: 'me', rally } }));
  const local = L.toLocalMatch(d.m, A, '山田', 1);
  assert.equal(local.id, L.receivedId(A, 'm1'));
  assert.equal(local.opponent, '山田');
  assert.equal(local.opponentId, A);
  assert.equal(local.mySets, 1);
  assert.equal(local.oppSets, 2);
  assert.equal(local.firstServer, 'opp');
  assert.ok(local.rally.startsWith('ooooooooooo'));
  assert.deepEqual(local.games, [{ me: 0, opp: 11 }, { me: 11, opp: 0 }, { me: 0, opp: 11 }]);
});

test('findDuplicate: 自分でも記録した同じ試合を見つける', () => {
  const own = { id: 'x', opponentId: A, date: '2026-10-08', mySets: 1, oppSets: 3 };
  const other = { id: 'y', opponentId: B, date: '2026-10-08', mySets: 1, oppSets: 3 };
  const local = { opponentId: A, date: '2026-10-08', mySets: 1, oppSets: 3 };
  assert.equal(L.findDuplicate([other, own], local), own);
  assert.equal(L.findDuplicate([Object.assign({}, own, { remote: { from: A, id: 'z' } })], local), null);
  assert.equal(L.findDuplicate([Object.assign({}, own, { mySets: 3, oppSets: 1 })], local), null);
});

test('暗号: 2人の共通鍵で暗号化・復号でき、第三者・送り返し・改ざんは失敗する', async () => {
  const a = await L.generateKeys();
  const b = await L.generateKeys();
  const c = await L.generateKeys();
  assert.ok(L.isPub(a.pub));
  const kAB = await L.pairKey(a.priv, b.pub);
  const kBA = await L.pairKey(b.priv, a.pub);
  const kCB = await L.pairKey(c.priv, b.pub);
  const inner = L.encode({ t: 'name', from: A, name: '山田', key: 'n:1', at: 1 });
  const envText = await L.seal(kAB, A, B, inner);
  const env = L.parseEnvelope(envText);
  assert.equal(env.kind, 'sealed');
  assert.ok(!envText.includes('山田'));
  assert.equal(await L.open(kBA, A, B, env), inner);
  // 第三者 C が A になりすましても B は復号できない
  const fake = L.parseEnvelope(await L.seal(kCB, A, B, inner));
  assert.equal(await L.open(kBA, A, B, fake), null);
  // A→B のメッセージを A の郵便受けに B 発として送り返しても受け付けない
  assert.equal(await L.open(kAB, B, A, env), null);
  // 改ざん
  const t = Object.assign({}, env, { ct: env.ct.slice(0, -2) + (env.ct.endsWith('AA') ? 'BB' : 'AA') });
  assert.equal(await L.open(kBA, A, B, t), null);
});

test('友だちリンク・友だちコード・IDの読み取り（公開鍵つき）', async () => {
  const { pub } = await L.generateKeys();
  const link = L.friendLink('https://example.com/tt_record/', A, '山田', pub);
  assert.deepEqual(L.parseFriendInput(link), { id: A, name: '山田', pub });
  assert.deepEqual(L.parseFriendInput(L.friendCode(A, pub)), { id: A, name: '', pub });
  assert.deepEqual(L.parseFriendInput(A), { id: A, name: '', pub: '' });
  const hello = L.parseEnvelope(L.helloEnvelope(A, '山田', pub));
  assert.deepEqual(hello, { kind: 'hello', from: A, name: '山田', pub });
});

test('sanitizeMatch: インポートや保存データの不正な値を弾く', () => {
  const ok = { id: 'x1', date: '2026-10-08', opponent: '山田', bestOf: 5, mode: 'simple', mySets: 3, oppSets: 1 };
  assert.equal(L.sanitizeMatch(ok).bestOf, 5);
  assert.equal(L.sanitizeMatch(Object.assign({}, ok, { bestOf: '<img src=x onerror=alert(1)>' })), null);
  assert.equal(L.sanitizeMatch(Object.assign({}, ok, { bestOf: 1e9 })), null);
  assert.equal(L.sanitizeMatch(Object.assign({}, ok, { id: '"><script>' })), null);
  const odd = L.sanitizeMatch(Object.assign({}, ok, { date: '<b>', opponentId: 'x"', evil: '<script>', mode: 'detail', rally: '<x>' }));
  assert.equal(odd.date, '');
  assert.equal(odd.opponentId, undefined);
  assert.equal(odd.evil, undefined);
  assert.equal(odd.mode, 'simple');
});
