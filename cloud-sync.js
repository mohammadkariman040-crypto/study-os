/* Study OS cloud sync v94 — production: educational data sync only; device-local preferences retained locally. */
(function () {
  'use strict';
  // Production compatibility: retain the existing v79 config/session/meta keys so current accounts stay signed in.
  var CONFIG_KEY = 'studyOSCloudConfigV79';
  var SESSION_KEY = 'studyOSCloudSessionV79';
  var META_KEY = 'studyOSCloudMetaV79';
  // Public publishable browser key only; RLS protects each user's private row. Never put service_role/secret keys here.
  var DEFAULT_CONFIG = {
    url: 'https://mekwowszoevgyrsguhxo.supabase.co',
    key: 'sb_publishable_GbzAB9CnD-zeVG3rF3RYHg__6-f9Plu'
  };
  // Only the two educational stores are shared. Previous v79 session/config keys remain compatible.
  // Legacy preference keys in old remote snapshots are filtered and removed on the next successful sync.
  var DATA_KEYS = ['pasokhBargDigitalV2', 'pasokhBargStudyOS_v2'];
  var STUDY_DATA_KEY = 'pasokhBargStudyOS_v2';
  // These fields describe this device's view/preferences, not the learner's shared academic record.
  var DEVICE_LOCAL_STUDY_SETTINGS = [
    'selectedDate', 'focusRangeV68', 'focusFromV68', 'focusToV68',
    'plannerSubject', 'taskSubject', 'selectedGoal', 'sessionKind', 'alarmEnabled'
  ];
  var DEVICE_LOCAL_GOAL_SETTINGS = ['focusGoalModeV68'];
  var state = { session: null, syncing: false, dirty: false, applying: false, panelOpen: false, installPrompt: null, poll: null, localRevision: 0, lastLocalChangeAt: 0, queuedRemote: null, realtime: null, realtimeReady: false, realtimeTopic: null, joinRef: null, heartbeat: null, reconnectTimer: null, reconnectAttempt: 0, stopRealtime: false };

  function byId(id) { return document.getElementById(id); }
  function readJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; } }
  function writeJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function getConfig() { var saved = readJSON(CONFIG_KEY, null); return saved && saved.url && saved.key ? saved : DEFAULT_CONFIG; }
  function getSession() { return readJSON(SESSION_KEY, null); }
  function getMeta() { return readJSON(META_KEY, { lastRemoteUpdatedAt: null, initialized: false, dirty: false, basePayload: null, lastLocalChangeAt: 0 }); }
  function setMeta(patch) { var m = getMeta(); Object.keys(patch).forEach(function (k) { m[k] = patch[k]; }); writeJSON(META_KEY, m); }
  function safeParse(raw, fallback) {
    try { return raw == null ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
  }
  function cloneJSON(value) {
    if (value == null || typeof value !== 'object') return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }
  function stripDeviceLocalStudyFields(value) {
    var data = cloneJSON(value);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    if (data.settings && typeof data.settings === 'object') {
      DEVICE_LOCAL_STUDY_SETTINGS.forEach(function (key) { delete data.settings[key]; });
    }
    if (data.goals && typeof data.goals === 'object') {
      DEVICE_LOCAL_GOAL_SETTINGS.forEach(function (key) { delete data.goals[key]; });
    }
    return data;
  }
  function preserveDeviceLocalStudyFields(incomingRaw, currentRaw) {
    var incoming = safeParse(incomingRaw, {}), current = safeParse(currentRaw, {});
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) incoming = {};
    if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
    incoming = cloneJSON(incoming);
    incoming.settings = incoming.settings && typeof incoming.settings === 'object' ? incoming.settings : {};
    var currentSettings = current.settings && typeof current.settings === 'object' ? current.settings : {};
    DEVICE_LOCAL_STUDY_SETTINGS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(currentSettings, key)) incoming.settings[key] = cloneJSON(currentSettings[key]);
      else delete incoming.settings[key];
    });
    incoming.goals = incoming.goals && typeof incoming.goals === 'object' ? incoming.goals : {};
    var currentGoals = current.goals && typeof current.goals === 'object' ? current.goals : {};
    DEVICE_LOCAL_GOAL_SETTINGS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(currentGoals, key)) incoming.goals[key] = cloneJSON(currentGoals[key]);
      else delete incoming.goals[key];
    });
    return JSON.stringify(incoming);
  }
  function normalizeSyncPayload(payload) {
    var out = {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
    DATA_KEYS.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
      if (key === STUDY_DATA_KEY) {
        var parsed = safeParse(payload[key], null);
        out[key] = parsed && typeof parsed === 'object' ? JSON.stringify(stripDeviceLocalStudyFields(parsed)) : String(payload[key]);
      } else {
        out[key] = String(payload[key]);
      }
    });
    return out;
  }
  function snapshot() {
    var obj = {};
    DATA_KEYS.forEach(function (key) {
      var value = localStorage.getItem(key);
      if (value === null) return;
      if (key === STUDY_DATA_KEY) {
        var parsed = safeParse(value, null);
        obj[key] = parsed && typeof parsed === 'object' ? JSON.stringify(stripDeviceLocalStudyFields(parsed)) : value;
      } else obj[key] = value;
    });
    return obj;
  }
  function hasMeaningfulLocalData() {
    var exam = readJSON('pasokhBargDigitalV2', {});
    if ((exam.books && exam.books.length) || (exam.dailyTestLog && exam.dailyTestLog.length)) return true;
    var study = readJSON('pasokhBargStudyOS_v2', {});
    if ((study.sessions && study.sessions.length) || (study.reviewed && Object.keys(study.reviewed).length) || (study.goals && Object.keys(study.goals).length)) return true;
    var collections = [study.plans, study.tasks, study.reviewSchedule];
    for (var i = 0; i < collections.length; i++) {
      var c = collections[i];
      if (c && Object.keys(c).some(function (d) { return Array.isArray(c[d]) ? c[d].length > 0 : !!c[d]; })) return true;
    }
    return false;
  }
  function hasMeaningfulSnapshot(obj) {
    if (!obj || !Object.keys(obj).length) return false;
    try {
      var exam = JSON.parse(obj.pasokhBargDigitalV2 || '{}');
      if ((exam.books && exam.books.length) || (exam.dailyTestLog && exam.dailyTestLog.length)) return true;
      var study = JSON.parse(obj.pasokhBargStudyOS_v2 || '{}');
      if ((study.sessions && study.sessions.length) || (study.reviewed && Object.keys(study.reviewed).length) || (study.goals && Object.keys(study.goals).length)) return true;
      var cs = [study.plans, study.tasks, study.reviewSchedule];
      for (var i = 0; i < cs.length; i++) if (cs[i] && Object.keys(cs[i]).some(function (d) { return Array.isArray(cs[i][d]) ? cs[i][d].length > 0 : !!cs[i][d]; })) return true;
    } catch (e) { return true; }
    return false;
  }
  function cleanUrl(url) { return String(url || '').trim().replace(/\/+$/, ''); }
  function validConfig(c) { return c && /^https:\/\/[a-zA-Z0-9.-]+$/.test(cleanUrl(c.url)) && c.key && c.key.length > 20; }
  function setStatus(text, mode) {
    var t = byId('sosCloudStatusText'), dot = byId('sosCloudDot');
    if (t) t.textContent = text;
    if (dot) dot.className = 'sos-cloud-dot ' + (mode || 'idle');
    var p = byId('sosCloudPill');
    if (p) p.setAttribute('aria-label', 'وضع همگام‌سازی: ' + text);
  }
  function showPanel(open) {
    state.panelOpen = open;
    var panel = byId('sosCloudPanel');
    if (panel) panel.hidden = !open;
    var btn = byId('sosCloudPill');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function note(msg, isError) {
    var el = byId('sosCloudNote');
    if (el) { el.textContent = msg; el.className = 'sos-cloud-note' + (isError ? ' error' : ''); }
  }
  function setBusy(busy) {
    ['sosCloudSignup','sosCloudLogin','sosCloudSyncNow','sosCloudSaveConfig','sosCloudSetPassword'].forEach(function (id) {
      var el = byId(id); if (el) el.disabled = !!busy;
    });
  }
  function authHeaders(token) {
    var c = getConfig();
    return { 'apikey': c.key, 'Authorization': 'Bearer ' + (token || c.key), 'Content-Type': 'application/json' };
  }
  function parseResponse(res) {
    return res.text().then(function (txt) {
      var body = {}; try { body = txt ? JSON.parse(txt) : {}; } catch (e) { body = { message: txt }; }
      if (!res.ok) { var msg = body.msg || body.message || body.error_description || body.error || ('HTTP ' + res.status); throw new Error(msg); }
      return body;
    });
  }
  function api(path, options, retry) {
    var c = getConfig(), s = getSession();
    if (!validConfig(c)) return Promise.reject(new Error('نشانی پروژه و کلید عمومی را کامل وارد کن.'));
    options = options || {};
    var headers = options.headers || {};
    headers.apikey = c.key;
    headers.Authorization = 'Bearer ' + (s && s.access_token ? s.access_token : c.key);
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    options.headers = headers;
    return fetch(c.url + path, options).then(function (res) {
      if (res.status === 401 && retry !== false && s && s.refresh_token) {
        return refreshSession().then(function () { return api(path, options, false); });
      }
      return parseResponse(res);
    });
  }
  function refreshSession() {
    var c = getConfig(), s = getSession();
    if (!s || !s.refresh_token) return Promise.reject(new Error('نشست منقضی شده؛ دوباره وارد شو.'));
    return fetch(c.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    }).then(parseResponse).then(function (data) { storeSession(data); return data; });
  }
  function storeSession(data) {
    if (!data || !data.access_token) throw new Error('ورود کامل نشد؛ پاسخ سرویس نشست معتبر نداشت.');
    var s = {
      access_token: data.access_token, refresh_token: data.refresh_token,
      token_type: data.token_type || 'bearer', expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      user: data.user || (getSession() || {}).user || null
    };
    writeJSON(SESSION_KEY, s); state.session = s;
    if (state.realtime && state.realtime.readyState === 1 && state.realtimeTopic) {
      try { state.realtime.send(JSON.stringify({ topic: state.realtimeTopic, event: 'access_token', payload: { access_token: s.access_token }, ref: String(Date.now()), join_ref: state.joinRef || null })); } catch (e) {}
    }
    return s;
  }
  function signup() {
    var c = getConfig(), email = (byId('sosCloudEmail').value || '').trim(), password = byId('sosCloudPassword').value;
    if (!email || !password || password.length < 8) return Promise.reject(new Error('ایمیل را وارد کن و برای گذرواژه حداقل ۸ نویسه در نظر بگیر.'));
    return fetch(c.url + '/auth/v1/signup', { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password }) })
      .then(parseResponse).then(function (data) {
        byId('sosCloudPassword').value = '';
        if (data.access_token) { storeSession(data); return startSync(true); }
        note('حساب ثبت شد. اگر تأیید ایمیل در پروژه روشن است، ایمیل را تأیید کن و سپس وارد شو.');
        return null;
      });
  }
  function login() {
    var c = getConfig(), email = (byId('sosCloudEmail').value || '').trim(), password = byId('sosCloudPassword').value;
    if (!email || !password) return Promise.reject(new Error('ایمیل و گذرواژه را وارد کن.'));
    return fetch(c.url + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password }) })
      .then(parseResponse).then(function (data) { byId('sosCloudPassword').value = ''; storeSession(data); return startSync(true); });
  }
  function currentUserId() { var s = getSession(); return s && s.user && s.user.id; }
  function getRemote() {
    var uid = currentUserId();
    if (!uid) return Promise.reject(new Error('ابتدا وارد حساب شو.'));
    return api('/rest/v1/study_os_sync?select=payload,updated_at&user_id=eq.' + encodeURIComponent(uid) + '&limit=1', { method: 'GET' }).then(function (rows) { return rows && rows.length ? rows[0] : null; });
  }
  function saveRemote(payload, expectedUpdatedAt) {
    return api('/rest/v1/rpc/study_os_sync_save', { method: 'POST', body: JSON.stringify({ p_payload: payload, p_expected_updated_at: expectedUpdatedAt || null }) }).then(function (rows) {
      var row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) throw new Error('پاسخ ذخیره‌سازی ابری خالی بود.');
      if (!row.saved) return { conflict: true, row: row };
      return { conflict: false, row: row };
    });
  }
  function backupLocalBeforeRestore() {
    var backupKey = 'studyOSLocalBackupBeforeCloudV89';
    if (localStorage.getItem(backupKey)) return;
    try { localStorage.setItem(backupKey, JSON.stringify(snapshot())); }
    catch (e) { note('فضای مرورگر برای تهیهٔ نسخهٔ پشتیبان کافی نیست؛ همگام‌سازی متوقف شد.', true); throw e; }
  }
  function canonical(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(value[k]); }).join(',') + '}';
  }
  function equalValue(a, b) { return canonical(a) === canonical(b); }
  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function arrayKey(item) {
    if (!item || typeof item !== 'object') return null;
    var keys = ['id', 'date', 'n', 'key', 'questionNumber', 'planId', 'sessionId', 'taskId'];
    for (var i = 0; i < keys.length; i++) if (item[keys[i]] !== undefined && item[keys[i]] !== null) return keys[i] + ':' + String(item[keys[i]]);
    return null;
  }
  function mergeArray(base, local, remote, localTime, remoteTime) {
    var sample = (local || []).concat(remote || [], base || []).filter(function (x) { return x !== undefined; });
    var keyed = sample.length && sample.every(function (x) { return arrayKey(x) !== null; });
    if (keyed) {
      var bm = new Map(), lm = new Map(), rm = new Map(), order = [];
      (base || []).forEach(function (x) { var k = arrayKey(x); bm.set(k, x); if (order.indexOf(k) < 0) order.push(k); });
      (local || []).forEach(function (x) { var k = arrayKey(x); lm.set(k, x); if (order.indexOf(k) < 0) order.push(k); });
      (remote || []).forEach(function (x) { var k = arrayKey(x); rm.set(k, x); if (order.indexOf(k) < 0) order.push(k); });
      var out = [];
      order.forEach(function (k) {
        var b = bm.has(k) ? bm.get(k) : undefined, l = lm.has(k) ? lm.get(k) : undefined, r = rm.has(k) ? rm.get(k) : undefined;
        var v = mergeNode(b, l, r, localTime, remoteTime);
        if (v !== undefined) out.push(v);
      });
      return out;
    }
    var primitive = sample.every(function (x) { return x === null || ['string','number','boolean'].indexOf(typeof x) >= 0; });
    if (primitive) {
      var bset = new Set(base || []), lset = new Set(local || []), rset = new Set(remote || []), additions = [];
      (local || []).concat(remote || []).forEach(function (x) { if (!bset.has(x) && additions.indexOf(x) < 0) additions.push(x); });
      var kept = [];
      (base || []).forEach(function (x) { if (lset.has(x) && rset.has(x)) kept.push(x); });
      return kept.concat(additions);
    }
    if (Array.isArray(base) && base.length === (local || []).length && base.length === (remote || []).length) {
      return base.map(function (x, i) { return mergeNode(x, local[i], remote[i], localTime, remoteTime); });
    }
    return (localTime || 0) >= (remoteTime || 0) ? (local || []) : (remote || []);
  }
  function mergeNode(base, local, remote, localTime, remoteTime) {
    if (equalValue(local, remote)) return local;
    if (equalValue(local, base)) return remote;
    if (equalValue(remote, base)) return local;
    if (isObject(local) && isObject(remote)) {
      var result = {}, keys = new Set(Object.keys(base || {}).concat(Object.keys(local), Object.keys(remote)));
      keys.forEach(function (key) {
        var bHas = isObject(base) && Object.prototype.hasOwnProperty.call(base, key);
        var lHas = Object.prototype.hasOwnProperty.call(local, key);
        var rHas = Object.prototype.hasOwnProperty.call(remote, key);
        var b = bHas ? base[key] : undefined, l = lHas ? local[key] : undefined, r = rHas ? remote[key] : undefined;
        var v = mergeNode(b, l, r, localTime, remoteTime);
        if (v !== undefined) result[key] = v;
      });
      return result;
    }
    if (Array.isArray(local) && Array.isArray(remote)) return mergeArray(Array.isArray(base) ? base : [], local, remote, localTime, remoteTime);
    return (localTime || 0) >= (remoteTime || 0) ? local : remote;
  }
  function parseStoredValue(raw) {
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }
  function mergePayload(basePayload, localPayload, remotePayload, localTime, remoteTime) {
    var base = basePayload || {}, local = localPayload || {}, remote = remotePayload || {}, result = {};
    DATA_KEYS.forEach(function (key) {
      var b = parseStoredValue(base[key]), l = parseStoredValue(local[key]), r = parseStoredValue(remote[key]);
      var merged = mergeNode(b, l, r, localTime, remoteTime);
      if (merged !== undefined) result[key] = typeof merged === 'string' && (typeof l === 'string' || typeof r === 'string') ? merged : JSON.stringify(merged);
    });
    return result;
  }
  function payloadEqual(a, b) {
    a = normalizeSyncPayload(a || {}); b = normalizeSyncPayload(b || {});
    return DATA_KEYS.every(function (key) {
      var av = Object.prototype.hasOwnProperty.call(a, key) ? parseStoredValue(a[key]) : undefined;
      var bv = Object.prototype.hasOwnProperty.call(b, key) ? parseStoredValue(b[key]) : undefined;
      return equalValue(av, bv);
    });
  }
  function payloadHasLegacyDeviceSettings(payload) {
    if (!payload || typeof payload !== 'object') return false;
    return Object.keys(payload).some(function (key) { return DATA_KEYS.indexOf(key) === -1; });
  }
  function writeLocalPayload(payload, updatedAt) {
    var changed = [];
    backupLocalBeforeRestore();
    state.applying = true;
    try {
      DATA_KEYS.forEach(function (key) {
        var next = Object.prototype.hasOwnProperty.call(payload || {}, key) ? String(payload[key]) : null;
        var current = localStorage.getItem(key);
        // Keep device-specific navigation/timer defaults and preferences when applying remote study data.
        if (key === STUDY_DATA_KEY && next !== null) next = preserveDeviceLocalStudyFields(next, current);
        if (current === next) return;
        if (next === null) localStorage.removeItem(key); else localStorage.setItem(key, next);
        changed.push(key);
      });
    } finally { state.applying = false; }
    if (changed.length) {
      try { window.dispatchEvent(new CustomEvent('studyos:cloud-data-updated', { detail: { changedKeys: changed, updatedAt: updatedAt || null } })); } catch (e) {}
    }
    return changed;
  }
  function updateSyncedMeta(remote) {
    var payload = remote && remote.payload ? normalizeSyncPayload(remote.payload) : snapshot();
    setMeta({ lastRemoteUpdatedAt: remote && remote.updated_at || null, initialized: true, dirty: false, basePayload: payload, lastLocalChangeAt: 0 });
    state.dirty = false;
    setStatus('همگام است', 'ok');
    note('اطلاعات آموزشی همگام شدند؛ تنظیمات ظاهری و صدای این دستگاه محلی باقی می‌مانند.');
  }
  function reconcileRemote(remote, attempt) {
    attempt = attempt || 0;
    if (attempt > 5) return Promise.reject(new Error('همگام‌سازی هم‌زمان چند دستگاه بیش از حد تکرار شد؛ چند ثانیه بعد دوباره تلاش می‌کنیم.'));
    var meta = getMeta(), localAtStart = snapshot(), revisionAtStart = state.localRevision;
    var localTime = Number(meta.lastLocalChangeAt || state.lastLocalChangeAt || 0);
    var remoteTime = remote && remote.updated_at ? Date.parse(remote.updated_at) : 0;
    if (!remote && meta.initialized && meta.lastRemoteUpdatedAt) {
      // The row may have been removed or temporarily hidden. Re-create from the local copy instead of discarding it.
      note('رکورد ابری در دسترس نیست؛ نسخهٔ محلی حفظ و برای بازیابی ارسال می‌شود.', true);
    }
    var base = meta.initialized && meta.basePayload ? normalizeSyncPayload(meta.basePayload) : {};
    var remotePayload = remote && remote.payload && typeof remote.payload === 'object' ? normalizeSyncPayload(remote.payload) : (meta.initialized && meta.basePayload ? normalizeSyncPayload(meta.basePayload) : {});
    var merged = mergePayload(base, localAtStart, remotePayload, localTime, remoteTime);
    writeLocalPayload(merged, remote && remote.updated_at);
    var localNow = snapshot();
    if (remote && payloadEqual(localNow, normalizeSyncPayload(remote.payload)) && !payloadHasLegacyDeviceSettings(remote.payload)) {
      updateSyncedMeta(remote);
      if (state.localRevision !== revisionAtStart) { state.dirty = true; setMeta({ dirty: true }); setTimeout(function () { runSync(false); }, 120); }
      return Promise.resolve(remote);
    }
    setStatus('در حال هماهنگ‌سازی…', 'busy');
    return saveRemote(localNow, remote && remote.updated_at || null).then(function (result) {
      if (result.conflict) return getRemote().then(function (latest) { return reconcileRemote(latest, attempt + 1); });
      var savedRow = result.row || { payload: localNow, updated_at: null };
      var currentChanged = state.localRevision !== revisionAtStart;
      setMeta({ lastRemoteUpdatedAt: savedRow.updated_at, initialized: true, dirty: currentChanged, basePayload: normalizeSyncPayload(savedRow.payload || localNow), lastLocalChangeAt: currentChanged ? (state.lastLocalChangeAt || Date.now()) : 0 });
      state.dirty = currentChanged;
      if (currentChanged) {
        setStatus('تغییر تازه در صف ارسال', 'warn');
        setTimeout(function () { runSync(false); }, 120);
      } else {
        setStatus('همگام است', 'ok');
        note('اطلاعات آموزشی همگام شدند؛ تنظیمات ظاهری و صدای این دستگاه محلی باقی می‌مانند.');
      }
      return savedRow;
    });
  }
  function finishSync() {
    state.syncing = false; setBusy(false);
    var queued = state.queuedRemote; state.queuedRemote = null;
    if (queued && getSession() && navigator.onLine) { handleRemoteRow(queued); return; }
    if (state.dirty && getSession() && navigator.onLine) setTimeout(function () { runSync(false); }, 140);
  }
  function runSync(force) {
    if (state.syncing) return Promise.resolve();
    var s = getSession();
    if (!s || !s.access_token) { setStatus('فقط روی این دستگاه', 'idle'); return Promise.resolve(); }
    if (!navigator.onLine) { setStatus('آفلاین؛ اطلاعات محلی محفوظ است', 'warn'); return Promise.resolve(); }
    state.syncing = true; setStatus('در حال بررسی…', 'busy');
    return getRemote().then(function (remote) { return reconcileRemote(remote, 0); })
      .catch(function (err) { setStatus(navigator.onLine ? 'خطا در همگام‌سازی' : 'آفلاین؛ اطلاعات محلی محفوظ است', navigator.onLine ? 'error' : 'warn'); note('همگام‌سازی انجام نشد: ' + err.message + '؛ اطلاعات محلی محفوظ است.', true); })
      .then(finishSync);
  }
  function handleRemoteRow(row) {
    if (!row || !row.payload || row.user_id !== currentUserId()) return;
    var meta = getMeta();
    if (row.updated_at && row.updated_at === meta.lastRemoteUpdatedAt) return;
    if (state.syncing) { state.queuedRemote = row; return; }
    if (!getSession() || !navigator.onLine) return;
    state.syncing = true; setStatus('دریافت تغییر دستگاه دیگر…', 'busy');
    reconcileRemote(row, 0)
      .catch(function (err) { note('دریافت زنده انجام نشد: ' + err.message, true); setStatus('در انتظار همگام‌سازی مجدد', 'warn'); })
      .then(finishSync);
  }
  function nextRef() { state.ref = (Number(state.ref) || 0) + 1; return String(state.ref); }
  function sendRealtime(event, payload, topic, ref) {
    var ws = state.realtime;
    if (!ws || ws.readyState !== 1) return false;
    var targetTopic = topic || state.realtimeTopic || 'phoenix';
    var message = { topic: targetTopic, event: event, payload: payload || {}, ref: ref || nextRef() };
    if (targetTopic !== 'phoenix' && state.joinRef) message.join_ref = state.joinRef;
    try { ws.send(JSON.stringify(message)); return true; } catch (e) { return false; }
  }
  function stopRealtime() {
    state.stopRealtime = true; state.realtimeReady = false;
    if (state.heartbeat) clearInterval(state.heartbeat); state.heartbeat = null;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
    if (state.realtime) { try { state.realtime.onclose = null; state.realtime.close(); } catch (e) {} }
    state.realtime = null; state.realtimeTopic = null; state.joinRef = null;
  }
  function scheduleRealtimeReconnect() {
    if (state.stopRealtime || !getSession() || !navigator.onLine || state.reconnectTimer) return;
    var delay = Math.min(30000, 1200 * Math.pow(1.7, state.reconnectAttempt++));
    state.reconnectTimer = setTimeout(function () { state.reconnectTimer = null; connectRealtime(); }, delay);
  }
  function connectRealtime() {
    var c = getConfig(), session = getSession(), uid = currentUserId();
    if (!uid || !session || !session.access_token || !navigator.onLine || typeof WebSocket === 'undefined') return;
    if (state.realtime && (state.realtime.readyState === 0 || state.realtime.readyState === 1)) return;
    state.stopRealtime = false;
    var topic = 'realtime:public:study_os_sync'; state.realtimeTopic = topic;
    var endpoint = cleanUrl(c.url).replace(/^https:/, 'wss:') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(c.key) + '&vsn=1.0.0';
    var ws;
    try { ws = new WebSocket(endpoint); } catch (e) { scheduleRealtimeReconnect(); return; }
    state.realtime = ws;
    ws.onopen = function () {
      state.reconnectAttempt = 0;
      var uidNow = currentUserId();
      if (!uidNow) { stopRealtime(); return; }
      state.joinRef = String(nextRef());
      sendRealtime('phx_join', {
        config: { broadcast: { ack: false, self: false, replication_ready: true }, presence: { enabled: false, key: uidNow }, postgres_changes: [{ event: '*', schema: 'public', table: 'study_os_sync', filter: 'user_id=eq.' + uidNow }], private: false },
        access_token: (getSession() || {}).access_token || ''
      }, topic, state.joinRef);
      if (state.heartbeat) clearInterval(state.heartbeat);
      state.heartbeat = setInterval(function () { sendRealtime('heartbeat', {}, 'phoenix'); }, 20000);
    };
    ws.onmessage = function (event) {
      var message; try { message = JSON.parse(event.data); } catch (e) { return; }
      if (message.event === 'phx_reply' && message.payload && message.payload.status === 'ok' && String(message.ref || '') === String(state.joinRef || '')) {
        state.reconnectAttempt = 0;
        setStatus('اتصال زنده برقرار شد', 'ok');
        return;
      }
      if (message.event === 'phx_reply' && message.payload && message.payload.status === 'error') {
        state.realtimeReady = false;
        note('کانال زنده هنوز فعال نشده؛ همگام‌سازی پشتیبان ادامه دارد. اگر این وضعیت ماند، SQL فعال‌سازی Realtime را اجرا کن.', true);
        try { ws.close(); } catch (e) {}
        return;
      }
      if (message.event === 'postgres_changes') {
        var data = message.payload && message.payload.data || {};
        var record = data.record || message.payload && message.payload.record;
        if (record) handleRemoteRow(record);
      }
      if (message.event === 'system' && message.payload) {
        if (message.payload.extension === 'postgres_changes' && message.payload.status === 'ok') {
          state.realtimeReady = true; setStatus('همگام‌سازی زنده فعال', 'ok');
        } else if (message.payload.status === 'error') {
          state.realtimeReady = false; note('کانال زنده موقتاً قطع شد؛ همگام‌سازی پشتیبان ادامه دارد.');
          try { ws.close(); } catch (e) {}
        }
      }
    };
    ws.onerror = function () { state.realtimeReady = false; };
    ws.onclose = function () {
      if (state.heartbeat) clearInterval(state.heartbeat); state.heartbeat = null;
      if (state.realtime === ws) { state.realtime = null; state.realtimeReady = false; }
      if (getSession() && navigator.onLine) setStatus('همگام‌سازی پشتیبان فعال است', 'warn');
      scheduleRealtimeReconnect();
    };
  }
  function startSync(fromLogin) {
    state.dirty = !!getMeta().dirty;
    refreshAccountUI();
    note(fromLogin ? 'ورود انجام شد؛ همگام‌سازی خودکار دستگاه‌ها فعال می‌شود…' : 'همگام‌سازی خودکار فعال است.');
    return runSync(true).then(function () { beginPolling(); connectRealtime(); });
  }
  function queueSync() {
    if (state.applying) return;
    if (!getSession()) return;
    var metaBeforeQueue = getMeta();
    if (metaBeforeQueue.initialized && payloadEqual(snapshot(), normalizeSyncPayload(metaBeforeQueue.basePayload || {}))) return;
    state.localRevision += 1;
    state.lastLocalChangeAt = Date.now();
    state.dirty = true; setMeta({ dirty: true, lastLocalChangeAt: state.lastLocalChangeAt });
    setStatus(navigator.onLine ? 'در حال ارسال تغییر…' : 'آفلاین؛ ذخیرهٔ محلی', 'warn');
    clearTimeout(queueSync.timer);
    queueSync.timer = setTimeout(function () { runSync(false); }, 60);
  }
  function beginPolling() {
    if (state.poll) clearInterval(state.poll);
    // Realtime is the primary path. Poll only as a recovery path while the socket is unavailable.
    state.poll = setInterval(function () {
      if (!state.realtimeReady && document.visibilityState !== 'hidden' && navigator.onLine && getSession()) runSync(false);
    }, 18000);
  }
  function clearPendingRemote() { state.queuedRemote = null; }
  function refreshAccountUI() {
    var logged = !!(getSession() && getSession().access_token);
    var auth = byId('sosCloudAuthFields'), logout = byId('sosCloudLogout'), login = byId('sosCloudLogin'), signup = byId('sosCloudSignup'), sync = byId('sosCloudSyncNow');
    var inviteSetup = byId('sosCloudInviteSetup');
    var invitePending = readJSON('studyOSCloudInvitePendingV79', false) === true;
    if (auth) auth.hidden = logged;
    if (inviteSetup) inviteSetup.hidden = !(logged && invitePending);
    if (logout) logout.hidden = !logged;
    if (login) login.hidden = logged;
    if (signup) signup.hidden = logged;
    if (sync) sync.hidden = !logged;
    if (logged) setStatus('حساب متصل', 'ok'); else setStatus('فقط روی این دستگاه', 'idle');
  }
  function setInvitePassword() {
    var c = getConfig(), session = getSession(), password = (byId('sosCloudInvitePassword').value || '');
    if (!session || !session.access_token) return Promise.reject(new Error('لینک دعوت منقضی شده است؛ دوباره از مدیر اصلی دعوت بخواه.'));
    if (password.length < 8) return Promise.reject(new Error('گذرواژه باید حداقل ۸ نویسه داشته باشد.'));
    return fetch(c.url + '/auth/v1/user', {
      method: 'PUT',
      headers: { apikey: c.key, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password })
    }).then(parseResponse).then(function () {
      byId('sosCloudInvitePassword').value = '';
      localStorage.removeItem('studyOSCloudInvitePendingV79');
      refreshAccountUI();
      note('گذرواژه ثبت شد؛ همگام‌سازی حساب آغاز می‌شود.');
      return startSync(true);
    });
  }
  function logout() {
    stopRealtime();
    var c = getConfig(), s = getSession();
    var req = s ? fetch(c.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: c.key, Authorization: 'Bearer ' + s.access_token } }).catch(function () {}) : Promise.resolve();
    return req.then(function () { localStorage.removeItem(SESSION_KEY); localStorage.removeItem('studyOSCloudInvitePendingV79'); state.session = null; state.dirty = false; refreshAccountUI(); setStatus('فقط روی این دستگاه', 'idle'); note('از حساب ابری خارج شدی؛ اطلاعات محلی این دستگاه پاک نشده است.'); });
  }
  function saveConfig() {
    var url = cleanUrl(byId('sosCloudUrl').value), key = (byId('sosCloudKey').value || '').trim();
    if (!/^https:\/\/[a-zA-Z0-9.-]+$/.test(url)) throw new Error('نشانی پروژه باید با https:// شروع شود.');
    if (key.length < 20) throw new Error('کلید عمومی پروژه کامل به نظر نمی‌رسد.');
    var prev = getConfig();
    if (prev.url !== url || prev.key !== key) { stopRealtime(); localStorage.removeItem(SESSION_KEY); localStorage.removeItem(META_KEY); }
    writeJSON(CONFIG_KEY, { url: url, key: key });
    refreshAccountUI(); note('تنظیمات پروژه ذخیره شد. حالا با همان حساب در همهٔ دستگاه‌ها وارد شو.');
  }
  function installApp() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt.userChoice.then(function () { state.installPrompt = null; var b = byId('sosInstallApp'); if (b) b.hidden = true; });
    } else {
      note('در Chrome روی منوی سه‌نقطه بزن و گزینهٔ «افزودن به صفحهٔ اصلی» یا «Install app» را انتخاب کن. اگر این گزینه نبود، برنامه از همان مرورگر قابل استفاده است.');
    }
  }
  function buildUI() {
    var css = document.createElement('style');
    css.textContent = '#sosCloudPill{position:fixed;z-index:9998;left:14px;bottom:14px;border:1px solid rgba(129,157,210,.32);background:rgba(17,27,46,.94);color:#eaf0ff;border-radius:999px;padding:9px 13px;display:flex;align-items:center;gap:8px;box-shadow:0 5px 24px rgba(0,0,0,.2);font:500 13px Tahoma,sans-serif;cursor:pointer}#sosCloudPill:focus-visible,#sosCloudPanel button:focus-visible{outline:2px solid #83baff;outline-offset:2px}.sos-cloud-dot{width:8px;height:8px;border-radius:50%;background:#8b96aa;display:inline-block}.sos-cloud-dot.ok{background:#55cf9c}.sos-cloud-dot.busy{background:#71baff;box-shadow:0 0 0 4px rgba(113,186,255,.13)}.sos-cloud-dot.warn{background:#e8bd69}.sos-cloud-dot.error{background:#ed7777}#sosCloudPanel{position:fixed;z-index:9999;left:12px;bottom:62px;width:min(370px,calc(100vw - 24px));max-height:82vh;overflow:auto;background:#111b2e;color:#ecf2ff;border:1px solid rgba(134,161,211,.28);border-radius:16px;padding:15px;box-shadow:0 16px 52px rgba(0,0,0,.36);font:13px/1.75 Tahoma,sans-serif;direction:rtl}#sosCloudPanel[hidden],#sosCloudChoice[hidden]{display:none}#sosCloudPanel h3{font-size:15px;margin:0 0 5px}#sosCloudPanel p{margin:4px 0 12px;color:#b9c5da}#sosCloudPanel label{display:block;margin:9px 0 3px;color:#cbd7ea}#sosCloudPanel input{display:block;width:100%;min-height:40px;padding:8px 10px;border-radius:9px;border:1px solid #354763;background:#0b1322;color:#fff;font:13px Tahoma,sans-serif;direction:ltr;text-align:left}#sosCloudPanel input:focus{outline:2px solid #679bdc;outline-offset:1px}#sosCloudPanel button{border:0;border-radius:9px;padding:9px 11px;background:#4979c7;color:white;font:600 12px Tahoma,sans-serif;cursor:pointer;min-height:38px}#sosCloudPanel button.secondary{background:#263752;color:#e5edff}#sosCloudPanel button:disabled{opacity:.55;cursor:wait}.sos-cloud-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.sos-cloud-note{margin-top:10px;padding:9px 10px;border-radius:9px;background:#1a2a43;color:#cbdaf1;overflow-wrap:anywhere}.sos-cloud-note.error{background:#3a222d;color:#ffd6dc}.sos-cloud-small{font-size:11px;color:#9eacc4;margin-top:10px}.sos-cloud-choice-title{font-weight:700;color:#fff;margin-bottom:4px}.sos-cloud-choice-copy{color:#becae0}.sos-cloud-choice-actions{display:grid;gap:7px;margin-top:10px}.sos-cloud-choice{padding:11px;margin-top:12px;border:1px solid #53698e;border-radius:11px;background:#192942}#sosCloudPanel .sos-cloud-top{display:flex;justify-content:space-between;align-items:center;gap:10px}#sosCloudPanel .sos-cloud-top button{min-height:30px;padding:4px 9px}#sosCloudPanel .sos-cloud-warning{color:#e9ca8b;font-size:11px;margin-top:8px}@media(max-width:520px){#sosCloudPill{left:10px;bottom:10px;padding:8px 11px}#sosCloudPanel{left:8px;bottom:56px;width:calc(100vw - 16px);max-height:78vh}}';
    css.textContent += `
      /* V89: compact icon-only cloud control, consistent on desktop/tablet/phone. */
      #sosCloudPill { position:fixed!important; z-index:100007!important; left:14px!important; right:auto!important; bottom:14px!important; width:46px!important; min-width:46px!important; max-width:46px!important; height:46px!important; min-height:46px!important; padding:0!important; display:grid!important; place-items:center!important; border-radius:50%!important; background:rgba(17,27,46,.97)!important; border:1px solid rgba(129,157,210,.42)!important; color:#eaf0ff!important; box-shadow:0 5px 18px rgba(0,0,0,.24)!important; }
      #sosCloudPill .sos-cloud-glyph { display:flex!important; width:23px!important; height:23px!important; align-items:center!important; justify-content:center!important; }
      #sosCloudPill .sos-cloud-glyph svg { display:block!important; width:23px!important; height:23px!important; fill:none!important; stroke:currentColor!important; stroke-width:1.8!important; stroke-linecap:round!important; stroke-linejoin:round!important; }
      #sosCloudPill .sos-cloud-label { display:none!important; }
      #sosCloudPill .sos-cloud-dot { position:absolute!important; top:5px!important; right:5px!important; width:7px!important; height:7px!important; border:1px solid #111b2e!important; border-radius:50%!important; }
      @media(max-width:600px){ #sosCloudPill{left:10px!important;bottom:10px!important;width:42px!important;min-width:42px!important;max-width:42px!important;height:42px!important;min-height:42px!important;} }
    `;
    css.textContent += `
      /* V83: actual vector cloud glyph; tablet retains its own safe-area offset. */
      #sosCloudPill .sos-cloud-glyph { display:none; flex:0 0 21px; width:21px; height:21px; align-items:center; justify-content:center; }
      #sosCloudPill .sos-cloud-glyph svg { display:block; width:21px; height:21px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      #sosCloudPill .sos-cloud-label { display:inline-block; line-height:1.25; }

    `;
    css.textContent += `
      /* V83: tablet class is based on touch + physical screen shape, not CSS viewport width alone. */
      html.sos-device-tablet #sosCloudPill {
        position:fixed !important; z-index:100007 !important;
        left:12px !important; right:auto !important;
        bottom:calc(84px + env(safe-area-inset-bottom,0px)) !important;
        display:inline-flex !important; align-items:center !important; justify-content:center !important;
        gap:8px !important; width:46px !important; min-width:46px !important; max-width:46px !important;
        min-height:46px !important; height:46px !important; padding:0 !important;
        box-sizing:border-box !important; border:1px solid rgba(129,157,210,.38) !important;
        border-radius:999px !important; background:rgba(17,27,46,.97) !important; color:#eaf0ff !important;
        box-shadow:0 5px 18px rgba(0,0,0,.22) !important; font:600 13px/1.25 system-ui,'Noto Naskh Arabic',Tahoma,sans-serif !important;
        direction:rtl !important; white-space:nowrap !important; transform:none !important; filter:none !important;
        touch-action:manipulation !important; -webkit-tap-highlight-color:transparent !important;
      }
      html.sos-device-tablet #sosCloudPill .sos-cloud-glyph { display:flex !important; flex:0 0 22px !important; width:22px !important; height:22px !important; }
      html.sos-device-tablet #sosCloudPill .sos-cloud-glyph svg { display:block !important; width:20px !important; height:20px !important; fill:none !important; stroke:currentColor !important; stroke-width:1.9 !important; stroke-linecap:round !important; stroke-linejoin:round !important; }
      html.sos-device-tablet #sosCloudPill .sos-cloud-dot { position:absolute!important;top:5px!important;right:5px!important;flex:0 0 7px!important;width:7px!important;height:7px!important;border-radius:50%!important; }
      html.sos-device-tablet #sosCloudPanel {
        position:fixed !important; z-index:100008 !important;
        left:12px !important; right:12px !important; bottom:calc(138px + env(safe-area-inset-bottom,0px)) !important;
        width:auto !important; max-width:460px !important; max-height:calc(100vh - 158px) !important;
        box-sizing:border-box !important; overflow:auto !important; overscroll-behavior:contain !important;
        -webkit-overflow-scrolling:touch !important; border-radius:16px !important;
      }
      html.sos-device-tablet #sosCloudPanel button { min-height:42px !important; border-radius:10px !important; white-space:normal !important; }
      html.sos-device-tablet #sosCloudPanel input { min-width:0 !important; max-width:100% !important; }
    `;
    css.textContent += `
      /* V89 final override: icon-only cloud button wins over all legacy V83 rules. */
      #sosCloudPill { display:grid!important; place-items:center!important; width:46px!important; min-width:46px!important; max-width:46px!important; height:46px!important; min-height:46px!important; padding:0!important; border-radius:50%!important; }
      #sosCloudPill .sos-cloud-glyph { display:flex!important; width:23px!important; height:23px!important; flex:0 0 23px!important; }
      #sosCloudPill .sos-cloud-label { display:none!important; }
      #sosCloudPill .sos-cloud-dot { position:absolute!important; top:5px!important; right:5px!important; width:7px!important; height:7px!important; flex:0 0 7px!important; }
      html.sos-device-tablet #sosCloudPill { display:grid!important; place-items:center!important; width:46px!important; min-width:46px!important; max-width:46px!important; height:46px!important; min-height:46px!important; padding:0!important; border-radius:50%!important; }
      html.sos-device-tablet #sosCloudPill .sos-cloud-glyph { display:flex!important; width:23px!important; height:23px!important; flex:0 0 23px!important; }
      html.sos-device-tablet #sosCloudPill .sos-cloud-label { display:none!important; }
      @media(max-width:600px){#sosCloudPill{width:42px!important;min-width:42px!important;max-width:42px!important;height:42px!important;min-height:42px!important}}
    `;
    document.head.appendChild(css);
    var markup = '<button id="sosCloudPill" type="button" aria-expanded="false" aria-label="وضع همگام‌سازی"><span id="sosCloudDot" class="sos-cloud-dot"></span><span class="sos-cloud-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7.2 18h9.6a4.4 4.4 0 0 0 .7-8.75 5.7 5.7 0 0 0-11.1 1.2A3.8 3.8 0 0 0 7.2 18Z"/></svg></span></button>' +
      '<section id="sosCloudPanel" hidden aria-label="همگام‌سازی ابری"><div class="sos-cloud-top"><div><h3>همگام‌سازی Study OS</h3><div id="sosCloudStatusText" class="sos-cloud-small">فقط روی این دستگاه</div></div><button id="sosCloudClose" class="secondary" type="button">بستن</button></div>' +
      '<p>آزمون‌ها، پاسخ‌ها، شمارش تست، برنامه‌ها، کارها، مرورها و جلسه‌های مطالعه بین دستگاه‌ها همگام می‌شوند. تم، نورپردازی، چیدمان، موسیقی و تنظیمات نمایشی فقط روی همین دستگاه می‌مانند.</p>' +
      '<label for="sosCloudUrl">نشانی پروژهٔ Supabase</label><input id="sosCloudUrl" inputmode="url" autocomplete="url" placeholder="https://your-project.supabase.co">' +
      '<label for="sosCloudKey">کلید عمومی (anon / publishable)</label><input id="sosCloudKey" type="password" autocomplete="off" placeholder="کلید عمومی پروژه">' +
      '<div class="sos-cloud-actions"><button id="sosCloudSaveConfig" type="button">ذخیرهٔ تنظیمات پروژه</button><button id="sosInstallApp" type="button" class="secondary">افزودن به صفحهٔ اصلی</button></div>' +
      '<div id="sosCloudAuthFields"><label for="sosCloudEmail">ایمیل حساب</label><input id="sosCloudEmail" type="email" autocomplete="username" placeholder="ایمیل حساب"><label for="sosCloudPassword">گذرواژه</label><input id="sosCloudPassword" type="password" autocomplete="current-password" placeholder="گذرواژه"><div class="sos-cloud-actions"><button id="sosCloudLogin" type="button">ورود</button><span class="sos-cloud-small" id="sosCloudInviteOnly">ثبت‌نام فقط با دعوت مدیر اصلی انجام می‌شود.</span></div></div>' +
      '<section id="sosCloudInviteSetup" hidden><label for="sosCloudInvitePassword">برای تکمیل دعوت، گذرواژهٔ جدید بساز</label><input id="sosCloudInvitePassword" type="password" autocomplete="new-password" placeholder="حداقل ۸ نویسه"><button id="sosCloudSetPassword" type="button">ثبت گذرواژه و ورود</button></section>' +
      '<div class="sos-cloud-actions"><button id="sosCloudSyncNow" type="button" hidden>همگام‌سازی همین حالا</button><button id="sosCloudLogout" type="button" class="secondary" hidden>خروج از حساب</button></div>' +
      '<div id="sosCloudChoice" class="sos-cloud-choice" hidden></div><div id="sosCloudNote" class="sos-cloud-note">هنوز به فضای ابری وصل نشده‌ای.</div>' +
      '<div class="sos-cloud-warning">فقط کلید عمومی پروژه را وارد کن؛ کلید service_role محرمانه است و نباید در برنامه قرار بگیرد.</div>' +
      '<div class="sos-cloud-small">اتصال پروژهٔ Study OS از قبل تنظیم شده است. ورود با حساب موجود یا دعوت مدیر اصلی انجام می‌شود. داده‌ها ابتدا محلی ذخیره و سپس با اینترنت همگام می‌شوند.</div></section>';
    document.body.insertAdjacentHTML('beforeend', markup);
    byId('sosCloudPill').onclick = function () { showPanel(!state.panelOpen); };
    byId('sosCloudClose').onclick = function () { showPanel(false); };
    byId('sosCloudSaveConfig').onclick = function () { try { saveConfig(); } catch (e) { note(e.message, true); } };
    byId('sosCloudLogin').onclick = function () { setBusy(true); login().catch(function (e) { note('ورود انجام نشد: ' + e.message, true); }).then(function () { setBusy(false); }); };
    byId('sosCloudSetPassword').onclick = function () { setBusy(true); setInvitePassword().catch(function (e) { note('ثبت گذرواژه انجام نشد: ' + e.message, true); }).then(function () { setBusy(false); }); };
    byId('sosCloudSyncNow').onclick = function () { runSync(true); };
    byId('sosCloudLogout').onclick = logout;
    byId('sosInstallApp').onclick = installApp;
    var c = getConfig(); if (c.url) byId('sosCloudUrl').value = c.url; if (c.key) byId('sosCloudKey').value = c.key;
    refreshAccountUI();
  }
  function installHooks() {
    ['pointerdown','keydown','input','touchstart','wheel'].forEach(function (type) {
      document.addEventListener(type, function () { state.lastInteractionAt = Date.now(); }, true);
    });
    var originalSet = Storage.prototype.setItem;
    var originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      originalSet.call(this, key, value);
      if (this === localStorage && !state.applying && DATA_KEYS.indexOf(String(key)) !== -1) queueSync();
    };
    Storage.prototype.removeItem = function (key) {
      originalRemove.call(this, key);
      if (this === localStorage && !state.applying && DATA_KEYS.indexOf(String(key)) !== -1) queueSync();
    };
    window.addEventListener('storage', function (event) {
      if (event.storageArea === localStorage && event.key && DATA_KEYS.indexOf(String(event.key)) !== -1) queueSync();
    });
    window.addEventListener('online', function () { if (getSession()) { note('اینترنت وصل شد؛ همگام‌سازی زنده از سر گرفته می‌شود.'); runSync(false); connectRealtime(); } });
    window.addEventListener('beforeinstallprompt', function (event) { event.preventDefault(); state.installPrompt = event; var b = byId('sosInstallApp'); if (b) b.textContent = 'نصب Study OS'; });
    window.addEventListener('appinstalled', function () { state.installPrompt = null; note('Study OS به صفحهٔ اصلی اضافه شد.'); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && getSession() && navigator.onLine) { runSync(false); connectRealtime(); } });
  }
  function registerWorker() {
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js?v=94', { scope: './' }).catch(function (err) { console.warn('Study OS offline setup:', err); }); });
    }
  }
  function captureAuthCallback() {
    // Supabase invite/confirmation links may return an implicit-flow token in the URL fragment.
    // Persist only the standard session fields, then remove tokens from the visible address bar.
    var hash = String(window.location.hash || '').replace(/^#/, '');
    if (!hash) return null;
    var params;
    try { params = new URLSearchParams(hash); } catch (e) { return null; }
    var authError = params.get('error_description') || params.get('error');
    if (authError) { try { localStorage.setItem('studyOSCloudAuthCallbackErrorV79', String(authError).slice(0, 500)); } catch (e) {} }
    var access = params.get('access_token');
    if (!access) return null;
    var expiresIn = Math.max(60, Number(params.get('expires_in')) || 3600);
    var user = null;
    try {
      var parts = access.split('.');
      if (parts.length >= 2) {
        var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        user = JSON.parse(decodeURIComponent(escape(atob(payload))));
      }
    } catch (e) { user = null; }
    var session = {
      access_token: access,
      refresh_token: params.get('refresh_token') || null,
      token_type: params.get('token_type') || 'bearer',
      expires_at: Date.now() + expiresIn * 1000,
      user: user ? { id: user.sub || null, email: user.email || null } : null
    };
    writeJSON(SESSION_KEY, session);
    if (params.get('type') === 'invite' || params.get('type') === 'recovery') writeJSON('studyOSCloudInvitePendingV79', true);
    try { window.history.replaceState({}, document.title, window.location.pathname + window.location.search); } catch (e) {}
    return session;
  }
  function init() {
    captureAuthCallback();
    buildUI();
    var callbackError = localStorage.getItem('studyOSCloudAuthCallbackErrorV79');
    if (callbackError) { note('تأیید دعوت کامل نشد: ' + callbackError, true); localStorage.removeItem('studyOSCloudAuthCallbackErrorV79'); }
    installHooks(); registerWorker();
    if (getSession()) {
      state.session = getSession();
      if (readJSON('studyOSCloudInvitePendingV79', false) === true) {
        setStatus('دعوت تأیید شد؛ گذرواژه را ثبت کن', 'warn');
        note('برای تکمیل دعوت ایمیلی، یک گذرواژهٔ جدید بساز. تا آن زمان همگام‌سازی شروع نمی‌شود.');
        refreshAccountUI();
      } else if (navigator.onLine) startSync(false);
      else setStatus('آفلاین؛ اطلاعات محلی محفوظ است', 'warn');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
