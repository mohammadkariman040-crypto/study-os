const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ext = fs.readFileSync(path.join(ROOT, 'study-os-v93.js'), 'utf8');
const sync = fs.readFileSync(path.join(ROOT, 'cloud-sync.js'), 'utf8');
const adminFn = fs.readFileSync(path.join(ROOT, 'supabase/functions/study-admin/index.ts'), 'utf8');
const aiFn = fs.readFileSync(path.join(ROOT, 'supabase/functions/study-ai/index.ts'), 'utf8');
const stableHtmlPath = process.env.STUDY_OS_V91_INDEX || '/mnt/data/compare-v91/index.html';
const stableHtml = fs.existsSync(stableHtmlPath) ? fs.readFileSync(stableHtmlPath, 'utf8') : null;

function extractBetween(source, start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `Missing start marker: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `Missing end marker: ${end}`);
  return source.slice(a, b);
}
function extractFunction(source, functionName, nextMarker) {
  return extractBetween(source, `function ${functionName}(`, nextMarker);
}
function evalInContext(code, values = {}) {
  const ctx = vm.createContext({ ...values, console, Intl, Date, Map, Set, URL, URLSearchParams });
  vm.runInContext(code, ctx, { timeout: 1000 });
  return ctx;
}
function datesIn(block) {
  // Source schedules use both tuple arrays ['YYYY-MM-DD', note] and object rows {date:'...'};
  // match the date values themselves instead of assuming one representation.
  return [...block.matchAll(/['\"]((?:1405|1406)-\d{2}-\d{2})['\"]/g)].map(m => m[1]);
}

// 1. Basic syntax and packaging invariants.
test('v93 app extension, sync layer and service worker pass JavaScript syntax parsing', () => {
  new vm.Script(ext);
  new vm.Script(sync);
  new vm.Script(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
  assert.match(html, /cloud-sync\.js\?v=92/);
  assert.match(html, /study-os-v93\.css\?v=93/);
  assert.match(html, /study-os-v93\.js\?v=93/);
  assert.match(html, /sw\.js\?v=93/);
  assert.match(html, /prefs\.alertVolume/);
  const examTone = extractFunction(html, 'playTimerEndChime', 'function startTimer');
  assert.match(examTone, /prefs\.alertTone/);
  assert.match(examTone, /StudyOSMediaV93\?\.duck/);
});

test('Persian timer digit formatting remains byte-identical to stable v91', { skip: !stableHtml }, () => {
  const faLine = s => s.match(/^const fa=n=>String\(n\)\.replace\(\\\/d\\\/g,d=>.*?;$/m)?.[0];
  const fmtLine = s => s.match(/^function fmt\(sec\)\{.*?\}$/m)?.[0];
  assert.equal(faLine(html), faLine(stableHtml));
  assert.equal(fmtLine(html), fmtLine(stableHtml));
  assert.match(fmtLine(html), /padStart\(2,'۰'\)/);
});

// 2. Off-platform tests are subtracted from the aggregated report rows before AI context lists them separately.
test('AI context does not double-count manual tests included in API.testRows', () => {
  const helper = extractFunction(ext, 'answerSheetRowsOnly', 'function buildPerformanceSummary()');
  const summaryFn = extractFunction(ext, 'buildPerformanceSummary', 'async function sendAiMessage()');
  const manual = [{
    id: 'm1', date: '2026-11-27', name: 'نمونه ماز', source: 'ماز', subject: 'زیست‌شناسی',
    total: 25, correct: 16, wrong: 7, blank: 2, percent: 54.67, percentIsOfficial: true,
    computedPercent: 54.6667, taraz: 8768, rank: 78
  }];
  const aggregate = [{
    date: '2026-11-27', count: 30, bySubject: { 'زیست‌شناسی': 30 },
    bySubjectStatus: { 'زیست‌شناسی': { correct: 19, wrong: 8, blank: 3, answered: 0, unknown: 0 } },
    statuses: { correct: 19, wrong: 8, blank: 3, answered: 0, unknown: 0 }
  }];
  const ctx = evalInContext(`${helper}\n${summaryFn}`, { API: { testRows: aggregate }, state: () => ({ externalTests: manual }) });
  const result = ctx.buildPerformanceSummary();
  assert.match(result, /کل 5 \| درست 3، غلط 1، نزده 1/);
  assert.match(result, /نمونه ماز \(ماز\)/);
  assert.match(result, /درصد رسمی درج‌شده 54\.67٪/);
  assert.match(result, /تراز رسمی 8768/);
  assert.match(result, /رتبه رسمی 78/);
  assert.equal((result.match(/نمونه ماز/g) || []).length, 1);
});

test('AI target range is withheld until three comparable manual results exist', () => {
  const helper = extractFunction(ext, 'answerSheetRowsOnly', 'function buildPerformanceSummary()');
  const summaryFn = extractFunction(ext, 'buildPerformanceSummary', 'async function sendAiMessage()');
  const makeTest = (date, percent) => ({ id: date, date, name: 'آزمون', source: 'ماز', subject: 'فیزیک', total: 20, correct: 10, wrong: 5, blank: 5, percent, percentIsOfficial: true, taraz: null, rank: null });
  const two = [makeTest('2026-10-01', 40), makeTest('2026-10-15', 50)];
  const c2 = evalInContext(`${helper}\n${summaryFn}`, { API: { testRows: [] }, state: () => ({ externalTests: two }) });
  const r2 = c2.buildPerformanceSummary();
  assert.match(r2, /فقط 2 نتیجهٔ ثبت‌شده/);
  assert.doesNotMatch(r2, /هدف تمرینی شخصیِ پیشنهادی با افزودن/);
  const three = [...two, makeTest('2026-10-29', 60)];
  const c3 = evalInContext(`${helper}\n${summaryFn}`, { API: { testRows: [] }, state: () => ({ externalTests: three }) });
  const r3 = c3.buildPerformanceSummary();
  assert.match(r3, /میانگین سه آزمون اخیر 50\.00٪/);
  assert.match(r3, /هدف تمرینی شخصیِ پیشنهادی با افزودن ۵ تا ۱۰ واحد درصد: 55\.00 تا 60\.00٪/);
});

// 3. Source-derived calendar schedule: 23 Kanoon, 17 Maz, 17 Arman stages.
test('calendar seed date counts and test-day weekdays match the source schedules', () => {
  const jalaliHelpers = extractBetween(ext.slice(ext.indexOf('function pad(')), 'function pad(', 'function shiftJalaliMonth(');
  const calendarFns = evalInContext(jalaliHelpers);
  const allKanoon = [
    ...datesIn(extractBetween(ext, 'const kanoonAutumn=[', 'const kanoonWinter=[')),
    ...datesIn(extractBetween(ext, 'const kanoonWinter=[', 'const kanoonSpring=[')),
    ...datesIn(extractBetween(ext, 'const kanoonSpring=[', "add('kanoon',kanoonAutumn)") )
  ];
  const maz = datesIn(extractBetween(ext, 'const mazStages=[', '// Dates and stage order'));
  const arman = [...extractBetween(ext, 'const armanDates=[', '];').matchAll(/'((?:1405|1406)-\d{2}-\d{2})'/g)].map(m => m[1]);
  assert.equal(allKanoon.length, 23);
  assert.ok(allKanoon.includes('1405-10-04'), 'Kanoon winter online exam is 4 Dey in the source PDF');
  assert.ok(!allKanoon.includes('1405-10-02'), 'Do not import the incorrect 2 Dey date');
  assert.equal(maz.length, 17);
  assert.equal(arman.length, 17);
  for (const date of maz) {
    const [y,m,d] = date.split('-').map(Number);
    const g = calendarFns.jalaliToGregorian(y,m,d);
    assert.equal(calendarFns.weekdayFromISO(`${g.y}-${String(g.m).padStart(2,'0')}-${String(g.d).padStart(2,'0')}`), 6, `${date} should be Friday`);
  }
  for (const date of arman) {
    const [y,m,d] = date.split('-').map(Number);
    const g = calendarFns.jalaliToGregorian(y,m,d);
    assert.equal(calendarFns.weekdayFromISO(`${g.y}-${String(g.m).padStart(2,'0')}-${String(g.d).padStart(2,'0')}`), 4, `${date} should be Wednesday`);
  }
});

// 4. Sync separation: local presentation settings are filtered out of the cloud snapshot.
test('cloud sync shares the two educational stores and strips per-device preference fields', () => {
  assert.match(sync, /var DATA_KEYS = \['pasokhBargDigitalV2', 'pasokhBargStudyOS_v2'\]/);
  assert.match(sync, /function stripDeviceLocalStudyFields/);
  for (const pref of ['selectedDate','plannerSubject','taskSubject','selectedGoal','sessionKind','alarmEnabled']) {
    assert.match(sync, new RegExp(`'${pref}'`));
  }
  assert.match(sync, /focusGoalModeV68/);
});

// 5. Timer and report rules are present in the implementation.
test('goal prompt pauses measured time for 10 seconds then auto-resumes', () => {
  assert.match(html, /goalPromptUntil=Date\.now\(\)\+10000/);
  assert.match(html, /if\(left<=0\)resumeAfterGoalPrompt\(\)/);
  assert.match(html, /function keepGoalPaused\(\)/);
  assert.match(html, /function finishStopwatch\(\)/);
});

test('multi-day PDF is one aggregate report; seven daily PDFs are selected separately', () => {
  assert.match(html, /\$\{r\.from!==r\.to\?dailySummary:''\}/);
  assert.match(html, /هفت گزارش روزانهٔ جداگانه/);
  assert.match(html, /selectedDays!==7/);
  assert.match(html, /openDailyPdfV93\(btn\.dataset\.pdfDay\)/);
});

test('question and key cards update in place for one answer or key change', () => {
  assert.match(html, /function refreshQuestionCardV93\(/);
  assert.match(html, /function refreshKeyCardV93\(/);
  const examAnswer = extractBetween(html, 'box.querySelectorAll(\'[data-a]\').forEach(btn=>btn.onclick=()=>{', 'box.querySelectorAll(\'[data-daily-mark]\')');
  assert.match(examAnswer, /refreshKeyCardV93\(questionNumber\)/);
  assert.doesNotMatch(examAnswer, /renderKey\(\)/);
  const keyAnswer = extractBetween(html, "grid.querySelectorAll('[data-key-q]')", "if(currentKeyQuestionNumberV70==null");
  assert.match(keyAnswer, /refreshKeyCardV93\(n\)/);
  assert.doesNotMatch(keyAnswer, /renderKey\(\)/);
});

test('external review questions are included in subject, source and chapter filters', () => {
  assert.match(html, /external:\$\{String\(x\.source\|\|'unknown'\)\}/);
  assert.match(html, /all\.forEach\(item=>\{if\(!subjectMap\.has/);
  assert.match(html, /all\.filter\(item=>selectedSubject==='all'/);
  assert.match(html, /all\.filter\(item=>\(reviewUIV53\.book==='all'/);
});

// 6. YouTube embed choices are concrete and controlled via documented IFrame API messaging.
test('music panel has verified long-form selections and a non-bypass fallback link', () => {
  for (const id of ['tRawQPTCxbQ','vGaZXoBnnyQ','hZp6yTZ7Gus','MCbv_RIBJqU']) assert.ok(ext.includes(id));
  assert.match(ext, /https:\/\/www\.youtube\.com\/@QuietQuest/);
  assert.match(ext, /youtube-nocookie\.com\/embed/);
  assert.match(ext, /func:'setVolume'/);
  assert.match(ext, /func:'pauseVideo'/);
});


test('account-data access is owner-consented, audited and summary scope returns counts only', () => {
  assert.match(adminFn, /if \(!grant\) return json\(\{ error: 'No active owner consent exists for this data' \}, 403\)/);
  assert.match(adminFn, /await audit\(admin, caller\.id, ownerId, caller\.id, 'view_shared'/);
  assert.match(adminFn, /if \(grant\.scope === 'summary'\) return json\(\{ summary: summarizePayload\(sync\.payload\)/);
  const summary = extractBetween(adminFn, 'function summarizePayload(payload: any)', '\n}');
  assert.match(summary, /summaryOnly: true/);
  assert.match(summary, /bookCount:/);
  assert.match(summary, /studySeconds:/);
  assert.doesNotMatch(summary, /email:|phone:|questionText:|studentName:/);
  assert.match(adminFn, /Only the configured primary admin can manage invitations and account roles/);
  assert.match(aiFn, /store: false/);
  assert.match(aiFn, /OPENAI_API_KEY/);
});

test('AI use requires a server-side guardian-approved account and separate file anonymization confirmation', () => {
  assert.match(aiFn, /STUDY_OS_AI_GUARDIAN_APPROVED_USER_IDS/);
  assert.match(aiFn, /guardianApprovedIds\.includes\(userId\)/);
  assert.match(aiFn, /body\.guardianApproval !== true/);
  assert.match(aiFn, /body\.fileIdentifiersRemoved !== true/);
  assert.match(ext, /v93AiGuardianConsent/);
  assert.match(ext, /v93AiIdentifiersRemoved/);
  assert.match(ext, /fileIdentifiersRemoved:identifiersRemoved/);
  assert.match(fs.readFileSync(path.join(ROOT, 'supabase/functions/.env.example'), 'utf8'), /STUDY_OS_AI_GUARDIAN_APPROVED_USER_IDS=/);
});

test('music preference always falls back to a real verified selection and presents checked durations', () => {
  assert.match(ext, /playlist:'quietLatest'/);
  assert.match(ext, /value="quietLatest">تازه‌ترین موسیقی تمرکز · ۳:۵۷:۵۲/);
  assert.match(ext, /value="quietNoVocals">تمرکز بدون آواز · ۳:۵۴:۱۲/);
  assert.match(ext, /value="quietThinking">موسیقی Ambient برای تفکر · ۳:۵۳:۳۶/);
});

test('daily PDF includes sessions, plans, tasks and subject-wise test breakdown', () => {
  const dailyPdf = extractBetween(html, 'function openDailyPdfV93(day){', 'function fullBackup(){');
  assert.match(dailyPdf, /جزئیات آزمون‌ها به تفکیک درس/);
  assert.match(dailyPdf, /جلسه‌های ثبت‌شده/);
  assert.match(dailyPdf, /برنامهٔ روز/);
  assert.match(dailyPdf, /چک‌لیست کارها/);
  assert.match(dailyPdf, /display:table-header-group/);
});


test('AI prompt requires source-grounded topic-level analysis and suppresses personal identifiers', () => {
  assert.match(aiFn, /تحلیل تک‌تک مبحث‌ها\/فصل‌ها/);
  assert.match(aiFn, /هیچ مقداری نساز/);
  assert.match(aiFn, /اطلاعات هویتی، نام، شماره تماس، شناسه، بارکد/);
});

test('primary admin profile initialization fails closed when its database write fails', () => {
  assert.match(aiFn, /primaryProfileWriteError/);
  assert.match(aiFn, /if \(primaryProfileWriteError\) return json\(\{ error: 'Primary admin profile could not be initialized' \}, 503\)/);
  assert.match(adminFn, /if \(primaryProfileWriteError\) return json\(\{ error: 'Primary admin profile could not be initialized' \}, 503\)/);
});

test('all inline scripts parse and required local assets are included', () => {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/(?:src\s*=)/i.test(m[1]) && m[2].trim());
  assert.equal(blocks.length, 17);
  blocks.forEach((m, i) => new vm.Script(m[2], { filename: `inline-${i + 1}.js` }));
  const assets = ['cloud-sync.js', 'study-os-v93.css', 'study-os-v93.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'study-os-mark.svg'];
  for (const name of assets) assert.ok(fs.existsSync(path.join(ROOT, name)), `Missing asset ${name}`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8')));
});

test('v93 migration is additive and does not rewrite the existing cloud snapshot table', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/202611270001_study_os_ai_and_access.sql'), 'utf8');
  assert.match(migration, /create table if not exists public\.study_os_user_profiles/);
  assert.match(migration, /create table if not exists public\.study_os_access_grants/);
  assert.match(migration, /create table if not exists public\.study_os_access_audit/);
  assert.match(migration, /create table if not exists public\.study_os_ai_usage_daily/);
  assert.doesNotMatch(migration, /alter table public\.study_os_sync|drop table public\.study_os_sync|truncate table public\.study_os_sync/i);
  assert.match(migration, /revoke all on public\.study_os_ai_usage_daily from anon, authenticated/);
  assert.match(migration, /grant execute on function public\.study_os_consume_ai_quota\(uuid, integer\) to service_role/);
});

test('local-only appearance, device layout and media preferences are not added to the cloud allowlist', () => {
  const keys = sync.match(/var DATA_KEYS = \[([^\]]+)\]/)?.[1] || '';
  assert.match(keys, /pasokhBargDigitalV2/);
  assert.match(keys, /pasokhBargStudyOS_v2/);
  for (const localKey of ['pasokhBargTheme', 'pasokhBargSidebarCollapsed', 'pasokhBargAmbientMotion_v1', 'studyOSV93DevicePrefs']) {
    assert.doesNotMatch(keys, new RegExp(localKey));
  }
});
