'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/ledger.js');

const A = 'AAAAAAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBBBBBB';

async function entry(keys, s, p, body) {
  return G.sign(keys.spriv, Object.assign({ v: 1, from: A }, body, { L: { s, p, at: 1000 + s, to: B } }));
}

test('canonical: キーの順番に関係なく同じ文字列', () => {
  assert.equal(G.canonical({ b: 1, a: [2, { d: 3, c: 'x' }] }), G.canonical({ a: [2, { c: 'x', d: 3 }], b: 1 }));
  assert.equal(G.canonical({ a: undefined, b: null }), '{"b":null}');
});

test('署名: 正しい行は検証でき、1文字でも変えると失敗する', async () => {
  const keys = await G.generateSigningKeys();
  const other = await G.generateSigningKeys();
  assert.ok(G.isSpub(keys.spub));
  const e = await entry(keys, 1, '', { t: 'key', spub: keys.spub });
  assert.ok(G.isLink(e.L));
  assert.equal(await G.verify(keys.spub, e), true);
  // JSON で送って受け取った後も検証できる
  assert.equal(await G.verify(keys.spub, JSON.parse(JSON.stringify(e))), true);
  assert.equal(await G.verify(other.spub, e), false);
  const changed = JSON.parse(JSON.stringify(e));
  changed.L.at += 1;
  assert.equal(await G.verify(keys.spub, changed), false);
  // 秘密鍵は取り出せない
  await assert.rejects(globalThis.crypto.subtle.exportKey('jwk', keys.spriv));
});

test('ハッシュ: 署名を除いた内容から決まる', async () => {
  const keys = await G.generateSigningKeys();
  const e = await entry(keys, 1, '', { t: 'key', spub: keys.spub });
  const h = await G.entryHash(e);
  assert.match(h, /^[A-Za-z0-9_-]{43}$/);
  const resigned = await G.sign(keys.spriv, JSON.parse(JSON.stringify(e)));
  assert.equal(await G.entryHash(resigned), h);
});

test('place: 重複・次・先・書き換え・断絶を見分ける', async () => {
  const keys = await G.generateSigningKeys();
  const e1 = await entry(keys, 1, '', { t: 'key', spub: keys.spub });
  const h1 = await G.entryHash(e1);
  const e2 = await entry(keys, 2, h1, { t: 'match', m: { id: 'x', mySets: 3, oppSets: 1 } });
  const h2 = await G.entryHash(e2);
  const hashes = [h1, h2];
  const at = (n) => hashes[n - 1];
  assert.equal(G.place(0, at, e1, h1), 'next');
  assert.equal(G.place(1, at, e1, h1), 'dup');
  assert.equal(G.place(1, at, e2, h2), 'next');
  const e3 = await entry(keys, 3, h2, { t: 'del', id: 'x' });
  assert.equal(G.place(1, at, e3, await G.entryHash(e3)), 'later');
  // 同じ2番目に別の内容（あとから書き換えた）
  const e2b = await entry(keys, 2, h1, { t: 'match', m: { id: 'x', mySets: 1, oppSets: 3 } });
  assert.equal(G.place(2, at, e2b, await G.entryHash(e2b)), 'conflict');
  // 前の行のハッシュが合わない
  const e3b = await entry(keys, 3, h1, { t: 'del', id: 'x' });
  assert.equal(G.place(2, at, e3b, await G.entryHash(e3b)), 'broken');
});

test('isLink: 不正な形を弾く', () => {
  const ok = { s: 2, p: 'a'.repeat(43), at: 1, to: B, g: 'b'.repeat(86) };
  assert.equal(G.isLink(ok), true);
  assert.equal(G.isLink(Object.assign({}, ok, { s: 0 })), false);
  assert.equal(G.isLink(Object.assign({}, ok, { s: 1 })), false); // 先頭は p が空
  assert.equal(G.isLink(Object.assign({}, ok, { g: 'short' })), false);
  assert.equal(G.isLink(Object.assign({}, ok, { p: '<x>' })), false);
});

test('OpenTimestamps: .ots ファイルの形と元データ', async () => {
  const doc = G.rootDoc(A, [{ from: A, to: B, s: 3, h: 'x' }], '2026-10-17T00:00:00.000Z');
  assert.equal(doc, G.rootDoc(A, [{ to: B, h: 'x', from: A, s: 3 }], '2026-10-17T00:00:00.000Z'));
  const digest = await G.sha256(doc);
  assert.equal(digest.length, 32);
  const reply = Uint8Array.from([0xf0, 0x10, 1, 2, 3]);
  const ots = G.otsFile(digest, reply);
  const magic = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
  assert.deepEqual(Buffer.from(ots.slice(0, magic.length)), magic);
  assert.equal(ots[magic.length], 0x01); // 版
  assert.equal(ots[magic.length + 1], 0x08); // SHA-256
  assert.deepEqual(Buffer.from(ots.slice(magic.length + 2, magic.length + 34)), Buffer.from(digest));
  assert.deepEqual(Buffer.from(ots.slice(magic.length + 34)), Buffer.from(reply));
});

test('署名つきの文書: 受領証を確かめられ、書き換えると失敗する', async () => {
  const k = await G.generateSigningKeys();
  const rc = await G.signDoc(k.spriv, { app: 'tt_record', kind: 'receipt', by: B, chainOf: A, s: 3, h: 'x'.repeat(43), at: 1 });
  assert.equal(await G.verifyDoc(k.spub, rc), true);
  assert.equal(await G.verifyDoc(k.spub, JSON.parse(JSON.stringify(rc))), true);
  assert.equal(await G.verifyDoc(k.spub, Object.assign({}, rc, { s: 4 })), false);
  assert.match(await G.fingerprint(k.spub), /^[A-Za-z0-9_-]{4}(-[A-Za-z0-9_-]{4}){3}$/);
});

async function chainOf(keys, from, to) {
  const key = await G.sign(keys.spriv, { v: 1, from, t: 'key', spub: keys.spub, L: { s: 1, p: '', at: 1, to } });
  return { key, h1: await G.entryHash(key) };
}

test('証拠ファイル: 書き換え（同じ番号に2つ）を第三者が確かめられる', async () => {
  const k = await G.generateSigningKeys();
  const { key, h1 } = await chainOf(k, A, B);
  const a = await G.sign(k.spriv, { v: 1, from: A, t: 'match', m: { id: 'm', mySets: 3, oppSets: 1 }, L: { s: 2, p: h1, at: 2, to: B } });
  const b = await G.sign(k.spriv, { v: 1, from: A, t: 'match', m: { id: 'm', mySets: 1, oppSets: 3 }, L: { s: 2, p: h1, at: 3, to: B } });
  const ev = { app: 'tt_record', kind: 'evidence', type: 'conflict', keyEntry: JSON.stringify(key), items: [JSON.stringify(a), JSON.stringify(b)] };
  const r = await G.checkEvidence(JSON.parse(JSON.stringify(ev)));
  assert.equal(r.ok, true, r.why);
  assert.equal(r.s, 2);
  // 同じ内容なら証拠にならない
  assert.equal((await G.checkEvidence(Object.assign({}, ev, { items: [JSON.stringify(a), JSON.stringify(a)] }))).ok, false);
  // 別の鍵で作った偽の行は証拠にならない
  const other = await G.generateSigningKeys();
  const fake = await G.sign(other.spriv, JSON.parse(JSON.stringify(b)));
  assert.equal((await G.checkEvidence(Object.assign({}, ev, { items: [JSON.stringify(a), JSON.stringify(fake)] }))).ok, false);
});

test('証拠ファイル: つながらない行・受領証の食い違い', async () => {
  const ka = await G.generateSigningKeys();
  const kb = await G.generateSigningKeys();
  const { key: keyA, h1 } = await chainOf(ka, A, B);
  const a2 = await G.sign(ka.spriv, { v: 1, from: A, t: 'del', id: 'm', L: { s: 2, p: h1, at: 2, to: B } });
  const a3 = await G.sign(ka.spriv, { v: 1, from: A, t: 'del', id: 'n', L: { s: 3, p: h1, at: 3, to: B } });
  const broken = { app: 'tt_record', kind: 'evidence', type: 'broken', keyEntry: JSON.stringify(keyA), items: [JSON.stringify(a2), JSON.stringify(a3)] };
  assert.equal((await G.checkEvidence(broken)).ok, true);
  // B の受領証：A の2行目は別のハッシュだった、と署名
  const { key: keyB } = await chainOf(kb, B, A);
  const rc = await G.signDoc(kb.spriv, { app: 'tt_record', kind: 'receipt', by: B, chainOf: A, s: 2, h: 'y'.repeat(43), at: 5 });
  const mm = { app: 'tt_record', kind: 'evidence', type: 'receipt-mismatch', keyEntry: JSON.stringify(keyB), items: [JSON.stringify(rc)], myKeyEntry: JSON.stringify(keyA), myItems: [JSON.stringify(a2)] };
  assert.equal((await G.checkEvidence(mm)).ok, true);
  const same = await G.signDoc(kb.spriv, Object.assign({}, rc, { h: await G.entryHash(a2), g: undefined }));
  assert.equal((await G.checkEvidence(Object.assign({}, mm, { items: [JSON.stringify(same)] }))).ok, false);
});

test('刻印の元データ: 署名つきなら確かめられる', async () => {
  const k = await G.generateSigningKeys();
  const doc = await G.signDoc(k.spriv, { app: 'tt_record', kind: 'ledger-root', v: 2, me: A, at: 't', spub: k.spub, chains: [] });
  const text = G.canonical(doc);
  assert.equal((await G.checkRoot(JSON.parse(text))).ok, true);
  assert.equal((await G.checkRoot(Object.assign(JSON.parse(text), { at: 'u' }))).ok, false);
});
