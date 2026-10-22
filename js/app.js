'use strict';
(function () {
  // 他のサイトに埋め込まれている場合は画面を出さない（透明に重ねてボタンを押させる攻撃を防ぐ）
  if (window.self !== window.top) {
    document.getElementById('tabbar').hidden = true;
    const main = document.getElementById('main');
    main.textContent = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'このアプリは他のページの中では使えません。';
    const a = document.createElement('a');
    a.href = location.href.split('#')[0];
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'btn primary';
    a.textContent = 'アプリを直接開く';
    main.append(p, a);
    return;
  }

  const S = window.TTScoring;
  const TR = window.TTTreat;
  const LG = window.TTLedger;
  const L = window.TTLink;
  const NTFY = 'https://ntfy.sh';
  // ntfy.sh は届いたメッセージを12時間しか預からない。相手が数日アプリを開かなくても届くよう、
  // 同じ内容を「11時間後・22時間後…66時間後に配達」の予約でも預けておく（ntfy.sh の予約は3日まで。受け取った側は重複を無視する）。
  // それでも返事(ack)が来なければ、預けた分が切れる少し前に送り直す
  const HOUR_MS = 60 * 60 * 1000;
  const KEEP_H = 12;
  const DELAYS_H = [11, 22, 33, 44, 55, 66];
  const RESEND_BEFORE_MS = 6 * HOUR_MS;
  const POLL_MS = 60 * 1000;
  const STORE_KEY = 'ttrecord.v1';
  const LIVE_KEY = 'ttrecord.live';

  // ---------- データ保存（localStorage） ----------

  function loadDb() {
    const empty = {
      settings: { myName: '自分' }, matches: [], friends: [], outbox: [], requests: [], blocked: [], treatLog: [], offers: [],
      sync: { since: 0, seen: [], tomb: {}, offersDone: [] }, ledger: sanitizeLedger(null),
    };
    let d = null;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      d = raw ? JSON.parse(raw) : null;
    } catch (e) {
      d = null;
    }
    // 保存データも書き換えられている可能性があるので、読み込むたびに検証する
    const arr = (v) => (Array.isArray(v) ? v : []);
    const out = d && typeof d === 'object' ? {
      settings: Object.assign({}, empty.settings, d.settings && typeof d.settings === 'object' ? d.settings : {}),
      matches: arr(d.matches).map(L.sanitizeMatch).filter(Boolean),
      treatLog: arr(d.treatLog).filter(TR.isLogEntry).map(sanitizeTreatEntry),
      ledger: sanitizeLedger(d.ledger),
      offers: arr(d.offers).filter((o) => o && L.isId(o.friendId) && ['in', 'out'].includes(o.dir) && typeof o.id === 'string' &&
        /^[A-Za-z0-9_-]{1,40}$/.test(o.id) && Number.isInteger(o.amount) && o.amount > 0 && o.amount <= 6000)
        .map((o) => ({ id: o.id, dir: o.dir, friendId: o.friendId, name: cleanName(o.name), amount: o.amount, at: Number.isFinite(o.at) ? o.at : 0 })),
      friends: arr(d.friends).map(sanitizeFriend).filter(Boolean),
      outbox: arr(d.outbox).filter((o) => o && L.isId(o.to) && typeof o.key === 'string'),
      requests: arr(d.requests).filter((r) => r && L.isId(r.id) && L.isPub(r.pub))
        .map((r) => ({ id: r.id, name: cleanName(r.name), pub: r.pub, at: r.at, buffer: arr(r.buffer).filter((t) => typeof t === 'string') })),
      blocked: arr(d.blocked).filter(L.isId),
      sync: Object.assign({}, empty.sync, d.sync && typeof d.sync === 'object' ? d.sync : {}),
    } : empty;
    out.settings.myName = cleanName(out.settings.myName) || '自分';
    if (!Array.isArray(out.sync.seen)) out.sync.seen = [];
    if (!out.sync.tomb || typeof out.sync.tomb !== 'object') out.sync.tomb = {};
    out.sync.offersDone = arr(out.sync.offersDone).filter((x) => typeof x === 'string').slice(-200);
    // 以前の「先にN勝で奢り・未/済」の済のメモを、奢った/奢ってもらった記録に移す
    if (d && !Array.isArray(d.treatLog) && d.treats && typeof d.treats === 'object') {
      for (const x of TR.legacyDecided(out.matches)) {
        const done = d.treats[x.matchId];
        if (done && done.done === true) {
          out.treatLog.push({ id: uid(), name: x.name, kind: x.winner === 'me' ? 'got' : 'paid', amount: TR.UNIT, at: Number.isFinite(done.at) ? done.at : 0 });
        }
      }
    }
    if (!Number.isFinite(out.sync.since)) out.sync.since = 0;
    if (!L.isId(out.settings.myId)) {
      out.settings.myId = L.newId((n) => crypto.getRandomValues(new Uint8Array(n)));
    }
    return out;
  }

  function saveDb() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 1, settings: db.settings, matches: db.matches, friends: db.friends, outbox: db.outbox,
        requests: db.requests, blocked: db.blocked, sync: db.sync, treatLog: db.treatLog, offers: db.offers, ledger: db.ledger,
      }));
    } catch (e) {
      toast('保存に失敗しました');
    }
  }

  function cleanName(v) {
    return L.cleanText(v);
  }

  // 奢りの記録。shared: 友だちとの帳簿にも書いた / from・rid: 友だちの帳簿から届いた / paired: 同じ1回を2人とも記録した相手側の記録
  function sanitizeTreatEntry(e) {
    const out = { id: typeof e.id === 'string' ? e.id.slice(0, 80) : uid(), name: cleanName(e.name), kind: e.kind, amount: e.amount, at: Number.isFinite(e.at) ? e.at : 0 };
    if (L.isId(e.shared)) out.shared = e.shared;
    if (L.isId(e.from) && typeof e.rid === 'string') {
      out.from = e.from;
      out.rid = e.rid.slice(0, 80);
    }
    if (e.paired && L.isId(e.paired.from) && typeof e.paired.id === 'string' && TR.isLogEntry(Object.assign({ name: 'x' }, e.paired))) {
      out.paired = { id: e.paired.id.slice(0, 80), from: e.paired.from, kind: e.paired.kind, amount: e.paired.amount, at: Number.isFinite(e.paired.at) ? e.paired.at : 0 };
    }
    return out;
  }

  // 友だちとの帳簿。mine: 自分が書いた行（相手ごと） / peer: 相手が書いた行の写し・預かり中の行・見つかった問題
  // 第三者に見せられる証拠の束（署名つきの行・受領証の文字列だけ）
  function sanitizePack(p) {
    if (!p || typeof p !== 'object' || !['conflict', 'broken', 'receipt-mismatch'].includes(p.type)) return undefined;
    const strs = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t.length <= 8000).slice(0, 2) : []);
    if (typeof p.keyEntry !== 'string') return undefined;
    const out = { type: p.type, keyEntry: p.keyEntry, items: strs(p.items) };
    if (p.type === 'receipt-mismatch') {
      if (typeof p.myKeyEntry !== 'string') return undefined;
      out.myKeyEntry = p.myKeyEntry;
      out.myItems = strs(p.myItems);
    }
    return out;
  }

  function sanitizeLedger(x) {
    const out = { mine: {}, peer: {}, acked: {}, receipts: {}, ots: { stamps: [], lastAt: 0, lastSig: '' } };
    if (!x || typeof x !== 'object') return out;
    const arr = (v) => (Array.isArray(v) ? v : []);
    const row = (r) => (r && Number.isInteger(r.s) && typeof r.h === 'string' && typeof r.text === 'string'
      ? { s: r.s, h: r.h.slice(0, 43), at: Number.isFinite(r.at) ? r.at : 0, text: r.text, note: typeof r.note === 'string' ? r.note.slice(0, 200) : '', resent: Number.isInteger(r.resent) ? r.resent : 0 }
      : null);
    for (const [id, rows] of Object.entries(x.mine || {})) if (L.isId(id)) out.mine[id] = arr(rows).map(row).filter(Boolean);
    for (const [id, p] of Object.entries(x.peer || {})) {
      if (!L.isId(id) || !p || typeof p !== 'object') continue;
      const pending = {};
      for (const [k, v] of Object.entries(p.pending || {}).slice(0, 100)) if (/^\d+$/.test(k) && typeof v === 'string') pending[k] = v;
      out.peer[id] = {
        rows: arr(p.rows).map(row).filter(Boolean),
        pending,
        spub: LG.isSpub(p.spub) ? p.spub : '',
        issues: arr(p.issues).filter((i) => i && typeof i.kind === 'string' && typeof i.text === 'string').slice(-50)
          .map((i) => ({ kind: i.kind.slice(0, 20), s: Number.isInteger(i.s) ? i.s : 0, at: Number.isFinite(i.at) ? i.at : 0, text: i.text.slice(0, 300), seen: !!i.seen, evidence: arr(i.evidence).filter((t) => typeof t === 'string').slice(0, 2), pack: sanitizePack(i.pack) })),
        old: arr(p.old).map((rows) => arr(rows).map(row).filter(Boolean)).slice(-3),
      };
    }
    for (const [id, a] of Object.entries(x.acked || {})) {
      if (L.isId(id) && a && Number.isInteger(a.s)) out.acked[id] = { s: a.s, at: Number.isFinite(a.at) ? a.at : 0, ok: !!a.ok, signed: !!a.signed };
    }
    out.receipts = {};
    for (const [id, t] of Object.entries(x.receipts || {})) if (L.isId(id) && typeof t === 'string' && t.length <= 600) out.receipts[id] = t;
    const o = x.ots && typeof x.ots === 'object' ? x.ots : {};
    out.ots = {
      lastAt: Number.isFinite(o.lastAt) ? o.lastAt : 0,
      lastTry: Number.isFinite(o.lastTry) ? o.lastTry : 0,
      failed: !!o.failed,
      lastSig: typeof o.lastSig === 'string' ? o.lastSig.slice(0, 4000) : '',
      stamps: arr(o.stamps).filter((t) => t && typeof t.doc === 'string' && Array.isArray(t.proofs)).slice(-30)
        .map((t) => ({ at: Number.isFinite(t.at) ? t.at : 0, doc: t.doc, proofs: t.proofs.filter((q) => q && typeof q.cal === 'string' && typeof q.b64 === 'string').slice(0, 4) })),
    };
    return out;
  }

  function sanitizeFriend(f) {
    if (!f || !L.isId(f.id)) return null;
    const out = { id: f.id, name: cleanName(f.name) || '友だち', remoteName: cleanName(f.remoteName), addedAt: f.addedAt };
    if (L.isPub(f.pub)) out.pub = f.pub;
    if (f.custom) out.custom = true;
    if (Number.isFinite(f.nameAt)) out.nameAt = f.nameAt;
    return out;
  }

  function loadLive() {
    try {
      const v = JSON.parse(localStorage.getItem(LIVE_KEY) || 'null');
      if (!v || typeof v !== 'object' || ![3, 5, 7].includes(v.bestOf)) return null;
      return {
        date: typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : '',
        opponent: cleanName(v.opponent),
        event: cleanName(v.event),
        memo: typeof v.memo === 'string' ? v.memo.slice(0, 2000) : '',
        bestOf: v.bestOf,
        firstServer: v.firstServer === 'opp' ? 'opp' : 'me',
        rally: typeof v.rally === 'string' && /^[mo]{0,2000}$/.test(v.rally) ? v.rally : '',
        treat: TR.isNeed(v.treat) ? v.treat : 0,
        board: v.board === true,
        boardLeft: v.boardLeft === 'opp' ? 'opp' : 'me',
        startedAt: v.startedAt,
      };
    } catch (e) {
      return null;
    }
  }

  function saveLive() {
    try {
      if (live) localStorage.setItem(LIVE_KEY, JSON.stringify(live));
      else localStorage.removeItem(LIVE_KEY);
    } catch (e) {
      /* 端末のストレージが使えなくても試合は続けられる */
    }
  }

  // ---------- ユーティリティ ----------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function fmtDate(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y) return '';
    const wd = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
    return `${m}/${d}(${wd})`;
  }

  // 年まで入れた日付（他の画面の「10/14(水)」とそろえた書き方）
  function fmtDateFull(iso) {
    const y = String(iso || '').slice(0, 4);
    const short = fmtDate(iso);
    return short ? `${y}/${short}` : '';
  }

  function pct(won, total) {
    return total ? `${((won / total) * 100).toFixed(1)}%` : '—';
  }

  // 勝ち越しは緑、負け越しは赤（五分は色なし）。数字の色だけで傾向が分かるようにする
  function tone(won, total) {
    if (!total || won * 2 === total) return '';
    return won * 2 > total ? ' good' : ' bad';
  }

  // 「4-2」の勝ちを緑、負けを赤で
  function wl(w, l) {
    return `<span class="wl-w">${w}</span>-<span class="wl-l">${l}</span>`;
  }

  function sortedMatches() {
    return db.matches.slice().sort((a, b) =>
      (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function uniqueValues(key) {
    const seen = new Map();
    for (const m of sortedMatches()) {
      const v = (m[key] || '').trim();
      if (v && !seen.has(v)) seen.set(v, true);
    }
    return [...seen.keys()];
  }

  // カタカナ→ひらがな・大文字→小文字にそろえて、読みの表記ゆれでも候補に出す
  function normalize(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  // 連携中の友だちと過去に記録した対戦相手を、対戦回数が多い順（同数なら最近の順）に返す
  function opponentSuggestions(query, limit) {
    const stats = new Map();
    for (const f of db.friends) stats.set(f.name, { name: f.name, n: 0, w: 0 });
    for (const m of sortedMatches()) {
      const name = (m.opponent || '').trim();
      if (!name) continue;
      const s = stats.get(name) || { name, n: 0, w: 0 };
      s.n++;
      if (m.mySets > m.oppSets) s.w++;
      stats.set(name, s);
    }
    const q = normalize(query);
    return [...stats.values()]
      .filter((s) => !q || (normalize(s.name).includes(q) && normalize(s.name) !== q))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit || 8);
  }

  function opponentChips(query) {
    const chips = opponentSuggestions(query).map((s) =>
      `<button type="button" class="opp-chip" data-action="pick-opp" data-name="${esc(s.name)}">${friendByName(s.name) ? '🔗 ' : ''}${esc(s.name)}<small>${s.n ? `${s.w}勝${s.n - s.w}敗` : '友だち'}</small></button>`).join('');
    const f = friendByName(query);
    let hint = f ? `<p class="link-hint">🔗 ${esc(f.name)}さんと連携中。保存すると相手のアプリにも結果が届きます。</p>` : '';
    // 入力途中の名前のまま保存しないよう、候補があるのに一致しないときは新しい相手になることを知らせる
    const q = (query || '').trim();
    const list = opponentSuggestions(query);
    if (!f && q && list.length && !list.some((s) => L.nameKey(s.name) === L.nameKey(q))) {
      hint = `<p class="new-opp-hint">「${esc(q)}」は新しい相手として記録されます。${esc(list[0].name)}さんなら上の候補をタップ</p>`;
    }
    return chips + hint;
  }

  // ---------- 友だち ----------

  function friendById(id) {
    return db.friends.find((f) => f.id === id) || null;
  }

  function friendByName(name) {
    const n = (name || '').trim();
    return n ? db.friends.find((f) => f.name === n) || null : null;
  }

  // 他の友だちや自分と名前がかぶらないようにする
  function uniqueFriendName(name, exceptId) {
    const raw = cleanName(name);
    // 「(2)」などを付けても上限の長さに収まるよう、元の名前を少し短くしておく
    const base = (raw && raw !== '自分' ? raw : '友だち').slice(0, 90);
    let n = raw && raw !== '自分' ? raw : base;
    for (let i = 2; i < 10000 && db.friends.some((f) => L.nameKey(f.name) === L.nameKey(n) && f.id !== exceptId); i++) n = `${base}(${i})`;
    return n;
  }

  function addFriend(id, name, pub) {
    if (id === db.settings.myId) return null;
    db.blocked = db.blocked.filter((x) => x !== id);
    let f = friendById(id);
    if (!f) {
      f = { id, name: uniqueFriendName(name), remoteName: cleanName(name), addedAt: Date.now() };
      db.friends.push(f);
    }
    if (!f.pub && L.isPub(pub)) f.pub = pub;
    return f;
  }

  // ---------- 連携（送受信） ----------
  //
  // ・友だち申請 (hello) だけは相手の鍵をまだ知らないので、公開鍵と名前を暗号化せずに送る
  // ・それ以外は2人の共通鍵で暗号化する。復号できたものだけを本人からの送信として扱う
  // ・知らない人からの申請は、画面上部の帯で「追加」を押すまで友だちにしない

  let syncing = false;
  let lastSyncOk = null;
  const keyCache = new Map();

  // 秘密鍵は「取り出し不可」の CryptoKey のまま IndexedDB に保存する（localStorage には公開鍵だけ）。
  // 同じ場所で動くスクリプトでも鍵の中身は読み出せないので、ファイルに書き出したり持ち去ったりできない
  let privKey = null;
  let signKey = null; // 帳簿の署名用（ECDSA・取り出し不可）
  const IDB_NAME = 'ttrecord';

  function idb(mode, fn) {
    return new Promise((resolve) => {
      try {
        const open = indexedDB.open(IDB_NAME, 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const tx = open.result.transaction('keys', mode);
          const req = fn(tx.objectStore('keys'));
          tx.oncomplete = () => { open.result.close(); resolve(req ? req.result : true); };
          tx.onerror = () => { open.result.close(); resolve(null); };
        };
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 端末の鍵ペアを用意する（初回だけ作成）。起動処理の最後で呼ぶ
  let keysReady = Promise.resolve();
  function prepareKeys() {
    keysReady = (async () => {
      const k = db.settings.keys || {};
      const stored = await idb('readonly', (s) => s.get('identity'));
      if (stored && L.isPub(stored.pub) && stored.priv) {
        privKey = stored.priv;
        if (k.pub !== stored.pub || k.priv) db.settings.keys = { pub: stored.pub };
      } else if (k.priv && L.isPub(k.pub)) {
        // 以前の形式（localStorage に JWK）から移す。移せたら JWK は消す
        privKey = await L.importPrivateJwk(k.priv);
        if (await idb('readwrite', (s) => s.put({ pub: k.pub, priv: privKey }, 'identity'))) db.settings.keys = { pub: k.pub };
      } else {
        const fresh = await L.generateKeys();
        if (await idb('readwrite', (s) => s.put(fresh, 'identity'))) {
          privKey = fresh.priv;
          db.settings.keys = { pub: fresh.pub };
        } else {
          // IndexedDB が使えない環境（一部のプライベートブラウズなど）では従来どおり保存する
          const legacy = await L.generateKeys(true);
          privKey = await L.importPrivateJwk(legacy.priv);
          db.settings.keys = legacy;
        }
      }
      // 帳簿の署名鍵（IndexedDB が使えない環境では帳簿なしで従来どおり送る）
      const sk = await idb('readonly', (st) => st.get('signing'));
      if (sk && LG.isSpub(sk.spub) && sk.spriv) {
        signKey = sk.spriv;
        db.settings.spub = sk.spub;
      } else {
        const fresh = await LG.generateSigningKeys();
        if (await idb('readwrite', (st) => st.put(fresh, 'signing'))) {
          // 鍵を作り直したら（ブラウザのデータが一部消えた場合など）、自分の帳簿もはじめから書き直す
          if (db.settings.spub && db.settings.spub !== fresh.spub) db.ledger.mine = {};
          signKey = fresh.spriv;
          db.settings.spub = fresh.spub;
        }
      }
      saveDb();
    })().catch(() => {
      /* 古いブラウザなどで暗号が使えない場合は連携だけ止まる */
    });
  }

  function myPub() {
    return db.settings.keys ? db.settings.keys.pub : '';
  }

  async function keyFor(friend) {
    const cacheKey = `${friend.id}:${friend.pub}`;
    if (!keyCache.has(cacheKey)) keyCache.set(cacheKey, L.pairKey(privKey, friend.pub));
    return keyCache.get(cacheKey);
  }

  function enqueue(to, key, ref, msg) {
    db.outbox = db.outbox.filter((o) => !(o.to === to && o.ref === ref));
    db.outbox.push({ to, key, ref, inner: L.encode(Object.assign({ from: db.settings.myId, name: myName(), key }, msg)), sentAt: 0 });
  }

  function queueHello(to) {
    db.outbox = db.outbox.filter((o) => !(o.to === to && o.ref === 'hello'));
    db.outbox.push({ to, key: `h:${db.settings.myId}`, ref: 'hello', hello: true, sentAt: 0 });
  }

  // 自分の名前が変わったことを全ての友だちに知らせる（古い知らせは新しいものに置き換える）
  function queueName() {
    const at = db.settings.nameAt || Date.now();
    for (const f of db.friends) enqueue(f.id, `n:${db.settings.myId}:${at}`, 'name', { t: 'name', at });
  }

  // 友だちの名前を、本人が設定した最新の名前に合わせる（自分で別名を付けている場合はそちらを優先）
  function updateFriendName(friend, name, at) {
    if (at <= (friend.nameAt || 0)) return false;
    friend.nameAt = at;
    friend.remoteName = name;
    if (friend.custom) return false;
    const next = uniqueFriendName(name, friend.id);
    if (next === friend.name) return false;
    const prev = friend.name;
    friend.name = next;
    renameFriendRecords(friend, prev);
    toast(`${prev}さんの名前が「${next}」に変わりました`);
    return true;
  }

  // 友だちコードやIDで追加した相手は名前が分からないので、相手から届いた本人の名前を使う
  // （名前の変更通知をすでに受け取っている場合や、自分で呼び名を付けている場合はそのまま）
  function adoptFriendName(friend, name) {
    if (!name) return;
    if (!friend.nameAt) friend.remoteName = name;
    if (friend.custom || friend.nameAt) return;
    const next = uniqueFriendName(name, friend.id);
    if (next === friend.name) return;
    const prev = friend.name;
    friend.name = next;
    renameFriendRecords(friend, prev);
  }

  // 友だちの表示名が変わったら、その友だちとの試合・奢りの記録の相手名もそろえる
  function renameFriendRecords(friend, prev) {
    for (const m of db.matches) if (m.opponentId === friend.id) m.opponent = friend.name;
    for (const e of db.treatLog) if (e.name === prev) e.name = friend.name;
    for (const o of db.offers) if (o.friendId === friend.id) o.name = friend.name;
  }

  // ---------- 帳簿（改ざんを検知できる記録） ----------
  // 友だちに送る試合・削除・奢り・相殺は、相手ごとの「追記だけの帳簿」の1行として署名して送る。
  // 1行目は署名用の公開鍵。各行に通し番号と前の行のハッシュが入るので、あとから途中を書き換えると相手の写しと食い違う

  const LEDGER_MAX_BYTES = 2550; // 署名を足して暗号化しても ntfy.sh に収まる大きさ
  let appendQueue = Promise.resolve();
  let applyNote = ''; // applyMessage が反映した内容の説明（帳簿の履歴に残す）

  function ledgerSend(fid, msg, note, legacy) {
    appendQueue = appendQueue.then(() => appendEntry(fid, msg, note, legacy)).catch(() => {});
    return appendQueue;
  }

  async function appendEntry(fid, msg, note, legacy) {
    await keysReady;
    if (!friendById(fid)) return;
    if (!signKey || !db.settings.spub) {
      // 署名が使えない環境では、帳簿なしで従来どおり送る
      if (legacy) enqueue(fid, legacy.key, legacy.ref, msg);
      saveDb();
      return;
    }
    const rows = db.ledger.mine[fid] || (db.ledger.mine[fid] = []);
    if (!rows.length && msg.t !== 'key') await appendEntry(fid, { t: 'key', spub: db.settings.spub }, '帳簿を開始');
    if (msg.t === 'key' && rows.length) return;
    const s = rows.length + 1;
    const key = `e:${s}`;
    const entry = Object.assign({ v: L.VERSION, from: db.settings.myId, name: myName(), key }, msg,
      { L: { s, p: s > 1 ? rows[s - 2].h : '', at: Date.now(), to: fid } });
    if (entry.m && entry.m.rally && new TextEncoder().encode(JSON.stringify(entry)).length > LEDGER_MAX_BYTES) {
      // 長すぎる試合は1点ごとの記録を省いて結果だけ送る
      entry.m = Object.assign({}, entry.m);
      delete entry.m.rally;
      delete entry.m.firstServer;
    }
    await LG.sign(signKey, entry);
    const text = JSON.stringify(entry);
    rows.push({ s, h: await LG.entryHash(entry), at: entry.L.at, text, note: note || '', resent: 0 });
    db.outbox.push({ to: fid, key, ref: `L:${s}`, inner: text, sentAt: 0 });
    saveDb();
  }

  // ---------- ビットコインへの刻印（OpenTimestamps・設定でオン） ----------
  // すべての帳簿の「最後の番号と先頭のハッシュ」をまとめた元データのハッシュ値だけを刻印サーバーに送る（中身は送らない）
  const OTS_CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'];
  let stamping = false;

  function ledgerHeads() {
    const me = db.settings.myId;
    const out = [];
    for (const [fid, rows] of Object.entries(db.ledger.mine)) if (rows.length) out.push({ from: me, to: fid, s: rows.length, h: rows[rows.length - 1].h });
    for (const [fid, st] of Object.entries(db.ledger.peer)) if (st.rows.length) out.push({ from: fid, to: me, s: st.rows.length, h: st.rows[st.rows.length - 1].h });
    return out.sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  }

  // 帳簿が変わっていれば1日1回まで刻印する（つながらなければ1時間あけてやり直す）
  async function stampLedger(force) {
    if (!db.settings.ots || stamping) return;
    const heads = ledgerHeads();
    if (!heads.length) return;
    const o = db.ledger.ots;
    const sig = JSON.stringify(heads);
    const now = Date.now();
    if (!force && (o.lastSig === sig || now - o.lastAt < 24 * HOUR_MS || now - (o.lastTry || 0) < HOUR_MS)) return;
    stamping = true;
    try {
      o.lastTry = now;
      // 誰がその状態を認めたかも分かるよう、元データに署名してから刻印する
      const root = { app: 'tt_record', kind: 'ledger-root', v: 2, me: db.settings.myId, at: new Date(now).toISOString(), chains: heads };
      const doc = signKey && db.settings.spub
        ? LG.canonical(await LG.signDoc(signKey, Object.assign(root, { spub: db.settings.spub })))
        : LG.rootDoc(db.settings.myId, heads, root.at);
      const digest = await LG.sha256(doc);
      const proofs = [];
      for (const cal of OTS_CALENDARS) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15000);
        try {
          const res = await fetch(`${cal}/digest`, {
            method: 'POST',
            headers: { Accept: 'application/vnd.opentimestamps.v1', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: digest,
            signal: ctl.signal,
          });
          if (res.ok) {
            const reply = new Uint8Array(await res.arrayBuffer());
            if (reply.length && reply.length <= 10000) proofs.push({ cal, b64: LG.toB64u(LG.otsFile(digest, reply)) });
          }
        } catch (e) {
          /* 次の刻印サーバーを試す */
        } finally {
          clearTimeout(timer);
        }
      }
      o.failed = !proofs.length;
      if (proofs.length) {
        o.stamps = o.stamps.concat({ at: now, doc, proofs }).slice(-30);
        o.lastAt = now;
        o.lastSig = sig;
      }
      saveDb();
    } finally {
      stamping = false;
    }
  }

  function otsCard() {
    const on = !!db.settings.ots;
    const o = db.ledger.ots;
    const last = o.stamps[o.stamps.length - 1];
    const seg = [[0, 'オフ'], [1, 'オン']].map(([v, l]) => {
      const sel = (on ? 1 : 0) === v;
      return `<button type="button" role="radio" aria-checked="${sel}" class="${sel ? 'on' : ''}" data-action="ots-setting" data-value="${v}">${l}</button>`;
    }).join('');
    let status = '';
    if (on && last) {
      status = `<p class="small">最新の刻印：${fmtTime(last.at)}（${last.proofs.length}か所の刻印サーバーに依頼済み。数時間後にビットコインのブロックに入ります）</p>
        <div class="row-actions">
          <button type="button" class="btn" data-action="ots-download" data-kind="ots">証明ファイル（.ots）</button>
          <button type="button" class="btn" data-action="ots-download" data-kind="json">元データ（.json）<span class="no-share">公開しないで</span></button>
        </div>
        <p class="hint small muted">2つのファイルを opentimestamps.org の Verify に入れると、ビットコインに刻まれた日時を確認できます。元データ（.json）にはこの端末の署名が入っていて、<a href="verify.html" target="_blank" rel="noopener">確認ページ</a>で誰が刻んだものかを確かめられます。</p>
        <p class="no-share-note">証明ファイル（.ots）は公開しても大丈夫です。元データ（.json）にはあなたと友だちのIDが入っているので、見せるのは関係する友だちだけにしてください。</p>`;
    } else if (on) {
      status = `<p class="small muted">${o.failed ? '刻印サーバーに接続できませんでした。1時間ほどあけて自動でやり直します。'
        : ledgerHeads().length ? '次の同期で刻印します。' : '友だちとの帳簿ができたら刻印します。'}</p>`;
    }
    return `<div class="card form">
      <h3>⛓ ビットコインへの刻印</h3>
      <p class="muted small">友だちとの帳簿の最新の状態を、1日1回まで OpenTimestamps でビットコインに刻みます。無料で、送るのはハッシュ値だけです（記録の中身は送りません）。刻んだあとは「その日時に帳簿がその状態だった」ことを、誰もあとから覆せなくなります。</p>
      <div class="field"><div class="seg" role="radiogroup">${seg}</div></div>
      ${status}
    </div>`;
  }

  // 公開鍵の指紋（確認ページの表示と見比べる用）。計算が終わったら描き直す
  const fpCache = {};
  function fpOf(spub) {
    if (!LG.isSpub(spub)) return '';
    if (!(spub in fpCache)) {
      fpCache[spub] = '';
      LG.fingerprint(spub).then((fp) => { fpCache[spub] = fp; if (view === 'opponent') render(); });
    }
    return fpCache[spub];
  }

  // 相手の成績ページに出す帳簿のようす（照合の結果・食い違い・最近の記録）
  function ledgerCard(name) {
    const f = friendByName(name);
    if (!f) return '';
    const mine = db.ledger.mine[f.id] || [];
    const st = db.ledger.peer[f.id];
    const peer = st ? st.rows : [];
    const issues = st ? st.issues : [];
    if (!mine.length && !peer.length && !issues.length) return '';
    const open = issues.filter((i) => !i.seen);
    const ack = db.ledger.acked[f.id];
    const waiting = st ? Object.keys(st.pending).length : 0;
    const who = esc(f.name);
    const mineState = !mine.length ? '' : !ack ? `あなたの記録 ${mine.length}行（${who}さんの照合待ち）`
      : ack.ok ? `あなたの記録 ${mine.length}行（${ack.s}行目まで${who}さんの写しと一致${ack.signed ? '・署名つきの受領証あり' : ''}・${fmtTime(ack.at)}）`
        : `あなたの記録 ${mine.length}行（⚠ ${who}さんの写しと食い違い）`;
    const peerState = peer.length ? `${who}さんの記録 ${peer.length}行（署名を確認済み${waiting ? `・${waiting}行は前の行の到着待ち` : ''}）` : '';
    const items = mine.map((r) => ({ at: r.at, who: 'あなた', note: r.note }))
      .concat(peer.map((r) => ({ at: r.at, who: `${f.name}さん`, note: r.note })))
      .filter((x) => x.note).sort((a, b) => b.at - a.at).slice(0, 15);
    const fpMine = fpOf(db.settings.spub);
    const fpPeer = st ? fpOf(st.spub) : '';
    // 署名つきの証拠がある食い違い（確認したあとも残す）
    const packs = issues.map((i, n) => ({ i, n })).filter((x) => x.i.pack).slice(-5).reverse();
    return `<section class="card ledger-card">
      <h3>📒 帳簿 <span class="muted small">改ざんを検知できる記録</span></h3>
      ${open.length ? `<div class="ledger-warn">${open.map((i) => `<p>⚠ ${esc(i.text)} <span class="muted small">${fmtTime(i.at)}</span></p>`).join('')}
        <button type="button" class="btn small-btn" data-action="ledger-seen" data-id="${esc(f.id)}">確認した</button></div>` : ''}
      <p class="small ledger-state">${[mineState, peerState].filter(Boolean).map((x) => `<span>${x}</span>`).join('')}</p>
      ${packs.length ? `<div class="ledger-evidence">
        <p class="small"><strong>署名つきの証拠</strong> <span class="muted">第三者にも確かめてもらえるファイルです</span></p>
        <ul>${packs.map((x) => `<li><span class="small">${esc(x.i.text)} <span class="muted">${fmtTime(x.i.at)}</span></span>
          <button type="button" class="btn small-btn" data-action="ledger-evidence" data-id="${esc(f.id)}" data-i="${x.n}">証拠ファイルを保存<span class="no-share">公開しないで</span></button></li>`).join('')}</ul>
        <p class="hint small muted">保存したファイルは <a href="verify.html" target="_blank" rel="noopener">確認ページ</a> に入れると、誰でも署名を確かめられます（アプリや登録は不要）。</p>
        <p class="no-share-note">証拠ファイルにはあなたと${who}さんのIDと、2人の帳簿（試合の記録）がすべて入っています。見せるのは、話し合いに必要な人だけにしてください。</p>
      </div>` : ''}
      ${items.length ? `<ul class="ledger-list">${items.map((x) => `<li><span class="ll-when">${fmtTime(x.at)}</span><span class="ll-who">${esc(x.who)}</span><span class="ll-what">${esc(x.note)}</span></li>`).join('')}</ul>` : ''}
      ${fpMine || fpPeer ? `<p class="hint small muted ledger-fp">鍵の指紋：${fpMine ? `あなた ${esc(fpMine)}` : ''}${fpMine && fpPeer ? '／' : ''}${fpPeer ? `${who}さん ${esc(fpPeer)}` : ''}</p>` : ''}
    </section>`;
  }

  // 戦績ページの上に、帳簿の食い違いを知らせる帯
  function ledgerBanner() {
    return Object.entries(db.ledger.peer).map(([fid, st]) => {
      const n = st.issues.filter((i) => !i.seen).length;
      const f = friendById(fid);
      return n && f ? `<button type="button" class="ledger-banner" data-action="opponent" data-name="${esc(f.name)}">⚠ ${esc(f.name)}さんとの帳簿に確認が必要なことがあります（${n}件）<span class="go">確認 ›</span></button>` : '';
    }).join('');
  }

  // 連携中で鍵のある友だちには、帳簿の1行目（署名用の公開鍵）を用意しておく
  function ensureLedgers() {
    keysReady.then(() => {
      if (!signKey) return;
      for (const f of db.friends) if (f.pub && !(db.ledger.mine[f.id] || []).length) ledgerSend(f.id, { t: 'key', spub: db.settings.spub }, '帳簿を開始');
    });
  }

  function peerOf(fid) {
    return db.ledger.peer[fid] || (db.ledger.peer[fid] = { rows: [], pending: {}, spub: '', issues: [], old: [] });
  }

  // 食い違いなどを記録して知らせる（同じものは1回だけ）
  function addIssue(fid, kind, s, text, evidence, pack) {
    const st = peerOf(fid);
    if (st.issues.some((i) => i.kind === kind && i.s === s && !i.seen)) return;
    st.issues.push({ kind, s, at: Date.now(), text, seen: false, evidence: (evidence || []).slice(0, 2), pack });
    st.issues = st.issues.slice(-50);
    toast(`⚠ ${text}`);
  }

  function treatLabel(n) {
    return TR.isNeed(n) ? `${n}勝で1奢り` : 'なし';
  }

  // 試合の記録・変更の説明（いつも自分から見た結果で書く）
  function matchNote(before, m, how) {
    const d = fmtDate(m.date) || '日付なし';
    const r = `${m.mySets}-${m.oppSets}`;
    if (how === 'restore') return `${d}の試合（${r}）を元に戻す`;
    if (how === 'del') return `${d}の試合（${r}）を取り消し`;
    if (!before) return `${d}の試合 ${r} を記録`;
    const parts = [];
    if (before.mySets !== m.mySets || before.oppSets !== m.oppSets) parts.push(`結果 ${before.mySets}-${before.oppSets} → ${r}`);
    if (before.date !== m.date) parts.push(`日付 ${fmtDate(before.date)} → ${d}`);
    if ((before.treat || 0) !== (m.treat || 0)) parts.push(`奢り ${treatLabel(before.treat)} → ${treatLabel(m.treat)}`);
    return parts.length ? `${fmtDate(before.date) || d}の試合を変更（${parts.join('・')}）` : `${d}の試合 ${r} を更新`;
  }

  function matchSnapshot(m) {
    return { date: m.date, mySets: m.mySets, oppSets: m.oppSets, treat: m.treat };
  }

  function queueMatch(m, before, how) {
    if (m.received || !m.opponentId || !friendById(m.opponentId)) return;
    const p = L.matchPayload(m);
    ledgerSend(m.opponentId, { t: 'match', m: p }, matchNote(before, m, how), { key: L.outboxKey('m', m.id, p.rev), ref: m.id });
  }

  // 奢りの相殺の提案・返事を送る。処理済みの提案は覚えておき、再送されても二重に扱わない
  function sendOffer(o, st) {
    if (st !== 'ask') db.sync.offersDone = db.sync.offersDone.concat(o.id).slice(-200);
    if (!friendById(o.friendId)) return;
    const note = st === 'ask' ? `${TR.format(o.amount)}奢りずつの相殺を提案` : st === 'ok' ? `${TR.format(o.amount)}奢りずつの相殺に合意`
      : o.dir === 'in' ? '相殺の提案を断った' : '相殺の提案を取り下げた';
    ledgerSend(o.friendId, { t: 'offset', id: o.id, st, amount: st === 'ask' ? o.amount : undefined }, note,
      { key: L.outboxKey('o', o.id, st), ref: `offset:${o.id}` });
  }

  function queueDelete(to, m) {
    if (!to || !friendById(to)) return;
    const at = Date.now();
    ledgerSend(to, { t: 'del', id: m.id, at }, matchNote(null, m, 'del'), { key: L.outboxKey('d', m.id, at), ref: m.id });
  }

  // 奢った・奢ってもらったの記録を友だちとの帳簿にも書く
  function queueTreat(f, e) {
    ledgerSend(f.id, { t: 'treat', id: e.id, kind: e.kind, amount: e.amount }, `${TR.format(e.amount)}奢り${e.kind === 'paid' ? 'した' : 'てもらった'}`,
      { key: `t:${e.id}`, ref: `treat:${e.id}` });
  }

  function queueTreatDel(f, e) {
    ledgerSend(f.id, { t: 'treat-del', id: e.id }, '奢りの記録を取り消し', { key: `td:${e.id}`, ref: `treat:${e.id}` });
  }

  // 届いた帳簿の行を確かめて、順番どおりに反映する
  async function receiveEntry(friend, msg, text) {
    const raw = msg.raw;
    const fid = friend.id;
    const st = peerOf(fid);
    if (!LG.isLink(raw.L) || raw.L.to !== db.settings.myId) {
      addIssue(fid, 'bad', 0, `${friend.name}さんから形式の正しくない記録が届きました（反映していません）`);
      return;
    }
    const s = raw.L.s;
    const h = await LG.entryHash(raw);
    // 帳簿の1行目がもう一度届いた：相手が帳簿をはじめから作り直した（友だちの登録し直しなど）
    if (s === 1 && st.rows.length && st.rows[0].h !== h && msg.t === 'key' && await LG.verify(msg.spub, raw)) {
      addIssue(fid, 'restart', 1, `${friend.name}さんが帳簿をはじめから作り直しました（以前の${st.rows.length}行はこの端末に残してあります）`);
      st.old = st.old.concat([st.rows]).slice(-3);
      st.rows = [];
      st.pending = {};
      st.spub = '';
    }
    const where = LG.place(st.rows.length, (n) => st.rows[n - 1] && st.rows[n - 1].h, raw, h);
    if (where === 'dup') return;
    if (where === 'later') {
      // 間の行がまだ届いていない。届くまで預かる
      if (Object.keys(st.pending).length < 100) st.pending[s] = text;
      return;
    }
    const spub = s === 1 && msg.t === 'key' ? msg.spub : st.spub;
    if (!(await LG.verify(spub, raw))) {
      addIssue(fid, 'bad-sig', s, `${friend.name}さんの帳簿の${s}行目の署名が正しくありません（反映していません）`, [text]);
      return;
    }
    if (where === 'conflict') {
      addIssue(fid, 'conflict', s, `${friend.name}さんの帳簿の${s}行目が、前に届いた内容と違います。あとから書き換えられた可能性があります`, [st.rows[s - 1].text, text],
        { type: 'conflict', keyEntry: st.rows[0].text, items: [st.rows[s - 1].text, text] });
      return;
    }
    if (where === 'broken') {
      addIssue(fid, 'broken', s, `${friend.name}さんの帳簿の${s}行目が前の行とつながっていません。途中が書き換えられた可能性があります`, [text],
        st.rows.length ? { type: 'broken', keyEntry: st.rows[0].text, items: [st.rows[s - 2].text, text] } : undefined);
      return;
    }
    if (s === 1) {
      if (msg.t !== 'key') return;
      st.spub = msg.spub;
    }
    applyNote = '';
    if (msg.t === 'key') applyNote = '帳簿を開始';
    else applyMessage(msg, Date.now());
    st.rows.push({ s, h, at: raw.L.at, text, note: applyNote, resent: 0 });
    // 預かっていた続きの行を順に反映する
    const next = st.pending[s + 1];
    if (next) {
      delete st.pending[s + 1];
      const m2 = L.decode(next);
      if (m2 && m2.raw && m2.from === fid) await receiveEntry(friend, m2, next);
    }
  }

  // 相手の返事に入っている「こちらの帳簿の写しの最後」を、自分の帳簿と照らし合わせる
  function checkAckHead(fid, lh, rcText) {
    const rows = db.ledger.mine[fid] || [];
    const f = friendById(fid);
    const name = f ? f.name : '相手';
    if (lh.s > rows.length) {
      addIssue(fid, 'mine-short', lh.s, `${name}さんの端末にあるあなたの記録（${lh.s}行）が、この端末の帳簿（${rows.length}行）より多くなっています。この端末のデータが消えたか、巻き戻された可能性があります`);
      db.ledger.acked[fid] = { s: lh.s, at: Date.now(), ok: false };
      return;
    }
    const ok = lh.s === 0 || rows[lh.s - 1].h === lh.h;
    const st = db.ledger.peer[fid];
    // 署名つきの受領証なら、相手の署名と自分の行をそのまま証拠にできる
    const pack = !ok && rcText && st && st.rows.length && rows.length
      ? { type: 'receipt-mismatch', keyEntry: st.rows[0].text, items: [rcText], myKeyEntry: rows[0].text, myItems: [rows[lh.s - 1].text] } : undefined;
    if (!ok) addIssue(fid, 'mismatch', lh.s, `${name}さんの端末にあるあなたの記録の${lh.s}行目が、この端末の帳簿と違います。どちらかの記録が書き換えられた可能性があります`, [], pack);
    db.ledger.acked[fid] = { s: lh.s, at: Date.now(), ok, signed: !!rcText };
    // 相手の写しが途中で止まっている（届いたあとに失われた）なら、続きを送り直す（1行につき3回まで）
    for (let i = lh.s; i < rows.length && i < lh.s + 20; i++) {
      if (db.outbox.some((o) => o.to === fid && o.ref === `L:${rows[i].s}`)) break;
      if (rows[i].resent >= 3) break;
      rows[i].resent++;
      db.outbox.push({ to: fid, key: `e:${rows[i].s}`, ref: `L:${rows[i].s}`, inner: rows[i].text, sentAt: 0 });
    }
  }

  async function post(to, body, delayH) {
    const res = await fetch(`${NTFY}/${L.topicFor(to)}${delayH ? `?delay=${delayH}h` : ''}`, { method: 'POST', body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function sealFor(friend, inner) {
    return L.seal(await keyFor(friend), db.settings.myId, friend.id, inner);
  }

  async function flushOutbox() {
    const now = Date.now();
    for (const o of db.outbox) {
      if (o.sentAt && now < (o.until || o.sentAt + KEEP_H * HOUR_MS) - RESEND_BEFORE_MS) continue;
      let body;
      if (o.hello) {
        body = L.helloEnvelope(db.settings.myId, myName(), myPub());
      } else {
        const f = friendById(o.to);
        // 相手の鍵がまだ届いていなければ、届くまで送らずに待つ
        if (!f || !f.pub || !o.inner) continue;
        try {
          body = await sealFor(f, o.inner);
        } catch (e) {
          // 鍵が壊れている相手がいても、他の友だちへの送信は続ける
          continue;
        }
      }
      try {
        await post(o.to, body);
      } catch (e) {
        lastSyncOk = false;
        return;
      }
      // 配達予約が途中で断られても（回数制限など）、預けられた分までで次の再送時刻を決める
      let kept = KEEP_H;
      for (const h of DELAYS_H) {
        try {
          await post(o.to, body, h);
          kept = h + KEEP_H;
        } catch (e) {
          break;
        }
      }
      o.sentAt = Date.now();
      o.until = o.sentAt + kept * HOUR_MS;
    }
  }

  function isTombstoned(from, id, rev) {
    const at = db.sync.tomb[`${from}:${id}`];
    return at !== undefined && rev <= at;
  }

  // 受け取ったメッセージ（復号・検証済み）を反映し、返事(ack)すべきキーを返す
  function applyMessage(msg, now) {
    const friend = friendById(msg.from);
    applyNote = '';
    if (!friend || msg.t === 'hello') return null;
    if (msg.t === 'name') {
      updateFriendName(friend, msg.name, msg.at);
      return msg.key;
    }
    if (msg.t === 'ack') {
      db.outbox = db.outbox.filter((o) => !(o.to === msg.from && msg.keys.includes(o.key)));
      if (msg.lh) checkAckHead(msg.from, msg.lh, msg.rcText);
      return null;
    }
    if (msg.t === 'del') {
      const rid = L.receivedId(msg.from, msg.id);
      const gone = db.matches.find((x) => x.id === rid);
      db.matches = db.matches.filter((x) => x.id !== rid);
      for (const x of db.matches) {
        if (x.remote && x.remote.from === msg.from && x.remote.id === msg.id) delete x.remote;
      }
      // 古い試合データを後から送り直されても復活させない
      db.sync.tomb[`${msg.from}:${msg.id}`] = Math.max(db.sync.tomb[`${msg.from}:${msg.id}`] || 0, msg.at || now);
      if (gone) {
        applyNote = matchNote(null, gone, 'del');
        toast(`${friend.name}さん：${applyNote}`);
      } else {
        applyNote = '試合を取り消し';
      }
      return msg.key;
    }
    if (msg.t === 'offset') {
      const o = db.offers.find((x) => x.id === msg.id && x.friendId === msg.from);
      applyNote = msg.st === 'ask' ? `${TR.format(msg.amount)}奢りずつの相殺を提案` : msg.st === 'ok' ? '相殺に合意' : '相殺を見送り';
      if (msg.st === 'ask') {
        if (!o && !db.sync.offersDone.includes(msg.id)) {
          db.offers.push({ id: msg.id, dir: 'in', friendId: msg.from, name: friend.name, amount: msg.amount, at: now });
          toast(`${friend.name}さんから奢りの相殺の提案が届きました`);
        }
      } else if (!o) {
        // 提案より先に返事が届いた場合も、あとから届く提案を表示しない
        if (!db.sync.offersDone.includes(msg.id)) db.sync.offersDone = db.sync.offersDone.concat(msg.id).slice(-200);
      } else {
        db.offers = db.offers.filter((x) => x !== o);
        db.sync.offersDone = db.sync.offersDone.concat(o.id).slice(-200);
        if (o.dir === 'out' && msg.st === 'ok') {
          applyNote = `${TR.format(o.amount)}奢りずつの相殺に合意`;
          db.treatLog.push({ id: uid(), name: o.name, kind: 'offset', amount: o.amount, at: now });
          toast(`${friend.name}さんが合意したので、${TR.format(o.amount)}奢りずつ相殺しました`);
        } else if (o.dir === 'out') {
          toast(`${friend.name}さんは相殺を見送りました`);
        } else {
          applyNote = '相殺の提案を取り下げ';
        }
      }
      return msg.key;
    }
    if (msg.t === 'treat') {
      // 相手が「奢った」= 自分は「奢ってもらった」
      const kind = msg.kind === 'paid' ? 'got' : 'paid';
      const at = msg.raw && msg.raw.L ? msg.raw.L.at : now;
      applyNote = `${TR.format(msg.amount)}奢り${msg.kind === 'paid' ? 'した' : 'てもらった'}`;
      const rid = `r_${msg.from}_${msg.id}`;
      if (db.treatLog.some((e) => e.id === rid || (e.paired && e.paired.from === msg.from && e.paired.id === msg.id))) return msg.key;
      // 同じ1回を2人とも記録していたら（同期の前に両方が押した）、2回分にしない
      const twin = db.treatLog.find((e) => e.shared === msg.from && !e.paired && e.kind === kind && e.amount === msg.amount && Math.abs(e.at - at) < 48 * HOUR_MS);
      if (twin) twin.paired = { id: msg.id, from: msg.from, kind, amount: msg.amount, at };
      else db.treatLog.push({ id: rid, name: friend.name, kind, amount: msg.amount, at, from: msg.from, rid: msg.id });
      toast(`${friend.name}さん：「${applyNote}」${twin ? '（あなたの記録と同じ1回として数えます）' : ''}`);
      return msg.key;
    }
    if (msg.t === 'treat-del') {
      const rid = `r_${msg.from}_${msg.id}`;
      const had = db.treatLog.some((e) => e.id === rid);
      db.treatLog = db.treatLog.filter((e) => e.id !== rid);
      for (const e of db.treatLog) if (e.paired && e.paired.from === msg.from && e.paired.id === msg.id) delete e.paired;
      applyNote = '奢りの記録を取り消し';
      if (had) toast(`${friend.name}さん：${applyNote}`);
      return msg.key;
    }
    if (msg.t === 'match') {
      const local = L.toLocalMatch(msg.m, msg.from, friend.name, now);
      if (isTombstoned(msg.from, msg.m.id, msg.m.rev)) {
        applyNote = `${matchNote(null, local)}（削除済みのため反映せず）`;
        return msg.key;
      }
      const existing = db.matches.find((x) => x.id === local.id);
      if (existing) {
        if ((existing.received.rev || 0) <= msg.m.rev) {
          // 自分で書いたメモと日時は残して、結果だけ相手の最新に合わせる。変わった内容は履歴に残して知らせる
          const before = matchSnapshot(existing);
          Object.assign(existing, local, { memo: existing.memo, createdAt: existing.createdAt });
          if (!local.treat) delete existing.treat;
          applyNote = matchNote(before, existing);
          if (applyNote.includes('を変更')) toast(`${friend.name}さん：${applyNote}`);
        } else {
          applyNote = `${matchNote(null, local)}（古い内容のため反映せず）`;
        }
        return msg.key;
      }
      const linked = db.matches.find((x) => x.remote && x.remote.from === msg.from && x.remote.id === msg.m.id);
      if (linked) {
        applyNote = `${matchNote(null, local)}（自分の記録とまとめ済み）`;
        return msg.key;
      }
      const dup = L.findDuplicate(db.matches, local);
      if (dup) {
        dup.remote = { from: msg.from, id: msg.m.id, rev: msg.m.rev };
        applyNote = `${matchNote(null, local)}（自分の記録とまとめました）`;
      } else {
        db.matches.push(local);
        applyNote = matchNote(null, local);
        toast(`${friend.name}さんから試合結果が届きました`);
      }
      return msg.key;
    }
    return null;
  }

  // 友だち申請（暗号化されていない hello）を処理する。ack すべき相手の ID を返す
  function handleHello(env) {
    if (env.from === db.settings.myId) return null;
    const friend = friendById(env.from);
    if (friend) {
      if (!friend.pub) {
        // ID だけで追加した相手や、暗号化前から連携していた相手の鍵をここで受け取る
        friend.pub = env.pub;
      } else if (friend.pub !== env.pub) {
        // 登録済みの鍵と違う鍵での申請は、なりすましの可能性があるので無視する
        return null;
      }
      adoptFriendName(friend, env.name);
      return env.from;
    }
    if (db.blocked.includes(env.from)) return null;
    const req = db.requests.find((r) => r.id === env.from);
    if (req) {
      if (req.pub === env.pub) req.name = env.name;
      return null;
    }
    // 上限を超えた申請は捨てる（大量の迷惑申請で先に届いた申請を押し流されないように）
    if (db.requests.length >= 20) return null;
    db.requests.push({ id: env.from, name: env.name, pub: env.pub, at: Date.now(), buffer: [] });
    toast(`${env.name || '友だち'}さんから友だち申請が届きました`);
    return null;
  }

  async function openSealed(env) {
    try {
      return await openSealedUnsafe(env);
    } catch (e) {
      return null;
    }
  }

  async function openSealedUnsafe(env) {
    const friend = friendById(env.from);
    if (friend && friend.pub) {
      const text = await L.open(await keyFor(friend), env.from, db.settings.myId, env);
      return text ? { text } : null;
    }
    // 申請中の相手から先に届いた結果は、追加されるまで預かっておく
    const req = db.requests.find((r) => r.id === env.from);
    if (req) {
      const text = await L.open(await keyFor(req), env.from, db.settings.myId, env);
      if (text && req.buffer.length < 30) req.buffer.push(text);
      return null;
    }
    return null;
  }

  async function sendAcks(acks) {
    for (const [to, keys] of acks) {
      const f = friendById(to);
      if (!f || !f.pub || !keys.length) continue;
      // 受け取った相手の帳簿の写しの最後も伝えて、相手の手元の帳簿と照らし合わせてもらう
      const rows = db.ledger.peer[to] ? db.ledger.peer[to].rows : [];
      const lh = rows.length ? { s: rows.length, h: rows[rows.length - 1].h } : undefined;
      // 「あなたの帳簿を何行目まで、この内容で受け取った」に署名した受領証。あとから受け取っていないとは言えなくなる
      const rc = lh && signKey
        ? await LG.signDoc(signKey, { app: 'tt_record', kind: 'receipt', by: db.settings.myId, chainOf: to, s: lh.s, h: lh.h, at: Date.now() }) : undefined;
      try {
        await post(to, await sealFor(f, L.encode({ t: 'ack', from: db.settings.myId, name: myName(), keys, lh, rc })));
      } catch (e) {
        /* 返事が届かなくても相手が再送してくるので、そのときにまた返す */
      }
    }
  }

  function addAck(acks, to, key) {
    if (!key) return;
    if (!acks.has(to)) acks.set(to, []);
    acks.get(to).push(key);
  }

  async function pollInbox() {
    const since = db.sync.since ? db.sync.since : 'all';
    const res = await fetch(`${NTFY}/${L.topicFor(db.settings.myId)}/json?poll=1&since=${encodeURIComponent(since)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const events = text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter((e) => e && e.event === 'message' && typeof e.message === 'string' && typeof e.id === 'string');
    events.sort((a, b) => (a.time || 0) - (b.time || 0));
    const acks = new Map();
    let changed = false;
    for (const e of events) {
      if (db.sync.seen.includes(e.id)) continue;
      db.sync.seen.push(e.id);
      if (Number.isFinite(e.time) && e.time > db.sync.since) db.sync.since = e.time;
      const env = L.parseEnvelope(e.message);
      if (!env || env.from === db.settings.myId) continue;
      if (env.kind === 'hello') {
        // 形式だけ正しい壊れた鍵の申請は表示しない
        if (!(await L.isUsablePub(env.pub))) continue;
        const ackTo = handleHello(env);
        if (ackTo) addAck(acks, ackTo, `h:${ackTo}`);
        changed = true;
        continue;
      }
      let inner = null;
      if (env.kind === 'sealed') {
        const opened = await openSealed(env);
        inner = opened && opened.text;
      } else if (env.kind === 'legacy') {
        // 暗号化前の形式は、まだ鍵を受け取っていない既存の友だちからだけ受け付ける
        const f = friendById(env.from);
        if (f && !f.pub) inner = env.text;
      }
      if (!inner) continue;
      if (await receiveInner(inner, env.from, acks)) changed = true;
    }
    db.sync.seen = db.sync.seen.slice(-300);
    await sendAcks(acks);
    return changed;
  }

  // 復号できた中身を反映する。帳簿の行は確かめてから順番どおりに反映する
  async function receiveInner(text, from, acks) {
    const msg = L.decode(text);
    if (!msg || msg.from !== from) return false;
    const friend = friendById(from);
    if (msg.raw && friend && msg.t !== 'ack') {
      // 受け取った行は（先の番号で預かる場合も）この端末に保存するので、すぐ返事する
      addAck(acks, from, msg.key);
      await receiveEntry(friend, msg, text);
      return true;
    }
    if (msg.t === 'ack' && msg.rc && friend) {
      const st = db.ledger.peer[from];
      const rc = msg.rc;
      if (st && st.spub && rc.by === from && rc.chainOf === db.settings.myId && await LG.verifyDoc(st.spub, rc)) {
        msg.lh = { s: rc.s, h: rc.h };
        msg.rcText = JSON.stringify(rc);
        db.ledger.receipts[from] = msg.rcText;
      }
    }
    addAck(acks, from, applyMessage(msg, Date.now()));
    return true;
  }

  // 申請を承認して友だちに追加する（預かっていた結果もここで反映する）
  async function acceptRequest(id) {
    const req = db.requests.find((r) => r.id === id);
    if (!req) return null;
    db.requests = db.requests.filter((r) => r.id !== id);
    const f = addFriend(req.id, req.name, req.pub);
    if (!f) return null;
    queueHello(f.id);
    const acks = new Map();
    addAck(acks, f.id, `h:${f.id}`);
    await keysReady;
    for (const text of req.buffer || []) await receiveInner(text, f.id, acks);
    saveDb();
    ensureLedgers();
    await sendAcks(acks);
    return f;
  }

  // 暗号化前から連携している友だちには、鍵を自動で送って切り替える（操作は不要）
  function migrateLegacyFriends() {
    for (const f of db.friends) {
      if (!f.pub && !db.outbox.some((o) => o.to === f.id && o.hello)) queueHello(f.id);
    }
    for (const o of db.outbox) {
      if (!o.hello && !o.inner && typeof o.body === 'string') {
        o.inner = o.body;
        delete o.body;
      }
    }
  }

  async function sync(opts) {
    // 友だちがまだいなくても、申請を受け取るため毎回確認する
    if (syncing || !navigator.onLine) return;
    syncing = true;
    let changed = false;
    try {
      await keysReady;
      if (!myPub() || !privKey) throw new Error('no keys');
      ensureLedgers();
      changed = await pollInbox();
      lastSyncOk = true;
      await appendQueue; // 帳簿への書き込み（署名）が終わってから送る
      await flushOutbox();
      await stampLedger();
    } catch (e) {
      lastSyncOk = false;
    } finally {
      syncing = false;
      db.sync.lastAt = Date.now();
      saveDb();
    }
    // 入力中の画面は描き直さない（フォーカスが外れるため）
    const quiet = ['new', 'edit', 'live'].includes(view);
    if (!quiet && (changed || view === 'friends' || (opts && opts.render))) render();
  }

  let toastTimer = null;
  // undo に関数を渡すと「元に戻す」ボタン付きで少し長めに表示する
  let toastUndo = null;
  let toastCount = 0;
  function toast(msg, undo) {
    toastCount++;
    const el = document.getElementById('toast');
    el.textContent = '';
    const text = document.createElement('span');
    text.textContent = msg;
    el.append(text);
    toastUndo = undo || null;
    if (undo) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-btn';
      b.dataset.action = 'toast-undo';
      b.textContent = '元に戻す';
      el.append(b);
    }
    el.classList.toggle('actionable', !!undo);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove('show', 'actionable'); toastUndo = null; }, undo ? 5000 : 2000);
  }

  // 試合中は画面が消えないようにする（対応ブラウザのみ。アプリを離れるとブラウザが自動で解除する）
  function keepAwake(on) {
    if (!navigator.wakeLock) return;
    if (on && !wake) {
      const p = navigator.wakeLock.request('screen').then((lock) => {
        lock.addEventListener('release', () => { if (wake === p) wake = null; });
        return lock;
      }).catch(() => {
        if (wake === p) wake = null;
        return null;
      });
      wake = p;
    } else if (!on && wake) {
      const p = wake;
      wake = null;
      p.then((lock) => { if (lock && !lock.released) lock.release(); }).catch(() => {});
    }
  }

  // 得点板は全画面で表示する（ボタンを押したときだけ。iPhone の Safari など未対応なら何もしない）
  function enterFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }

  function exitFullscreen() {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }

  function buzz() {
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function applyTheme() {
    const t = db.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  // ---------- 奢りメモ ----------
  // 試合ごとに「N勝で1奢り」を選ぶ。勝てば相手から 1/N 奢り、負ければ相手へ 1/N 奢りがたまる

  // その相手との直近の試合と同じ設定を初期値にする（毎回選び直さなくて済むように）
  function defaultTreatFor(name) {
    const key = (name || '').trim();
    const last = key && sortedMatches().find((m) => (m.opponent || '').trim() === key);
    return last && TR.isNeed(last.treat) ? last.treat : 0;
  }

  function treatBalances() {
    return TR.balances(db.matches, db.treatLog);
  }

  // 1試合で動く奢り（1/3 は小数にせず分数で出す）
  function shareText(need) {
    return need === 3 ? '1/3' : TR.format(TR.UNIT / need);
  }

  // 「あなた → 山田さん 1.5奢り ・ 山田さん → あなた 1奢り」
  function balanceText(name, b) {
    const parts = [];
    if (b && b.iOwe) parts.push(`あなた → ${name}さん ${TR.format(b.iOwe)}奢り`);
    if (b && b.owedToMe) parts.push(`${name}さん → あなた ${TR.format(b.owedToMe)}奢り`);
    return parts.length ? parts.join(' ・ ') : '貸し借りなし';
  }

  function treatField(d) {
    const cur = TR.isNeed(d.treat) ? d.treat : 0;
    const name = (d.opponent || '').trim();
    const b = name && treatBalances().get(name);
    return `<span class="label">奢り（何勝で1奢り？）</span>
      <div class="seg" role="radiogroup">${[[0, 'なし'], [1, '1勝'], [2, '2勝'], [3, '3勝']].map(([v, l]) =>
        `<button type="button" role="radio" aria-checked="${v === cur}" class="${v === cur ? 'on' : ''}" data-action="treat-pick" data-value="${v}">${l}</button>`).join('')}</div>
      ${cur ? `<p class="hint small muted">勝つと相手から、負けると相手へ ${shareText(cur)}奢り。${b && (b.iOwe || b.owedToMe) ? `いま：${esc(balanceText(name, b))}` : ''}</p>` : ''}`;
  }

  function refreshTreatField() {
    const el = document.getElementById('treatField');
    if (el && draft) el.innerHTML = treatField(draft);
  }

  // 保存した試合が奢りの対象なら、動いた奢りといまの貸し借りを知らせる
  function announceTreat(m) {
    const sh = TR.matchShare(m);
    if (!sh) return false;
    const name = m.opponent.trim();
    toast(`🍜 ${sh.toMe ? '勝ち' : '負け'}（${m.mySets}-${m.oppSets}）で ${sh.toMe ? `${name}さん → あなた` : `あなた → ${name}さん`} +${shareText(m.treat)}奢り。いま ${balanceText(name, treatBalances().get(name))}`);
    return true;
  }

  function friendForTreat(name) {
    const f = friendByName(name);
    return f && f.pub ? f : null;
  }

  function isoOf(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 相殺の提案（届いたもの・送ったもの）
  function offerLine(o, withName) {
    const f = friendById(o.friendId);
    const name = esc(f ? f.name : o.name);
    if (o.dir === 'in') {
      return `<div class="offer"><span class="offer-text">🤝 ${name}さんから相殺の提案：お互いの奢りを <b>${TR.format(o.amount)}奢りずつ</b> 相殺</span>
        <span class="offer-btns"><button type="button" class="btn small-btn primary" data-action="offer-accept" data-id="${esc(o.id)}">合意する</button>
        <button type="button" class="btn small-btn" data-action="offer-decline" data-id="${esc(o.id)}">断る</button></span></div>`;
    }
    return `<div class="offer"><span class="offer-text">⇄ ${withName ? `${name}さんに` : ''}${TR.format(o.amount)}奢りずつの相殺を提案中（返事待ち）</span>
      <span class="offer-btns"><button type="button" class="btn small-btn" data-action="offer-decline" data-id="${esc(o.id)}">取り下げる</button></span></div>`;
  }

  // 1回に記録できる量：残りが1奢り以上なら1奢り、少なければ残り全部。半分（0.5奢り）も選べる
  function treatAmounts(left) {
    if (left <= 0) return [];
    const main = Math.min(TR.UNIT, left);
    const half = TR.UNIT / 2;
    return main !== half && left >= half ? [main, half] : [main];
  }

  // 奢った・奢ってもらった・相殺のボタン
  function treatActions(name, b) {
    const btns = [];
    const btn = (kind, amount) => `<button type="button" class="btn treat-${kind}" data-action="treat-log" data-kind="${kind}" data-amount="${amount}" data-name="${esc(name)}">${kind === 'paid' ? '💸' : '🍜'} ${TR.format(amount)}奢り${kind === 'paid' ? 'した' : 'てもらった'}</button>`;
    for (const a of treatAmounts(b.iOwe)) btns.push(btn('paid', a));
    for (const a of treatAmounts(b.owedToMe)) btns.push(btn('got', a));
    const off = TR.offsetAmount(b);
    if (off && !db.offers.some((o) => o.name === name)) {
      btns.push(`<button type="button" class="btn" data-action="treat-offset" data-name="${esc(name)}">⇄ ${TR.format(off)}奢りずつ相殺${friendForTreat(name) ? 'を提案' : ''}</button>`);
    }
    return btns.length ? `<div class="treat-actions">${btns.join('')}</div>` : '';
  }

  const LOG_TEXT = { paid: '💸 奢った', got: '🍜 奢ってもらった', offset: '⇄ 相殺' };

  // 相手ごとの奢り（相手の成績ページ用）
  function treatCard(name) {
    const key = (name || '').trim();
    const b = treatBalances().get(key) || { owedToMe: 0, iOwe: 0 };
    const log = db.treatLog.filter((e) => e.name === key);
    const offers = db.offers.filter((o) => o.name === key);
    if (!treatBalances().has(key) && !log.length && !offers.length) return '';
    return `<section class="card treat-card"><h3>🍜 奢り</h3>
      ${offers.map((o) => offerLine(o, false)).join('')}
      <div class="treat-now">
        <div><span class="tn-val">${TR.format(b.iOwe)}</span><span class="tn-lbl">あなた → ${esc(key)}さん</span></div>
        <div><span class="tn-val">${TR.format(b.owedToMe)}</span><span class="tn-lbl">${esc(key)}さん → あなた</span></div>
      </div>
      ${treatActions(key, b)}
      ${!friendForTreat(key) && TR.offsetAmount(b) ? '<p class="hint small muted">相殺は相手と話して合意してから押してください。</p>' : ''}
      ${log.length ? `<h4 class="sub-title">これまでの記録</h4><ul class="treat-list">${log.slice().reverse().map((e) => `<li class="treat-item">
        <span class="ti-main"><b>${LOG_TEXT[e.kind]}</b><span class="muted small">${fmtDate(isoOf(e.at)) || '—'}</span></span><span class="ti-amt">${TR.format(e.amount)}奢り</span></li>`).join('')}</ul>` : ''}
    </section>`;
  }

  // 奢りのまとめ（戦績ページ用）: 届いた相殺の提案と、相手ごとの貸し借り
  function treatSummaryCard() {
    const rows = [...treatBalances()].filter(([, b]) => b.iOwe || b.owedToMe);
    const offers = db.offers;
    if (!rows.length && !offers.length) return '';
    const total = rows.reduce((t, [, b]) => ({ iOwe: t.iOwe + b.iOwe, owedToMe: t.owedToMe + b.owedToMe }), { iOwe: 0, owedToMe: 0 });
    return `<section class="card treat-card"><h3>🍜 奢り</h3>
      ${offers.map((o) => offerLine(o, true)).join('')}
      ${rows.length > 1 ? `<p class="small">合計：あなたが奢る <b>${TR.format(total.iOwe)}奢り</b> ・ ご馳走になる <b>${TR.format(total.owedToMe)}奢り</b></p>` : ''}
      <ul class="opp-stats">${rows.map(([name, b]) => `<li><button type="button" class="opp-row" data-action="opponent" data-name="${esc(name)}">
        <span class="or-main"><span class="or-name">${esc(name)}</span><span class="or-sub">${esc(balanceText(name, b))}</span></span>
        <span class="or-go" aria-hidden="true">›</span></button></li>`).join('')}</ul>
    </section>`;
  }

  function myName() {
    return db.settings.myName || '自分';
  }

  // ---------- 状態 ----------

  const db = loadDb();
  let live = loadLive();
  let view = 'list';
  let params = {};
  let draft = null;
  let listQuery = '';
  let statsRange = 'all';
  let oppSort = 'recent'; // 対戦相手別の並び順（既定は最近対戦した順）
  const OPP_ROWS = 5; // 対戦相手別で最初に出す人数
  let oppAll = false;
  const END_NOTICE_MS = 3000;
  let endNoticeUntil = 0; // 得点板に「チェンジエンド」を出しておく時刻
  let wake = null; // 画面のスリープ防止（WakeLockSentinel を返す Promise）

  function go(v, p) {
    view = v;
    params = p || {};
    if (v === 'new') {
      if (live) {
        view = 'live';
      } else if (!params.keepDraft || !draft || draft.id) {
        draft = newDraft();
      }
    }
    if (v === 'edit') {
      const m = db.matches.find((x) => x.id === params.id);
      if (!m) return go('list');
      draft = Object.assign({}, m, { result: [m.mySets, m.oppSets], treat: TR.isNeed(m.treat) ? m.treat : 0, treatTouched: true });
    }
    render();
    window.scrollTo(0, 0);
  }

  function newDraft() {
    return {
      date: today(),
      opponent: '',
      event: '',
      bestOf: 5,
      mode: 'simple', // デフォルトはセット数のみ記録
      result: null,
      firstServer: 'me',
      memo: '',
      treat: 0,
      treatTouched: false,
    };
  }

  // ---------- 描画 ----------

  const main = document.getElementById('main');

  function render() {
    const views = { list: viewList, new: viewForm, edit: viewForm, live: viewLive, match: viewMatch, opponent: viewOpponent, friends: viewFriends, settings: viewSettings };
    // 友だち申請は入力中の画面以外ならどこでも上部に出し、その場で1回押せば追加できるようにする
    const banner = ['new', 'edit', 'live'].includes(view) ? '' : requestBanner();
    main.innerHTML = banner + (views[view] || viewList)();
    document.body.classList.toggle('is-live', view === 'live');
    const board = !!main.querySelector('.board');
    document.body.classList.toggle('is-board', board);
    if (!board) exitFullscreen();
    keepAwake(view === 'live');
    const activeTab = view === 'edit' || view === 'live' ? 'new' : view === 'match' ? 'list'
      : view === 'opponent' ? (params.from === 'friends' ? 'friends' : 'list') : view;
    for (const b of document.querySelectorAll('#tabbar button')) {
      b.classList.toggle('active', b.dataset.view === activeTab);
    }
    const tabNew = document.querySelector('#tabbar [data-view="new"]');
    tabNew.classList.toggle('has-live', !!live);
    afterRender();
  }

  function requestBanner() {
    return db.requests.map((r) => {
      // 既存の友だちと同じ名前での申請は、なりすましの可能性があるので注意を出す
      const k = L.nameKey(r.name);
      const same = k && db.friends.find((f) => L.nameKey(f.name) === k || L.nameKey(f.remoteName) === k);
      return `<div class="request-banner${same ? ' warn-border' : ''}">
      <span class="rb-text">🤝 <b>${esc(r.name || '名前未設定')}</b>さんから友だち申請${same ? `<br><span class="warn small">⚠ 友だちの「${esc(same.name)}」さんとは別の人です。心当たりがなければ追加しないでください</span>` : ''}</span>
      <button type="button" class="btn primary small-btn" data-action="req-accept" data-id="${esc(r.id)}">追加</button>
      <button type="button" class="btn small-btn" data-action="req-decline" data-id="${esc(r.id)}" aria-label="申請を断る">×</button>
    </div>`;
    }).join('');
  }

  function resultBadge(m) {
    const win = m.mySets > m.oppSets;
    return `<span class="badge ${win ? 'win' : 'lose'}">${win ? '勝' : '負'}</span>`;
  }

  function liveBanner() {
    if (!live || view === 'live') return '';
    const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    return `<button type="button" class="live-banner" data-action="nav" data-view="live">
      <span class="dot"></span>試合中: vs ${esc(live.opponent)}（${c.mySets}-${c.oppSets}）<span class="go">再開 ›</span>
    </button>`;
  }

  // 戦績：成績のまとめと試合の一覧を1ページに出す（期間の絞り込みはページ全体にかかる）
  function viewList() {
    const all = sortedMatches();
    let html = liveBanner() + ledgerBanner() + '<h2 class="view-title">戦績</h2>';
    if (!all.length) {
      return html + `<div class="empty">
        <p>まだ記録がありません。</p>
        <button type="button" class="btn primary" data-action="nav" data-view="new">最初の試合を記録する</button>
      </div>`;
    }

    html += `<select id="statsRange" class="range" aria-label="期間">
      ${[['all', '全期間'], ['year', '今年'], ['90', '直近90日'], ['30', '直近30日']].map(([v, l]) =>
        `<option value="${v}" ${v === statsRange ? 'selected' : ''}>${l}</option>`).join('')}
    </select>`;
    const ms = all.filter(inRange);
    if (!ms.length) return html + treatSummaryCard() + '<p class="empty">この期間の記録はありません。</p>';

    const wins = ms.filter((m) => m.mySets > m.oppSets).length;
    const setsWon = ms.reduce((a, m) => a + m.mySets, 0);
    const setsLost = ms.reduce((a, m) => a + m.oppSets, 0);
    const last = ms[0];
    let streak = 0;
    for (const m of ms) {
      if ((m.mySets > m.oppSets) === (last.mySets > last.oppSets)) streak++;
      else break;
    }
    html += `<div class="tiles">
      <div class="tile"><div class="t-val">${wl(wins, ms.length - wins)}</div><div class="t-lbl">勝-敗</div></div>
      <div class="tile"><div class="t-val${tone(wins, ms.length)}">${pct(wins, ms.length)}</div><div class="t-lbl">勝率</div></div>
      <div class="tile"><div class="t-val${tone(setsWon, setsWon + setsLost)}">${pct(setsWon, setsWon + setsLost)}</div><div class="t-lbl">ゲーム取得率</div></div>
      <div class="tile"><div class="t-val ${last.mySets > last.oppSets ? 'good' : 'bad'}">${streak}${last.mySets > last.oppSets ? '連勝' : '連敗'}</div><div class="t-lbl">現在</div></div>
    </div>`;

    html += treatSummaryCard();
    html += opponentStats(ms);
    html += rallyCard(ms);
    html += eventTable(ms);

    const q = listQuery.trim().toLowerCase();
    const items = q ? ms.filter((m) => `${m.opponent} ${m.event} ${m.memo}`.toLowerCase().includes(q)) : ms;
    html += `<h3 class="list-title">試合（${ms.length}）</h3>
      <input type="search" class="search" id="listSearch" placeholder="相手・大会名・メモで検索" value="${esc(listQuery)}">`;
    let month = '';
    html += '<ul class="match-list">';
    for (const m of items) {
      const mo = (m.date || '').slice(0, 7);
      if (mo !== month) {
        month = mo;
        const [y, mm] = mo.split('-');
        html += `<li class="month">${y ? `${y}年${Number(mm)}月` : '日付なし'}</li>`;
      }
      html += matchItem(m);
    }
    html += '</ul>';
    if (!items.length) html += '<p class="empty">該当する試合がありません。</p>';
    return html;
  }

  // 一覧の奢りの印：この試合で動いた量と向きを分数のように表す（勝ち＝もらう +🍜/2、負け＝奢る −🍜/3、1勝で1奢りは ±🍜）
  function treatChip(m) {
    const sh = TR.matchShare(m);
    if (!sh) return '';
    const sign = sh.toMe ? '+' : '−';
    const label = `${m.treat}勝で1奢り・この試合で${sh.toMe ? 'もらう' : '奢る'} ${shareText(m.treat)}奢り`;
    return `<span class="chip treat ${sh.toMe ? 'plus' : 'minus'}" title="${label}" aria-label="${label}">${sign}🍜${m.treat > 1 ? `/${m.treat}` : ''}</span>`;
  }

  function matchItem(m) {
    return `<li><button type="button" class="match-item" data-action="open" data-id="${esc(m.id)}">
        ${resultBadge(m)}
        <span class="score">${m.mySets}-${m.oppSets}</span>
        <span class="who">
          <span class="opp">vs ${esc(m.opponent)}</span>
          ${m.event ? `<span class="event">${esc(m.event)}</span>` : ''}
        </span>
        <span class="meta"><span>${treatChip(m)}${m.opponentId ? '<span class="chip link">🔗</span>' : ''}${m.mode === 'detail' ? '<span class="chip">1点ごと</span>' : ''}</span><span class="date">${fmtDate(m.date)}</span></span>
      </button></li>`;
  }

  function segmented(name, options, value) {
    return `<div class="seg" role="radiogroup">${options.map(([v, label]) =>
      `<button type="button" role="radio" aria-checked="${String(v) === String(value)}" class="${String(v) === String(value) ? 'on' : ''}" data-action="draft" data-key="${name}" data-value="${esc(v)}">${label}</button>`).join('')}</div>`;
  }

  function datalist(id, values) {
    return `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  }

  // 新規記録・編集フォーム
  function viewForm() {
    const d = draft;
    const editing = view === 'edit';
    const detailLocked = editing && d.mode === 'detail';
    let html = `<h2 class="view-title">${editing ? '試合を編集' : '試合を記録'}</h2>`;

    if (!editing) {
      html += `<div class="mode-switch">
        ${segmented('mode', [['simple', 'セット数のみ'], ['detail', '詳細（1点ごと）']], d.mode)}
        <p class="hint">${d.mode === 'simple'
          ? '最終的なゲームカウントだけを記録します。'
          : '試合中に1点ずつ入力します。サーブ順やゲームポイントも自動で表示します。'}</p>
      </div>`;
    }

    // よく使う「相手 → 結果 → 保存」を上にまとめ、日付・大会名・メモは下の「そのほか」に置く
    html += `<div class="card form">
      <label class="with-suggest">対戦相手<input type="text" data-field="opponent" placeholder="例: 山田 太郎" value="${esc(d.opponent)}" autocomplete="off" maxlength="100"></label>
      <div class="opp-suggest" id="oppSuggest">${opponentChips(d.opponent)}</div>
      <div class="field"><span class="label">試合形式</span>
        ${detailLocked
          ? `<div class="locked">${d.bestOf}ゲームマッチ</div>`
          : segmented('bestOf', [[3, '3ゲーム'], [5, '5ゲーム'], [7, '7ゲーム']], d.bestOf)}
      </div>`;

    if (d.mode === 'simple') {
      const rs = S.possibleResults(d.bestOf);
      const sel = d.result ? `${d.result[0]}-${d.result[1]}` : '';
      html += `<div class="field"><span class="label">結果（${esc(myName())} - 相手）</span>
        <div class="results">${rs.map(([a, b]) => {
          const k = `${a}-${b}`;
          return `<button type="button" class="result-btn ${a > b ? 'w' : 'l'} ${k === sel ? 'on' : ''}" data-action="pick-result" data-me="${a}" data-opp="${b}">
            <span>${a > b ? '勝' : '負'}</span>${a} - ${b}</button>`;
        }).join('')}</div>
      </div>`;
    } else if (detailLocked) {
      html += `<div class="field"><span class="label">結果</span><div class="locked">${d.mySets} - ${d.oppSets}（1点ごとに記録した試合はスコアを変更できません）</div></div>`;
    } else {
      html += `<div class="field"><span class="label">最初のサーブ</span>
        ${segmented('firstServer', [['me', esc(myName())], ['opp', '相手']], d.firstServer)}
      </div>`;
    }
    html += `<div class="field" id="treatField">${treatField(d)}</div>`;
    html += '</div>';

    const startsLive = d.mode === 'detail' && !editing;
    html += `<div class="card form">
      <h3 class="form-sub">そのほか <span class="opt">任意</span></h3>
      <label>日付<input type="date" data-field="date" value="${esc(d.date)}"></label>
      <label>大会・練習名<input type="text" data-field="event" list="dl-event" placeholder="例: 市民大会 / 練習試合" value="${esc(d.event)}" autocomplete="off" maxlength="100"></label>
      ${datalist('dl-event', uniqueValues('event'))}
      ${startsLive ? '' : `<label>メモ<textarea data-field="memo" rows="3" maxlength="2000" placeholder="戦型、気づいたことなど">${esc(d.memo)}</textarea></label>`}
    </div>`;
    if (startsLive) html += '<p class="hint small muted center">メモは試合が終わった画面で書けます。</p>';

    // 保存ボタンは画面の下に固定し、スクロールせずに押せるようにする
    html += `<div class="sticky-action">${startsLive
      ? '<button type="button" class="btn primary block" data-action="start-live">試合開始</button>'
      : `<button type="button" class="btn primary block" data-action="save-form">${editing ? '変更を保存' : '保存'}</button>`}
      ${editing ? `<button type="button" class="btn block" data-action="open" data-id="${esc(d.id)}">キャンセル</button>` : ''}
    </div>`;
    return html;
  }

  // 詳細モードのスコアボード
  function viewLive() {
    if (!live) return viewList();
    const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    const names = { me: myName(), opp: live.opponent };

    const chips = c.completedGames.map((g) =>
      `<span class="game-chip ${g.winner === 'me' ? 'w' : 'l'}">${g.me}-${g.opp}</span>`).join('');

    let html = `<div class="live-head">
      <div class="live-sets">
        <span class="name me">${esc(names.me)}</span>
        <span class="sets">${c.mySets} - ${c.oppSets}</span>
        <span class="name opp">${esc(names.opp)}</span>
      </div>
      <div class="live-info">${live.bestOf}ゲームマッチ${live.event ? ` ・ ${esc(live.event)}` : ''}</div>
      <div class="game-chips">${chips}</div>
    </div>`;

    if (!c.finished && live.board) return viewBoard(c);

    if (c.finished) {
      const win = c.winner === 'me';
      html += `<div class="card finished ${win ? 'win' : 'lose'}">
        <div class="finished-title">${win ? '勝利！' : '敗戦'}</div>
        <div class="finished-score">${c.mySets} - ${c.oppSets}</div>
        <div class="finished-games">${c.games.map((g) => `${g.me}-${g.opp}`).join(' / ')}</div>
        <label class="finished-memo">メモ <span class="opt">任意</span><textarea data-live-field="memo" rows="3" maxlength="2000" placeholder="戦型、気づいたことなど">${esc(live.memo)}</textarea></label>
        <button type="button" class="btn primary block" data-action="live-save">記録を保存</button>
        <button type="button" class="btn block" data-action="live-undo">1点戻す</button>
      </div>`;
      return html;
    }

    const cur = c.current;
    const label = (side) => {
      if (cur.matchPoint === side) return '<span class="flag mp">マッチポイント</span>';
      if (cur.gamePoint === side) return '<span class="flag gp">ゲームポイント</span>';
      return '<span class="flag"></span>';
    };
    const pad = (side) => `<button type="button" class="pad ${side}" data-action="point" data-side="${side}" aria-label="${esc(names[side])}に1点">
        <span class="pad-name">${esc(names[side])}</span>
        <span class="pad-score">${cur[side]}</span>
        <span class="serve ${cur.server === side ? 'on' : ''}">● サーブ</span>
        ${label(side)}
      </button>`;

    html += `<div class="game-label">第${cur.gameIndex + 1}ゲーム${cur.me >= 10 && cur.opp >= 10 ? ' ・ ジュース' : ''}</div>
      <div class="pads">${pad('me')}${pad('opp')}</div>
      <div class="live-actions">
        <button type="button" class="btn" data-action="live-undo" ${live.rally.length ? '' : 'disabled'}>↶ 1点戻す</button>
        <button type="button" class="btn" data-action="live-swap-serve" title="最初のサーブを入れ替える">⇄ 先サーブを入替</button>
        <button type="button" class="btn board-open" data-action="board-open">📺 得点板にする</button>
        <button type="button" class="btn ghost pause" data-action="nav" data-view="list">一時中断</button>
        <button type="button" class="btn ghost danger discard" data-action="live-discard">試合を破棄</button>
      </div>`;
    return html;
  }

  // 得点板：卓球台の横に置いて両方の選手に見せる表示。
  // 左右は台のどちら側にいるかに合わせ、チェンジエンドのたびに自動で入れ替える
  function viewBoard(c) {
    const cur = c.current;
    const names = { me: myName(), opp: live.opponent };
    const sets = { me: c.mySets, opp: c.oppSets };
    const left = S.endChanges(c) % 2 ? S.other(live.boardLeft) : live.boardLeft;
    const half = (side, pos) => {
      const flag = cur.matchPoint === side ? '<span class="bh-flag mp">マッチポイント</span>'
        : cur.gamePoint === side ? '<span class="bh-flag">ゲームポイント</span>' : '';
      return `<button type="button" class="board-half ${side} ${pos}" data-action="point" data-side="${side}" aria-label="${esc(names[side])}に1点（${cur[side]}点）">
        <span class="bh-head"><span class="bh-name">${esc(names[side])}</span><span class="bh-sets" title="取ったゲーム数">${sets[side]}</span></span>
        <span class="bh-score">${cur[side]}</span>
        <span class="bh-foot"><span class="bh-serve ${cur.server === side ? 'on' : ''}">● サーブ</span>${flag}</span>
      </button>`;
    };
    const notice = Date.now() < endNoticeUntil ? '<div class="board-notice" role="status">⇄ チェンジエンド</div>' : '';
    return `<div class="board">
      <div class="board-halves">${half(left, 'left')}${half(S.other(left), 'right')}</div>
      <div class="board-bar">
        <button type="button" class="board-btn" data-action="live-undo" ${live.rally.length ? '' : 'disabled'}>↶ 1点戻す</button>
        <span class="board-game">第${cur.gameIndex + 1}ゲーム${cur.me >= 10 && cur.opp >= 10 ? '・ジュース' : ''}<span class="board-rotate">横向きにすると大きく表示されます</span></span>
        <button type="button" class="board-btn" data-action="board-swap">⇄ 左右を入替</button>
        <button type="button" class="board-btn" data-action="board-close">✕ 閉じる</button>
      </div>
      ${notice}
    </div>`;
  }

  // 試合詳細
  function viewMatch() {
    const m = db.matches.find((x) => x.id === params.id);
    if (!m) return viewList();
    const win = m.mySets > m.oppSets;
    let html = `<button type="button" class="back" data-action="back">‹ ${params.back ? 'vs ' + esc(params.back.params.name) : '戦績'}</button>
      <section class="card match-head ${win ? 'win' : 'lose'}">
        <div class="mh-result">${win ? '勝ち' : '負け'}</div>
        <div class="mh-score">${m.mySets} - ${m.oppSets}</div>
        <div class="mh-opp">${opponentLink(m.opponent, `vs ${esc(m.opponent)} ›`)}</div>
        <div class="muted">${fmtDateFull(m.date)}${m.event ? ` ・ ${esc(m.event)}` : ''} ・ ${m.bestOf}ゲームマッチ${m.mode === 'detail' ? ' ・ 1点ごとに記録' : ''}</div>
        ${linkStatus(m)}
        ${treatStatus(m)}
      </section>`;

    if (m.mode === 'detail' && m.rally) {
      const c = S.computeMatch(m.bestOf, m.firstServer, m.rally);
      const st = S.rallyStats(c);
      html += `<section class="card"><h3>ゲームスコア</h3><table class="games">
        <tr><th></th>${c.games.map((g) => `<th>${g.index + 1}</th>`).join('')}</tr>
        <tr><td>${esc(myName())}</td>${c.games.map((g) => `<td class="${g.winner === 'me' ? 'won' : ''}">${g.me}</td>`).join('')}</tr>
        <tr><td>${esc(m.opponent)}</td>${c.games.map((g) => `<td class="${g.winner === 'opp' ? 'won' : ''}">${g.opp}</td>`).join('')}</tr>
      </table></section>`;

      html += `<section class="card"><h3>データ</h3><dl class="kv">
        <dt>総得点</dt><dd>${st.pointsWon} / ${st.pointsTotal}（${pct(st.pointsWon, st.pointsTotal)}）</dd>
        <dt>自分のサーブ時の得点</dt><dd>${st.serveWon} / ${st.serveTotal}（${pct(st.serveWon, st.serveTotal)}）</dd>
        <dt>相手のサーブ時の得点</dt><dd>${st.receiveWon} / ${st.receiveTotal}（${pct(st.receiveWon, st.receiveTotal)}）</dd>
        <dt>最大連続得点</dt><dd>自分 ${st.longestRun.me} / 相手 ${st.longestRun.opp}</dd>
        ${st.deuceGames ? `<dt>ジュース</dt><dd>${st.deuceWon}勝 ${st.deuceGames - st.deuceWon}敗</dd>` : ''}
      </dl></section>`;

      html += `<section class="card"><h3>得点の流れ</h3>
        <p class="legend"><span class="pt me"></span>自分の得点 <span class="pt opp"></span>相手の得点 <span class="pt me sv"></span>枠付き＝自分のサーブ</p>
        ${c.games.map((g) => `<div class="flow"><div class="flow-label">第${g.index + 1}G <b>${g.me}-${g.opp}</b></div>
          <div class="flow-points">${g.points.map((p) => `<span class="pt ${p.winner}${p.server === 'me' ? ' sv' : ''}"></span>`).join('')}</div></div>`).join('')}
      </section>`;
    }

    if (m.memo) html += `<section class="card"><h3>メモ</h3><p class="memo">${esc(m.memo)}</p></section>`;

    html += `<div class="row-actions">
      <button type="button" class="btn" data-action="nav" data-view="edit" data-id="${esc(m.id)}">編集</button>
      <button type="button" class="btn danger" data-action="delete" data-id="${esc(m.id)}">削除</button>
    </div>`;
    return html;
  }

  function treatStatus(m) {
    const sh = TR.matchShare(m);
    if (!sh) return '';
    const name = esc(m.opponent);
    return `<div class="treat-status">🍜 奢りの対象（${m.treat}勝で1奢り）・ この試合で ${sh.toMe ? `${name}さん → あなた` : `あなた → ${name}さん`} ${shareText(m.treat)}奢り</div>`;
  }

  function linkStatus(m) {
    if (!m.opponentId) return '';
    const f = friendById(m.opponentId);
    const name = esc(f ? f.name : m.opponent);
    if (m.received) return `<div class="link-status">🔗 ${name}さんが記録した試合です</div>`;
    if (m.remote) return `<div class="link-status">🔗 ${name}さんも記録済み（同じ試合としてまとめました）</div>`;
    if (!f) return '';
    const waiting = db.outbox.some((o) => o.to === f.id && o.ref === m.id);
    return `<div class="link-status">🔗 ${name}さんに${waiting ? '送信待ち（相手がアプリを開くと届きます）' : '届きました'}</div>`;
  }

  // 成績
  function inRange(m) {
    if (statsRange === 'all') return true;
    const d = new Date();
    if (statsRange === 'year') return (m.date || '').startsWith(String(d.getFullYear()));
    const days = Number(statsRange);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - days + 1);
    const iso = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
    return (m.date || '') >= iso;
  }

  // 対戦相手ごとの成績（勝率・勝敗・最終対戦日）。多いときは上位だけ出して、残りはボタンで開く
  function opponentStats(ms) {
    const groups = new Map();
    // ms は新しい順なので、最初に出てきた試合がその相手との最終対戦
    ms.forEach((m, order) => {
      const name = (m.opponent || '').trim();
      if (!name) return;
      const g = groups.get(name) || { name, n: 0, w: 0, last: m.date, order };
      g.n++;
      if (m.mySets > m.oppSets) g.w++;
      groups.set(name, g);
    });
    const sorters = {
      recent: (a, b) => a.order - b.order,
      count: (a, b) => b.n - a.n || a.order - b.order,
      rate: (a, b) => b.w / b.n - a.w / a.n || b.n - a.n,
      name: (a, b) => a.name.localeCompare(b.name, 'ja'),
    };
    const rows = [...groups.values()].sort(sorters[oppSort] || sorters.recent);
    const shown = oppAll ? rows : rows.slice(0, OPP_ROWS);
    return `<section class="card">
      <div class="card-head"><h3>対戦相手別 <span class="muted small">（${rows.length}人）</span></h3>
        <select id="oppSort" class="sort" aria-label="並び順">
          ${[['recent', '最近対戦した順'], ['count', '対戦数順'], ['rate', '勝率順'], ['name', '名前順']].map(([v, l]) =>
            `<option value="${v}" ${v === oppSort ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <ul class="opp-stats">${shown.map((g) => `<li><button type="button" class="opp-row" data-action="opponent" data-name="${esc(g.name)}">
        <span class="or-main">
          <span class="or-name">${friendByName(g.name) ? '🔗 ' : ''}${esc(g.name)}</span>
          <span class="or-sub">${g.w}勝${g.n - g.w}敗 ・ 最終 ${fmtDate(g.last) || '—'}</span>
        </span>
        <span class="or-rate${tone(g.w, g.n)}">${pct(g.w, g.n)}</span>
        <span class="or-go" aria-hidden="true">›</span>
      </button></li>`).join('')}</ul>
      ${rows.length > shown.length ? `<button type="button" class="btn block" data-action="opp-more">ほか${rows.length - shown.length}人を表示</button>` : ''}
    </section>`;
  }

  // 詳細モードで記録した試合の集計
  function rallyCard(ms) {
    let html = '';
    const detail = ms.filter((m) => m.mode === 'detail' && m.rally);
    if (detail.length) {
      const agg = { serveWon: 0, serveTotal: 0, receiveWon: 0, receiveTotal: 0, pointsWon: 0, pointsTotal: 0, deuceGames: 0, deuceWon: 0 };
      for (const m of detail) {
        const st = S.rallyStats(S.computeMatch(m.bestOf, m.firstServer, m.rally));
        for (const k of Object.keys(agg)) agg[k] += st[k];
      }
      html += `<section class="card"><h3>1点ごとのデータ <span class="muted small">（1点ごとに記録した ${detail.length}試合）</span></h3><dl class="kv">
        <dt>総得点率</dt><dd>${pct(agg.pointsWon, agg.pointsTotal)}</dd>
        <dt>自分のサーブ時の得点率</dt><dd>${pct(agg.serveWon, agg.serveTotal)}</dd>
        <dt>相手のサーブ時の得点率</dt><dd>${pct(agg.receiveWon, agg.receiveTotal)}</dd>
        <dt>ジュースの勝敗</dt><dd>${agg.deuceGames ? `${agg.deuceWon}勝 ${agg.deuceGames - agg.deuceWon}敗` : '—'}</dd>
      </dl></section>`;
    }
    return html;
  }

  function opponentLink(name, inner) {
    return `<button type="button" class="link-btn" data-action="opponent" data-name="${esc(name)}">${inner}</button>`;
  }

  // 相手ごとの対戦成績
  function viewOpponent() {
    const name = params.name || '';
    const ms = sortedMatches().filter((m) => (m.opponent || '').trim() === name);
    const friend = friendByName(name);
    let html = `<button type="button" class="back" data-action="back">‹ 戻る</button>`;
    if (!ms.length) {
      return html + `<h2 class="view-title">${friend ? '🔗 ' : ''}${esc(name)}</h2><p class="empty">まだ対戦記録がありません。</p>`;
    }
    const w = ms.filter((m) => m.mySets > m.oppSets).length;
    const sw = ms.reduce((a, m) => a + m.mySets, 0);
    const sl = ms.reduce((a, m) => a + m.oppSets, 0);
    const recent = ms.slice(0, 10).reverse();
    let streak = 0;
    for (const m of ms) {
      if ((m.mySets > m.oppSets) === (ms[0].mySets > ms[0].oppSets)) streak++;
      else break;
    }

    html += `<section class="card h2h">
        <div class="h2h-name">vs ${friend ? '🔗 ' : ''}${esc(name)}</div>
        <div class="h2h-rate${tone(w, ms.length)}">${pct(w, ms.length)}</div>
        <div class="muted">勝率（${w}勝 ${ms.length - w}敗）</div>
        <div class="h2h-bar" aria-hidden="true"><span data-w="${Math.round((w / ms.length) * 1000) / 10}"></span></div>
      </section>
      <div class="tiles">
        <div class="tile"><div class="t-val">${ms.length}</div><div class="t-lbl">対戦数</div></div>
        <div class="tile"><div class="t-val${tone(sw, sw + sl)}">${pct(sw, sw + sl)}</div><div class="t-lbl">ゲーム取得率（${sw}-${sl}）</div></div>
        <div class="tile"><div class="t-val ${ms[0].mySets > ms[0].oppSets ? 'good' : 'bad'}">${ms[0].mySets}-${ms[0].oppSets}</div><div class="t-lbl">前回（${fmtDate(ms[0].date) || '日付なし'}）</div></div>
        <div class="tile"><div class="t-val ${ms[0].mySets > ms[0].oppSets ? 'good' : 'bad'}">${streak}${ms[0].mySets > ms[0].oppSets ? '連勝' : '連敗'}</div><div class="t-lbl">現在</div></div>
      </div>
      <section class="card"><h3>直近${recent.length}試合 <span class="muted small">（左が古い）</span></h3>
        <div class="form-dots">${recent.map((m) => `<span class="fd ${m.mySets > m.oppSets ? 'w' : 'l'}" title="${esc(m.date)} ${m.mySets}-${m.oppSets}">${m.mySets > m.oppSets ? '○' : '●'}</span>`).join('')}</div>
      </section>`;
    html += rallyCard(ms);
    html += treatCard(name);
    html += ledgerCard(name);
    html += `<h3 class="list-title">対戦履歴</h3><ul class="match-list">${ms.map(matchItem).join('')}</ul>`;
    return html;
  }

  // 大会・練習ごとの勝敗（大会名を入れていない試合は数えない）
  function eventTable(ms) {
    const groups = new Map();
    for (const m of ms) {
      const k = (m.event || '').trim();
      if (!k) continue;
      const g = groups.get(k) || { n: 0, w: 0 };
      g.n++;
      if (m.mySets > m.oppSets) g.w++;
      groups.set(k, g);
    }
    if (!groups.size) return '';
    const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0], 'ja'));
    return `<section class="card"><h3>大会・練習別</h3><table class="table">
      <thead><tr><th>名前</th><th>勝-敗</th><th>勝率</th></tr></thead>
      <tbody>${rows.map(([k, g]) => `<tr><td>${esc(k)}</td><td>${g.w}-${g.n - g.w}</td><td>${pct(g.w, g.n)}</td></tr>`).join('')}</tbody>
    </table></section>`;
  }

  // 設定
  function myLink() {
    return L.friendLink(location.href, db.settings.myId, myName(), myPub());
  }

  function qrSvg(text) {
    if (!window.qrcode) return '';
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: '友だち追加用QRコード' });
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // 友だち
  function viewFriends() {
    let html = '<h2 class="view-title">友だち連携</h2>';
    const pending = params.pending;
    if (pending) {
      if (pending.id === db.settings.myId) {
        html += '<div class="card notice"><p>これはあなた自身の友だちリンクです。対戦相手に送って開いてもらってください。</p></div>';
      } else if (friendById(pending.id)) {
        html += `<div class="card notice"><p>${esc(friendById(pending.id).name)}さんとはすでに連携しています。</p></div>`;
      } else {
        html += `<div class="card notice">
          <p>${pending.name ? `<b>${esc(pending.name)}</b>さん` : 'この友だちコードの人'}を友だちに追加しますか？<br><span class="muted small">追加すると、お互いの対戦結果が相手のアプリにも自動で届くようになります。</span></p>
          <button type="button" class="btn primary block" data-action="friend-accept">追加する</button>
          <button type="button" class="btn block" data-action="nav" data-view="friends">やめる</button>
        </div>`;
      }
    }

    const unnamed = !db.settings.myName || db.settings.myName === '自分';
    // 名前の入力欄は設定にまとめる。まだ名前がないときだけ、ここでも入れられるようにする
    html += unnamed
      ? `<div class="card form">
      <label>あなたの名前（友だちのアプリに表示されます）<input type="text" id="myName" value="" placeholder="例: 山田 太郎" maxlength="20"></label>
    </div>`
      : `<p class="name-line">あなたの名前：<b>${esc(db.settings.myName)}</b>
      <button type="button" class="btn small-btn" data-action="nav" data-view="settings">設定で変更</button></p>`;

    html += `<div class="card">
      <h3>あなたの友だちリンク <span class="no-share">公開しないで</span></h3>
      <p class="muted small">対戦相手にこのQRコードを読み取ってもらうか、リンクを送って開いてもらうと連携できます。連携は最初の1回だけでOKです。</p>
      <p class="no-share-note">リンク・QRコード・友だちコードは対戦相手にだけ渡してください。SNSなどに載せると、誰でもあなたに友だち申請を送れるようになります。</p>
      ${unnamed ? '<p class="warn small">先に上で名前を入れておくと、相手のアプリにその名前で表示されます。</p>' : ''}
      <div class="qr">${qrSvg(myLink())}</div>
      <div class="row-actions">
        <button type="button" class="btn" data-action="copy-link">リンクをコピー</button>
        <button type="button" class="btn" data-action="share-link">共有…</button>
      </div>
      <button type="button" class="btn block" data-action="copy-code">友だちコードをコピー</button>
    </div>`;

    html += `<div class="card form">
      <h3>友だちを追加</h3>
      <label>相手の友だちリンクか友だちコードを貼り付け<input type="text" id="friendInput" placeholder="https://…#add=… または 友だちコード" autocomplete="off"></label>
      <button type="button" class="btn primary block" data-action="friend-add">追加</button>
    </div>`;

    html += `<div class="card"><h3>連携中の友だち（${db.friends.length}人）</h3>`;
    if (!db.friends.length) {
      html += '<p class="muted small">まだいません。</p>';
    } else {
      html += '<ul class="friend-list">';
      for (const f of db.friends) {
        const ms = db.matches.filter((m) => m.opponentId === f.id);
        const w = ms.filter((m) => m.mySets > m.oppSets).length;
        const waiting = db.outbox.filter((o) => o.to === f.id && !o.hello).length;
        const pendingApproval = db.outbox.some((o) => o.to === f.id && o.hello);
        html += `<li>
          <div class="f-main">${opponentLink(f.name, `<b>🔗 ${esc(f.name)}</b>`)}<span class="muted small">${pendingApproval ? '相手の承認待ち ・ ' : ''}${ms.length ? `${w}勝${ms.length - w}敗` : '対戦なし'}${waiting ? ` ・ 送信待ち${waiting}件` : ''}${f.custom && f.remoteName && f.remoteName !== f.name ? ` ・ 本人の名前: ${esc(f.remoteName)}` : ''}</span></div>
          <button type="button" class="btn small-btn" data-action="friend-rename" data-id="${esc(f.id)}">名前</button>
          <button type="button" class="btn small-btn danger" data-action="friend-remove" data-id="${esc(f.id)}">解除</button>
        </li>`;
      }
      html += '</ul>';
    }
    html += '</div>';

    html += `<div class="card">
      <h3>同期</h3>
      <p class="muted small">最終確認: ${fmtTime(db.sync.lastAt)}${lastSyncOk === false ? ' ・ <span class="warn">通信できませんでした</span>' : ''}${db.outbox.length ? ` ・ 送信待ち${db.outbox.length}件` : ''}</p>
      <button type="button" class="btn block" data-action="sync-now">今すぐ同期</button>
      <p class="muted small">結果は暗号化して中継サービス ntfy.sh 経由で届けます（記録は各端末だけに保存。メモは送りません）。</p>
    </div>`;
    return html;
  }

  function viewSettings() {
    return `<h2 class="view-title">設定</h2>
      <div class="card form">
        <label>自分の名前（友だち・得点板に表示）<input type="text" id="myName" value="${esc(db.settings.myName)}" maxlength="20"></label>
        <div class="field"><span class="label">画面の明るさ</span>
          <div class="seg" role="radiogroup">${[['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => {
            const on = (db.settings.theme || 'auto') === v;
            return `<button type="button" role="radio" aria-checked="${on}" class="${on ? 'on' : ''}" data-action="theme" data-value="${v}">${l}</button>`;
          }).join('')}</div>
          <p class="hint small muted">「自動」は端末のダークモード設定に合わせます。</p>
        </div>
      </div>
      ${otsCard()}
      <div class="card">
        <h3>データ</h3>
        <p class="muted small">記録はこの端末の中だけにあります。機種変更の前はエクスポートしてください。</p>
        ${storageNote()}
        <button type="button" class="btn block" data-action="export">エクスポート（JSON）<span class="no-share">公開しないで</span></button>
        <p class="no-share-note">試合の記録・メモ・友だちの一覧が入ります。自分のバックアップ用にだけ使ってください。</p>
        <label class="btn block file-btn">インポート（JSON）<input type="file" id="importFile" accept="application/json,.json"></label>
        <button type="button" class="btn block danger" data-action="wipe">すべての記録を削除</button>
      </div>
      <p class="muted small center">保存済み ${db.matches.length}試合</p>
      ${supportCard()}`;
  }

  // 設定タブのいちばん下に出す、開発者の応援のお願い（押さなくても使える）
  function supportCard() {
    const link = (href, label) => `<li><a href="${href}" target="_blank" rel="noopener noreferrer sponsored">${label}</a></li>`;
    return `<section class="card support-card">
      <h3>🎁 利用料について</h3>
      <p class="small">利用料は無料です！</p>
      <p class="small muted">もし「応援してもいいよ」という方がいれば、募金感覚で下記のリンクをご利用いただけると嬉しいです 🙏</p>
      <ul class="small">
        ${link('https://www.amazon.co.jp?&amp;linkCode=ll2&amp;tag=mokumoku0a-22&amp;linkId=164404febe06b273f3db5be4519c9761&amp;ref_=as_li_ss_tl', 'Amazonはこちら')}
        ${link('https://item.rakuten.co.jp/rakutenoriginal-daily/ro-b-001/', '楽天市場はこちら')}
      </ul>
    </section>`;
  }

  // ---------- 描画後のイベント（入力欄） ----------

  function afterRender() {
    for (const el of main.querySelectorAll('[data-live-field]')) {
      el.addEventListener('input', () => {
        if (!live) return;
        live[el.dataset.liveField] = el.value;
        saveLive();
      });
    }
    // CSPでstyle属性を禁止しているので、幅はスクリプトから設定する
    for (const el of main.querySelectorAll('[data-w]')) el.style.width = `${Number(el.dataset.w)}%`;
    for (const el of main.querySelectorAll('[data-field]')) {
      el.addEventListener('input', () => {
        draft[el.dataset.field] = el.value;
        if (el.dataset.field === 'opponent') {
          document.getElementById('oppSuggest').innerHTML = opponentChips(el.value);
          if (!draft.treatTouched) draft.treat = defaultTreatFor(el.value);
          refreshTreatField();
        }
      });
    }
    const search = document.getElementById('listSearch');
    if (search) {
      search.addEventListener('input', () => {
        listQuery = search.value;
        const pos = search.selectionStart;
        render();
        const s2 = document.getElementById('listSearch');
        s2.focus();
        s2.setSelectionRange(pos, pos);
      });
    }
    const range = document.getElementById('statsRange');
    if (range) range.addEventListener('change', () => { statsRange = range.value; render(); });
    const sort = document.getElementById('oppSort');
    if (sort) sort.addEventListener('change', () => { oppSort = sort.value; render(); });
    const name = document.getElementById('myName');
    if (name) {
      name.addEventListener('change', () => {
        const next = name.value.trim() || '自分';
        const changed = next !== db.settings.myName;
        db.settings.myName = next;
        if (changed) {
          db.settings.nameAt = Date.now();
          queueName();
        }
        saveDb();
        toast(changed && db.friends.length ? '保存しました。友だちのアプリにも反映されます' : '保存しました');
        if (changed && db.friends.length) sync();
        // QRコードとリンクに名前が入っているので描き直す
        if (view === 'friends') render();
      });
    }
    const file = document.getElementById('importFile');
    if (file) file.addEventListener('change', () => importFile(file.files[0]));
  }

  // ---------- 操作 ----------

  function validateDraft() {
    draft.opponent = (draft.opponent || '').trim();
    draft.event = (draft.event || '').trim();
    if (!draft.opponent) {
      toast('対戦相手を入力してください');
      return false;
    }
    if (!draft.date) {
      toast('日付を入力してください');
      return false;
    }
    return true;
  }

  function saveForm() {
    if (!validateDraft()) return;
    const d = draft;
    if (d.mode === 'simple' && (!d.result || !S.isValidResult(d.bestOf, d.result[0], d.result[1]))) {
      toast('結果を選んでください');
      return;
    }
    if (view === 'edit') {
      const m = db.matches.find((x) => x.id === d.id);
      if (!m) return go('list');
      const prevOpponentId = m.opponentId;
      const before = matchSnapshot(m);
      Object.assign(m, { date: d.date, opponent: d.opponent, event: d.event, memo: d.memo, updatedAt: Date.now() });
      if (m.mode !== 'detail') Object.assign(m, { bestOf: d.bestOf, mySets: d.result[0], oppSets: d.result[1] });
      const treat = draftTreat(d);
      if (treat) m.treat = treat;
      else delete m.treat;
      if (!m.received) {
        // 相手を変えたら、前の友だちに送った結果は取り消す
        const f = friendByName(m.opponent);
        m.opponentId = f ? f.id : undefined;
        if (prevOpponentId && prevOpponentId !== m.opponentId) queueDelete(prevOpponentId, m);
        queueMatch(m, prevOpponentId === m.opponentId ? before : null);
      }
      saveDb();
      sync();
      if (!announceTreat(m)) toast('更新しました');
      go('match', { id: m.id });
      return;
    }
    const m = {
      id: uid(),
      date: d.date,
      opponent: d.opponent,
      event: d.event,
      bestOf: d.bestOf,
      mode: 'simple',
      mySets: d.result[0],
      oppSets: d.result[1],
      memo: d.memo,
      createdAt: Date.now(),
    };
    const treat = draftTreat(d);
    if (treat) m.treat = treat;
    const friend = friendByName(m.opponent);
    if (friend) {
      m.opponentId = friend.id;
      const already = db.matches.find((x) => x.received && x.opponentId === friend.id && x.date === m.date &&
        x.mySets === m.mySets && x.oppSets === m.oppSets);
      if (already && !confirm(`${friend.name}さんから同じ結果（${m.mySets}-${m.oppSets}）がすでに届いています。重複して記録しますか？`)) {
        draft = null;
        go('match', { id: already.id });
        return;
      }
    }
    db.matches.push(m);
    queueMatch(m);
    saveDb();
    sync();
    draft = null;
    if (!announceTreat(m)) toast(`${m.mySets > m.oppSets ? '勝ち' : '負け'}（${m.mySets}-${m.oppSets}）を記録しました`);
    go('list');
  }

  // フォームの選択から、保存する「何勝で1奢りか」を決める（対象外なら 0）
  function draftTreat(d) {
    return TR.isNeed(d.treat) ? d.treat : 0;
  }

  function startLive() {
    if (!validateDraft()) return;
    live = {
      date: draft.date,
      opponent: draft.opponent,
      event: draft.event,
      memo: draft.memo,
      bestOf: draft.bestOf,
      firstServer: draft.firstServer,
      rally: '',
      treat: draftTreat(draft),
      board: db.settings.board === true, // 前回得点板で使っていたら得点板で始める
      boardLeft: 'me',
      startedAt: Date.now(),
    };
    draft = null;
    saveLive();
    go('live');
  }

  function addPoint(side) {
    const before = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    if (before.finished) return;
    live.rally += side === 'me' ? 'm' : 'o';
    saveLive();
    buzz();
    const after = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    const changeEnds = !after.finished && S.endChanges(after) > S.endChanges(before);
    if (changeEnds) endNoticeUntil = Date.now() + END_NOTICE_MS;
    if (!after.finished && after.completedGames.length > before.completedGames.length) {
      const g = after.completedGames[after.completedGames.length - 1];
      toast(`第${g.index + 1}ゲーム ${g.me}-${g.opp} ${g.winner === 'me' ? '取得' : '失う'}`);
    } else if (changeEnds) {
      toast('最終ゲームの5点目です。チェンジエンド');
    }
    render();
  }

  function saveLiveMatch() {
    const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
    if (!c.finished) return;
    const m = {
      id: uid(),
      date: live.date,
      opponent: live.opponent,
      event: live.event,
      bestOf: live.bestOf,
      mode: 'detail',
      mySets: c.mySets,
      oppSets: c.oppSets,
      games: c.games.map((g) => ({ me: g.me, opp: g.opp })),
      firstServer: live.firstServer,
      // 試合終了後の余分な入力は保存しない
      rally: c.games.map((g) => g.points.map((p) => (p.winner === 'me' ? 'm' : 'o')).join('')).join(''),
      memo: live.memo,
      createdAt: Date.now(),
    };
    if (TR.isNeed(live.treat)) m.treat = live.treat;
    const friend = friendByName(m.opponent);
    if (friend) m.opponentId = friend.id;
    db.matches.push(m);
    queueMatch(m);
    saveDb();
    sync();
    live = null;
    saveLive();
    if (!announceTreat(m)) toast('試合を保存しました');
    go('match', { id: m.id });
  }

  function exportData() {
    // 鍵やIDは入れない（ファイルが他人に渡ってもなりすましに使えないように）
    const settings = { myName: db.settings.myName, theme: db.settings.theme };
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings, matches: db.matches, friends: db.friends, treatLog: db.treatLog }, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `tt-record-${today()}.json`);
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        // ファイルの中身は信用せず、1件ずつ検証してから取り込む
        const incoming = (Array.isArray(data) ? data : (data && data.matches) || []).map(L.sanitizeMatch).filter(Boolean);
        const ids = new Set(db.matches.map((m) => m.id));
        const added = incoming.filter((m) => !ids.has(m.id));
        db.matches.push(...added);
        if (Array.isArray(data.friends)) {
          for (const f of data.friends.map(sanitizeFriend).filter(Boolean)) if (!friendById(f.id)) addFriend(f.id, f.name, f.pub);
        }
        if (Array.isArray(data.treatLog)) {
          const have = new Set(db.treatLog.map((e) => e.id));
          for (const e of data.treatLog.filter(TR.isLogEntry)) {
            if (typeof e.id === 'string' && have.has(e.id)) continue;
            db.treatLog.push({ id: typeof e.id === 'string' ? e.id.slice(0, 40) : uid(), name: cleanName(e.name), kind: e.kind, amount: e.amount, at: Number.isFinite(e.at) ? e.at : 0 });
          }
        }
        saveDb();
        toast(`${added.length}試合を読み込みました`);
        render();
      } catch (e) {
        toast('ファイルを読み込めませんでした');
      }
    };
    reader.readAsText(file);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled) return;
    const a = t.dataset.action;
    switch (a) {
      case 'nav':
        go(t.dataset.view, { id: t.dataset.id });
        break;
      case 'open':
        go('match', { id: t.dataset.id, back: view === 'opponent' ? { view, params } : null });
        break;
      case 'opponent':
        go('opponent', { name: t.dataset.name, from: view === 'match' ? 'list' : view, back: { view, params } });
        break;
      case 'back':
        if (params.back) go(params.back.view, params.back.params);
        else go('list');
        break;
      case 'draft': {
        const k = t.dataset.key;
        let v = t.dataset.value;
        if (k === 'bestOf') {
          v = Number(v);
          if (draft.result && !S.isValidResult(v, draft.result[0], draft.result[1])) draft.result = null;
        }
        draft[k] = v;
        render();
        break;
      }
      case 'pick-opp': {
        draft.opponent = t.dataset.name;
        const input = main.querySelector('[data-field="opponent"]');
        input.value = draft.opponent;
        document.getElementById('oppSuggest').innerHTML = opponentChips(draft.opponent);
        if (!draft.treatTouched) draft.treat = defaultTreatFor(draft.opponent);
        refreshTreatField();
        break;
      }
      case 'treat-pick':
        draft.treat = Number(t.dataset.value) || 0;
        draft.treatTouched = true;
        refreshTreatField();
        break;
      case 'treat-log': {
        // 奢った / 奢ってもらった（押した直後のポップアップから元に戻せる）
        const kind = t.dataset.kind === 'got' ? 'got' : 'paid';
        const bal = treatBalances().get(t.dataset.name) || { owedToMe: 0, iOwe: 0 };
        const amount = Number(t.dataset.amount);
        if (!treatAmounts(kind === 'got' ? bal.owedToMe : bal.iOwe).includes(amount)) break;
        const entry = { id: uid(), name: t.dataset.name, kind, amount, at: Date.now() };
        const tf = friendForTreat(entry.name);
        if (tf) {
          entry.shared = tf.id;
          queueTreat(tf, entry);
        }
        db.treatLog.push(entry);
        saveDb();
        render();
        if (tf) sync();
        toast(`${TR.format(amount)}奢り${entry.kind === 'got' ? 'てもらった' : 'した'}と記録しました`, () => {
          db.treatLog = db.treatLog.filter((e) => e !== entry);
          if (tf) {
            queueTreatDel(tf, entry);
            // 相手も同じ1回を記録していた場合は、相手側の記録を残す
            if (entry.paired) {
              const p = entry.paired;
              db.treatLog.push({ id: `r_${p.from}_${p.id}`, name: entry.name, kind: p.kind, amount: p.amount, at: p.at, from: p.from, rid: p.id });
            }
            sync();
          }
          saveDb();
          render();
          toast('元に戻しました');
        });
        break;
      }
      case 'treat-offset': {
        const name = t.dataset.name;
        const amount = TR.offsetAmount(treatBalances().get(name));
        if (!amount) break;
        const f = friendForTreat(name);
        if (f) {
          // 連携中の友だちには提案を送り、相手が合意したら相殺する
          const o = { id: uid(), dir: 'out', friendId: f.id, name, amount, at: Date.now() };
          db.offers.push(o);
          sendOffer(o, 'ask');
          saveDb();
          sync();
          render();
          toast(`${f.name}さんが合意すると相殺されます`);
          break;
        }
        const entry = { id: uid(), name, kind: 'offset', amount, at: Date.now() };
        db.treatLog.push(entry);
        saveDb();
        render();
        toast(`${TR.format(amount)}奢りずつ相殺しました`, () => {
          db.treatLog = db.treatLog.filter((e) => e !== entry);
          saveDb();
          render();
          toast('元に戻しました');
        });
        break;
      }
      case 'offer-accept':
      case 'offer-decline': {
        const o = db.offers.find((x) => x.id === t.dataset.id);
        if (!o) break;
        db.offers = db.offers.filter((x) => x !== o);
        const ok = a === 'offer-accept';
        if (ok) db.treatLog.push({ id: uid(), name: o.name, kind: 'offset', amount: o.amount, at: Date.now() });
        sendOffer(o, ok ? 'ok' : 'no');
        saveDb();
        sync();
        render();
        toast(ok ? `${TR.format(o.amount)}奢りずつ相殺しました` : o.dir === 'in' ? '相殺の提案を断りました' : '相殺の提案を取り下げました');
        break;
      }
      case 'toast-undo': {
        const undo = toastUndo;
        toastUndo = null;
        if (undo) undo();
        break;
      }
      case 'pick-result':
        draft.result = [Number(t.dataset.me), Number(t.dataset.opp)];
        render();
        break;
      case 'save-form':
        saveForm();
        break;
      case 'start-live':
        startLive();
        if (live && live.board) enterFullscreen();
        break;
      case 'board-open':
      case 'board-close': {
        if (!live) break;
        live.board = a === 'board-open';
        db.settings.board = live.board; // 次の試合も同じ表示で始める
        saveLive();
        saveDb();
        if (live.board) enterFullscreen();
        render();
        break;
      }
      case 'board-swap':
        if (!live) break;
        live.boardLeft = S.other(live.boardLeft);
        saveLive();
        render();
        break;
      case 'point':
        addPoint(t.dataset.side);
        break;
      case 'live-undo':
        if (live && live.rally) {
          const c = S.computeMatch(live.bestOf, live.firstServer, live.rally);
          // 試合終了後に押された余分な点があれば先に取り除く
          const used = c.games.reduce((n, g) => n + g.points.length, 0);
          live.rally = live.rally.slice(0, used - 1);
          saveLive();
          render();
        }
        break;
      case 'live-swap-serve':
        live.firstServer = S.other(live.firstServer);
        saveLive();
        toast('サーブ順を入れ替えました');
        render();
        break;
      case 'live-discard': {
        // 確認画面は出さず、直後のポップアップから元に戻せるようにする
        const prev = live;
        live = null;
        saveLive();
        go('list');
        toast('試合を破棄しました', () => {
          if (live) return; // その間に別の試合を始めていたら上書きしない
          live = prev;
          saveLive();
          go('live');
        });
        break;
      }
      case 'live-save':
        saveLiveMatch();
        break;
      case 'delete': {
        const gone = db.matches.find((m) => m.id === t.dataset.id);
        if (!gone) break;
        db.matches = db.matches.filter((m) => m.id !== gone.id);
        // 自分の記録を消したら相手に届けた分も取り消す（相手から届いた記録はこの端末からだけ消す）
        if (!gone.received && gone.opponentId) queueDelete(gone.opponentId, gone);
        // 相手から届いた（またはまとめた）記録は、あとから同じ内容が届いても戻さない。相手が編集すれば届く
        const src = gone.received || gone.remote;
        const tombKey = src ? `${src.from}:${src.id}` : '';
        const prevTomb = tombKey ? db.sync.tomb[tombKey] : undefined;
        if (tombKey) db.sync.tomb[tombKey] = Math.max(prevTomb || 0, src.rev || Date.now());
        saveDb();
        sync();
        go('list');
        // 確認画面は出さず、直後のポップアップから元に戻せるようにする
        toast('試合を削除しました', () => {
          if (!gone.received && gone.opponentId) {
            // 相手側の削除済みの印より新しくして、もう一度届ける
            gone.updatedAt = Date.now();
            queueMatch(gone, null, 'restore');
          }
          if (tombKey) {
            if (prevTomb === undefined) delete db.sync.tomb[tombKey];
            else db.sync.tomb[tombKey] = prevTomb;
          }
          db.matches.push(gone);
          saveDb();
          sync();
          go('match', { id: gone.id });
          toast('元に戻しました');
        });
        break;
      }
      case 'ledger-seen': {
        const st = db.ledger.peer[t.dataset.id];
        if (st) for (const i of st.issues) i.seen = true;
        saveDb();
        render();
        break;
      }
      case 'ledger-evidence': {
        const st = db.ledger.peer[t.dataset.id];
        const issue = st && st.issues[Number(t.dataset.i)];
        if (!issue || !issue.pack) break;
        // 2人の帳簿をまるごと入れて、確認ページで対戦成績も確かめられるようにする（[相手の帳簿, 自分の帳簿]）
        const mine = db.ledger.mine[t.dataset.id] || [];
        const extra = { ledgers: [st.rows.map((r) => r.text), mine.map((r) => r.text)] };
        if (issue.pack.type !== 'receipt-mismatch' && mine.length) extra.myKeyEntry = mine[0].text;
        const ev = Object.assign({ app: 'tt_record', kind: 'evidence' }, issue.pack, extra, {
          found: new Date(issue.at).toISOString(),
          text: issue.text,
          howToCheck: 'https://tomochi3.github.io/tt_record/verify.html にこのファイルを入れると、署名を確かめられます',
        });
        downloadBlob(new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' }), `tt-record-evidence-${isoOf(issue.at)}-${issue.s}.json`);
        break;
      }
      case 'ots-setting':
        db.settings.ots = t.dataset.value === '1';
        saveDb();
        render();
        if (db.settings.ots) stampLedger(true).then(() => { if (view === 'settings') render(); });
        break;
      case 'ots-download': {
        const last = db.ledger.ots.stamps[db.ledger.ots.stamps.length - 1];
        if (!last) break;
        const d = new Date(last.at);
        const base = `tt-record-ledger-${isoOf(last.at)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`;
        if (t.dataset.kind === 'json') downloadBlob(new Blob([last.doc], { type: 'application/json' }), base);
        else downloadBlob(new Blob([LG.fromB64u(last.proofs[0].b64)], { type: 'application/octet-stream' }), `${base}.ots`);
        break;
      }
      case 'opp-more':
        oppAll = true;
        render();
        break;
      case 'export':
        exportData();
        break;
      case 'theme':
        db.settings.theme = t.dataset.value;
        applyTheme();
        saveDb();
        render();
        break;
      case 'friend-accept': {
        const p = params.pending;
        if (!p) break;
        // 相手からの申請がすでに届いていれば、それを承認したことにする
        const req = db.requests.find((r) => r.id === p.id);
        if (req && (!p.pub || p.pub === req.pub)) {
          acceptRequest(p.id).then((f) => {
            if (f) toast(`${f.name}さんを友だちに追加しました`);
            sync({ render: true });
          });
          go('friends');
          break;
        }
        const f = addFriend(p.id, p.name, p.pub);
        if (f) {
          queueHello(f.id);
          saveDb();
          toast(p.name ? `${f.name}さんを友だちに追加しました` : '追加しました。相手が承認すると名前が表示されます');
          sync({ render: true });
        }
        go('friends');
        break;
      }
      case 'req-accept':
        acceptRequest(t.dataset.id).then((f) => {
          if (f) toast(`${f.name}さんを友だちに追加しました`);
          render();
          sync({ render: true });
        });
        break;
      case 'req-decline': {
        // 断った相手からの申請は今後表示しない（相手のリンクから自分で追加すれば解除される）
        db.requests = db.requests.filter((r) => r.id !== t.dataset.id);
        if (!db.blocked.includes(t.dataset.id)) db.blocked.push(t.dataset.id);
        saveDb();
        render();
        break;
      }
      case 'friend-add': {
        const input = document.getElementById('friendInput');
        const p = L.parseFriendInput(input.value);
        if (!p) {
          toast('友だちリンクか友だちコードを貼り付けてください（英数字20文字だけのIDや古いリンクでは追加できません）');
          break;
        }
        showPending(p);
        break;
      }
      case 'friend-rename': {
        const f = friendById(t.dataset.id);
        const name = f && prompt(`あなたの画面での${f.remoteName ? `「${f.remoteName}」さんの` : ''}表示名（相手には伝わりません。空欄で相手が設定した名前に戻します）`, f.name);
        if (name === null || name === undefined || !f) break;
        const prev = f.name;
        if (name.trim()) {
          f.name = uniqueFriendName(name, f.id);
          f.custom = true;
        } else {
          f.custom = false;
          f.name = uniqueFriendName(f.remoteName || f.name, f.id);
        }
        // この友だちとの試合・奢りの記録の相手名もそろえる
        renameFriendRecords(f, prev);
        saveDb();
        render();
        break;
      }
      case 'friend-remove': {
        const f = friendById(t.dataset.id);
        if (!f) break;
        const waiting = db.outbox.filter((o) => o.to === f.id);
        const ledger = { mine: db.ledger.mine[f.id], peer: db.ledger.peer[f.id], acked: db.ledger.acked[f.id] };
        db.friends = db.friends.filter((x) => x.id !== f.id);
        db.outbox = db.outbox.filter((o) => o.to !== f.id);
        // 登録し直したときは帳簿もはじめからにする
        delete db.ledger.mine[f.id];
        delete db.ledger.peer[f.id];
        delete db.ledger.acked[f.id];
        saveDb();
        render();
        toast(`${f.name}さんとの連携を解除しました（記録は残ります）`, () => {
          if (!friendById(f.id)) db.friends.push(f);
          db.outbox.push(...waiting);
          for (const k of ['mine', 'peer', 'acked']) if (ledger[k]) db.ledger[k][f.id] = ledger[k];
          saveDb();
          render();
          toast('元に戻しました');
        });
        break;
      }
      case 'copy-code':
        navigator.clipboard.writeText(L.friendCode(db.settings.myId, myPub())).then(() => toast('友だちコードをコピーしました'), () => toast('コピーできませんでした'));
        break;
      case 'copy-link':
        navigator.clipboard.writeText(myLink()).then(() => toast('リンクをコピーしました'), () => toast('コピーできませんでした'));
        break;
      case 'share-link':
        if (navigator.share) {
          navigator.share({ title: '卓球戦績メモ', text: `${myName()}と卓球の対戦結果を共有しよう`, url: myLink() }).catch(() => {});
        } else {
          navigator.clipboard.writeText(myLink()).then(() => toast('リンクをコピーしました'), () => {});
        }
        break;
      case 'sync-now': {
        // 同期中に届いた知らせ（変更・削除など）は「同期しました」で上書きしない
        const shown = toastCount;
        sync({ render: true }).then(() => {
          if (lastSyncOk === false) toast('通信できませんでした');
          else if (toastCount === shown) toast('同期しました');
        });
        break;
      }
      case 'wipe':
        if (confirm('すべての記録を削除します。元に戻せません。よろしいですか？')) {
          db.matches = [];
          saveDb();
          toast('削除しました');
          render();
        }
        break;
      default:
        break;
    }
  });

  // 入力中のフォームから別タブへ移動しても、下書きは「記録」タブで残す
  document.querySelector('#tabbar [data-view="new"]').addEventListener('click', (e) => {
    e.stopPropagation();
    go('new', { keepDraft: view !== 'new' && view !== 'edit' });
  });

  // ---------- 保存データを消されにくくする ----------
  // ブラウザは容量不足や長く使われていないサイトの保存データを自動で消すことがある
  // （iPhone の Safari は7日間開かないと消す）。消さないよう頼んでおく。
  // Chrome・Edge・Safari は利用状況から自動で判断し確認画面を出さないが、
  // パソコンの Firefox は許可の確認を出して操作が増えるため頼まない。
  let storageState = 'unknown'; // persisted | not-persisted | unsupported
  function asksPermission() {
    return /Firefox\//.test(navigator.userAgent) && !/FxiOS/.test(navigator.userAgent);
  }

  async function requestPersistentStorage() {
    const st = navigator.storage;
    if (!st || !st.persisted) {
      storageState = 'unsupported';
      return;
    }
    try {
      let ok = await st.persisted();
      // まだ認められていなければ、起動のたびに頼み直す（使い続けると認められやすくなる）
      if (!ok && st.persist && !asksPermission()) ok = await st.persist();
      storageState = ok ? 'persisted' : 'not-persisted';
    } catch (e) {
      storageState = 'unsupported';
    }
    if (view === 'settings') render();
  }

  function storageNote() {
    if (storageState === 'persisted') return '<p class="small storage-ok">この端末では、ブラウザが記録を自動で消さない設定になっています。</p>';
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (ios && !standalone) {
      return '<p class="small warn">iPhone の Safari では、7日間開かないと記録が消えることがあります。共有メニューの「ホーム画面に追加」から使うと消えません。</p>';
    }
    if (storageState === 'not-persisted') {
      return '<p class="small muted">ブラウザの空き容量が少なくなると、記録が消される可能性があります。ときどきエクスポートしておくと安心です。</p>';
    }
    return '';
  }

  // 鍵が使えるものか確かめてから追加の確認を出す
  function showPending(p) {
    go('friends');
    L.isUsablePub(p.pub).then((ok) => {
      if (ok) go('friends', { pending: p });
      else toast('この友だちリンク・コードは壊れているため追加できません');
    });
  }

  // 友だちリンク (#add=...) から開かれたときは追加の確認を出す
  function handleHash() {
    if (!location.hash.includes('add=')) return false;
    const p = L.parseFriendInput(location.hash);
    history.replaceState(null, '', location.pathname + location.search);
    if (!p) {
      toast('古い形式のリンクです。相手に新しいリンクを送ってもらってください');
      return false;
    }
    showPending(p);
    return true;
  }

  window.addEventListener('hashchange', handleHash);
  // 同じ端末で別のタブが保存したら、その内容を読み込み直す（古い内容で上書きして記録を消さないように）
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY) {
      Object.assign(db, loadDb());
      keyCache.clear();
    } else if (e.key === LIVE_KEY) {
      live = loadLive();
      if (view === 'live' && !live) return go('list');
    } else {
      return;
    }
    if (!['new', 'edit'].includes(view)) render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (view === 'live') keepAwake(true);
    sync();
  });
  window.addEventListener('online', () => sync());
  setInterval(() => {
    if (document.visibilityState === 'visible') sync();
  }, POLL_MS);

  applyTheme();
  prepareKeys();
  migrateLegacyFriends();
  ensureLedgers();
  if (!handleHash()) go(live ? 'live' : 'list');
  // 初回は鍵の作成が終わってからQRコードを描き直す
  keysReady.then(() => { if (view === 'friends') render(); });
  saveDb(); // 新しく作ったIDを保存しておく
  sync();
  requestPersistentStorage();
})();
