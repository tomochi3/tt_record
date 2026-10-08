// 友だち連携のプロトコル（DOM・通信に依存しない純粋関数）
// 結果は ntfy.sh の「郵便受け」(トピック) を経由して届け、記録本体は各端末に保存する。
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
  // ntfy.sh は 4096 バイトを超える本文を添付ファイル扱いにするので、その手前に収める
  const MAX_MESSAGE_BYTES = 3900;
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

  function friendLink(baseUrl, id, name) {
    return `${baseUrl.split('#')[0]}#add=${id}&name=${encodeURIComponent(name || '')}`;
  }

  // 友だちリンク、または ID そのものを受け付ける
  function parseFriendInput(text) {
    const s = String(text || '').trim();
    if (isId(s)) return { id: s, name: '' };
    const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
    const params = new URLSearchParams(hash);
    const id = params.get('add');
    if (!isId(id)) return null;
    return { id, name: cleanText(params.get('name') || '') };
  }

  function cleanText(v) {
    return typeof v === 'string' ? v.trim().slice(0, MAX_TEXT) : '';
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
      case 'match': {
        const m = validMatch(d.m);
        return m ? Object.assign(base, { m }) : null;
      }
      case 'del':
        return typeof d.id === 'string' && d.id.length <= 40 ? Object.assign(base, { id: d.id }) : null;
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

  return {
    VERSION,
    isId,
    newId,
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
