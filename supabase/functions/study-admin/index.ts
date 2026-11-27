import { createClient } from 'npm:@supabase/supabase-js@2';

const appOrigin = Deno.env.get('APP_ORIGIN') || 'https://mohammadkariman040-crypto.github.io';
const corsHeaders = {
  'Access-Control-Allow-Origin': appOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== appOrigin) return json({ error: 'Origin is not allowed' }, 403);

  const url = Deno.env.get('SUPABASE_URL');
  const publishableMap = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
  const secretMap = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
  const anon = publishableMap.default || Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const service = secretMap.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY');
  const primaryAdminId = Deno.env.get('STUDY_OS_ADMIN_USER_ID');
  if (!url || !anon || !service || !primaryAdminId) return json({ error: 'Server secrets are not configured' }, 503);
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Authentication required' }, 401);
  const callerClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: authData, error: authError } = await callerClient.auth.getUser(token);
  if (authError || !authData.user) return json({ error: 'Invalid session' }, 401);
  const caller = authData.user;
  const admin = createClient(url, service, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const action = String(body.action || '');
  const isPrimaryAdmin = caller.id === primaryAdminId;
  const { data: callerProfile, error: callerProfileError } = await admin.from('study_os_user_profiles').select('*').eq('user_id', caller.id).maybeSingle();
  if (callerProfileError) return json({ error: 'Account permissions could not be verified' }, 503);

  // The primary admin profile is initialized server-side; no browser flag can promote a user.
  if (isPrimaryAdmin && (!callerProfile || callerProfile.role !== 'admin' || !callerProfile.approved)) {
    const { error: primaryProfileWriteError } = await admin.from('study_os_user_profiles').upsert({ user_id: caller.id, email: caller.email || null, role: 'admin', approved: true, updated_at: new Date().toISOString() });
    if (primaryProfileWriteError) return json({ error: 'Primary admin profile could not be initialized' }, 503);
  }
  const isApprovedManager = callerProfile?.role === 'manager' && callerProfile?.approved === true;
  if (['invite', 'list'].includes(action) && !isPrimaryAdmin) return json({ error: 'Only the configured primary admin can manage invitations and account roles' }, 403);
  if (['list_shared', 'view_shared'].includes(action) && !isPrimaryAdmin && !isApprovedManager) return json({ error: 'An approved manager role is required' }, 403);

  try {
    if (action === 'invite') {
      const email = String(body.email || '').trim().toLowerCase();
      const role = body.role === 'manager' ? 'manager' : 'user';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400);
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${appOrigin}/study-os/` });
      if (error) throw error;
      const { error: profileWriteError } = await admin.from('study_os_user_profiles').upsert({ user_id: data.user.id, email, role, approved: true, updated_at: new Date().toISOString() });
      if (profileWriteError) return json({ error: 'Invitation was sent but its access profile could not be saved; check the invited account before retrying.' }, 503);
      await audit(admin, caller.id, data.user.id, data.user.id, 'invite', { role });
      return json({ ok: true, email, userId: data.user.id, role });
    }
    if (action === 'list') {
      const { data, error } = await admin.from('study_os_user_profiles').select('user_id,email,role,approved,created_at').order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return json({ users: data || [] });
    }
    if (action === 'grant_access') {
      const email = String(body.managerEmail || '').trim().toLowerCase();
      const scope = body.scope === 'full' ? 'full' : 'summary';
      if (!email) return json({ error: 'Manager email is required' }, 400);
      const { data: manager, error } = await admin.from('study_os_user_profiles').select('user_id,email,role,approved').ilike('email', email).maybeSingle();
      if (error) throw error;
      if (!manager || manager.role !== 'manager' || !manager.approved) return json({ error: 'This account is not an approved manager. Ask the primary admin to invite it as a manager first.' }, 404);
      const { data: grant, error: saveError } = await admin.from('study_os_access_grants').upsert({ owner_id: caller.id, manager_id: manager.user_id, scope, active: true, revoked_at: null }, { onConflict: 'owner_id,manager_id' }).select('*').single();
      if (saveError) throw saveError;
      await audit(admin, caller.id, caller.id, manager.user_id, 'grant_access', { scope, grantId: grant.id });
      return json({ ok: true, grant });
    }
    if (action === 'list_my_grants') {
      const { data, error } = await admin.from('study_os_access_grants').select('id,manager_id,scope,active,created_at').eq('owner_id', caller.id).order('created_at', { ascending: false });
      if (error) throw error;
      const ids = [...new Set((data || []).map((g: any) => g.manager_id))];
      const { data: profiles, error: profileError } = ids.length ? await admin.from('study_os_user_profiles').select('user_id,email').in('user_id', ids) : { data: [], error: null };
      if (profileError) throw profileError;
      const byId = new Map((profiles || []).map((p: any) => [p.user_id, p.email]));
      const grants = (data || []).map((g: any) => ({ ...g, managerEmail: byId.get(g.manager_id) || null }));
      return json({ grants });
    }
    if (action === 'revoke_access') {
      const grantId = String(body.grantId || '');
      const { data, error } = await admin.from('study_os_access_grants').update({ active: false, revoked_at: new Date().toISOString() }).eq('id', grantId).eq('owner_id', caller.id).select('*').maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: 'Grant not found or not owned by caller' }, 404);
      await audit(admin, caller.id, caller.id, data.manager_id, 'revoke_access', { grantId });
      return json({ ok: true });
    }
    if (action === 'list_shared') {
      const { data, error } = await admin.from('study_os_access_grants').select('id,owner_id,scope,created_at').eq('manager_id', caller.id).eq('active', true);
      if (error) throw error;
      const ids = [...new Set((data || []).map((g: any) => g.owner_id))];
      const { data: profiles, error: profileError } = ids.length ? await admin.from('study_os_user_profiles').select('user_id,email').in('user_id', ids) : { data: [], error: null };
      if (profileError) throw profileError;
      const byId = new Map((profiles || []).map((p: any) => [p.user_id, p.email]));
      return json({ shared: (data || []).map((g: any) => ({ ...g, ownerEmail: byId.get(g.owner_id) || null })) });
    }
    if (action === 'view_shared') {
      const ownerId = String(body.ownerId || '');
      const { data: grant, error: grantError } = await admin.from('study_os_access_grants').select('id,scope').eq('owner_id', ownerId).eq('manager_id', caller.id).eq('active', true).maybeSingle();
      if (grantError) throw grantError;
      if (!grant) return json({ error: 'No active owner consent exists for this data' }, 403);
      const { data: sync, error: syncError } = await admin.from('study_os_sync').select('payload,updated_at').eq('user_id', ownerId).maybeSingle();
      if (syncError) throw syncError;
      if (!sync) return json({ error: 'Owner has no cloud data yet' }, 404);
      await audit(admin, caller.id, ownerId, caller.id, 'view_shared', { scope: grant.scope, grantId: grant.id });
      if (grant.scope === 'summary') return json({ summary: summarizePayload(sync.payload), updatedAt: sync.updated_at });
      return json({ payload: sync.payload, updatedAt: sync.updated_at, scope: 'full' });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (_error) {
    return json({ error: 'The requested account operation could not be completed' }, 500);
  }
});

async function audit(client: any, actorId: string, ownerId: string, managerId: string, action: string, details: Record<string, unknown>) {
  const { error } = await client.from('study_os_access_audit').insert({ actor_id: actorId, owner_id: ownerId, manager_id: managerId, action, details });
  if (error) throw new Error('Audit log could not be written');
}
function parseSnapshotSection(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function countBuckets(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0);
}
function summarizePayload(payload: any) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { dataAvailable: false };
  const exam = parseSnapshotSection(payload.pasokhBargDigitalV2);
  const study = parseSnapshotSection(payload.pasokhBargStudyOS_v2);
  const books = Array.isArray(exam.books) ? exam.books : [];
  const chapters = books.flatMap((book: any) => Array.isArray(book?.chapters) ? book.chapters : []);
  const exams = chapters.flatMap((chapter: any) => Array.isArray(chapter?.exams) ? chapter.exams : []);
  const questionCount = exams.reduce((sum: number, entry: any) => sum + (Array.isArray(entry?.questions) ? entry.questions.length : 0), 0);
  const sessions = Array.isArray(study.sessions) ? study.sessions : [];
  const externalTests = Array.isArray(study.externalTests) ? study.externalTests : [];
  const calendarEvents = Array.isArray(study.calendarEvents) ? study.calendarEvents : [];
  const recurringClasses = Array.isArray(study.recurringClasses) ? study.recurringClasses : [];
  const dailyRows = Array.isArray(exam.dailyTestLog) ? exam.dailyTestLog : [];
  // Return counts only for a summary grant: no names, dates, email addresses, notes or answer content.
  return {
    dataAvailable: Object.keys(exam).length > 0 || Object.keys(study).length > 0,
    summaryOnly: true,
    answerSheet: {
      bookCount: books.length,
      chapterCount: chapters.length,
      examCount: exams.length,
      questionCount,
      dailyTestDayCount: dailyRows.length,
      recordedDailyQuestionCount: dailyRows.reduce((sum: number, row: any) => sum + (Array.isArray(row?.keys) ? row.keys.length : 0), 0),
    },
    study: {
      sessionCount: sessions.length,
      studySeconds: sessions.reduce((sum: number, session: any) => sum + Math.max(0, Number(session?.duration) || 0), 0),
      taskCount: countBuckets(study.tasks),
      planCount: countBuckets(study.plans),
      reviewScheduleCount: study.reviewSchedule && typeof study.reviewSchedule === 'object' ? Object.keys(study.reviewSchedule).length : 0,
      externalTestCount: externalTests.length,
      calendarEventCount: calendarEvents.length,
      recurringClassCount: recurringClasses.length,
    },
    note: 'Only anonymous record counts and total study time are included. Names, dates, notes, answer content and uploaded documents are not shared in summary mode.',
  };
}
