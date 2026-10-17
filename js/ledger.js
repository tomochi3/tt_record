// 改ざんを検知できる帳簿（DOMに依存しない関数）
// 友だちとのやり取りを「追記だけの帳簿」にする。1行ごとに通し番号・前の行のハッシュを入れて
// 端末の署名鍵 (ECDSA P-256・取り出し不可) で署名し、相手の端末にも写しを残す。
// 途中を書き換えるとハッシュがつながらなくなり、同じ番号に違う内容があれば署名つきの証拠が残る。
// 帳簿の先頭のハッシュをビットコインに刻む (OpenTimestamps) ための形式もここで作る。
// ブラウザでは window.TTLedger、Node では module.exports として使える。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTLedger = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIGN_KEY = { name: 'ECDSA', namedCurve: 'P-256' };
  const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
  const SPUB_RE = /^[A-Za-z0-9_-]{87}$/;
  const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
  const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

  function subtle() {
    return globalThis.crypto.subtle;
  }

  function toB64u(bytes) {
    let bin = '';
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64u(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  function isSpub(s) {
    return typeof s === 'string' && SPUB_RE.test(s);
  }

  // キーの順番をそろえた JSON（同じ内容なら誰が作っても同じ文字列になる）
  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  // 署名の対象：署名そのもの (L.g) を除いた行の全体
  function signedText(entry) {
    const copy = Object.assign({}, entry, { L: Object.assign({}, entry.L) });
    delete copy.L.g;
    return canonical(copy);
  }

  async function sha256(text) {
    return new Uint8Array(await subtle().digest('SHA-256', new TextEncoder().encode(text)));
  }

  async function entryHash(entry) {
    return toB64u(await sha256(signedText(entry)));
  }

  // L: { s: 通し番号(1〜), p: 前の行のハッシュ(先頭は ''), at: 書いた時刻, to: 相手のID, g: 署名 }
  function isLink(L) {
    return !!L && typeof L === 'object' && Number.isInteger(L.s) && L.s >= 1 && L.s <= 1e7 &&
      (L.s === 1 ? L.p === '' : HASH_RE.test(L.p || '')) && Number.isFinite(L.at) &&
      typeof L.to === 'string' && typeof L.g === 'string' && SIG_RE.test(L.g);
  }

  async function generateSigningKeys() {
    const kp = await subtle().generateKey(SIGN_KEY, false, ['sign', 'verify']);
    return { spub: toB64u(await subtle().exportKey('raw', kp.publicKey)), spriv: kp.privateKey };
  }

  async function sign(spriv, entry) {
    const sig = await subtle().sign(SIGN_ALG, spriv, new TextEncoder().encode(signedText(entry)));
    entry.L.g = toB64u(sig);
    return entry;
  }

  async function verify(spub, entry) {
    if (!isSpub(spub) || !entry || !isLink(entry.L)) return false;
    try {
      const key = await subtle().importKey('raw', fromB64u(spub), SIGN_KEY, false, ['verify']);
      return await subtle().verify(SIGN_ALG, key, fromB64u(entry.L.g), new TextEncoder().encode(signedText(entry)));
    } catch (e) {
      return false;
    }
  }

  // 届いた行が、手元の写し (have: これまでの行の数, hashAt(n): n番目のハッシュ) に対してどうか
  //   dup: すでに同じ内容がある / next: 次の行 / later: 先の番号（間が届くまで預かる）
  //   conflict: 同じ番号に違う内容（書き換えの証拠） / broken: 前の行とつながらない
  function place(have, hashAt, entry, hash) {
    const s = entry.L.s;
    if (s <= have) return hashAt(s) === hash ? 'dup' : 'conflict';
    if (s > have + 1) return 'later';
    if (s > 1 && entry.L.p !== hashAt(s - 1)) return 'broken';
    return 'next';
  }

  // ---------- 署名つきの文書（受領証・刻印の元データ） ----------
  // g（署名）を除いた内容に署名する。誰でも公開鍵で確かめられる

  function docText(doc) {
    const copy = Object.assign({}, doc);
    delete copy.g;
    return canonical(copy);
  }

  async function signDoc(spriv, obj) {
    const sig = await subtle().sign(SIGN_ALG, spriv, new TextEncoder().encode(docText(obj)));
    return Object.assign({}, obj, { g: toB64u(sig) });
  }

  async function verifyDoc(spub, doc) {
    if (!isSpub(spub) || !doc || typeof doc !== 'object' || typeof doc.g !== 'string' || !SIG_RE.test(doc.g)) return false;
    try {
      const key = await subtle().importKey('raw', fromB64u(spub), SIGN_KEY, false, ['verify']);
      return await subtle().verify(SIGN_ALG, key, fromB64u(doc.g), new TextEncoder().encode(docText(doc)));
    } catch (e) {
      return false;
    }
  }

  // 公開鍵の短い指紋（人が見比べる用）
  async function fingerprint(spub) {
    const h = toB64u(await sha256(spub)).slice(0, 16);
    return h.match(/.{4}/g).join('-');
  }

  // ---------- 証拠ファイルの検証（アプリの外の検証ページでも使う） ----------
  // 証拠ファイル: { app, kind: 'evidence', type, keyEntry, items, myKeyEntry?, myItems? }
  //   keyEntry: 署名した人の帳簿の1行目（公開鍵。その鍵自身の署名つき）
  //   conflict: 同じ番号に違う内容の2行 / broken: 前の行と、それとつながらない次の行
  //   receipt-mismatch: 署名つきの受領証と、それと食い違う受け取り手側の行（myKeyEntry で確かめる）

  function parseJson(text) {
    try {
      return typeof text === 'string' ? JSON.parse(text) : text;
    } catch (e) {
      return null;
    }
  }

  async function keyOf(text) {
    const k = parseJson(text);
    if (!k || k.t !== 'key' || !isSpub(k.spub) || !isLink(k.L) || k.L.s !== 1) return null;
    return (await verify(k.spub, k)) ? { id: k.from, to: k.L.to, spub: k.spub, fp: await fingerprint(k.spub) } : null;
  }

  async function checkEvidence(ev) {
    const fail = (why) => ({ ok: false, why });
    if (!ev || ev.app !== 'tt_record' || ev.kind !== 'evidence' || !Array.isArray(ev.items)) return fail('証拠ファイルの形式ではありません');
    const key = await keyOf(ev.keyEntry);
    if (!key) return fail('署名した人の公開鍵（帳簿の1行目）を確かめられません');
    const items = ev.items.map(parseJson);
    if (ev.type === 'conflict' || ev.type === 'broken') {
      const [a, b] = items;
      if (!a || !b || !(await verify(key.spub, a)) || !(await verify(key.spub, b))) return fail('2つの行のどちらかの署名が、この公開鍵のものではありません');
      if (a.from !== key.id || b.from !== key.id || a.L.to !== key.to || b.L.to !== key.to) return fail('2つの行が同じ帳簿のものではありません');
      if (ev.type === 'conflict') {
        if (a.L.s !== b.L.s || (await entryHash(a)) === (await entryHash(b))) return fail('同じ番号に違う内容、にはなっていません');
        return { ok: true, key, s: a.L.s, title: `鍵 ${key.fp} が、帳簿の${a.L.s}行目に違う内容を2つ署名しています`, detail: 'あとから記録を書き換えた（または相手によって違う記録を見せた）証拠です。この鍵の持ち主以外には、この2つの署名は作れません。' };
      }
      if (b.L.s !== a.L.s + 1 || b.L.p === (await entryHash(a))) return fail('前の行とつながらない行、にはなっていません');
      return { ok: true, key, s: b.L.s, title: `鍵 ${key.fp} が、帳簿の${a.L.s}行目と食い違う${b.L.s}行目を署名しています`, detail: `${b.L.s}行目は、手元の${a.L.s}行目とは別の行の続きとして書かれています。途中を書き換えた証拠です。` };
    }
    if (ev.type === 'receipt-mismatch') {
      const [rc] = items;
      const mine = await keyOf(ev.myKeyEntry);
      const row = parseJson((ev.myItems || [])[0]);
      if (!rc || rc.kind !== 'receipt' || !(await verifyDoc(key.spub, rc)) || rc.by !== key.id) return fail('受領証の署名を確かめられません');
      if (!mine || !row || !(await verify(mine.spub, row)) || row.from !== mine.id || rc.chainOf !== mine.id) return fail('食い違う行の署名を確かめられません');
      if (row.L.s !== rc.s || (await entryHash(row)) === rc.h) return fail('受領証と行は食い違っていません');
      return { ok: true, key, s: rc.s, title: `鍵 ${key.fp} の受領証が、鍵 ${mine.fp} の帳簿の${rc.s}行目と食い違っています`, detail: '受領証には、実際に署名された行とは違う内容を受け取ったと書かれています。どちらかの手元の記録が書き換えられた証拠です。' };
    }
    return fail('この種類の証拠には対応していません');
  }

  // 刻印した元データ（署名つき）を確かめる
  async function checkRoot(doc) {
    if (!doc || doc.app !== 'tt_record' || doc.kind !== 'ledger-root') return { ok: false, why: '刻印の元データではありません' };
    if (!isSpub(doc.spub)) return { ok: false, why: 'この元データには署名がありません（以前の形式）' };
    if (!(await verifyDoc(doc.spub, doc))) return { ok: false, why: '署名が正しくありません' };
    return { ok: true, fp: await fingerprint(doc.spub), at: doc.at, chains: Array.isArray(doc.chains) ? doc.chains : [] };
  }

  // ---------- ビットコインへの刻印 (OpenTimestamps) ----------

  // 刻印する元データ：すべての帳簿の「最後の番号と先頭のハッシュ」
  function rootDoc(me, chains, at) {
    return canonical({ app: 'tt_record', kind: 'ledger-root', v: 1, me, at, chains });
  }

  // .ots ファイル = 見出し + 版(1) + SHA-256 の印(0x08) + 元データのハッシュ + 刻印サーバーの返事
  const OTS_MAGIC = Uint8Array.from([0x00, ...Array.from('OpenTimestamps', (c) => c.charCodeAt(0)), 0x00, 0x00,
    ...Array.from('Proof', (c) => c.charCodeAt(0)), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);

  function otsFile(digest, calendarReply) {
    const out = new Uint8Array(OTS_MAGIC.length + 2 + digest.length + calendarReply.length);
    out.set(OTS_MAGIC, 0);
    out[OTS_MAGIC.length] = 0x01;
    out[OTS_MAGIC.length + 1] = 0x08;
    out.set(digest, OTS_MAGIC.length + 2);
    out.set(calendarReply, OTS_MAGIC.length + 2 + digest.length);
    return out;
  }

  return {
    isSpub, isLink, canonical, signedText, sha256, entryHash, generateSigningKeys, sign, verify, place,
    signDoc, verifyDoc, fingerprint, checkEvidence, checkRoot,
    rootDoc, otsFile, OTS_MAGIC, toB64u, fromB64u,
  };
});
