/* Study OS v93 extension. All academic records remain in the existing shared study blob.
   Device media preferences and this AI chat history remain local to this browser. */
(()=>{
'use strict';
const API=window.StudyOSV93;
if(!API){console.error('Study OS v93 bridge not found; extension is disabled.');return;}
const $=id=>document.getElementById(id);
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fa=n=>API.fa(n);
const STORAGE_KEY='pasokhBargStudyOS_v2';
const DEVICE_PREF_KEY='studyOSDevicePrefsV93';
const AI_HISTORY_KEY='studyOS_AI_CHAT_DEVICE_V93';
const LOCAL_REMINDER_KEY='studyOSCalendarReminderLedgerV93';
const weekdays=['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه'];
const months=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
const SOURCE_META={
  kanoon:{label:'کانون قلم‌چی',desc:'برنامهٔ راهبردی پایهٔ یازدهم تجربی ۱۴۰۵–۱۴۰۶'},
  maz:{label:'ماز',desc:'برنامهٔ آزمون‌های یازدهم تجربی ۱۴۰۵–۱۴۰۶'},
  arman:{label:'آرمان',desc:'برنامهٔ آزمون آزمایشی آرمان، پایهٔ یازدهم'}
};
let mediaPrefs=readPrefs();let aiHistory=readAIHistory();let selectedCalendarMonth=null;let selectedCalendarDay=null;let activeAiFile=null;let aiBusy=false;let reminderTimer=null;let externalRefreshGuard=false;
function readPrefs(){try{return {...{musicVolume:35,alertVolume:.085,alertTone:'bright',playlist:'quietLatest',customPlaylist:''},...(JSON.parse(localStorage.getItem(DEVICE_PREF_KEY)||'{}')||{})}}catch{return {musicVolume:35,alertVolume:.085,alertTone:'bright',playlist:'quietLatest',customPlaylist:''}}}
function savePrefs(){try{localStorage.setItem(DEVICE_PREF_KEY,JSON.stringify(mediaPrefs))}catch(e){console.warn('Device preferences not saved',e)}}
function readAIHistory(){try{const x=JSON.parse(localStorage.getItem(AI_HISTORY_KEY)||'[]');return Array.isArray(x)?x.slice(-80):[]}catch{return []}}
function saveAIHistory(){try{localStorage.setItem(AI_HISTORY_KEY,JSON.stringify(aiHistory.slice(-80)))}catch(e){console.warn('AI history not saved',e)}}
function state(){return API.data;}
function persist(){API.save();try{document.dispatchEvent(new CustomEvent('study-os-external-tests-updated',{detail:{date:new Date().toISOString().slice(0,10)}}))}catch{}}
function pad(n){return String(n).padStart(2,'0')}
function parseJ(s){const m=String(s||'').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);return m?{y:+m[1],m:+m[2],d:+m[3]}:null}
// Jalali-to-Gregorian conversion calibrated from the browser's Persian calendar.
// This avoids the approximate 33-year cycle error around Nowruz.
const _yearStartCache=new Map();
function jalaliYearStart(jy){
 jy=Number(jy);if(_yearStartCache.has(jy))return _yearStartCache.get(jy);
 const fmt=new Intl.DateTimeFormat('en-u-ca-persian',{year:'numeric',month:'numeric',day:'numeric',timeZone:'UTC'});
 for(let day=19;day<=22;day++){
  const candidate=new Date(Date.UTC(jy+621,2,day,12));
  const p={};fmt.formatToParts(candidate).forEach(x=>{if(['year','month','day'].includes(x.type))p[x.type]=Number(x.value)});
  if(p.year===jy&&p.month===1&&p.day===1){const stamp=Math.floor(Date.UTC(jy+621,2,day)/86400000);_yearStartCache.set(jy,stamp);return stamp;}
 }
 throw new Error('Could not locate Persian new year '+jy);
}
function jalaliToGregorian(jy,jm,jd){
 jy=Number(jy);jm=Number(jm);jd=Number(jd);
 if(!Number.isInteger(jy)||!Number.isInteger(jm)||!Number.isInteger(jd)||jm<1||jm>12||jd<1||jd>daysInJalaliMonth(jy,jm))throw new RangeError('Invalid Jalali date');
 const offset=(jm<=6?(jm-1)*31:(jm-7)*30+186)+(jd-1);
 const date=new Date((jalaliYearStart(jy)+offset)*86400000);
 return {y:date.getUTCFullYear(),m:date.getUTCMonth()+1,d:date.getUTCDate()};
}
function gDate(y,m,d){return new Date(y,m-1,d,12,0,0)}
function jalaliParts(date){
 try{const parts=new Intl.DateTimeFormat('en-u-ca-persian',{year:'numeric',month:'numeric',day:'numeric'}).formatToParts(date);const v={};parts.forEach(p=>{if(['year','month','day'].includes(p.type))v[p.type]=Number(p.value)});if(v.year&&v.month&&v.day)return {y:v.year,m:v.month,d:v.day}}catch{}
 return {y:1405,m:9,d:6};
}
function jalaliKey(j){return `${j.y}-${pad(j.m)}-${pad(j.d)}`}
function dateIsoFromJalali(value){const j=typeof value==='string'?parseJ(value):value;if(!j)return '';const g=jalaliToGregorian(j.y,j.m,j.d);return `${g.y}-${pad(g.m)}-${pad(g.d)}`}
function weekdayFromISO(iso){const [y,m,d]=iso.split('-').map(Number);return (gDate(y,m,d).getDay()+1)%7}
function formatJalali(value){const j=typeof value==='string'?parseJ(value):value;return j?`${fa(j.d)} ${months[j.m-1]} ${fa(j.y)}`:''}
function daysInJalaliMonth(y,m){if(m<1||m>12)return 0;if(m<=6)return 31;if(m<=11)return 30;return jalaliYearStart(y+1)-jalaliYearStart(y)-336}
function shiftJalaliMonth(y,m,delta){let z=y*12+(m-1)+delta;return {y:Math.floor(z/12),m:(z%12+12)%12+1}}
function addJDays(y,m,d,days){let iso=dateIsoFromJalali({y,m,d});const [gy,gm,gd]=iso.split('-').map(Number);const dt=gDate(gy,gm,gd);dt.setDate(dt.getDate()+days);return jalaliParts(dt)}
function initData(){const d=state();let changed=false;for(const key of ['externalTests','externalReviewItems','calendarEvents','recurringClasses'])if(!Array.isArray(d[key])){d[key]=[];changed=true}if(!d.legacy||typeof d.legacy!=='object'){d.legacy={};changed=true}if(seedCalendar(d))changed=true;if(changed)persist();}
function seedCalendar(d){
 const seedVersion=4;
 if(Number(d.legacy.v93CalendarSeededVersion||0)>=seedVersion)return false;
 // Never delete or overwrite existing events. Add missing seed rows only.
 const events=[];
 const add=(source,records,kind='exam')=>records.forEach((v,i)=>{
  const j=parseJ(v.date);if(!j)return;
  events.push({id:`v93-${source}-${j.y}${pad(j.m)}${pad(j.d)}-${i}`,source,kind:v.kind||kind,title:v.title||`${SOURCE_META[source].label} · ${kind==='review'?'مرور':'آزمون'}`,jalaliDate:jalaliKey(j),date:dateIsoFromJalali(j),reminderDays:1,note:v.note||'',budget:v.budget||'',createdBy:'seed-v93'});
 });
 const kanoonAutumn=[
  ['1405-07-03','زیست: تنظیم عصبی؛ فیزیک: الکتریسیتهٔ ساکن؛ شیمی: قدر هدایای زمینی را بدانیم؛ ریاضی: هندسهٔ تحلیلی و جبر؛ زمین‌شناسی: آفرینش کیهان و تکوین زمین.'],
  ['1405-07-10','بودجهٔ دقیق هر درس در جدول پاییز فایل کانون، ستون ۱۰ مهر آمده است.'],
  ['1405-07-17','بودجهٔ دقیق هر درس در جدول پاییز فایل کانون، ستون ۱۷ مهر آمده است.'],
  ['1405-08-01','بودجهٔ دقیق هر درس در جدول پاییز فایل کانون، ستون ۱ آبان آمده است.'],
  ['1405-08-15','بودجهٔ دقیق هر درس در جدول پاییز فایل کانون، ستون ۱۵ آبان آمده است.'],
  ['1405-08-29','بودجهٔ دقیق هر درس در جدول پاییز فایل کانون، ستون ۲۹ آبان آمده است.'],
  ['1405-09-13','آزمون آنلاین؛ بودجهٔ هر درس در ستون ۱۳ آذر جدول پاییز کانون.'],
  ['1405-09-27','مشابه آزمون ۲۷ شهریور، طبق عنوان ستون در جدول کانون.']
 ].map(([date,note])=>({date,note}));
 const kanoonWinter=[
  ['1405-10-04','آزمون آنلاین؛ بودجه مطابق ستون ۴ دی در جدول زمستان کانون.'],
  ['1405-10-11','آزمون آنلاین؛ بودجه مطابق ستون ۱۱ دی در جدول زمستان کانون.'],
  ['1405-10-25','آزمون آنلاین؛ بودجه مطابق ستون ۲۵ دی در جدول زمستان کانون.'],
  ['1405-11-09','بودجه مطابق ستون ۹ بهمن در جدول زمستان کانون.'],
  ['1405-11-23','بودجه مطابق ستون ۲۳ بهمن در جدول زمستان کانون.'],
  ['1405-12-07','بودجه مطابق ستون ۷ اسفند در جدول زمستان کانون.'],
  ['1405-12-21','بودجه مطابق ستون ۲۱ اسفند در جدول زمستان کانون.'],
  ['1406-01-07','آزمون کانون؛ ستون ۷ فروردین در جدول زمستان برنامه؛ مشابه آزمون ۹ بهمن.']
 ].map(([date,note])=>({date,note}));
 const kanoonSpring=[
  {date:'1406-01-20',note:'بهار: زیست‌شناسی شامل تقسیم یاخته و تولیدمثل؛ فیزیک شامل جریان الکتریکی و مدارهای جریان مستقیم؛ شیمی «در پی غذای سالم»؛ ریاضی مثلثات و توابع نمایی و لگاریتمی؛ زمین‌شناسی پویایی زمین و مباحث پیشین.'},
  {date:'1406-02-03',note:'بهار: بودجه‌بندی موضوعی هر پنج درس طبق ستون ۳ اردیبهشت جدول صفحهٔ دوم کانون؛ از جمله تولیدمثل نهاندانگان، مغناطیس و القای الکترومغناطیسی و مباحث نیمسال دوم.'},
  {date:'1406-02-17',note:'بهار: بودجه‌بندی موضوعی هر پنج درس طبق ستون ۱۷ اردیبهشت جدول صفحهٔ دوم کانون.'},
  {date:'1406-02-24',note:'بهار: بودجه‌بندی موضوعی هر پنج درس طبق ستون ۲۴ اردیبهشت جدول صفحهٔ دوم کانون.'},
  {date:'1406-02-31',title:'آزمون آنلاین کانون',note:'آزمون آنلاین؛ بودجه طبق ستون ۳۱ اردیبهشت جدول صفحهٔ دوم کانون.'},
  {date:'1406-03-07',title:'آزمون آنلاین کانون',note:'آزمون آنلاین؛ بودجه طبق ستون ۷ خرداد جدول صفحهٔ دوم کانون.'},
  {date:'1406-03-14',title:'آزمون آنلاین کانون',note:'آزمون آنلاین؛ بودجه طبق ستون ۱۴ خرداد جدول صفحهٔ دوم کانون.'}
 ];
 add('kanoon',kanoonAutumn);add('kanoon',kanoonWinter);add('kanoon',kanoonSpring);
 const mazStages=[
  {date:'1405-07-17',budget:'زیست: تنظیم عصبی؛ فیزیک: الکتریسیتهٔ ساکن؛ شیمی: قدر هدایای زمینی را بدانیم؛ ریاضی: هندسهٔ تحلیلی و جبر؛ زمین‌شناسی: آفرینش کیهان و تکوین زمین.'},
  {date:'1405-08-01',budget:'زیست: تنظیم عصبی؛ فیزیک: الکتریسیتهٔ ساکن تا ابتدای فرایند میدان‌های الکتریکی؛ شیمی: قدر هدایای زمینی را بدانیم؛ ریاضی: هندسهٔ تحلیلی و جبر؛ زمین‌شناسی: آفرینش کیهان و تکوین زمین.'},
  {date:'1405-08-15',budget:'زیست: تنظیم عصبی و حواس؛ فیزیک: الکتریسیتهٔ ساکن تا ابتدای پتانسیل الکتریکی؛ شیمی: قدر هدایای زمینی را بدانیم؛ ریاضی: هندسهٔ تحلیلی و جبر و هندسه؛ زمین‌شناسی: آفرینش کیهان و تکوین زمین و منابع معدنی.'},
  {date:'1405-08-29',budget:'زیست: حواس؛ فیزیک: الکتریسیتهٔ ساکن تا ابتدای خازن؛ شیمی: قدر هدایای زمینی را بدانیم؛ ریاضی: هندسه و تابع؛ زمین‌شناسی: منابع معدنی و ذخایر انرژی.'},
  {date:'1405-09-13',budget:'زیست: تنظیم عصبی، حواس و دستگاه حرکتی؛ فیزیک: الکتریسیتهٔ ساکن و جریان الکتریکی؛ شیمی: قدر هدایای زمینی را بدانیم؛ ریاضی: هندسهٔ تحلیلی و جبر و هندسه؛ زمین‌شناسی: آفرینش کیهان، منابع معدنی و آب و خاک.'},
  {date:'1405-09-27',budget:'زیست: دستگاه حرکتی و تنظیم شیمیایی؛ فیزیک: الکتریسیتهٔ ساکن و مدارهای جریان مستقیم؛ شیمی: در پی غذای سالم؛ ریاضی: هندسه و تابع؛ زمین‌شناسی: منابع آب و خاک.'},
  {date:'1405-10-25',title:'ماز · مرحلهٔ ۷ و جمع‌بندی نیمسال اول',note:'جمع‌بندی نیمسال اول پس از میان‌ترم طبق صفحهٔ ۳ برنامه؛ ریزبودجهٔ دروس مطابق جدول مرحلهٔ پایانی نیمسال اول.',budget:'زیست: دستگاه حرکتی، تنظیم شیمیایی و ایمنی؛ فیزیک: جریان الکتریکی و مدارهای جریان مستقیم؛ شیمی: در پی غذای سالم؛ ریاضی: هندسه و تابع؛ زمین‌شناسی: منابع آب و خاک.'},
  {date:'1405-11-09',title:'ماز · مرحلهٔ ۸ و جمع‌بندی کامل نیمسال اول',note:'جمع‌بندی کامل نیمسال اول طبق صفحهٔ ۳ برنامه.',budget:'زیست: ایمنی و تقسیم یاخته؛ فیزیک: جریان الکتریکی و مدارهای جریان مستقیم؛ شیمی: در پی غذای سالم؛ ریاضی: تابع و مثلثات؛ زمین‌شناسی: پویایی زمین.'},
  {date:'1405-11-23',budget:'زیست: تقسیم یاخته و تولیدمثل؛ فیزیک: جریان الکتریکی، مدارهای جریان مستقیم، مغناطیس و القای الکترومغناطیسی؛ شیمی: در پی غذای سالم و قانون هس؛ ریاضی: مثلثات؛ زمین‌شناسی: پویایی زمین.'},
  {date:'1405-12-07',budget:'زیست: تقسیم یاخته و تولیدمثل؛ فیزیک: مدارهای جریان مستقیم و مغناطیس؛ شیمی: در پی غذای سالم؛ ریاضی: مثلثات و توابع نمایی و لگاریتمی؛ زمین‌شناسی: پویایی زمین و زمین‌شناسی و سلامت.'},
  {date:'1405-12-21',budget:'زیست: تقسیم یاخته و تولیدمثل؛ فیزیک: مغناطیس و القای الکترومغناطیسی؛ شیمی: در پی غذای سالم؛ ریاضی: مثلثات و توابع؛ زمین‌شناسی: پویایی زمین.'},
  {date:'1406-01-06',kind:'review',title:'ماز · مرحلهٔ ۱۲ و جمع‌بندی کامل نیمسال اول',note:'ایستگاه جمع‌بندی و مرور نیمسال اول در جدول صفحهٔ ۵ برنامهٔ ماز؛ این روز به‌عنوان مرحلهٔ مرور ثبت شده است.',budget:'جمع‌بندی مباحث نیمسال اول هر پنج درس؛ برای جزئیات هر درس به ستون ۶ فروردین در صفحهٔ ۵ برنامهٔ ماز مراجعه شود.'},
  {date:'1406-01-20',title:'ماز · مرحلهٔ ۱۳ و جمع‌بندی میان‌ترم نیمسال دوم',note:'جمع‌بندی و مرور میان‌ترم نیمسال دوم طبق صفحهٔ ۳ برنامه.',budget:'زیست: تقسیم یاخته و تولیدمثل؛ فیزیک: جریان الکتریکی، مدارهای جریان مستقیم، مغناطیس و القای الکترومغناطیسی؛ شیمی: در پی غذای سالم و پوشاک، نیازی پایان‌ناپذیر؛ ریاضی: حد و پیوستگی و آمار و احتمال؛ زمین‌شناسی: پویایی زمین.'},
  {date:'1406-02-03',budget:'زیست: تولیدمثل نهاندانگان و پاسخ گیاهان به محرک‌ها؛ فیزیک: مغناطیس و القای الکترومغناطیسی؛ شیمی: پوشاک، نیازی پایان‌ناپذیر؛ ریاضی: حد و پیوستگی و آمار و احتمال؛ زمین‌شناسی: زمین‌شناسی و سازه‌های مهندسی.'},
  {date:'1406-02-17',budget:'زیست: تولیدمثل نهاندانگان و پاسخ گیاهان به محرک‌ها؛ فیزیک: مغناطیس و القای الکترومغناطیسی؛ شیمی: پوشاک، نیازی پایان‌ناپذیر؛ ریاضی: حد و پیوستگی؛ زمین‌شناسی: زمین‌شناسی ایران.'},
  {date:'1406-02-24',title:'ماز · مرحلهٔ ۱۶ و جمع‌بندی نیمسال دوم',note:'جمع‌بندی و مرور نیمسال دوم پس از میان‌ترم طبق صفحهٔ ۳ برنامه.',budget:'زیست: تولیدمثل نهاندانگان و پاسخ گیاهان به محرک‌ها؛ فیزیک: مغناطیس و القای الکترومغناطیسی؛ شیمی: پوشاک، نیازی پایان‌ناپذیر؛ ریاضی: حد و پیوستگی و آمار و احتمال؛ زمین‌شناسی: زمین‌شناسی ایران و سازه‌های مهندسی.'},
  {date:'1406-03-28',title:'ماز · مرحلهٔ پایانی و تسلط کل سال یازدهم',note:'جمع‌بندی و تسلط کامل بر کتاب‌های پایهٔ یازدهم طبق صفحهٔ ۳ برنامه.',budget:'بودجهٔ پایانی: کل کتاب‌های زیست‌شناسی ۲، فیزیک ۲، شیمی ۲، ریاضی ۲ و زمین‌شناسی.'}
 ];
 // Dates and stage order are transcribed from pages 4–5. 6 Farvardin is the stage-12 review checkpoint.
 mazStages.forEach((x,i)=>{if(!x.title)x.title=`ماز · مرحلهٔ ${fa(i+1)}`;x.note=(x.note?x.note+' ':'')+'طبق راهنمای برنامه: آزمون آنلاین جمعه، بازهٔ شرکت ۰۸:۰۰ تا ۱۵:۰۰ و مهلت ورود تا ۱۳:۰۰؛ پاسخنامه از ۱۵:۰۰ و کارنامه از ۱۸:۰۰.';});
 add('maz',mazStages);
 const armanDates=['1405-07-15','1405-07-29','1405-08-13','1405-08-27','1405-09-11','1405-09-25','1405-10-23','1405-11-07','1405-11-21','1405-12-05','1405-12-19','1406-01-04','1406-01-18','1406-02-01','1406-02-15','1406-02-22','1406-03-26'];
 const armanReviewNotes={
  '1405-10-23':'ایستگاه جمع‌بندی نیمسال اول پس از میان‌ترم (صفحهٔ ۳ برنامه).',
  '1405-11-07':'ایستگاه جمع‌بندی کامل نیمسال اول (صفحهٔ ۳ برنامه).',
  '1406-01-04':'ایستگاه مرور کامل نیمسال اول (صفحهٔ ۳ برنامه).',
  '1406-01-18':'ایستگاه مرور میان‌ترم نیمسال دوم (صفحهٔ ۳ برنامه).',
  '1406-02-22':'ایستگاه جمع‌بندی نیمسال دوم پس از میان‌ترم (صفحهٔ ۳ برنامه).',
  '1406-03-26':'ایستگاه تسلط بر زیست‌شناسی یازدهم (صفحهٔ ۳ برنامه).'
 };
 const armanBudgets=['تنظیم عصبی؛ تا پایان حفاظت از مغز و نخاع.','تنظیم عصبی.','تنظیم عصبی و حواس؛ تا ابتدای شنوایی و تعادل.','حواس.','تنظیم عصبی، حواس و دستگاه حرکتی.','دستگاه حرکتی و تنظیم شیمیایی.','دستگاه حرکتی، تنظیم شیمیایی و ایمنی.','فصل‌های ۱ تا ۵.','ایمنی و تقسیم یاخته.','تقسیم یاخته.','تقسیم یاخته و تولیدمثل.','فصل‌های ۱ تا ۵؛ مرور و جمع‌بندی نیمسال اول.','تقسیم یاخته و تولیدمثل.','تولیدمثل نهاندانگان و پاسخ گیاهان به محرک‌ها.','تولیدمثل نهاندانگان و پاسخ گیاهان به محرک‌ها.','تولیدمثل نهاندانگان و پاسخ گیاهان به محرک‌ها.','کل کتاب زیست‌شناسی ۲.'];
 armanDates.forEach((date,i)=>{
  const j=parseJ(date),end=addJDays(j.y,j.m,j.d,1);
  const note='طبق صفحهٔ ۸ برنامهٔ آرمان: ورود به آزمون از چهارشنبه ساعت ۸ تا پنجشنبه ساعت ۱۴:۵۹؛ پاسخنامه و کارنامه از پنجشنبه ساعت ۱۶ در دسترس است.'+(armanReviewNotes[date]?` ${armanReviewNotes[date]}`:'');
  events.push({id:`v93-arman-${i+1}`,source:'arman',kind:'exam-window',createdBy:'seed-v93',title:`آزمون زیست‌شناسی آرمان · مرحلهٔ ${fa(i+1)}`,jalaliDate:date,date:dateIsoFromJalali(j),endJalali:jalaliKey(end),endDate:dateIsoFromJalali(end),windowStart:'چهارشنبه ۰۸:۰۰',windowEnd:'پنجشنبه ۱۴:۵۹',answerKeyAt:'پنجشنبه ۱۶:۰۰',reportAt:'پنجشنبه ۱۶:۰۰',reminderDays:1,note,budget:armanBudgets[i]+' (عنوان‌های جدول برنامهٔ آرمان؛ شماره‌صفحه‌ها در نسخهٔ خوانای فایل ارسالی به‌طور قابل اعتماد قابل استخراج نبود.)'});
 });
 const existingIds=new Set((d.calendarEvents||[]).map(x=>x.id));
 const existingKeys=new Set((d.calendarEvents||[]).filter(x=>x.createdBy==='seed-v93'||String(x.id||'').startsWith('v93-')).map(x=>`${x.source}|${x.date}|${x.kind}`));
 for(const ev of events){const key=`${ev.source}|${ev.date}|${ev.kind}`;if(!existingIds.has(ev.id)&&!existingKeys.has(key)){d.calendarEvents.push(ev);existingIds.add(ev.id);existingKeys.add(key);}}
 d.legacy.v93CalendarSeeded=true;d.legacy.v93CalendarSeededVersion=seedVersion;
 d.legacy.v93CalendarSourceNote='تاریخ‌ها و بودجه‌ها از برنامه‌های کاربر استخراج شده‌اند. برنامهٔ کانون: فایل دوصفحه‌ای پایه یازدهم تجربی ۱۴۰۵–۱۴۰۶؛ ماز: برنامه ۱۷ مرحله‌ای سال ۱۴۰۵–۱۴۰۶؛ آرمان: ۱۷ مرحلهٔ زیست‌شناسی و ایستگاه‌های مرور صفحهٔ ۳. مواردی که فایل بودجهٔ دقیق نداده با صراحت علامت‌گذاری شده‌اند.';
 return true;
}
function mountNav(){
 const nav=$('sTabs');if(!nav)return;
 const rows=[['calendar','تقویم','M4 5h16v15H4zM8 3v4M16 3v4M4 10h16'],['manual','ثبت آزمون','M5 3h14v18H5zM8 8h8M8 12h8M8 16h5'],['assistant','هوش مصنوعی','M12 3a8 8 0 0 0-8 8v2a3 3 0 0 0 3 3h1v-5H7a5 5 0 0 1 10 0h-1v5h1a3 3 0 0 0 3-3v-2a8 8 0 0 0-8-8zM9 20h6'],['admin','مدیریت','M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6zM9 12l2 2 4-4']];
 const bottom=nav.querySelector('.rail-bottom');
 rows.forEach(([id,label,path])=>{if(nav.querySelector(`[data-tab="${id}"]`))return;const b=document.createElement('button');b.type='button';b.dataset.tab=id;b.dataset.tip=label;b.title=label;b.setAttribute('aria-label',label);b.innerHTML=`<svg aria-hidden="true" class="rail-svg" viewBox="0 0 24 24"><path d="${path}"/></svg><span class="rail-label">${label}</span>`;b.addEventListener('click',()=>API.setTab(id));nav.insertBefore(b,bottom);});
 document.querySelectorAll('#sTabs [data-tab]').forEach(b=>{if(['calendar','manual','assistant','admin'].includes(b.dataset.tab))b.onclick=()=>API.setTab(b.dataset.tab)});
}
function moveSidebarClose(){const btn=$('collapseSidebar'),label=document.querySelector('label[for="subjectFilter"]');if(!btn||!label||btn.dataset.v93Moved)return;btn.textContent='×';btn.title='بستن پنل';btn.setAttribute('aria-label','بستن پنل');btn.classList.add('v93-inline-close');label.classList.add('v93-subject-label-row');label.appendChild(btn);btn.dataset.v93Moved='1';}
function bindExternalTestsCount(){
 // The classic answer-sheet daily counter reads the shared Study OS object; trigger a repaint where possible.
 const refresh=()=>{try{document.dispatchEvent(new CustomEvent('study-os-external-tests-updated',{detail:{date:new Date().toISOString().slice(0,10)}}))}catch{}};
 window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY)refresh()});
}
function appendStyles(){if($('studyOsV93Style'))return;const l=document.createElement('link');l.id='studyOsV93Style';l.rel='stylesheet';l.href='./study-os-v93.css?v=93';document.head.appendChild(l);}
function renderTab(tab){if(tab==='calendar')renderCalendar();else if(tab==='manual')renderManual();else if(tab==='assistant')renderAssistant();else if(tab==='admin')renderAdmin();}
function monthEvents(y,m){return state().calendarEvents.filter(e=>{const j=parseJ(e.jalaliDate);return j&&j.y===y&&j.m===m});}
function classForDay(iso){const day=weekdayFromISO(iso);return state().recurringClasses.filter(c=>c.active!==false&&Number(c.weekday)===day)}
function eventDateForCalendar(event){const j=parseJ(event.jalaliDate||'');return j?formatJalali(j):event.date||''}
function renderCalendar(){
 const d=state();const cur=selectedCalendarMonth||jalaliParts(new Date());selectedCalendarMonth=cur;
 const count=daysInJalaliMonth(cur.y,cur.m),firstISO=dateIsoFromJalali({y:cur.y,m:cur.m,d:1}),offset=weekdayFromISO(firstISO),cells=[];
 for(let i=0;i<offset;i++)cells.push('<div class="v93-cal-empty"></div>');
 for(let day=1;day<=count;day++){
  const j={y:cur.y,m:cur.m,d:day},iso=dateIsoFromJalali(j),evs=(d.calendarEvents||[]).filter(e=>e.jalaliDate===jalaliKey(j)),classes=classForDay(iso),selected=selectedCalendarDay===jalaliKey(j),todayKey=jalaliKey(jalaliParts(new Date()));
  const types=[...new Set([...evs.map(e=>e.source),...(classes.length?['class']:[])])];
  cells.push(`<button type="button" class="v93-cal-day ${selected?'selected':''} ${todayKey===jalaliKey(j)?'today':''}" data-calendar-day="${jalaliKey(j)}"><b>${fa(day)}</b><span>${types.map(t=>`<i class="v93-dot v93-dot-${safe(t)}"></i>`).join('')}</span></button>`);
 }
 const key=selectedCalendarDay||`${cur.y}-${pad(cur.m)}-01`,sel=parseJ(key)||{y:cur.y,m:cur.m,d:1};
 const iso=dateIsoFromJalali(sel),events=(d.calendarEvents||[]).filter(e=>e.jalaliDate===jalaliKey(sel)).sort((a,b)=>String(a.source).localeCompare(String(b.source)));
 const classes=classForDay(iso);
 const renderEvent=e=>`<article class="v93-cal-event"><div class="v93-cal-event-top"><div><span class="v93-source v93-source-${safe(e.source)}">${safe(SOURCE_META[e.source]?.label||'شخصی')}</span><h4>${safe(e.title)}</h4><small>${eventDateForCalendar(e)}${e.endJalali?` تا ${safe(formatJalali(e.endJalali))}`:''}</small></div><button class="v93-icon-action" type="button" data-calendar-delete="${safe(e.id)}" title="حذف رویداد">×</button></div>${e.windowStart?`<p>پنجرهٔ آزمون: ${safe(e.windowStart)} تا ${safe(e.windowEnd)} · پاسخنامه/کارنامه: ${safe(e.answerKeyAt)}</p>`:''}${e.note?`<p>${safe(e.note)}</p>`:''}${e.budget?`<details><summary>بودجه‌بندی / توضیحات</summary><p>${safe(e.budget)}</p></details>`:''}<div class="v93-cal-event-foot"><span>یادآوری: ${e.reminderDays===0?'همان روز':`${fa(e.reminderDays||1)} روز قبل`}</span><span>${e.kind==='review'?'جمع‌بندی و مرور':e.kind==='exam-window'?'پنجرهٔ آزمون':'آزمون'}</span></div></article>`;
 panelCalendar.innerHTML=`<div class="page-head"><div><span class="eyebrow">CALENDAR & EXAMS</span><h2>تقویم آزمون‌ها و کلاس‌ها</h2><p>تقویم شمسی · برنامه‌های کانون، ماز و آرمان به‌علاوهٔ کلاس‌های هفتگی</p></div><div class="quick-row"><button class="os-btn subtle" id="v93ReminderPermission">فعال‌سازی یادآوری</button><button class="os-btn primary" id="v93AddEvent">＋ رویداد شخصی</button></div></div>
 <section class="os-card v93-calendar-card"><div class="v93-month-head"><button class="os-btn subtle" id="v93PrevMonth">ماه قبل</button><strong>${months[cur.m-1]} ${fa(cur.y)}</strong><button class="os-btn subtle" id="v93NextMonth">ماه بعد</button></div><div class="v93-calendar-grid v93-calendar-weekdays">${weekdays.map(x=>`<b>${x}</b>`).join('')}</div><div class="v93-calendar-grid">${cells.join('')}</div><div class="v93-calendar-legend"><span><i class="v93-dot v93-dot-kanoon"></i>کانون</span><span><i class="v93-dot v93-dot-maz"></i>ماز</span><span><i class="v93-dot v93-dot-arman"></i>آرمان</span><span><i class="v93-dot v93-dot-class"></i>کلاس</span><span><i class="v93-dot v93-dot-custom"></i>شخصی</span></div></section>
 <div class="v93-calendar-lower"><section class="os-card"><div class="section-head"><h3>${formatJalali(sel)} · رویدادها</h3><small>${fa(events.length+classes.length)} مورد</small></div>${events.length?events.map(renderEvent).join(''):'<div class="empty-state">برای این روز رویدادی ثبت نشده.</div>'}${classes.map(c=>`<article class="v93-cal-class" style="border-inline-start:4px solid ${safe(c.color||'#58b98e')}"><b>${safe(c.title)}</b><span>${safe(c.time||'بدون ساعت')} · ${safe(c.subject||'کلاس')}</span><button type="button" class="v93-icon-action" data-class-delete="${safe(c.id)}">×</button></article>`).join('')}</section><section class="os-card"><div class="section-head"><h3>کلاس هفتگی</h3><small>در همهٔ دستگاه‌ها همگام می‌شود</small></div><div class="v93-form-grid"><label>نام کلاس<input id="v93ClassTitle" placeholder="مثلاً کلاس زیست"></label><label>درس / توضیح<input id="v93ClassSubject" placeholder="مثلاً زیست‌شناسی"></label><label>روز هفته<select id="v93ClassDay">${weekdays.map((x,i)=>`<option value="${i}">${x}</option>`).join('')}</select></label><label>ساعت (اختیاری)<input id="v93ClassTime" type="time"></label><label>رنگ<select id="v93ClassColor"><option value="#79b9ef">آبی</option><option value="#75cfa7">سبز</option><option value="#b2a0ed">بنفش</option><option value="#e7b46e">کهربایی</option><option value="#de8db4">صورتی</option></select></label><button class="os-btn primary" id="v93ClassSave">افزودن کلاس هفتگی</button></div><div class="v93-muted-note">یادآوری‌ها در زمان فعال بودن سایت بررسی می‌شوند. اعلان پس‌زمینه هنگام بسته‌بودن کامل مرورگر بدون راه‌اندازی سرویس اعلان سروری تضمین نمی‌شود.</div></section></div>
 <section class="os-card v93-calendar-custom"><div class="section-head"><h3>افزودن رویداد دلخواه</h3><small>برای آزمون‌های مدرسه، کلاس جبرانی یا موعد شخصی</small></div><div class="v93-form-grid"><label>عنوان<input id="v93EventTitle" placeholder="عنوان رویداد"></label><label>تاریخ<input id="v93EventDate" type="date" value="${iso}"></label><label>منبع / دسته<input id="v93EventSource" placeholder="مدرسه، کلاس، شخصی"></label><label>یادآوری<select id="v93EventReminder"><option value="1">یک روز قبل</option><option value="0">همان روز</option><option value="2">دو روز قبل</option><option value="3">سه روز قبل</option></select></label><label class="v93-wide">توضیح یا بودجه‌بندی<textarea id="v93EventNote" rows="2" placeholder="توضیحات و مباحث"></textarea></label><button class="os-btn primary" id="v93EventSave">ذخیرهٔ رویداد</button></div></section>`;
 bindCalendarControls(sel);
}
const panelCalendar={set innerHTML(v){const panel=$('sPanel');panel.innerHTML=v;}};
function bindCalendarControls(sel){
 $('v93PrevMonth').onclick=()=>{selectedCalendarMonth=shiftJalaliMonth(selectedCalendarMonth.y,selectedCalendarMonth.m,-1);renderCalendar()};$('v93NextMonth').onclick=()=>{selectedCalendarMonth=shiftJalaliMonth(selectedCalendarMonth.y,selectedCalendarMonth.m,1);renderCalendar()};
 document.querySelectorAll('[data-calendar-day]').forEach(b=>b.onclick=()=>{selectedCalendarDay=b.dataset.calendarDay;renderCalendar()});
 $('v93ReminderPermission').onclick=async()=>{if(!('Notification'in window)){alert('این مرورگر اعلان را پشتیبانی نمی‌کند.');return}const p=await Notification.requestPermission();alert(p==='granted'?'یادآوری‌های تقویم فعال شدند.':'اجازهٔ اعلان داده نشد.')};
 $('v93AddEvent').onclick=()=>{document.getElementById('v93EventTitle')?.focus();$('v93EventTitle')?.scrollIntoView({behavior:'smooth',block:'center'})};
 $('v93ClassSave').onclick=()=>{const title=$('v93ClassTitle').value.trim();if(!title){$('v93ClassTitle').focus();return alert('نام کلاس را وارد کن.')}state().recurringClasses.push({id:API.makeId(),title,subject:$('v93ClassSubject').value.trim(),weekday:Number($('v93ClassDay').value),time:$('v93ClassTime').value||'',color:$('v93ClassColor').value,active:true,createdAt:new Date().toISOString()});persist();renderCalendar()};
 $('v93EventSave').onclick=()=>{const title=$('v93EventTitle').value.trim(),date=$('v93EventDate').value;if(!title||!date)return alert('عنوان و تاریخ رویداد را وارد کن.');const parts=date.split('-').map(Number),j=jalaliParts(gDate(parts[0],parts[1],parts[2]));state().calendarEvents.push({id:API.makeId(),source:'custom',kind:'custom',title,date,jalaliDate:jalaliKey(j),note:$('v93EventNote').value.trim(),budget:'',reminderDays:Number($('v93EventReminder').value),createdBy:'user'});persist();selectedCalendarDay=jalaliKey(j);selectedCalendarMonth=j;renderCalendar()};
 document.querySelectorAll('[data-calendar-delete]').forEach(b=>b.onclick=()=>{if(!confirm('این رویداد حذف شود؟'))return;state().calendarEvents=state().calendarEvents.filter(x=>x.id!==b.dataset.calendarDelete);persist();renderCalendar()});
 document.querySelectorAll('[data-class-delete]').forEach(b=>b.onclick=()=>{if(!confirm('این کلاس هفتگی حذف شود؟'))return;state().recurringClasses=state().recurringClasses.filter(x=>x.id!==b.dataset.classDelete);persist();renderCalendar()});
}
function renderManual(){
 const db=API.getExamDB(),subjects=(db.subjects||[]).map(x=>x.name).filter(Boolean);const defaults=['زیست‌شناسی','شیمی','فیزیک','ریاضی','زمین‌شناسی','عمومی'];const opts=[...new Set([...subjects,...defaults])];
 const rows=state().externalTests.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date)));
 const totalAll=rows.reduce((a,x)=>a+(Number(x.total)||0),0);
 $('sPanel').innerHTML=`<div class="page-head"><div><span class="eyebrow">OFF-PLATFORM EXAMS</span><h2>ثبت آزمون خارج از سامانه</h2><p>آزمون کاغذی، ماز، کانون یا هر منبع دیگر؛ تعداد تست‌ها وارد آمار روزانه و گزارش‌ها می‌شود.</p></div><div class="quick-row"><span class="v93-stat-chip">${fa(rows.length)} آزمون ثبت‌شده</span><span class="v93-stat-chip">${fa(totalAll)} تست</span></div></div><section class="os-card"><div class="section-head"><h3>ثبت نتیجهٔ آزمون</h3><small>اطلاعات را مطابق کارنامه وارد کن</small></div><div class="v93-form-grid"><label>نام آزمون<input id="v93ManualName" placeholder="مثلاً آزمون مرحلهٔ ۸"></label><label>منبع آزمون<input id="v93ManualSource" placeholder="ماز، کانون، مدرسه…"></label><label>تاریخ<input type="date" id="v93ManualDate" value="${API.today()}"></label><label>درس<select id="v93ManualSubject">${opts.map(x=>`<option value="${safe(x)}">${safe(x)}</option>`).join('')}</select></label><label>تعداد کل سؤال<input type="number" min="1" max="2000" id="v93ManualTotal" value="25"></label><label>درست<input type="number" min="0" id="v93ManualCorrect" value="0"></label><label>غلط<input type="number" min="0" id="v93ManualWrong" value="0"></label><label>نزده<input type="number" min="0" id="v93ManualBlank" value="0"></label><label>روش محاسبهٔ درصد<select id="v93ManualScoring"><option value="four-choice-negative">چهارگزینه‌ای با نمرهٔ منفی یک‌سوم</option><option value="no-negative">بدون نمرهٔ منفی</option></select></label><label>تراز رسمی (اختیاری)<input type="number" min="0" id="v93ManualTaraz" placeholder="فقط عدد درج‌شده در کارنامه"></label><label>رتبهٔ رسمی (اختیاری)<input type="number" min="1" id="v93ManualRank" placeholder="رتبهٔ درج‌شده در کارنامه"></label><label>درصد رسمی (اختیاری)<input type="number" step="0.01" id="v93ManualPercent" placeholder="در صورت وجود در کارنامه"></label><label class="v93-wide">فصل / مبحث<input id="v93ManualChapter" placeholder="مثلاً گفتار ۲، تنظیم عصبی"></label><label class="v93-wide">شمارهٔ سؤال‌های مهم برای مرور<input id="v93ManualReviewNums" placeholder="مثلاً ۳، ۸، ۱۲-۱۵"></label><label class="v93-wide v93-checkline"><input id="v93ManualAddReview" type="checkbox" checked> سؤال‌های مهم بالا به صف مرور اضافه شوند.</label></div><div id="v93ManualValidation" class="v93-validation" aria-live="polite">مجموع درست، غلط و نزده باید با تعداد کل برابر باشد.</div><div class="v93-manual-actions"><button class="os-btn primary" id="v93ManualSave">ثبت آزمون و افزودن به آمار</button><button class="os-btn subtle" id="v93ManualPreview">محاسبهٔ درصد</button></div></section><section class="os-card"><div class="section-head"><h3>آزمون‌های خارج از سامانه</h3><small>این موارد در گزارش‌ها و تعداد تست روزانه لحاظ می‌شوند.</small></div>${rows.length?rows.map(x=>`<article class="v93-manual-row"><div><b>${safe(x.name||'آزمون')}</b><small>${safe(x.source||'منبع نامشخص')} · ${safe(x.date)} · ${safe(x.subject)}</small><div class="v93-manual-stats"><span>کل ${fa(x.total)}</span><span class="good">درست ${fa(x.correct)}</span><span class="bad">غلط ${fa(x.wrong)}</span><span>نزده ${fa(x.blank)}</span><b>${Number(x.percent||0).toFixed(2)}٪ ${x.percentIsOfficial?'رسمی':'محاسباتی'}</b>${x.taraz?`<span>تراز ${fa(x.taraz)}</span>`:''}${x.rank?`<span>رتبه ${fa(x.rank)}</span>`:''}</div></div><button class="v93-icon-action" data-manual-delete="${safe(x.id)}" title="حذف ثبت">×</button></article>`).join(''):'<div class="empty-state">هنوز آزمونی دستی ثبت نشده است.</div>'}</section><section class="os-card"><div class="section-head"><h3>قاعدهٔ محاسبه</h3></div><p>روش محاسبه را مطابق آزمون انتخاب کن: چهارگزینه‌ای با نمرهٔ منفی یک‌سوم، یا بدون نمرهٔ منفی. درصد رسمی کارنامه در صورت واردکردن، جداگانه نگهداری می‌شود. مجموع درست، غلط و نزده باید دقیقاً برابر تعداد کل باشد.</p></section>`;
 const validate=()=>{const total=Number($('v93ManualTotal').value),c=Number($('v93ManualCorrect').value),w=Number($('v93ManualWrong').value),b=Number($('v93ManualBlank').value),scoring=$('v93ManualScoring').value,ok=Number.isInteger(total)&&total>0&&total<=2000&&Number.isInteger(c)&&Number.isInteger(w)&&Number.isInteger(b)&&c>=0&&w>=0&&b>=0&&c+w+b===total;const pct=total?(scoring==='no-negative'?c:(c-w/3))/total*100:0;$('v93ManualValidation').textContent=ok?`درصد محاسباتی ${scoring==='no-negative'?'بدون نمرهٔ منفی':'با نمرهٔ منفی یک‌سوم'}: ${fa(pct.toFixed(2))}٪ · مجموع پاسخ‌ها کامل است.`:`مجموع فعلی: ${fa(c+w+b)} از ${fa(total)} سؤال؛ باید برابر باشد و کل از ۲۰۰۰ بیشتر نباشد.`;$('v93ManualValidation').classList.toggle('valid',ok);return {ok,total,c,w,b,pct,scoring};};
 ['v93ManualTotal','v93ManualCorrect','v93ManualWrong','v93ManualBlank','v93ManualScoring'].forEach(id=>$(id).oninput=validate);$('v93ManualPreview').onclick=validate;
 $('v93ManualSave').onclick=()=>{const v=validate();if(!v.ok)return alert('تعداد درست، غلط و نزده باید عدد صحیح باشند و مجموعشان دقیقاً با کل سؤال‌ها برابر باشد.');const date=$('v93ManualDate').value;if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return alert('تاریخ آزمون را مشخص کن.');const name=$('v93ManualName').value.trim()||'آزمون خارج از سامانه',source=$('v93ManualSource').value.trim()||'منبع نامشخص',subject=$('v93ManualSubject').value,chapter=$('v93ManualChapter').value.trim();const pctRaw=$('v93ManualPercent').value,official=pctRaw===''?null:Number(pctRaw),tarazRaw=$('v93ManualTaraz').value,rankRaw=$('v93ManualRank').value,taraz=tarazRaw===''?null:Number(tarazRaw),rank=rankRaw===''?null:Number(rankRaw);if(official!==null&&(!Number.isFinite(official)||official<0||official>100))return alert('درصد رسمی باید بین صفر تا صد باشد.');if(taraz!==null&&(!Number.isInteger(taraz)||taraz<0))return alert('تراز باید عدد صحیح نامنفی باشد.');if(rank!==null&&(!Number.isInteger(rank)||rank<1))return alert('رتبه باید عدد صحیح مثبت باشد.');const rec={id:API.makeId(),date,name,source,subject,chapter,total:v.total,correct:v.c,wrong:v.w,blank:v.b,percent:official!==null?official:Number(v.pct.toFixed(2)),percentIsOfficial:official!==null,computedPercent:Number(v.pct.toFixed(2)),taraz,rank,scoring:v.scoring,createdAt:new Date().toISOString()};state().externalTests.push(rec);
  if($('v93ManualAddReview').checked){const nums=parseQuestionNumbers($('v93ManualReviewNums').value);nums.forEach(question=>state().externalReviewItems.push({id:API.makeId(),key:`external:${rec.id}:${question}`,question,source,exam:name,subject,chapter,tags:['مهم'],dueDate:API.today()}));}
  persist();renderManual();alert('آزمون ثبت شد و در گزارش‌ها و آمار تست روزانه لحاظ می‌شود.');};
 document.querySelectorAll('[data-manual-delete]').forEach(b=>b.onclick=()=>{if(!confirm('این آزمون دستی و آمار مربوط به آن حذف شود؟'))return;const id=b.dataset.manualDelete;state().externalTests=state().externalTests.filter(x=>x.id!==id);state().externalReviewItems=state().externalReviewItems.filter(x=>!String(x.key).startsWith(`external:${id}:`));persist();renderManual()});
}
function parseQuestionNumbers(raw){const value=String(raw||'').replace(/[۰-۹]/g,d=>'0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]).replace(/[٠-٩]/g,d=>'0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)]);const set=new Set();for(const part of value.split(/[،,\s]+/).filter(Boolean)){const m=part.match(/^(\d+)(?:[-–](\d+))?$/);if(!m)continue;let a=+m[1],b=+(m[2]||m[1]);if(b<a)[a,b]=[b,a];if(b-a>200)continue;for(let n=a;n<=b;n++)set.add(n)}return [...set].sort((a,b)=>a-b)}
function renderAssistant(){
 const messages=aiHistory.map((m,i)=>`<article class="v93-chat-message ${m.role==='user'?'user':'assistant'}"><small>${m.role==='user'?'تو':'Study OS AI'} · ${safe(m.time||'')}</small><div>${safe(m.text).replace(/\n/g,'<br>')}</div>${m.filename?`<span class="v93-file-chip">پیوست: ${safe(m.filename)}</span>`:''}</article>`).join('');
 $('sPanel').innerHTML=`<div class="page-head"><div><span class="eyebrow">PRIVATE STUDY ASSISTANT</span><h2>دستیار هوشمند Study OS</h2><p>گفت‌وگوی مستقل این برنامه؛ تاریخچه روی همین دستگاه نگهداری می‌شود.</p></div><div class="quick-row"><button class="os-btn subtle" id="v93AiClear">پاک‌کردن گفت‌وگو</button></div></div><section class="os-card v93-ai-notice"><b>اتصال امن، نیازمند راه‌اندازی سمت سرور</b><p>کلید OpenAI داخل مرورگر یا مخزن عمومی قرار نمی‌گیرد. این بخش تا زمانی که سرپرست قانونی موافقت نکرده و شناسهٔ حساب در Secret سروری <code>STUDY_OS_AI_GUARDIAN_APPROVED_USER_IDS</code> ثبت نشده باشد، از سمت سرور مسدود می‌ماند. ارسال کارنامه فقط پس از حذف دستی اطلاعات شناسایی و تأیید جداگانهٔ آن انجام می‌شود.</p></section><section class="os-card"><div class="v93-chat-history" id="v93AiHistory">${messages||'<div class="empty-state">گفت‌وگو هنوز شروع نشده است. می‌توانی دربارهٔ تحلیل آزمون، برنامه‌ریزی یا یک مبحث درسی سؤال کنی.</div>'}</div><div class="v93-ai-attach"><label class="os-btn subtle" for="v93AiFile">افزودن فایل کارنامه / گزارش</label><input id="v93AiFile" type="file" accept=".pdf,.txt,.csv,.xlsx,.json" hidden><span id="v93AiFileName">فایلی انتخاب نشده</span><button class="os-btn subtle" id="v93AiAnalyze">تحلیل عملکرد آزمون‌ها</button></div><label class="v93-consent"><input id="v93AiConsent" type="checkbox"> می‌دانم پیام من برای پردازش به API هوش مصنوعی ارسال می‌شود و تاریخچهٔ گفت‌وگو روی همین دستگاه ذخیره می‌شود. درخواست با store:false می‌رود؛ بااین‌حال ثبت‌های پایش سوءاستفادهٔ API ممکن است طبق تنظیم پیش‌فرض تا ۳۰ روز نگهداری شوند؛ داده‌های API به‌طور پیش‌فرض برای آموزش مدل استفاده نمی‌شوند مگر سازمان صریحاً موافقت کرده باشد.</label><label class="v93-consent"><input id="v93AiGuardianConsent" type="checkbox"> سرپرست قانونی من پس از بررسی حریم خصوصی و هزینهٔ احتمالی API، با استفاده از این سرویس موافقت کرده است. علاوه بر این تأیید، حساب باید از سمت سرور نیز در فهرست مجاز قرار گرفته باشد.</label><label class="v93-consent" id="v93AiRedactionWrap" style="display:none"><input id="v93AiIdentifiersRemoved" type="checkbox"> پیش از انتخاب و ارسال این فایل، نام، نام پدر، شماره تماس، شناسهٔ دانش‌آموزی، بارکد و هر اطلاعات شناسایی را از خود فایل حذف کرده‌ام. سامانه این اطلاعات را به‌طور خودکار از PDF پاک نمی‌کند.</label><div class="v93-ai-compose"><textarea id="v93AiInput" rows="3" placeholder="پیامت را بنویس…"></textarea><button class="os-btn primary" id="v93AiSend" ${aiBusy?'disabled':''}>${aiBusy?'در حال ارسال…':'ارسال'}</button></div><div class="v93-muted-note">برای فایل‌های حساس، نام، شماره تماس یا شناسه‌های شخصی را پیش از ارسال حذف کن. هزینهٔ API جدا از اشتراک ChatGPT محاسبه می‌شود؛ فعال‌سازی پرداخت باید با نظارت سرپرست انجام شود.</div></section>`;
 $('v93AiFile').onchange=async e=>{const f=e.target.files?.[0];activeAiFile=null;$('v93AiRedactionWrap').style.display='none';$('v93AiIdentifiersRemoved').checked=false;if(!f){$('v93AiFileName').textContent='فایلی انتخاب نشده';return}const allowed=['application/pdf','text/plain','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/json'];if(!allowed.includes(f.type)&&! /\.(pdf|txt|csv|xlsx|json)$/i.test(f.name)){alert('این نوع فایل پشتیبانی نمی‌شود.');$('v93AiFileName').textContent='فایلی انتخاب نشده';e.target.value='';return}if(f.size>4.5*1024*1024){alert('برای ارسال مطمئن، حجم فایل باید حداکثر ۴٫۵ مگابایت باشد.');$('v93AiFileName').textContent='فایلی انتخاب نشده';e.target.value='';return}activeAiFile=f;$('v93AiFileName').textContent=`${f.name} · ${fa(Math.ceil(f.size/1024))} کیلوبایت`;$('v93AiRedactionWrap').style.display='flex'};
 $('v93AiClear').onclick=()=>{if(!confirm('تاریخچهٔ گفت‌وگوی محلی پاک شود؟'))return;aiHistory=[];saveAIHistory();activeAiFile=null;renderAssistant()};
 $('v93AiAnalyze').onclick=()=>{const summary=buildPerformanceSummary();$('v93AiInput').value='لطفاً این گزارش عملکرد را مثل یک مشاور آموزشی دقیق تحلیل کن. تحلیل را به تفکیک هر درس و سپس کلی ارائه بده. نقاط قوت، ضعف، روند و پیشنهادهای عملی را جدا کن. درصد و تراز رسمی را از هم تفکیک کن و تراز را از روی درصد حدس نزن. نسبت غلط به درست را هم محاسبه کن.\n\n'+summary;$('v93AiInput').focus()};
 $('v93AiSend').onclick=sendAiMessage;
}
function answerSheetRowsOnly(){
 // API.testRows already includes off-platform tests for the reports UI.
 // Subtract those records here so the AI context can list them separately exactly once.
 const rows=(Array.isArray(API.testRows)?API.testRows:[]).map(r=>({
  ...r,
  bySubject:{...(r.bySubject||{})},
  bySubjectStatus:Object.fromEntries(Object.entries(r.bySubjectStatus||{}).map(([k,v])=>[k,{...v}])),
  statuses:{...(r.statuses||{})}
 }));
 const byDate=new Map(rows.map(r=>[String(r.date),r]));
 for(const x of (state().externalTests||[])){
  const row=byDate.get(String(x.date));if(!row)continue;
  const subject=String(x.subject||'سایر');
  const total=Math.max(0,Number(x.total)||0);
  row.bySubject[subject]=Math.max(0,(Number(row.bySubject[subject])||0)-total);
  const st=row.bySubjectStatus[subject];
  if(st){
   for(const key of ['correct','wrong','blank'])st[key]=Math.max(0,(Number(st[key])||0)-(Number(x[key])||0));
  }
  row.count=Math.max(0,(Number(row.count)||0)-total);
  for(const key of ['correct','wrong','blank'])row.statuses[key]=Math.max(0,(Number(row.statuses[key])||0)-(Number(x[key])||0));
 }
 return rows.filter(r=>Object.values(r.bySubject||{}).some(v=>Number(v)>0));
}
function buildPerformanceSummary(){
 const daily=answerSheetRowsOnly();
 const official=state().externalTests.slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
 if(!daily.length&&!official.length)return 'هنوز آزمون ثبت‌شده‌ای در سامانه وجود ندارد. اگر فایل کارنامه پیوست شده، بر اساس همان فایل تحلیل کن.';
 const lines=['داده‌های تجمیعی پاسخ‌برگ: درصد این بخش در صورت محاسبه با پاسخ‌برگ، با فرض نمرهٔ منفی یک‌سوم است و لزوماً درصد رسمی مؤسسه نیست.'];
 const grouped={};
 daily.forEach(row=>Object.entries(row.bySubjectStatus||{}).forEach(([subject,st])=>{
  const bucket=(grouped[subject]??=[]);bucket.push({date:row.date,total:Number(row.bySubject?.[subject]||0),correct:Number(st.correct||0),wrong:Number(st.wrong||0),blank:Number(st.blank||0),answered:Number(st.answered||0),unknown:Number(st.unknown||0)});
 }));
 Object.entries(grouped).forEach(([subject,items])=>{
  lines.push(`درس: ${subject}`);
  items.forEach(x=>{const ratio=x.correct>0?x.wrong/x.correct*100:null;const pct=x.total>0?((x.correct-x.wrong/3)/x.total*100):null;lines.push(`${x.date} | کل ${x.total} | درست ${x.correct}، غلط ${x.wrong}، نزده ${x.blank}، پاسخ‌داده ${x.answered}، نامشخص ${x.unknown} | درصد محاسباتی با فرض نمره منفی یک‌سوم: ${pct==null?'ناموجود':pct.toFixed(2)+'٪'} | نسبت غلط به درست: ${ratio==null?'قابل محاسبه نیست':ratio.toFixed(1)+'٪'}`)});
 });
 if(official.length){
  lines.push('آزمون‌های خارج از سامانه:');
  official.forEach(x=>{const ratio=Number(x.correct)>0?Number(x.wrong)/Number(x.correct)*100:null;const pctLabel=x.percentIsOfficial?'درصد رسمی درج‌شده':'درصد محاسباتی ثبت‌شده';lines.push(`${x.date} | ${x.name} (${x.source}) | درس ${x.subject} | ${pctLabel} ${Number(x.percent).toFixed(2)}٪ | درست ${x.correct}، غلط ${x.wrong}، نزده ${x.blank} | تراز رسمی ${x.taraz??'ثبت نشده'} | رتبه رسمی ${x.rank??'ثبت نشده'} | نسبت غلط به درست ${ratio==null?'قابل محاسبه نیست':ratio.toFixed(1)+'٪'}`)});
  const bySubject={};official.forEach(x=>(bySubject[x.subject]??=[]).push(x));
  Object.entries(bySubject).forEach(([subject,items])=>{
   const last=items.slice(-3);
   if(last.length===3){
    const avg=last.reduce((a,x)=>a+Number(x.percent||0),0)/3;
    lines.push(`${subject}: میانگین سه آزمون اخیر ${avg.toFixed(2)}٪؛ هدف تمرینی شخصیِ پیشنهادی با افزودن ۵ تا ۱۰ واحد درصد: ${(avg+5).toFixed(2)} تا ${(avg+10).toFixed(2)}٪. این هدف است، نه پیش‌بینی علمی.`);
   }else{
    lines.push(`${subject}: فقط ${last.length} نتیجهٔ ثبت‌شده وجود دارد؛ برای روش هدف‌گذاری تعریف‌شده، سه آزمون مشابه لازم است، بنابراین فعلاً هدف ۵ تا ۱۰ واحد درصدی محاسبه نمی‌شود.`);
   }
   const tarazValues=last.map(x=>Number(x.taraz)).filter(x=>Number.isFinite(x)&&x>0);
   if(tarazValues.length)lines.push(`${subject}: میانگین ترازهای رسمی ثبت‌شده در همین ${tarazValues.length} نتیجه ${Math.round(tarazValues.reduce((a,b)=>a+b,0)/tarazValues.length)} است؛ این فقط خلاصهٔ دادهٔ قبلی است و پیش‌بینی تراز آینده نیست.`);
  });
 }
 lines.push('هدف شخصی دانش‌آموز: نسبت غلط به درست کمتر از ۲۰٪. این هدف شخصی است و معیار علمی یا استاندارد همگانی محسوب نمی‌شود. نسبت = غلط ÷ درست × ۱۰۰؛ اگر پاسخ درست صفر باشد، نسبت تعریف نمی‌شود.');
 lines.push('تراز از روی درصد حدس زده نشود؛ برای برآورد تراز معتبر، دادهٔ توزیع نتایج جامعهٔ آزمون لازم است.');
 return lines.join('\n');
}
async function sendAiMessage(){
 if(aiBusy)return;const text=$('v93AiInput')?.value.trim();if(!text&&!activeAiFile)return alert('پیام یا فایل پیوست کن.');const guardianApproval=$('v93AiGuardianConsent')?.checked===true;const identifiersRemoved=activeAiFile?$('v93AiIdentifiersRemoved')?.checked===true:false;if(!$('v93AiConsent')?.checked)return alert('برای پردازش پیام در سرویس هوش مصنوعی، رضایت آگاهانه را علامت بزن.');if(!guardianApproval)return alert('ابتدا باید سرپرست قانونی پس از بررسی هزینه و حریم خصوصی موافقت کند.');if(activeAiFile&&!identifiersRemoved)return alert('پیش از ارسال فایل، اطلاعات شناسایی را از خود فایل حذف کن و سپس تأیید کن.');
 const savedCfg=readJSONSafe('studyOSCloudConfigV79'),cfg={url:savedCfg?.url||'https://mekwowszoevgyrsguhxo.supabase.co',key:savedCfg?.key||'sb_publishable_GbzAB9CnD-zeVG3rF3RYHg__6-f9Plu'},session=readJSONSafe('studyOSCloudSessionV79');if(!cfg.url||!cfg.key||!session?.access_token){alert('ابتدا وارد حساب ابری Study OS شو تا اتصال امن به Edge Function ممکن باشد.');return;}
 aiBusy=true;renderAssistant();const userText=text||`این فایل را بررسی کن و گزارش دقیق عملکرد آموزشی ارائه بده.\n${buildPerformanceSummary()}`;const userMsg={role:'user',text:userText,time:new Date().toLocaleString('fa-IR'),filename:activeAiFile?.name||''};aiHistory.push(userMsg);saveAIHistory();
 try{
  let file=null;if(activeAiFile)file={filename:activeAiFile.name,mimeType:activeAiFile.type||guessMime(activeAiFile.name),base64:await fileToBase64(activeAiFile)};
  const history=aiHistory.slice(-13,-1).map(x=>({role:x.role==='assistant'?'assistant':'user',content:x.text}));
  const res=await fetch(cfg.url.replace(/\/$/,'')+'/functions/v1/study-ai',{method:'POST',headers:{'Content-Type':'application/json','apikey':cfg.key,'Authorization':'Bearer '+session.access_token},body:JSON.stringify({action:'chat',message:userText,history,file,studentContext:buildPerformanceSummary(),guardianApproval,fileIdentifiersRemoved:identifiersRemoved})});
  const payload=await res.json().catch(()=>({}));if(!res.ok)throw new Error(payload.error||`خطای سرور (${res.status})`);
  aiHistory.push({role:'assistant',text:String(payload.text||'پاسخی دریافت نشد.'),time:new Date().toLocaleString('fa-IR')});saveAIHistory();activeAiFile=null;
 }catch(e){aiHistory.push({role:'assistant',text:`اتصال کامل نشد: ${e.message}\n\nمطمئن شو Edge Function نسخهٔ study-ai روی Supabase منتشر و کلید OPENAI_API_KEY در Secrets تنظیم شده است.`,time:new Date().toLocaleString('fa-IR')});saveAIHistory();}
 finally{aiBusy=false;renderAssistant()}
}
function readJSONSafe(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
function guessMime(name){const ext=String(name).toLowerCase().split('.').pop();return ({pdf:'application/pdf',txt:'text/plain',csv:'text/csv',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',json:'application/json'})[ext]||'application/octet-stream'}
async function fileToBase64(file){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary)}
function renderAdmin(){
 const session=readJSONSafe('studyOSCloudSessionV79');
 $('sPanel').innerHTML=`<div class="page-head"><div><span class="eyebrow">ACCOUNT & ACCESS</span><h2>مدیریت حساب‌ها و مجوزها</h2><p>دعوت کاربر، نقش مدیریتی و دسترسی شفاف به داده‌های اشتراک‌گذاری‌شده</p></div></div>
 <section class="os-card v93-admin-banner"><b>اصل امنیت و مالکیت داده</b><p>مدیر اصلی می‌تواند حساب‌ها را مدیریت کند، اما دیدن محتوای آموزشی کاربران فقط با موافقت صریح مالک داده و در محدودهٔ مجوز ثبت‌شده امکان‌پذیر است. هر مشاهده باید در گزارش دسترسی ثبت شود.</p></section>
 <section class="os-card"><div class="section-head"><h3>وضعیت حساب</h3><span class="v93-status-chip ${session?.access_token?'connected':''}">${session?.access_token?'حساب ابری وارد شده':'وارد حساب نشده'}</span></div><p>شناسهٔ مدیر اصلی فقط در Secret سمت سرور به نام <code>STUDY_OS_ADMIN_USER_ID</code> ثبت می‌شود. کلید محرمانه در این صفحه یا مخزن عمومی قرار نمی‌گیرد.</p>
 <div class="v93-form-grid"><label>ایمیل کاربر جدید<input type="email" id="v93InviteEmail" placeholder="ایمیل دعوت‌شونده"></label><label>نقش<select id="v93InviteRole"><option value="user">کاربر</option><option value="manager">مدیر کمکی</option></select></label><button class="os-btn primary" id="v93InviteUser">دعوت کاربر</button><button class="os-btn subtle" id="v93LoadUsers">نمایش حساب‌های مجاز</button></div></section>
 <section class="os-card"><h3>مجوز اشتراک‌گذاری داده</h3><p class="v93-muted-note">این بخش برای مالک حساب است. تنها کاربرانی که قبلاً به‌عنوان مدیر کمکی دعوت و تأیید شده‌اند قابل انتخاب‌اند.</p><div class="v93-form-grid"><label>ایمیل مدیر کمکی<input type="email" id="v93GrantEmail" placeholder="ایمیل حساب مدیر کمکی"></label><label>سطح مجوز<select id="v93GrantScope"><option value="summary">فقط خلاصه و گزارش‌ها</option><option value="full">دسترسی کامل به دادهٔ آموزشی</option></select></label><button class="os-btn primary" id="v93GrantAccess">اشتراک‌گذاری با رضایت من</button><button class="os-btn subtle" id="v93MyGrants">مجوزهای فعال من</button><button class="os-btn subtle" id="v93SharedWithMe">داده‌هایی که با من به اشتراک گذاشته شده</button><label>شناسهٔ مالک برای مشاهدهٔ اشتراک<input id="v93OwnerId" placeholder="شناسهٔ مالک از فهرست اشتراک‌ها"></label><button class="os-btn primary" id="v93ViewShared">مشاهدهٔ دادهٔ مجاز</button><label>شناسهٔ مجوز برای لغو<input id="v93GrantId" placeholder="شناسهٔ مجوز فعال"></label><button class="os-btn subtle" id="v93RevokeAccess">لغو مجوز اشتراک</button></div><div id="v93AdminResult" class="v93-admin-result" aria-live="polite">برای فعال‌سازی این امکانات باید توابع سمت سرور و مهاجرت SQL بسته نصب شوند.</div></section>
 <section class="os-card"><h3>قواعد اجرایی</h3><ul class="v93-admin-rules"><li>ثبت‌نام آزاد تنها پس از نصب و بررسی سامانهٔ دعوت غیرفعال می‌شود؛ این تغییر اکنون انجام نشده است.</li><li>مدیر کمکی فقط به حساب‌هایی دسترسی دارد که مالک، مجوز فعال داده است.</li><li>مالک می‌تواند مجوز را در هر زمان لغو کند.</li><li>هر مشاهده و تغییر مجوز در گزارش ممیزی ثبت می‌شود.</li></ul></section>`;
 $('v93InviteUser').onclick=()=>adminRequest('invite');$('v93LoadUsers').onclick=()=>adminRequest('list');$('v93GrantAccess').onclick=()=>adminRequest('grant_access');$('v93MyGrants').onclick=()=>adminRequest('list_my_grants');$('v93SharedWithMe').onclick=()=>adminRequest('list_shared');$('v93ViewShared').onclick=()=>adminRequest('view_shared');$('v93RevokeAccess').onclick=()=>adminRequest('revoke_access');$('v93ViewShared').onclick=()=>adminRequest('view_shared');$('v93RevokeAccess').onclick=()=>adminRequest('revoke_access');
}
async function adminRequest(action){
 const savedCfg=readJSONSafe('studyOSCloudConfigV79'),cfg={url:savedCfg?.url||'https://mekwowszoevgyrsguhxo.supabase.co',key:savedCfg?.key||'sb_publishable_GbzAB9CnD-zeVG3rF3RYHg__6-f9Plu'},session=readJSONSafe('studyOSCloudSessionV79');if(!cfg.url||!cfg.key||!session?.access_token){$('v93AdminResult').textContent='ابتدا وارد حساب ابری شو.';return;}
 try{
  const body={action,email:$('v93InviteEmail')?.value.trim(),role:$('v93InviteRole')?.value,managerEmail:$('v93GrantEmail')?.value.trim(),scope:$('v93GrantScope')?.value,ownerId:$('v93OwnerId')?.value.trim(),grantId:$('v93GrantId')?.value.trim()};
  const res=await fetch(cfg.url.replace(/\/$/,'')+'/functions/v1/study-admin',{method:'POST',headers:{'Content-Type':'application/json','apikey':cfg.key,'Authorization':'Bearer '+session.access_token},body:JSON.stringify(body)});
  const out=await res.json().catch(()=>({}));if(!res.ok)throw new Error(out.error||`خطای ${res.status}`);
  if(action==='list')$('v93AdminResult').textContent=(out.users||[]).map(u=>`${u.email||'بدون ایمیل'} · ${u.approved?'مجاز':'در انتظار تأیید'} · ${u.role||'user'}`).join('\n')||'کاربری ثبت نشده است.';
  else if(action==='list_my_grants')$('v93AdminResult').textContent=(out.grants||[]).map(g=>`${g.managerEmail||'ایمیل نامشخص'} · ${g.scope} · ${g.active?'فعال':'غیرفعال'} · شناسهٔ مجوز: ${g.id}`).join('\n')||'مجوز فعالی وجود ندارد.';
  else if(action==='list_shared')$('v93AdminResult').textContent=(out.shared||[]).map(g=>`${g.ownerEmail||'ایمیل نامشخص'} · سطح ${g.scope} · شناسهٔ مالک: ${g.owner_id}`).join('\n')||'کسی داده‌ای با تو به اشتراک نگذاشته است.';
  else if(action==='view_shared')$('v93AdminResult').textContent=JSON.stringify(out.payload||out.summary||out,null,2);
  else $('v93AdminResult').textContent=action==='invite'?`دعوت‌نامه برای ${body.email} ارسال شد.`:action==='grant_access'?'مجوز دسترسی ثبت شد.':action==='revoke_access'?'مجوز اشتراک لغو شد.':`درخواست ${action} انجام شد.`;
 }catch(e){$('v93AdminResult').textContent=`مدیریت هنوز آماده نیست: ${e.message}`}
}
function mountMusic(){
 if($('v93MusicFab'))return;
 const fab=document.createElement('button');fab.id='v93MusicFab';fab.className='v93-music-fab';fab.type='button';fab.title='موسیقی تمرکز';fab.setAttribute('aria-label','بازکردن موسیقی تمرکز');fab.innerHTML='<span>♫</span><b>موسیقی</b>';document.body.appendChild(fab);
 const overlay=document.createElement('div');overlay.id='v93MusicOverlay';overlay.className='v93-media-overlay';overlay.hidden=true;overlay.innerHTML=`<div class="v93-media-dialog" role="dialog" aria-modal="true" aria-labelledby="v93MediaTitle"><div class="v93-media-head"><div><small>FOCUS AUDIO</small><h2 id="v93MediaTitle">موسیقی تمرکز</h2></div><button class="v93-icon-action" id="v93MediaClose" aria-label="بستن">×</button></div><p class="v93-muted-note">پخش با اقدام خودت شروع می‌شود؛ اگر YouTube یا پخش توکار در شبکه مسدود باشد، از «بازکردن در YouTube» استفاده کن؛ این برنامه محدودیت شبکه را دور نمی‌زند. پخش خودکار تضمین‌شده نیست؛ در دسترس‌بودن و تبلیغات هر ویدئو به YouTube و شبکه بستگی دارد.</p><label>ویدئوی پیشنهادی<select id="v93Playlist"><option value="quietLatest">تازه‌ترین موسیقی تمرکز · ۳:۵۷:۵۲ · ۲ آذر ۱۴۰۵</option><option value="quietNoVocals">تمرکز بدون آواز · ۳:۵۴:۱۲</option><option value="quietClassic">موسیقی آرام برای تمرکز · ۳:۵۴:۲۴</option><option value="quietThinking">موسیقی Ambient برای تفکر · ۳:۵۳:۳۶</option><option value="custom">لینک ویدئو یا فهرست دلخواه</option></select></label><p class="v93-muted-note">برای گزینه‌های بیشتر و ویدئوهای طولانی‌تر: <a href="https://www.youtube.com/@QuietQuest" target="_blank" rel="noopener noreferrer">کانال رسمی Quiet Quest</a></p><div id="v93CustomPlaylistWrap" class="hidden"><label>شناسهٔ ویدئو یا فهرست<input id="v93CustomPlaylist" placeholder="لینک یا شناسهٔ ویدئو / فهرست YouTube"></label></div><div class="v93-player-frame" id="v93PlayerFrame"><div class="v93-player-placeholder">برای شروع، فهرست را انتخاب و روی «شروع پخش» بزن.</div></div><div class="v93-media-controls"><button class="os-btn primary" id="v93PlayMusic">شروع پخش</button><button class="os-btn subtle" id="v93PauseMusic">توقف</button><button class="os-btn subtle" id="v93OpenMusic">بازکردن در YouTube</button></div><label class="v93-volume-label">صدای موسیقی <input type="range" min="0" max="100" id="v93MusicVolume" value="${mediaPrefs.musicVolume}"><b id="v93MusicVolumeText">${fa(mediaPrefs.musicVolume)}٪</b></label><hr><h3>هشدار زمان‌سنج</h3><label>نوع صدا<select id="v93AlertTone"><option value="bright">زنگ روشن</option><option value="soft">ملایم</option><option value="playful">شاد و پرتحرک</option></select></label><label class="v93-volume-label">بلندی هشدار <input type="range" min="20" max="100" id="v93AlertVolume" value="${Math.round(mediaPrefs.alertVolume/.13*100)}"><b id="v93AlertVolumeText">${fa(Math.round(mediaPrefs.alertVolume/.13*100))}٪</b></label><button class="os-btn subtle" id="v93TestAlert">آزمایش هشدار</button></div>`;
 document.body.appendChild(overlay);
 fab.onclick=()=>{overlay.hidden=false;document.body.classList.add('v93-media-open');};$('v93MediaClose').onclick=()=>{overlay.hidden=true;document.body.classList.remove('v93-media-open')};overlay.addEventListener('click',e=>{if(e.target===overlay){overlay.hidden=true;document.body.classList.remove('v93-media-open')}});
 $('v93Playlist').value=playlists[mediaPrefs.playlist]?mediaPrefs.playlist:'quietLatest';$('v93CustomPlaylist').value=mediaPrefs.customPlaylist||'';$('v93CustomPlaylistWrap').classList.toggle('hidden',$('v93Playlist').value!=='custom');$('v93Playlist').onchange=()=>{$('v93CustomPlaylistWrap').classList.toggle('hidden',$('v93Playlist').value!=='custom');mediaPrefs.playlist=$('v93Playlist').value;savePrefs()};
 $('v93CustomPlaylist').onchange=()=>{mediaPrefs.customPlaylist=$('v93CustomPlaylist').value.trim();savePrefs()};
 $('v93MusicVolume').oninput=()=>{mediaPrefs.musicVolume=Number($('v93MusicVolume').value);$('v93MusicVolumeText').textContent=fa(mediaPrefs.musicVolume)+'٪';savePrefs();setPlayerVolume(mediaPrefs.musicVolume)};
 $('v93AlertTone').value=mediaPrefs.alertTone;$('v93AlertTone').onchange=()=>{mediaPrefs.alertTone=$('v93AlertTone').value;savePrefs()};
 $('v93AlertVolume').oninput=()=>{const p=Number($('v93AlertVolume').value);mediaPrefs.alertVolume=Math.max(.02,Math.min(.13,p/100*.13));$('v93AlertVolumeText').textContent=fa(p)+'٪';savePrefs()};
 $('v93PlayMusic').onclick=()=>playMusic(true);$('v93PauseMusic').onclick=()=>pauseMusic();$('v93OpenMusic').onclick=()=>openMusicExternally();$('v93TestAlert').onclick=()=>API.playChime?.();
}
const playlists={quietLatest:{kind:'video',id:'tRawQPTCxbQ',url:'https://www.youtube.com/watch?v=tRawQPTCxbQ'},quietNoVocals:{kind:'video',id:'vGaZXoBnnyQ',url:'https://www.youtube.com/watch?v=vGaZXoBnnyQ'},quietClassic:{kind:'video',id:'hZp6yTZ7Gus',url:'https://www.youtube.com/watch?v=hZp6yTZ7Gus'},quietThinking:{kind:'video',id:'MCbv_RIBJqU',url:'https://www.youtube.com/watch?v=MCbv_RIBJqU'}};
function currentPlaylist(){const k=$('v93Playlist')?.value||mediaPrefs.playlist;if(k==='custom'){const raw=$('v93CustomPlaylist')?.value.trim()||mediaPrefs.customPlaylist;if(!raw)return null;let u;try{u=new URL(raw.includes('://')?raw:'https://www.youtube.com/watch?v='+raw)}catch{return null}const host=u.hostname.replace(/^www\./,'');let id='',kind='video';if(host==='youtu.be')id=u.pathname.split('/').filter(Boolean)[0]||'';else if(['youtube.com','m.youtube.com','youtube-nocookie.com'].includes(host)){if(u.pathname==='/playlist'){id=u.searchParams.get('list')||'';kind='playlist'}else if(u.pathname==='/watch')id=u.searchParams.get('v')||'';else if(u.pathname.startsWith('/embed/'))id=u.pathname.split('/')[2]||'';}if(!/^[A-Za-z0-9_-]{8,80}$/.test(id))return null;return {kind,id,url:kind==='playlist'?`https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`:`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`}}return playlists[k]||playlists.quietLatest}
function playMusic(fromClick){
 const p=currentPlaylist();if(!p){alert('شناسهٔ معتبر YouTube را وارد کن.');return}
 const frame=$('v93PlayerFrame');
 const params=new URLSearchParams({enablejsapi:'1',origin:location.origin,autoplay:fromClick?'1':'0',playsinline:'1'});
 const embedUrl=p.kind==='playlist'
  ?`https://www.youtube-nocookie.com/embed?listType=playlist&list=${encodeURIComponent(p.id)}&${params}`
  :`https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.id)}?${params}`;
 frame.innerHTML=`<iframe id="v93YouTubePlayer" title="موسیقی تمرکز" src="${embedUrl}" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
 setTimeout(()=>setPlayerVolume(mediaPrefs.musicVolume),1500);
}
function pauseMusic(){const f=$('v93YouTubePlayer');if(f?.contentWindow)f.contentWindow.postMessage(JSON.stringify({event:'command',func:'pauseVideo',args:[]}), '*')}
function setPlayerVolume(value){const f=$('v93YouTubePlayer');if(f?.contentWindow)f.contentWindow.postMessage(JSON.stringify({event:'command',func:'setVolume',args:[Math.max(0,Math.min(100,Number(value)||0))]}),'*')}
function openMusicExternally(){const p=currentPlaylist();if(p)window.open(p.url,'_blank','noopener,noreferrer')}
let duckTimer=null;function duckMusic(duration=3500){const f=$('v93YouTubePlayer');if(!f?.contentWindow)return;clearTimeout(duckTimer);setPlayerVolume(Math.max(4,Math.round(mediaPrefs.musicVolume*.22)));duckTimer=setTimeout(()=>setPlayerVolume(mediaPrefs.musicVolume),Math.max(1000,duration))}
function maybeNotify(){
 if(!('Notification'in window)||Notification.permission!=='granted')return;const now=new Date();const todayIso=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`,ledger=readLedger();
 const upcoming=[...(state().calendarEvents||[]).map(e=>({...e,notifyDate:addDaysISO(e.date,-Math.max(0,Number(e.reminderDays??1)))})),...(state().recurringClasses||[]).flatMap(c=>{const offset=(Number(c.weekday)-((now.getDay()+1)%7)+7)%7;const target=new Date(now.getFullYear(),now.getMonth(),now.getDate()+offset,12);const iso=`${target.getFullYear()}-${pad(target.getMonth()+1)}-${pad(target.getDate())}`;return [{...c,id:`class-${c.id}-${iso}`,title:c.title,notifyDate:addDaysISO(iso,-1),date:iso,source:'class'}]})];
 upcoming.filter(e=>e.notifyDate===todayIso).forEach(e=>{const key=`${e.id}:${todayIso}`;if(ledger[key])return;try{new Notification('یادآوری Study OS',{body:`${e.title} · ${e.source==='class'?'کلاس هفتگی':SOURCE_META[e.source]?.label||'رویداد'}`});ledger[key]=true;writeLedger(ledger)}catch{}});
}
function addDaysISO(iso,days){const [y,m,d]=String(iso||'').split('-').map(Number);if(!y)return '';const date=gDate(y,m,d);date.setDate(date.getDate()+days);return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`}
function readLedger(){try{return JSON.parse(localStorage.getItem(LOCAL_REMINDER_KEY)||'{}')}catch{return {}}}function writeLedger(x){try{localStorage.setItem(LOCAL_REMINDER_KEY,JSON.stringify(x))}catch{}}
function install(){initData();mountNav();moveSidebarClose();bindExternalTestsCount();appendStyles();mountMusic();window.StudyOSMediaV93={prefs:()=>mediaPrefs,duck:duckMusic,playAlert:()=>API.playChime?.()};API.renderTab=renderTab;maybeNotify();reminderTimer=setInterval(()=>{if(!document.hidden)maybeNotify()},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)maybeNotify()});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
