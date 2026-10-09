// 友だち連携のプロトコル（DOMに依存しない関数）
// 結果は ntfy.sh の「郵便受け」(トピック) を経由して届け、記録本体は各端末に保存する。
// 郵便受けは ID を知っていれば誰でも読み書きできるので、友だちとのやり取りは
// 端末ごとの鍵ペア (ECDH P-256) から作った2人だけの鍵で暗号化 (AES-GCM) する。
// 暗号化が成功すること自体が「相手の秘密鍵を持つ本人からの送信」の証明になる。
// ブラウザでは window.TTLink、Node では module.exports として使える。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scoring.js'));
  else root.TTLink = factory(root.TTScoring);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  const VERSION = 1;
  const ID_LENGTH = 20;
  const ID_RE = /^[A-Za-z0-9]{16,32}$/;
  const TOPIC_PREFIX = 'ttrec-';
  // ntfy.sh は 4096 バイトを超える本文を添付ファイル扱いにするので、
  // 暗号化して base64 にしても収まる大きさに抑える
  const MAX_MESSAGE_BYTES = 2700;
  const PUB_RE = /^[A-Za-z0-9_-]{87}$/;
  const MAX_TEXT = 100;
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  // randomBytes(n) は Uint8Array を返す関数（ブラウザでは crypto.getRandomValues を使う）
  function newId(randomBytes) {
    const bytes = randomBytes(ID_LENGTH);
    let id = '';
    for (let i = 0; i < ID_LENGTH; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
    return id;
  }

  function isId(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  function topicFor(id) {
    return TOPIC_PREFIX + id;
  }

  function isPub(pub) {
    return typeof pub === 'string' && PUB_RE.test(pub);
  }

  // 友だちリンクには公開鍵も入れて、相手の鍵を最初から正しく受け取れるようにする
  function friendLink(baseUrl, id, name, pub) {
    return `${baseUrl.split('#')[0]}#add=${id}${pub ? `&k=${pub}` : ''}&name=${encodeURIComponent(name || '')}`;
  }

  // 貼り付け用の友だちコード（ID と公開鍵をつないだもの）
  function friendCode(id, pub) {
    return pub ? `${id}.${pub}` : id;
  }

  // 友だちリンクか友だちコードを読み取る。公開鍵が入っていないもの（ID だけ・古い形式のリンク）は、
  // 最初の鍵交換で第三者に割り込まれる余地があるので受け付けない
  function parseFriendInput(text) {
    const s = String(text || '').trim();
    const dot = s.indexOf('.');
    if (dot > 0 && !s.includes('#') && isId(s.slice(0, dot)) && isPub(s.slice(dot + 1))) {
      return { id: s.slice(0, dot), name: '', pub: s.slice(dot + 1) };
    }
    const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
    const params = new URLSearchParams(hash);
    const id = params.get('add');
    if (!isId(id)) return null;
    const pub = params.get('k') || '';
    if (!isPub(pub)) return null;
    return { id, name: cleanText(params.get('name') || ''), pub };
  }

  // 見えない文字（ゼロ幅空白など）・文字の向きを変える制御文字・改行などを取り除き、
  // 互換文字（全角英数など）をそろえる。見た目が同じ別の名前を作れないようにするため
  const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8]/g;

  function normalizeText(v) {
    return typeof v === 'string' ? v.normalize('NFKC').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim() : '';
  }

  function cleanText(v) {
    return normalizeText(v).slice(0, MAX_TEXT);
  }

  // 名前の同一判定用（空白の有無や大文字小文字の違いも同じとみなす。長さでは切らない）
  function nameKey(v) {
    return normalizeText(v).replace(/\s/g, '').toLowerCase();
  }

  function byteLength(s) {
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s);
  }

  // 送る内容（メモは個人的なものなので送らない）
  function matchPayload(m) {
    const p = {
      id: m.id,
      rev: m.updatedAt || m.createdAt || 0,
      date: m.date,
      event: m.event || '',
      bestOf: m.bestOf,
      mode: m.mode === 'detail' ? 'detail' : 'simple',
      mySets: m.mySets,
      oppSets: m.oppSets,
    };
    // 奢りの対象にした試合は、相手も同じ勝数で数えられるよう「何勝で奢りか」も送る
    if ([1, 2, 3].includes(m.treat)) p.treat = m.treat;
    if (p.mode === 'detail' && m.rally) {
      p.firstServer = m.firstServer;
      p.rally = m.rally;
    }
    return p;
  }

  function encode(msg) {
    let text = JSON.stringify(Object.assign({ v: VERSION }, msg));
    if (byteLength(text) > MAX_MESSAGE_BYTES && msg.m && msg.m.rally) {
      // 長すぎる試合は1点ごとの記録を省いて結果だけ送る
      const m = Object.assign({}, msg.m);
      delete m.rally;
      delete m.firstServer;
      text = JSON.stringify(Object.assign({ v: VERSION }, msg, { m }));
    }
    return text;
  }

  function validMatch(m) {
    if (!m || typeof m !== 'object') return null;
    const bestOf = m.bestOf;
    if (![3, 5, 7].includes(bestOf)) return null;
    if (!S.isValidResult(bestOf, m.mySets, m.oppSets)) return null;
    if (typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(m.id)) return null;
    if (typeof m.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return null;
    const out = {
      id: m.id,
      rev: Number.isFinite(m.rev) ? m.rev : 0,
      date: m.date,
      event: cleanText(m.event),
      bestOf,
      mode: m.mode === 'detail' ? 'detail' : 'simple',
      mySets: m.mySets,
      oppSets: m.oppSets,
    };
    if ([1, 2, 3].includes(m.treat)) out.treat = m.treat;
    if (out.mode === 'detail' && typeof m.rally === 'string' && /^[mo]{1,2000}$/.test(m.rally) &&
        (m.firstServer === 'me' || m.firstServer === 'opp')) {
      const c = S.computeMatch(bestOf, m.firstServer, m.rally);
      // 1点ごとの記録と結果が食い違うものは結果だけ採用する
      if (c.finished && c.mySets === m.mySets && c.oppSets === m.oppSets) {
        out.firstServer = m.firstServer;
        out.rally = m.rally;
      }
    }
    return out;
  }

  // 受け取った文字列を検証して返す。不正なら null
  function decode(text) {
    let d;
    try {
      d = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!d || typeof d !== 'object' || d.v !== VERSION || !isId(d.from)) return null;
    const key = typeof d.key === 'string' && d.key.length <= 80 ? d.key : '';
    const base = { t: d.t, from: d.from, name: cleanText(d.name), key };
    switch (d.t) {
      case 'hello':
        return base;
      case 'name':
        // 名前の変更通知。古い通知で新しい名前を上書きしないよう、変更時刻も送る
        return base.name && Number.isFinite(d.at) ? Object.assign(base, { at: d.at }) : null;
      case 'match': {
        const m = validMatch(d.m);
        return m ? Object.assign(base, { m }) : null;
      }
      case 'del':
        return typeof d.id === 'string' && d.id.length <= 40
          ? Object.assign(base, { id: d.id, at: Number.isFinite(d.at) ? d.at : 0 }) : null;
      case 'ack':
        return Array.isArray(d.keys)
          ? Object.assign(base, { keys: d.keys.filter((k) => typeof k === 'string' && k.length <= 80).slice(0, 200) })
          : null;
      default:
        return null;
    }
  }

  // 送信待ちを区別するキー（同じ試合でも編集されたら別キー）
  function outboxKey(type, id, rev) {
    return `${type}:${id}:${rev || 0}`;
  }

  function receivedId(from, remoteId) {
    return `r_${from}_${remoteId}`;
  }

  function flipSide(side) {
    return side === 'me' ? 'opp' : 'me';
  }

  // 相手の端末で記録された試合を、自分から見た記録に変換する
  function toLocalMatch(m, from, friendName, now) {
    const local = {
      id: receivedId(from, m.id),
      date: m.date,
      opponent: friendName,
      opponentId: from,
      event: m.event,
      bestOf: m.bestOf,
      mode: m.mode,
      mySets: m.oppSets,
      oppSets: m.mySets,
      memo: '',
      createdAt: now,
      received: { from, id: m.id, rev: m.rev },
    };
    if (m.treat) local.treat = m.treat;
    if (m.rally) {
      local.firstServer = flipSide(m.firstServer);
      local.rally = m.rally.replace(/[mo]/g, (c) => (c === 'm' ? 'o' : 'm'));
      const c = S.computeMatch(local.bestOf, local.firstServer, local.rally);
      local.games = c.games.map((g) => ({ me: g.me, opp: g.opp }));
    } else if (local.mode === 'detail') {
      local.mode = 'simple';
    }
    return local;
  }

  // 自分でも同じ試合を記録していたら、その記録を返す（まだ相手の記録と結び付いていないもの）
  function findDuplicate(matches, local) {
    return matches.find((x) =>
      !x.received && !x.remote &&
      x.opponentId === local.opponentId &&
      x.date === local.date &&
      x.mySets === local.mySets && x.oppSets === local.oppSets) || null;
  }

  // 端末に保存する試合記録を検証してきれいにする（インポートや保存データの改ざん対策）。不正なら null
  function sanitizeMatch(m) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(m.id)) return null;
    if (![3, 5, 7].includes(m.bestOf) || !S.isValidResult(m.bestOf, m.mySets, m.oppSets)) return null;
    const out = {
      id: m.id,
      date: typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : '',
      opponent: cleanText(m.opponent),
      event: cleanText(m.event),
      bestOf: m.bestOf,
      mode: m.mode === 'detail' ? 'detail' : 'simple',
      mySets: m.mySets,
      oppSets: m.oppSets,
      memo: typeof m.memo === 'string' ? m.memo.slice(0, 2000) : '',
      createdAt: Number.isFinite(m.createdAt) ? m.createdAt : 0,
    };
    if (Number.isFinite(m.updatedAt)) out.updatedAt = m.updatedAt;
    if ([1, 2, 3].includes(m.treat)) out.treat = m.treat;
    if (!out.opponent) return null;
    if (out.mode === 'detail') {
      const okRally = typeof m.rally === 'string' && /^[mo]{1,2000}$/.test(m.rally) && (m.firstServer === 'me' || m.firstServer === 'opp');
      const c = okRally && S.computeMatch(m.bestOf, m.firstServer, m.rally);
      if (c && c.finished && c.mySets === m.mySets && c.oppSets === m.oppSets) {
        out.firstServer = m.firstServer;
        out.rally = m.rally;
        out.games = c.games.map((g) => ({ me: g.me, opp: g.opp }));
      } else {
        out.mode = 'simple';
      }
    }
    if (isId(m.opponentId)) out.opponentId = m.opponentId;
    const ref = (r) => r && typeof r === 'object' && isId(r.from) && typeof r.id === 'string' && r.id.length <= 40;
    if (ref(m.received)) out.received = { from: m.received.from, id: m.received.id, rev: Number.isFinite(m.received.rev) ? m.received.rev : 0 };
    if (ref(m.remote)) out.remote = { from: m.remote.from, id: m.remote.id };
    return out;
  }

  // ---------- 暗号 ----------

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

  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

  // 端末の鍵ペアを作る。pub は公開してよい。priv は「取り出し不可」の鍵で、
  // ブラウザの中で使えるだけで中身を読み出せない（盗まれてもファイルにできない）
  // exportable=true は、取り出し不可の鍵を保存できない環境向けの予備（JWK で返す）
  async function generateKeys(exportable) {
    const kp = await subtle().generateKey(ECDH, !!exportable, ['deriveKey']);
    return {
      pub: toB64u(await subtle().exportKey('raw', kp.publicKey)),
      priv: exportable ? await subtle().exportKey('jwk', kp.privateKey) : kp.privateKey,
    };
  }

  // 以前の形式（JWK で保存していた秘密鍵）を取り出し不可の鍵に作り直す
  function importPrivateJwk(jwk) {
    return subtle().importKey('jwk', jwk, ECDH, false, ['deriveKey']);
  }

  // 公開鍵が本当に使えるもの（曲線上の点）か確かめる。形式だけ正しい壊れた鍵を弾く
  async function isUsablePub(pub) {
    if (!isPub(pub)) return false;
    try {
      await subtle().importKey('raw', fromB64u(pub), ECDH, false, []);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 自分の秘密鍵と相手の公開鍵から、2人だけが作れる共通鍵を作る
  async function pairKey(privKey, pub) {
    const priv = privKey && privKey.type === 'private' ? privKey : await importPrivateJwk(privKey);
    const peer = await subtle().importKey('raw', fromB64u(pub), ECDH, false, []);
    return subtle().deriveKey({ name: 'ECDH', public: peer }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // 送信者→受信者の向きも認証に含めて、自分の送ったものを送り返される攻撃を防ぐ
  function aad(from, to) {
    return new TextEncoder().encode(`ttrec:${from}>${to}`);
  }

  async function seal(key, from, to, text) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(from, to) }, key, new TextEncoder().encode(text));
    return JSON.stringify({ v: 2, from, iv: toB64u(iv), ct: toB64u(ct) });
  }

  // 復号できなければ（鍵が違う・改ざん・なりすまし）null
  async function open(key, from, to, env) {
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64u(env.iv), additionalData: aad(from, to) }, key, fromB64u(env.ct));
      return new TextDecoder().decode(pt);
    } catch (e) {
      return null;
    }
  }

  // 友だち申請だけは相手の鍵をまだ知らないので暗号化せずに送る（公開鍵と名前だけ）
  function helloEnvelope(from, name, pub) {
    return JSON.stringify({ v: 2, t: 'hello', from, name: cleanText(name), pub });
  }

  // 郵便受けから取り出した文字列の外側を読む
  function parseEnvelope(text) {
    let d;
    try {
      d = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!d || typeof d !== 'object' || !isId(d.from)) return null;
    if (d.v === 2 && d.t === 'hello') {
      return isPub(d.pub) ? { kind: 'hello', from: d.from, name: cleanText(d.name), pub: d.pub } : null;
    }
    if (d.v === 2) {
      return typeof d.iv === 'string' && typeof d.ct === 'string' && d.iv.length < 40 && d.ct.length < 8000
        ? { kind: 'sealed', from: d.from, iv: d.iv, ct: d.ct } : null;
    }
    if (d.v === VERSION) return { kind: 'legacy', from: d.from, text };
    return null;
  }

  return {
    VERSION,
    isId,
    isPub,
    isUsablePub,
    cleanText,
    nameKey,
    newId,
    friendCode,
    sanitizeMatch,
    generateKeys,
    importPrivateJwk,
    pairKey,
    seal,
    open,
    helloEnvelope,
    parseEnvelope,
    topicFor,
    friendLink,
    parseFriendInput,
    matchPayload,
    encode,
    decode,
    outboxKey,
    receivedId,
    toLocalMatch,
    findDuplicate,
  };
});
