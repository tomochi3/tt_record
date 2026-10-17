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
    rootDoc, otsFile, OTS_MAGIC, toB64u, fromB64u,
  };
});
