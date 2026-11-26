/* Study OS cloud sync v78 — local-first, Supabase Auth + one-row JSON sync. */
(function () {
  'use strict';
  var CONFIG_KEY = 'studyOSCloudConfigV79';
  var SESSION_KEY = 'studyOSCloudSessionV79';
  var META_KEY = 'studyOSCloudMetaV79';
  // Public browser key only; RLS protects each user's private row.
  var DEFAULT_CONFIG = {
    url: 'https://mekwowszoevgyrsguhxo.supabase.co',
    key: 'sb_publishable_GbzAB9CnD-zeVG3rF3RYHg__6-f9Plu'
  };
  var DATA_KEYS = [
    'pasokhBargDigitalV2', 'pasokhBargStudyOS_v2',
    'pasokhBargLiveCorrectMode', 'pasokhBargTheme', 'pasokhBargSidebarCollapsed',
    'pasokhBargAmbientMotion_v1', 'pasokhBargPrismModeV60', 'pasokhBargPrismStrengthV60',
    'pasokhBargPrismSpeedV60', 'pasokhBargPrismPaletteV61', 'pasokhBargPrismHoverV61',
    'pasokhBargPrismLiftV61', 'pasokhBargPrismPaletteV63', 'pasokhBargPrismCustomV63',
    'pasokhBargPrismThicknessV63', 'pasokhBargPrismGlowV63', 'pasokhBargPrismPowerV65'
  ];
  var state = { session: null, syncing: false, dirty: false, applying: false, panelOpen: false, installPrompt: null, remoteChoice: null, poll: null, localRevision: 0 };

  function byId(id) { return document.getElementById(id); }
  function readJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; } }
  function writeJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function getConfig() { var saved = readJSON(CONFIG_KEY, null); return saved && saved.url && saved.key ? saved : DEFAULT_CONFIG; }
  function getSession() { return readJSON(SESSION_KEY, null); }
  function getMeta() { return readJSON(META_KEY, { lastRemoteUpdatedAt: null, initialized: false, dirty: false }); }
  function setMeta(patch) { var m = getMeta(); Object.keys(patch).forEach(function (k) { m[k] = patch[k]; }); writeJSON(META_KEY, m); }
  function snapshot() {
    var obj = {};
    DATA_KEYS.forEach(function (k) { var v = localStorage.getItem(k); if (v !== null) obj[k] = v; });
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
    ['sosCloudSignup','sosCloudLogin','sosCloudSyncNow','sosCloudSaveConfig'].forEach(function (id) {
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
    writeJSON(SESSION_KEY, s); state.session = s; return s;
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
    try { localStorage.setItem('studyOSLocalBackupBeforeCloudV79', JSON.stringify(snapshot())); } catch (e) { note('فضای مرورگر برای تهیهٔ نسخهٔ پشتیبان کافی نیست؛ همگام‌سازی متوقف شد.', true); throw e; }
  }
  function applyRemote(payload, updatedAt) {
    if (!payload || typeof payload !== 'object') throw new Error('دادهٔ ابری معتبر نیست.');
    backupLocalBeforeRestore();
    state.applying = true;
    try {
      DATA_KEYS.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(payload, k)) localStorage.setItem(k, String(payload[k]));
        else localStorage.removeItem(k);
      });
      setMeta({ lastRemoteUpdatedAt: updatedAt || null, initialized: true, dirty: false });
    } finally { state.applying = false; }
    note('اطلاعات از ابر دریافت شد؛ برنامه برای بارگذاری داده‌های تازه بازآغاز می‌شود.');
    setStatus('دریافت شد', 'ok');
    setTimeout(function () { location.reload(); }, 650);
  }
  function showInitialChoice(remote) {
    state.remoteChoice = { type: 'initial', remote: remote };
    var box = byId('sosCloudChoice');
    if (box) {
      box.hidden = false;
      box.innerHTML = '<div class="sos-cloud-choice-title">روی این دستگاه و فضای ابری هر دو اطلاعات وجود دارد.</div><div class="sos-cloud-choice-copy">برای جلوگیری از حذف ناخواسته، انتخاب کن کدام نسخه مبنا باشد. قبل از دریافت اطلاعات ابری، از داده‌های همین دستگاه هم نسخهٔ پشتیبان ساخته می‌شود.</div><div class="sos-cloud-choice-actions"><button type="button" id="sosUseLocal">اطلاعات این دستگاه را نگه دار و به ابر بفرست</button><button type="button" id="sosUseRemote" class="secondary">اطلاعات ابر را روی این دستگاه دریافت کن</button></div>';
      byId('sosUseLocal').onclick = function () { hideChoice(); pushLocal(remote.updated_at || null); };
      byId('sosUseRemote').onclick = function () { hideChoice(); applyRemote(remote.payload, remote.updated_at); };
    }
    note('انتخاب اولیه لازم است؛ بعد از این، همگام‌سازی خودکار انجام می‌شود.');
    showPanel(true);
  }
  function showRemoteUpdate(remote) {
    state.remoteChoice = { type: 'remote-update', remote: remote };
    var box = byId('sosCloudChoice');
    if (box) {
      box.hidden = false;
      box.innerHTML = '<div class="sos-cloud-choice-title">نسخهٔ تازه‌تری در فضای ابری وجود دارد.</div><div class="sos-cloud-choice-copy">برای اینکه وسط آزمون یا هنگام ویرایش، صفحه ناگهانی بازآغاز نشود، دریافت نسخهٔ تازه با تأیید تو انجام می‌شود.</div><div class="sos-cloud-choice-actions"><button type="button" id="sosUseRemote">دریافت نسخهٔ تازه از ابر</button><button type="button" id="sosUseLocal" class="secondary">فعلاً همین نسخه را نگه دار</button></div>';
      byId('sosUseLocal').onclick = function () { hideChoice(); state.dirty = true; setMeta({ lastRemoteUpdatedAt: remote.updated_at, dirty: true }); note('نسخهٔ همین دستگاه انتخاب شد؛ در حال ارسال آن به فضای ابری…'); pushLocal(remote.updated_at); };
      byId('sosUseRemote').onclick = function () { hideChoice(); applyRemote(remote.payload, remote.updated_at); };
    }
    note('نسخهٔ تازهٔ ابری آماده است؛ برای جلوگیری از قطع آزمون یا ویرایش، دریافت آن نیازمند تأیید توست.');
    setStatus('نسخهٔ تازه در ابر', 'warn'); showPanel(true);
  }
  function showConflict(remote) {
    state.remoteChoice = { type: 'conflict', remote: remote };
    var box = byId('sosCloudChoice');
    if (box) {
      box.hidden = false;
      box.innerHTML = '<div class="sos-cloud-choice-title">هر دو دستگاه از آخرین همگام‌سازی تغییر کرده‌اند.</div><div class="sos-cloud-choice-copy">برای جلوگیری از بازنویسی بی‌خبر، همگام‌سازی متوقف شده است. نسخه‌ای را که می‌خواهی مبنا قرار بگیرد انتخاب کن.</div><div class="sos-cloud-choice-actions"><button type="button" id="sosUseLocal">نسخهٔ این دستگاه به‌عنوان نسخهٔ اصلی</button><button type="button" id="sosUseRemote" class="secondary">نسخهٔ ابری به‌عنوان نسخهٔ اصلی</button></div>';
      byId('sosUseLocal').onclick = function () { hideChoice(); pushLocal(remote.updated_at); };
      byId('sosUseRemote').onclick = function () { hideChoice(); applyRemote(remote.payload, remote.updated_at); };
    }
    note('تداخل تغییرات شناسایی شد؛ هیچ اطلاعاتی خودکار حذف یا جایگزین نشده است.', true);
    setStatus('نیازمند انتخاب', 'warn'); showPanel(true);
  }
  function hideChoice() { var b = byId('sosCloudChoice'); if (b) { b.hidden = true; b.innerHTML = ''; } state.remoteChoice = null; }
  function pushLocal(expected) {
    if (state.syncing) return Promise.resolve();
    state.syncing = true; setBusy(true); setStatus('در حال ارسال…', 'busy');
    var revisionAtStart = state.localRevision;
    var payloadAtStart = snapshot();
    return saveRemote(payloadAtStart, expected).then(function (result) {
      if (result.conflict) { showConflict({ payload: result.row.payload, updated_at: result.row.updated_at }); return; }
      var changedDuringUpload = state.localRevision !== revisionAtStart;
      setMeta({ lastRemoteUpdatedAt: result.row.updated_at, initialized: true, dirty: changedDuringUpload });
      state.dirty = changedDuringUpload;
      if (changedDuringUpload) {
        note('تغییر تازه‌ای هنگام ارسال ثبت شد؛ باقی تغییرات هم در صف ارسال قرار گرفت.');
        setStatus('تغییرات در صف ارسال', 'warn');
      } else {
        note('همهٔ اطلاعات این دستگاه با فضای ابری هماهنگ شد.'); setStatus('همگام شد', 'ok');
      }
    }).catch(function (err) {
      state.dirty = true; setMeta({ dirty: true });
      setStatus(navigator.onLine ? 'خطا در همگام‌سازی' : 'آفلاین؛ اطلاعات محلی محفوظ است', navigator.onLine ? 'error' : 'warn');
      note('همگام‌سازی انجام نشد: ' + err.message + ' اطلاعات روی همین دستگاه محفوظ است.', true);
    }).then(function () {
      state.syncing = false; setBusy(false);
      if (state.dirty && !state.remoteChoice && getSession() && navigator.onLine) {
        clearTimeout(pushLocal.retryTimer);
        pushLocal.retryTimer = setTimeout(function () { runSync(false); }, 700);
      }
    });
  }

  function runSync(force) {
    if (state.syncing || state.remoteChoice) return Promise.resolve();
    var s = getSession(); if (!s || !s.access_token) { setStatus('فقط روی این دستگاه', 'idle'); return Promise.resolve(); }
    if (!navigator.onLine) { setStatus('آفلاین؛ اطلاعات محلی محفوظ است', 'warn'); return Promise.resolve(); }
    state.syncing = true; setStatus('در حال بررسی…', 'busy');
    return getRemote().then(function (remote) {
      var meta = getMeta(), localData = hasMeaningfulLocalData(), remoteData = remote && hasMeaningfulSnapshot(remote.payload);
      if (!meta.initialized) {
        if (remote && remoteData && localData) { state.syncing = false; showInitialChoice(remote); return; }
        if (remote && remoteData && !localData) { state.syncing = false; applyRemote(remote.payload, remote.updated_at); return; }
        state.syncing = false; return pushLocal(remote ? remote.updated_at : null);
      }
      if (!remote) {
        if (meta.lastRemoteUpdatedAt) { state.syncing = false; note('نسخهٔ ابری پیدا نشد؛ برای ایمنی، ارسال خودکار متوقف شد.', true); setStatus('نیازمند بررسی', 'warn'); return; }
        state.syncing = false; return pushLocal(null);
      }
      var remoteChanged = !!meta.lastRemoteUpdatedAt && remote.updated_at !== meta.lastRemoteUpdatedAt;
      var dirty = !!(meta.dirty || state.dirty);
      if (remoteChanged && dirty) { state.syncing = false; showConflict(remote); return; }
      if (remoteChanged && !dirty) { state.syncing = false; showRemoteUpdate(remote); return; }
      if (dirty || !meta.lastRemoteUpdatedAt) { state.syncing = false; return pushLocal(remote.updated_at); }
      setStatus('همگام است', 'ok'); note('این دستگاه با فضای ابری هماهنگ است.');
    }).catch(function (err) {
      setStatus(navigator.onLine ? 'خطا در اتصال' : 'آفلاین؛ اطلاعات محلی محفوظ است', navigator.onLine ? 'error' : 'warn');
      note('بررسی فضای ابری انجام نشد: ' + err.message, true);
    }).then(function () { state.syncing = false; setBusy(false); });
  }
  function startSync(fromLogin) {
    state.dirty = !!getMeta().dirty;
    refreshAccountUI();
    note(fromLogin ? 'ورود انجام شد؛ در حال بررسی داده‌های محلی و ابری…' : 'همگام‌سازی خودکار فعال است.');
    return runSync(true).then(function () { beginPolling(); });
  }
  function queueSync() {
    if (state.applying) return;
    state.localRevision += 1;
    if (!getSession()) return;
    state.dirty = true; setMeta({ dirty: true });
    setStatus(navigator.onLine ? 'تغییرات در صف ارسال' : 'آفلاین؛ ذخیرهٔ محلی', 'warn');
    clearTimeout(queueSync.timer);
    queueSync.timer = setTimeout(function () { runSync(false); }, 2200);
  }
  function beginPolling() {
    if (state.poll) clearInterval(state.poll);
    state.poll = setInterval(function () { if (document.visibilityState !== 'hidden' && navigator.onLine) runSync(false); }, 25000);
  }
  function refreshAccountUI() {
    var logged = !!(getSession() && getSession().access_token);
    var auth = byId('sosCloudAuthFields'), logout = byId('sosCloudLogout'), login = byId('sosCloudLogin'), signup = byId('sosCloudSignup'), sync = byId('sosCloudSyncNow');
    if (auth) auth.hidden = logged;
    if (logout) logout.hidden = !logged;
    if (login) login.hidden = logged;
    if (signup) signup.hidden = logged;
    if (sync) sync.hidden = !logged;
    if (logged) setStatus('حساب متصل', 'ok'); else setStatus('فقط روی این دستگاه', 'idle');
  }
  function logout() {
    var c = getConfig(), s = getSession();
    var req = s ? fetch(c.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: c.key, Authorization: 'Bearer ' + s.access_token } }).catch(function () {}) : Promise.resolve();
    return req.then(function () { localStorage.removeItem(SESSION_KEY); state.session = null; state.dirty = false; refreshAccountUI(); setStatus('فقط روی این دستگاه', 'idle'); note('از حساب ابری خارج شدی؛ اطلاعات محلی این دستگاه پاک نشده است.'); });
  }
  function saveConfig() {
    var url = cleanUrl(byId('sosCloudUrl').value), key = (byId('sosCloudKey').value || '').trim();
    if (!/^https:\/\/[a-zA-Z0-9.-]+$/.test(url)) throw new Error('نشانی پروژه باید با https:// شروع شود.');
    if (key.length < 20) throw new Error('کلید عمومی پروژه کامل به نظر نمی‌رسد.');
    var prev = getConfig();
    if (prev.url !== url || prev.key !== key) { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(META_KEY); }
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
    document.head.appendChild(css);
    var markup = '<button id="sosCloudPill" type="button" aria-expanded="false"><span id="sosCloudDot" class="sos-cloud-dot"></span><span>ابر</span></button>' +
      '<section id="sosCloudPanel" hidden aria-label="همگام‌سازی ابری"><div class="sos-cloud-top"><div><h3>همگام‌سازی Study OS</h3><div id="sosCloudStatusText" class="sos-cloud-small">فقط روی این دستگاه</div></div><button id="sosCloudClose" class="secondary" type="button">بستن</button></div>' +
      '<p>اطلاعات ابتدا روی همین دستگاه ذخیره می‌شوند. با اتصال اینترنت، تغییرات بین دستگاه‌ها هماهنگ می‌شود.</p>' +
      '<label for="sosCloudUrl">نشانی پروژهٔ Supabase</label><input id="sosCloudUrl" inputmode="url" autocomplete="url" placeholder="https://your-project.supabase.co">' +
      '<label for="sosCloudKey">کلید عمومی (anon / publishable)</label><input id="sosCloudKey" type="password" autocomplete="off" placeholder="کلید عمومی پروژه">' +
      '<div class="sos-cloud-actions"><button id="sosCloudSaveConfig" type="button">ذخیرهٔ تنظیمات پروژه</button><button id="sosInstallApp" type="button" class="secondary">افزودن به صفحهٔ اصلی</button></div>' +
      '<div id="sosCloudAuthFields"><label for="sosCloudEmail">ایمیل حساب</label><input id="sosCloudEmail" type="email" autocomplete="username" placeholder="name@example.com"><label for="sosCloudPassword">گذرواژه</label><input id="sosCloudPassword" type="password" autocomplete="current-password" placeholder="حداقل ۸ نویسه"><div class="sos-cloud-actions"><button id="sosCloudLogin" type="button">ورود</button><button id="sosCloudSignup" type="button" class="secondary">ساخت حساب</button></div></div>' +
      '<div class="sos-cloud-actions"><button id="sosCloudSyncNow" type="button" hidden>همگام‌سازی همین حالا</button><button id="sosCloudLogout" type="button" class="secondary" hidden>خروج از حساب</button></div>' +
      '<div id="sosCloudChoice" class="sos-cloud-choice" hidden></div><div id="sosCloudNote" class="sos-cloud-note">هنوز به فضای ابری وصل نشده‌ای.</div>' +
      '<div class="sos-cloud-warning">فقط کلید عمومی پروژه را وارد کن؛ کلید service_role محرمانه است و نباید در برنامه قرار بگیرد.</div>' +
      '<div class="sos-cloud-small">نشانی و کلید عمومی پروژهٔ Study OS از قبل تنظیم شده‌اند. فقط حساب خودت را بساز یا وارد شو. برنامه ابتدا محلی ذخیره می‌کند و با اینترنت همگام می‌شود.</div></section>';
    document.body.insertAdjacentHTML('beforeend', markup);
    byId('sosCloudPill').onclick = function () { showPanel(!state.panelOpen); };
    byId('sosCloudClose').onclick = function () { showPanel(false); };
    byId('sosCloudSaveConfig').onclick = function () { try { saveConfig(); } catch (e) { note(e.message, true); } };
    byId('sosCloudSignup').onclick = function () { setBusy(true); signup().catch(function (e) { note('ساخت حساب انجام نشد: ' + e.message, true); }).then(function () { setBusy(false); }); };
    byId('sosCloudLogin').onclick = function () { setBusy(true); login().catch(function (e) { note('ورود انجام نشد: ' + e.message, true); }).then(function () { setBusy(false); }); };
    byId('sosCloudSyncNow').onclick = function () { runSync(true); };
    byId('sosCloudLogout').onclick = logout;
    byId('sosInstallApp').onclick = installApp;
    var c = getConfig(); if (c.url) byId('sosCloudUrl').value = c.url; if (c.key) byId('sosCloudKey').value = c.key;
    refreshAccountUI();
  }
  function installHooks() {
    var originalSet = Storage.prototype.setItem;
    var originalRemove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      originalSet.call(this, key, value);
      if (this === localStorage && DATA_KEYS.indexOf(String(key)) !== -1) queueSync();
    };
    Storage.prototype.removeItem = function (key) {
      originalRemove.call(this, key);
      if (this === localStorage && DATA_KEYS.indexOf(String(key)) !== -1) queueSync();
    };
    window.addEventListener('storage', function (event) {
      if (event.storageArea === localStorage && event.key && DATA_KEYS.indexOf(String(event.key)) !== -1) queueSync();
    });
    window.addEventListener('online', function () { if (getSession()) { note('اینترنت وصل شد؛ همگام‌سازی از سر گرفته می‌شود.'); runSync(false); } });
    window.addEventListener('beforeinstallprompt', function (event) { event.preventDefault(); state.installPrompt = event; var b = byId('sosInstallApp'); if (b) b.textContent = 'نصب Study OS'; });
    window.addEventListener('appinstalled', function () { state.installPrompt = null; note('Study OS به صفحهٔ اصلی اضافه شد.'); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && getSession() && navigator.onLine) runSync(false); });
  }
  function registerWorker() {
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function (err) { console.warn('Study OS offline setup:', err); }); });
    }
  }
  function init() {
    buildUI(); installHooks(); registerWorker();
    if (getSession()) {
      state.session = getSession();
      if (navigator.onLine) startSync(false); else setStatus('آفلاین؛ اطلاعات محلی محفوظ است', 'warn');
      beginPolling();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
