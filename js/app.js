'use strict';
(function () {
  const S = window.TTScoring;
  const L = window.TTLink;
  const NTFY = 'https://ntfy.sh';
  // ntfy.sh は約12時間しか預からないので、届いた返事(ack)が来るまで間隔をあけて再送する
  const RESEND_MS = 6 * 60 * 60 * 1000;
  const POLL_MS = 60 * 1000;
  const STORE_KEY = 'ttrecord.v1';
  const LIVE_KEY = 'ttrecord.live';

  // ---------- データ保存（localStorage） ----------

  function loadDb() {
    const empty = {
      settings: { myName: '自分' }, matches: [], friends: [], outbox: [], requests: [], blocked: [],
      sync: { since: 0, seen: [], tomb: {} },
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
        requests: db.requests, blocked: db.blocked, sync: db.sync,
      }));
    } catch (e) {
      toast('保存に失敗しました');
    }
  }

  function cleanName(v) {
    return typeof v === 'string' ? v.trim().slice(0, 40) : '';
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

  function pct(won, total) {
    return total ? `${((won / total) * 100).toFixed(1)}%` : '—';
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
    const hint = f ? `<p class="link-hint">🔗 ${esc(f.name)}さんと連携中。保存すると相手のアプリにも結果が届きます。</p>` : '';
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
    const raw = (name || '').trim();
    const base = raw && raw !== '自分' ? raw : '友だち';
    let n = base;
    for (let i = 2; db.friends.some((f) => f.name === n && f.id !== exceptId); i++) n = `${base}(${i})`;
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

  // 端末の鍵ペアを用意する（初回だけ作成）。起動処理の最後で呼ぶ
  let keysReady = Promise.resolve();
  function prepareKeys() {
    keysReady = (async () => {
      const k = db.settings.keys;
      if (!k || !L.isPub(k.pub) || !k.priv) {
        db.settings.keys = await L.generateKeys();
        saveDb();
      }
    })().catch(() => {
      /* 古いブラウザなどで暗号が使えない場合は連携だけ止まる */
    });
  }

  function myPub() {
    return db.settings.keys ? db.settings.keys.pub : '';
  }

  async function keyFor(friend) {
    const cacheKey = `${friend.id}:${friend.pub}`;
    if (!keyCache.has(cacheKey)) keyCache.set(cacheKey, L.pairKey(db.settings.keys.priv, friend.pub));
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
    for (const m of db.matches) if (m.opponentId === friend.id) m.opponent = next;
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
    friend.name = next;
    for (const m of db.matches) if (m.opponentId === friend.id) m.opponent = next;
  }

  function queueMatch(m) {
    if (m.received || !m.opponentId || !friendById(m.opponentId)) return;
    const p = L.matchPayload(m);
    enqueue(m.opponentId, L.outboxKey('m', m.id, p.rev), m.id, { t: 'match', m: p });
  }

  function queueDelete(to, matchId) {
    if (!to || !friendById(to)) return;
    const at = Date.now();
    enqueue(to, L.outboxKey('d', matchId, at), matchId, { t: 'del', id: matchId, at });
  }

  async function post(to, body) {
    const res = await fetch(`${NTFY}/${L.topicFor(to)}`, { method: 'POST', body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function sealFor(friend, inner) {
    return L.seal(await keyFor(friend), db.settings.myId, friend.id, inner);
  }

  async function flushOutbox() {
    const now = Date.now();
    for (const o of db.outbox) {
      if (o.sentAt && now - o.sentAt < RESEND_MS) continue;
      let body;
      if (o.hello) {
        body = L.helloEnvelope(db.settings.myId, myName(), myPub());
      } else {
        const f = friendById(o.to);
        // 相手の鍵がまだ届いていなければ、届くまで送らずに待つ
        if (!f || !f.pub || !o.inner) continue;
        body = await sealFor(f, o.inner);
      }
      try {
        await post(o.to, body);
        o.sentAt = Date.now();
      } catch (e) {
        lastSyncOk = false;
        return;
      }
    }
  }

  function isTombstoned(from, id, rev) {
    const at = db.sync.tomb[`${from}:${id}`];
    return at !== undefined && rev <= at;
  }

  // 受け取ったメッセージ（復号・検証済み）を反映し、返事(ack)すべきキーを返す
  function applyMessage(msg, now) {
    const friend = friendById(msg.from);
    if (!friend || msg.t === 'hello') return null;
    if (msg.t === 'name') {
      updateFriendName(friend, msg.name, msg.at);
      return msg.key;
    }
    if (msg.t === 'ack') {
      db.outbox = db.outbox.filter((o) => !(o.to === msg.from && msg.keys.includes(o.key)));
      return null;
    }
    if (msg.t === 'del') {
      const rid = L.receivedId(msg.from, msg.id);
      db.matches = db.matches.filter((x) => x.id !== rid);
      for (const x of db.matches) {
        if (x.remote && x.remote.from === msg.from && x.remote.id === msg.id) delete x.remote;
      }
      // 古い試合データを後から送り直されても復活させない
      db.sync.tomb[`${msg.from}:${msg.id}`] = Math.max(db.sync.tomb[`${msg.from}:${msg.id}`] || 0, msg.at || now);
      return msg.key;
    }
    if (msg.t === 'match') {
      if (isTombstoned(msg.from, msg.m.id, msg.m.rev)) return msg.key;
      const local = L.toLocalMatch(msg.m, msg.from, friend.name, now);
      const existing = db.matches.find((x) => x.id === local.id);
      if (existing) {
        if ((existing.received.rev || 0) <= msg.m.rev) {
          // 自分で書いたメモと日時は残して、結果だけ相手の最新に合わせる
          Object.assign(existing, local, { memo: existing.memo, createdAt: existing.createdAt });
        }
        return msg.key;
      }
      const linked = db.matches.find((x) => x.remote && x.remote.from === msg.from && x.remote.id === msg.m.id);
      if (linked) return msg.key;
      const dup = L.findDuplicate(db.matches, local);
      if (dup) {
        dup.remote = { from: msg.from, id: msg.m.id };
      } else {
        db.matches.push(local);
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
    db.requests.push({ id: env.from, name: env.name, pub: env.pub, at: Date.now(), buffer: [] });
    db.requests = db.requests.slice(-20);
    toast(`${env.name || '友だち'}さんから友だち申請が届きました`);
    return null;
  }

  async function openSealed(env) {
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
      try {
        await post(to, await sealFor(f, L.encode({ t: 'ack', from: db.settings.myId, name: myName(), keys })));
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
      const msg = inner && L.decode(inner);
      if (!msg || msg.from !== env.from) continue;
      changed = true;
      addAck(acks, msg.from, applyMessage(msg, Date.now()));
    }
    db.sync.seen = db.sync.seen.slice(-300);
    await sendAcks(acks);
    return changed;
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
    for (const text of req.buffer || []) {
      const msg = L.decode(text);
      if (msg && msg.from === f.id) addAck(acks, f.id, applyMessage(msg, Date.now()));
    }
    saveDb();
    await keysReady;
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
      if (!myPub()) throw new Error('no keys');
      changed = await pollInbox();
      lastSyncOk = true;
      await flushOutbox();
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
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  function buzz() {
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function applyTheme() {
    const t = db.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
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
      draft = Object.assign({}, m, { result: [m.mySets, m.oppSets] });
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
    };
  }

  // ---------- 描画 ----------

  const main = document.getElementById('main');

  function render() {
    const views = { list: viewList, new: viewForm, edit: viewForm, live: viewLive, match: viewMatch, stats: viewStats, opponent: viewOpponent, friends: viewFriends, settings: viewSettings };
    // 友だち申請は入力中の画面以外ならどこでも上部に出し、その場で1回押せば追加できるようにする
    const banner = ['new', 'edit', 'live'].includes(view) ? '' : requestBanner();
    main.innerHTML = banner + (views[view] || viewList)();
    document.body.classList.toggle('is-live', view === 'live');
    const activeTab = view === 'edit' || view === 'live' ? 'new' : view === 'match' ? 'list'
      : view === 'opponent' ? (params.from || 'stats') : view;
    for (const b of document.querySelectorAll('#tabbar button')) {
      b.classList.toggle('active', b.dataset.view === activeTab);
    }
    const tabNew = document.querySelector('#tabbar [data-view="new"]');
    tabNew.classList.toggle('has-live', !!live);
    afterRender();
  }

  function requestBanner() {
    return db.requests.map((r) => `<div class="request-banner">
      <span class="rb-text">🤝 <b>${esc(r.name || '名前未設定')}</b>さんから友だち申請</span>
      <button type="button" class="btn primary small-btn" data-action="req-accept" data-id="${esc(r.id)}">追加</button>
      <button type="button" class="btn small-btn" data-action="req-decline" data-id="${esc(r.id)}" aria-label="申請を断る">×</button>
    </div>`).join('');
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

  // 履歴
  function viewList() {
    const all = sortedMatches();
    const q = listQuery.trim().toLowerCase();
    const items = q
      ? all.filter((m) => `${m.opponent} ${m.event} ${m.memo}`.toLowerCase().includes(q))
      : all;
    const wins = all.filter((m) => m.mySets > m.oppSets).length;

    let html = liveBanner();
    html += `<section class="card summary">
      <div><div class="big">${wins}<small>勝</small> ${all.length - wins}<small>敗</small></div><div class="muted">通算 ${all.length}試合</div></div>
      <div class="rate"><div class="big">${pct(wins, all.length)}</div><div class="muted">勝率</div></div>
    </section>`;

    if (!all.length) {
      html += `<div class="empty">
        <p>まだ記録がありません。</p>
        <button type="button" class="btn primary" data-action="nav" data-view="new">最初の試合を記録する</button>
      </div>`;
      return html;
    }

    html += `<input type="search" class="search" id="listSearch" placeholder="相手・大会名・メモで検索" value="${esc(listQuery)}">`;

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

  function matchItem(m) {
    return `<li><button type="button" class="match-item" data-action="open" data-id="${esc(m.id)}">
        ${resultBadge(m)}
        <span class="score">${m.mySets}-${m.oppSets}</span>
        <span class="who">
          <span class="opp">vs ${esc(m.opponent)}</span>
          ${m.event ? `<span class="event">${esc(m.event)}</span>` : ''}
        </span>
        <span class="meta"><span>${m.opponentId ? '<span class="chip link">🔗</span>' : ''}${m.mode === 'detail' ? '<span class="chip">詳細</span>' : ''}</span><span class="date">${fmtDate(m.date)}</span></span>
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

    html += `<div class="card form">
      <label>日付<input type="date" data-field="date" value="${esc(d.date)}"></label>
      <label class="with-suggest">対戦相手<input type="text" data-field="opponent" placeholder="例: 山田 太郎" value="${esc(d.opponent)}" autocomplete="off"></label>
      <div class="opp-suggest" id="oppSuggest">${opponentChips(d.opponent)}</div>
      <label>大会・練習名 <span class="opt">任意</span><input type="text" data-field="event" list="dl-event" placeholder="例: 市民大会 / 練習試合" value="${esc(d.event)}" autocomplete="off"></label>
      ${datalist('dl-event', uniqueValues('event'))}
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
      html += `<div class="field"><span class="label">結果</span><div class="locked">${d.mySets} - ${d.oppSets}（詳細モードで記録した試合はスコアを変更できません）</div></div>`;
    } else {
      html += `<div class="field"><span class="label">最初のサーブ</span>
        ${segmented('firstServer', [['me', esc(myName())], ['opp', '相手']], d.firstServer)}
      </div>`;
    }

    html += `<label>メモ <span class="opt">任意</span><textarea data-field="memo" rows="3" placeholder="戦型、気づいたことなど">${esc(d.memo)}</textarea></label>
    </div>`;

    if (d.mode === 'detail' && !editing) {
      html += `<button type="button" class="btn primary block" data-action="start-live">試合開始</button>`;
    } else {
      html += `<button type="button" class="btn primary block" data-action="save-form">${editing ? '変更を保存' : '保存'}</button>`;
    }
    if (editing) {
      html += `<button type="button" class="btn block" data-action="open" data-id="${esc(d.id)}">キャンセル</button>`;
    }
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
      <div class="game-chips">${chips || '<span class="muted">第1ゲーム</span>'}</div>
    </div>`;

    if (c.finished) {
      const win = c.winner === 'me';
      html += `<div class="card finished ${win ? 'win' : 'lose'}">
        <div class="finished-title">${win ? '勝利！' : '敗戦'}</div>
        <div class="finished-score">${c.mySets} - ${c.oppSets}</div>
        <div class="finished-games">${c.games.map((g) => `${g.me}-${g.opp}`).join(' / ')}</div>
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
        <button type="button" class="btn" data-action="live-swap-serve" title="最初のサーブを入れ替える">⇄ サーブ修正</button>
      </div>
      <div class="live-actions">
        <button type="button" class="btn ghost" data-action="nav" data-view="list">一時中断</button>
        <button type="button" class="btn ghost danger" data-action="live-discard">試合を破棄</button>
      </div>`;
    return html;
  }

  // 試合詳細
  function viewMatch() {
    const m = db.matches.find((x) => x.id === params.id);
    if (!m) return viewList();
    const win = m.mySets > m.oppSets;
    let html = `<button type="button" class="back" data-action="back">‹ ${params.back ? 'vs ' + esc(params.back.params.name) : '履歴'}</button>
      <section class="card match-head ${win ? 'win' : 'lose'}">
        <div class="mh-result">${win ? '勝ち' : '負け'}</div>
        <div class="mh-score">${m.mySets} - ${m.oppSets}</div>
        <div class="mh-opp">${opponentLink(m.opponent, `vs ${esc(m.opponent)} ›`)}</div>
        <div class="muted">${esc(m.date)}${m.event ? ` ・ ${esc(m.event)}` : ''} ・ ${m.bestOf}ゲームマッチ ・ ${m.mode === 'detail' ? '詳細記録' : 'セット数のみ'}</div>
        ${linkStatus(m)}
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

  function viewStats() {
    const ms = sortedMatches().filter(inRange);
    let html = `<h2 class="view-title">成績</h2>
      <select id="statsRange" class="range">
        ${[['all', '全期間'], ['year', '今年'], ['90', '直近90日'], ['30', '直近30日']].map(([v, l]) =>
          `<option value="${v}" ${v === statsRange ? 'selected' : ''}>${l}</option>`).join('')}
      </select>`;

    if (!ms.length) return html + '<p class="empty">この期間の記録はありません。</p>';

    const wins = ms.filter((m) => m.mySets > m.oppSets).length;
    const setsWon = ms.reduce((a, m) => a + m.mySets, 0);
    const setsLost = ms.reduce((a, m) => a + m.oppSets, 0);
    const fullGame = ms.filter((m) => m.mySets + m.oppSets === m.bestOf);
    const fullWins = fullGame.filter((m) => m.mySets > m.oppSets).length;

    html += `<div class="tiles">
      <div class="tile"><div class="t-val">${ms.length}</div><div class="t-lbl">試合</div></div>
      <div class="tile"><div class="t-val">${wins}-${ms.length - wins}</div><div class="t-lbl">勝-敗</div></div>
      <div class="tile"><div class="t-val">${pct(wins, ms.length)}</div><div class="t-lbl">勝率</div></div>
      <div class="tile"><div class="t-val">${pct(setsWon, setsWon + setsLost)}</div><div class="t-lbl">ゲーム取得率</div></div>
    </div>`;

    const recent = ms.slice(0, 10).reverse();
    html += `<section class="card"><h3>直近${recent.length}試合 <span class="muted small">（左が古い）</span></h3>
      <div class="form-dots">${recent.map((m) => `<span class="fd ${m.mySets > m.oppSets ? 'w' : 'l'}" title="${esc(m.date)} vs ${esc(m.opponent)} ${m.mySets}-${m.oppSets}">${m.mySets > m.oppSets ? '○' : '●'}</span>`).join('')}</div>
      ${fullGame.length ? `<p class="muted small">フルゲームの試合: ${fullWins}勝 ${fullGame.length - fullWins}敗</p>` : ''}
    </section>`;

    html += rallyCard(ms);

    html += groupTable('対戦相手別', ms, 'opponent');
    if (ms.some((m) => m.event)) html += groupTable('大会・練習別', ms, 'event');
    return html;
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
      html += `<section class="card"><h3>1点ごとのデータ <span class="muted small">（詳細記録 ${detail.length}試合）</span></h3><dl class="kv">
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
    const full = ms.filter((m) => m.mySets + m.oppSets === m.bestOf);
    const fullW = full.filter((m) => m.mySets > m.oppSets).length;
    const recent = ms.slice(0, 10).reverse();
    let streak = 0;
    for (const m of ms) {
      if ((m.mySets > m.oppSets) === (ms[0].mySets > ms[0].oppSets)) streak++;
      else break;
    }

    html += `<section class="card h2h">
        <div class="h2h-name">vs ${friend ? '🔗 ' : ''}${esc(name)}</div>
        <div class="h2h-rate">${pct(w, ms.length)}</div>
        <div class="muted">勝率（${w}勝 ${ms.length - w}敗）</div>
        <div class="h2h-bar" aria-hidden="true"><span data-w="${Math.round((w / ms.length) * 1000) / 10}"></span></div>
      </section>
      <div class="tiles">
        <div class="tile"><div class="t-val">${ms.length}</div><div class="t-lbl">対戦数</div></div>
        <div class="tile"><div class="t-val">${pct(sw, sw + sl)}</div><div class="t-lbl">ゲーム取得率（${sw}-${sl}）</div></div>
        <div class="tile"><div class="t-val">${full.length ? `${fullW}-${full.length - fullW}` : '—'}</div><div class="t-lbl">フルゲーム</div></div>
        <div class="tile"><div class="t-val">${streak}${ms[0].mySets > ms[0].oppSets ? '連勝' : '連敗'}</div><div class="t-lbl">現在</div></div>
      </div>
      <section class="card"><h3>直近${recent.length}試合 <span class="muted small">（左が古い）</span></h3>
        <div class="form-dots">${recent.map((m) => `<span class="fd ${m.mySets > m.oppSets ? 'w' : 'l'}" title="${esc(m.date)} ${m.mySets}-${m.oppSets}">${m.mySets > m.oppSets ? '○' : '●'}</span>`).join('')}</div>
      </section>`;
    html += rallyCard(ms);
    html += `<h3 class="list-title">対戦履歴</h3><ul class="match-list">${ms.map(matchItem).join('')}</ul>`;
    return html;
  }

  function groupTable(title, ms, key) {
    const groups = new Map();
    for (const m of ms) {
      const k = (m[key] || '').trim() || '（未入力）';
      const g = groups.get(k) || { n: 0, w: 0, sw: 0, sl: 0 };
      g.n++;
      if (m.mySets > m.oppSets) g.w++;
      g.sw += m.mySets;
      g.sl += m.oppSets;
      groups.set(k, g);
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0], 'ja'));
    return `<section class="card"><h3>${title}</h3><table class="table">
      <thead><tr><th>${key === 'opponent' ? '相手（タップで詳細）' : '名前'}</th><th>勝-敗</th><th>勝率</th><th>ゲーム</th></tr></thead>
      <tbody>${rows.map(([k, g]) => `<tr><td>${key === 'opponent' && k !== '（未入力）' ? opponentLink(k, esc(k)) : esc(k)}</td><td>${g.w}-${g.n - g.w}</td><td>${pct(g.w, g.n)}</td><td>${g.sw}-${g.sl}</td></tr>`).join('')}</tbody>
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
    html += `<div class="card form">
      <label>あなたの名前（友だちのアプリに表示されます）<input type="text" id="myName" value="${esc(unnamed ? '' : db.settings.myName)}" placeholder="例: 山田 太郎" maxlength="20"></label>
    </div>`;

    html += `<div class="card">
      <h3>あなたの友だちリンク</h3>
      <p class="muted small">対戦相手にこのQRコードを読み取ってもらうか、リンクを送って開いてもらうと連携できます。連携は最初の1回だけでOKです。</p>
      ${unnamed ? '<p class="warn small">先に上で名前を入れておくと、相手のアプリにその名前で表示されます。</p>' : ''}
      <div class="qr">${qrSvg(myLink())}</div>
      <div class="row-actions">
        <button type="button" class="btn" data-action="copy-link">リンクをコピー</button>
        <button type="button" class="btn" data-action="share-link">共有…</button>
      </div>
      <p class="muted small id-line">あなたの友だちコード: <code>${esc(L.friendCode(db.settings.myId, myPub()))}</code></p>
      <button type="button" class="btn block" data-action="copy-code">友だちコードをコピー</button>
    </div>`;

    html += `<div class="card form">
      <h3>友だちを追加</h3>
      <label>相手のリンク・友だちコード・IDを貼り付け<input type="text" id="friendInput" placeholder="https://…#add=… または 友だちコード" autocomplete="off"></label>
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
      <p class="muted small">結果は無料の中継サービス ntfy.sh を一時的に経由して届けます（最大12時間預かり、記録本体は各端末に保存）。相手から受け取りの返事が来るまで、アプリを開くたびに自動で再送します。メモは送りません。IDを知っている人はあなたに結果を送れるので、リンクは対戦相手にだけ渡してください。</p>
    </div>`;
    return html;
  }

  function viewSettings() {
    return `<h2 class="view-title">設定</h2>
      <div class="card form">
        <label>自分の名前（スコアボードに表示）<input type="text" id="myName" value="${esc(db.settings.myName)}" maxlength="20"></label>
        <div class="field"><span class="label">画面の明るさ</span>
          <div class="seg" role="radiogroup">${[['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map(([v, l]) => {
            const on = (db.settings.theme || 'auto') === v;
            return `<button type="button" role="radio" aria-checked="${on}" class="${on ? 'on' : ''}" data-action="theme" data-value="${v}">${l}</button>`;
          }).join('')}</div>
          <p class="hint small muted">「自動」は端末のダークモード設定に合わせます。</p>
        </div>
      </div>
      <div class="card">
        <h3>データ</h3>
        <p class="muted small">記録はこの端末のブラウザ内に保存されます。機種変更やバックアップにはエクスポートを使ってください。</p>
        <button type="button" class="btn block" data-action="export">エクスポート（JSON）</button>
        <label class="btn block file-btn">インポート（JSON）<input type="file" id="importFile" accept="application/json,.json"></label>
        <button type="button" class="btn block danger" data-action="wipe">すべての記録を削除</button>
      </div>
      <p class="muted small center">保存済み ${db.matches.length}試合</p>`;
  }

  // ---------- 描画後のイベント（入力欄） ----------

  function afterRender() {
    // CSPでstyle属性を禁止しているので、幅はスクリプトから設定する
    for (const el of main.querySelectorAll('[data-w]')) el.style.width = `${Number(el.dataset.w)}%`;
    for (const el of main.querySelectorAll('[data-field]')) {
      el.addEventListener('input', () => {
        draft[el.dataset.field] = el.value;
        if (el.dataset.field === 'opponent') document.getElementById('oppSuggest').innerHTML = opponentChips(el.value);
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
      Object.assign(m, { date: d.date, opponent: d.opponent, event: d.event, memo: d.memo, updatedAt: Date.now() });
      if (m.mode !== 'detail') Object.assign(m, { bestOf: d.bestOf, mySets: d.result[0], oppSets: d.result[1] });
      if (!m.received) {
        // 相手を変えたら、前の友だちに送った結果は取り消す
        const f = friendByName(m.opponent);
        m.opponentId = f ? f.id : undefined;
        if (prevOpponentId && prevOpponentId !== m.opponentId) queueDelete(prevOpponentId, m.id);
        queueMatch(m);
      }
      saveDb();
      sync();
      toast('更新しました');
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
    toast(`${m.mySets > m.oppSets ? '勝ち' : '負け'}（${m.mySets}-${m.oppSets}）を記録しました`);
    go('list');
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
    if (!after.finished && after.completedGames.length > before.completedGames.length) {
      const g = after.completedGames[after.completedGames.length - 1];
      toast(`第${g.index + 1}ゲーム ${g.me}-${g.opp} ${g.winner === 'me' ? '取得' : '失う'}`);
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
    const friend = friendByName(m.opponent);
    if (friend) m.opponentId = friend.id;
    db.matches.push(m);
    queueMatch(m);
    saveDb();
    sync();
    live = null;
    saveLive();
    toast('試合を保存しました');
    go('match', { id: m.id });
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings: db.settings, matches: db.matches, friends: db.friends }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tt-record-${today()}.json`;
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
      case 'live-discard':
        if (confirm('この試合の記録を破棄しますか？')) {
          live = null;
          saveLive();
          go('list');
        }
        break;
      case 'live-save':
        saveLiveMatch();
        break;
      case 'delete':
        if (confirm('この試合を削除しますか？')) {
          const gone = db.matches.find((m) => m.id === t.dataset.id);
          db.matches = db.matches.filter((m) => m.id !== t.dataset.id);
          // 自分の記録を消したら相手に届けた分も取り消す（相手から届いた記録はこの端末からだけ消す）
          if (gone && !gone.received && gone.opponentId) queueDelete(gone.opponentId, gone.id);
          saveDb();
          sync();
          toast('削除しました');
          go('list');
        }
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
          toast('リンクまたはIDを確認してください');
          break;
        }
        go('friends', { pending: p });
        break;
      }
      case 'friend-rename': {
        const f = friendById(t.dataset.id);
        const name = f && prompt(`あなたの画面での${f.remoteName ? `「${f.remoteName}」さんの` : ''}表示名（相手には伝わりません。空欄で相手が設定した名前に戻します）`, f.name);
        if (name === null || name === undefined || !f) break;
        if (name.trim()) {
          f.name = uniqueFriendName(name, f.id);
          f.custom = true;
        } else {
          f.custom = false;
          f.name = uniqueFriendName(f.remoteName || f.name, f.id);
        }
        // この友だちとの試合の相手名もそろえる
        for (const m of db.matches) if (m.opponentId === f.id) m.opponent = f.name;
        saveDb();
        render();
        break;
      }
      case 'friend-remove': {
        const f = friendById(t.dataset.id);
        if (!f || !confirm(`${f.name}さんとの連携を解除しますか？（これまでの記録は残ります）`)) break;
        db.friends = db.friends.filter((x) => x.id !== f.id);
        db.outbox = db.outbox.filter((o) => o.to !== f.id);
        saveDb();
        render();
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
      case 'sync-now':
        sync({ render: true }).then(() => toast(lastSyncOk === false ? '通信できませんでした' : '同期しました'));
        break;
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

  // 友だちリンク (#add=...) から開かれたときは追加の確認を出す
  function handleHash() {
    if (!location.hash.includes('add=')) return false;
    const p = L.parseFriendInput(location.hash);
    history.replaceState(null, '', location.pathname + location.search);
    if (!p) return false;
    go('friends', { pending: p });
    return true;
  }

  window.addEventListener('hashchange', handleHash);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });
  window.addEventListener('online', () => sync());
  setInterval(() => {
    if (document.visibilityState === 'visible') sync();
  }, POLL_MS);

  applyTheme();
  prepareKeys();
  migrateLegacyFriends();
  if (!handleHash()) go(live ? 'live' : 'list');
  // 初回は鍵の作成が終わってからQRコードを描き直す
  keysReady.then(() => { if (view === 'friends') render(); });
  saveDb(); // 新しく作ったIDを保存しておく
  sync();
})();
