import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

class EdgeFunctionError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status = 400, details: unknown = null) {
    super(message);
    this.name = 'EdgeFunctionError';
    this.status = status;
    this.details = details;
  }
}

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing Supabase credentials for Edge function.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function normaliseEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function listPartners() {
  const { data, error } = await supabase
    .from('partners')
    .select('id,name,email')
    .order('name', { ascending: true });

  if (error) {
    throw new EdgeFunctionError('partners-list-failed', 500, error);
  }

  return { data: data ?? [] };
}

async function ensureUser(payload: Record<string, unknown>) {
  const email = normaliseEmail(payload?.email);
  if (!email) {
    throw new EdgeFunctionError('missing-email', 400);
  }

  const name = typeof payload?.name === 'string' && payload.name.trim()
    ? payload.name.trim()
    : email;
  const linkedin = typeof payload?.linkedin === 'string' && payload.linkedin.trim()
    ? payload.linkedin.trim()
    : null;

  const { data: existing, error: lookupError } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (lookupError && lookupError.code !== 'PGRST116') {
    throw new EdgeFunctionError('users-lookup-failed', 500, lookupError);
  }

  if (existing?.id) {
    return { data: { id: existing.id } };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('users')
    .insert({ name, email, linkedin })
    .select('id')
    .single();

  if (insertError) {
    throw new EdgeFunctionError('users-insert-failed', 500, insertError);
  }

  return { data: { id: inserted.id } };
}

async function insertTasks(payload: Record<string, unknown>) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  if (!tasks.length) {
    return { data: [] };
  }

  const { data, error } = await supabase
    .from('tasks')
    .insert(tasks)
    .select('*');

  if (error) {
    throw new EdgeFunctionError('tasks-insert-failed', 500, error);
  }

  return { data: data ?? [] };
}

async function fetchCompanyByDomainOrName(payload: Record<string, unknown>) {
  const domain = typeof payload?.domain === 'string' ? payload.domain.trim() : '';
  const companyName = typeof payload?.companyName === 'string' ? payload.companyName.trim() : '';
  const columns = 'id,name,website,contact_person,email,linkedin';

  if (!domain && !companyName) {
    return { data: null };
  }

  if (domain) {
    const { data, error } = await supabase
      .from('companies')
      .select(columns)
      .ilike('website', `%${domain}%`)
      .limit(1);

    if (error) {
      throw new EdgeFunctionError('companies-lookup-domain-failed', 500, error);
    }

    if (data && data[0]) {
      return { data: data[0] };
    }
  }

  if (companyName) {
    const { data, error } = await supabase
      .from('companies')
      .select(columns)
      .eq('name', companyName)
      .limit(1);

    if (error) {
      throw new EdgeFunctionError('companies-lookup-name-failed', 500, error);
    }

    if (data && data[0]) {
      return { data: data[0] };
    }
  }

  return { data: null };
}

async function fetchCompanyTasks(payload: Record<string, unknown>) {
  const companyId = typeof payload?.companyId === 'string' ? payload.companyId : null;
  if (!companyId) {
    return { data: [] };
  }

  const { data, error } = await supabase
    .from('tasks')
    .select('id,upcoming_task,trigger_date,message_text,partner:partners(id,name,email)')
    .eq('company_id', companyId)
    .order('trigger_date', { ascending: true });

  if (error) {
    throw new EdgeFunctionError('tasks-company-fetch-failed', 500, error);
  }

  return { data: data ?? [] };
}

async function fetchCompanyById(payload: Record<string, unknown>) {
  const companyId = typeof payload?.companyId === 'string' ? payload.companyId : null;
  if (!companyId) {
    throw new EdgeFunctionError('missing-company-id', 400);
  }

  const { data, error } = await supabase
    .from('companies')
    .select('id,name,website,contact_person,email,linkedin')
    .eq('id', companyId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new EdgeFunctionError('companies-lookup-id-failed', 500, error);
  }

  return { data: data ?? null };
}

async function buildTaskQuery({
  userId,
  userEmail,
  excludeCompanyId,
  limit,
  comparison,
}: {
  userId?: string | null;
  userEmail?: string | null;
  excludeCompanyId?: string | null;
  limit?: number;
  comparison: 'gte' | 'lte' | 'gt';
}) {
  const nowIso = new Date().toISOString();
  const select = 'id,company_id,upcoming_task,trigger_date,created_at,message_text,context,company:companies(id,name,website,contact_person,email,linkedin),partner:partners(id,name,email),assignee:users(id,email)';

  let query = supabase
    .from('tasks')
    .select(select)
    .order('trigger_date', { ascending: true });

  const normalizedUserId = typeof userId === 'string' && userId.trim() ? userId.trim() : null;
  const normalizedEmail = typeof userEmail === 'string' && userEmail.trim() ? userEmail.trim().toLowerCase() : null;

  if (!normalizedUserId && !normalizedEmail) {
    return query.limit(0);
  }

  if (normalizedUserId) {
    query = query.eq('user_id', normalizedUserId);
  }

  if (normalizedEmail) {
    query = query.eq('assignee.email', normalizedEmail);
  }

  if (comparison === 'gte') {
    query = query.gte('trigger_date', nowIso);
  } else if (comparison === 'lte') {
    query = query.lte('trigger_date', nowIso);
  } else if (comparison === 'gt') {
    query = query.gt('trigger_date', nowIso);
  }

  if (limit && Number.isFinite(limit)) {
    query = query.limit(limit);
  }

  if (excludeCompanyId) {
    query = query.neq('company_id', excludeCompanyId);
  }

  return query;
}

async function fetchOutstandingTasks(payload: Record<string, unknown>) {
  const userId = typeof payload?.userId === 'string' ? payload.userId : '';
  const userEmail = typeof payload?.userEmail === 'string' ? payload.userEmail.trim().toLowerCase() : '';
  if (!userId && !userEmail) {
    return { data: [] };
  }

  const excludeCompanyId = typeof payload?.excludeCompanyId === 'string' ? payload.excludeCompanyId : null;
  const query = await buildTaskQuery({
    userId,
    userEmail,
    excludeCompanyId,
    limit: 12,
    comparison: 'gte',
  });

  const { data, error } = await query;

  if (error) {
    throw new EdgeFunctionError('tasks-outstanding-fetch-failed', 500, error);
  }

  return { data: Array.isArray(data) ? data : [] };
}

async function fetchOverdueTasks(payload: Record<string, unknown>) {
  const userId = typeof payload?.userId === 'string' ? payload.userId : '';
  const userEmail = typeof payload?.userEmail === 'string' ? payload.userEmail.trim().toLowerCase() : '';
  if (!userId && !userEmail) {
    return { data: [] };
  }

  const limit = typeof payload?.limit === 'number' ? payload.limit : 20;
  const query = await buildTaskQuery({
    userId,
    userEmail,
    limit,
    comparison: 'lte',
  });

  const { data, error } = await query;

  if (error) {
    throw new EdgeFunctionError('tasks-overdue-fetch-failed', 500, error);
  }

  return { data: Array.isArray(data) ? data : [] };
}

async function fetchUpcomingTasks(payload: Record<string, unknown>) {
  const userId = typeof payload?.userId === 'string' ? payload.userId : '';
  const userEmail = typeof payload?.userEmail === 'string' ? payload.userEmail.trim().toLowerCase() : '';
  if (!userId && !userEmail) {
    return { data: [] };
  }

  const limit = typeof payload?.limit === 'number' ? payload.limit : 40;
  const query = await buildTaskQuery({
    userId,
    userEmail,
    limit,
    comparison: 'gt',
  });

  const { data, error } = await query;

  if (error) {
    throw new EdgeFunctionError('tasks-upcoming-fetch-failed', 500, error);
  }

  return { data: Array.isArray(data) ? data : [] };
}

async function deleteTask(payload: Record<string, unknown>) {
  const taskId = typeof payload?.taskId === 'string' ? payload.taskId : '';
  if (!taskId) {
    throw new EdgeFunctionError('missing-task-id', 400);
  }

  const { data, error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', taskId)
    .select('id');

  if (error) {
    throw new EdgeFunctionError('tasks-delete-failed', 500, error);
  }

  const deleted = Array.isArray(data) && data.length > 0;
  return { data: { deleted } };
}

async function insertCompany(payload: Record<string, unknown>) {
  const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
  const website = typeof payload?.website === 'string' ? payload.website.trim() : null;
  const contact = typeof payload?.contact_person === 'string' ? payload.contact_person.trim() : '';
  const email = typeof payload?.email === 'string' ? payload.email.trim() : '';
  const linkedin = typeof payload?.linkedin === 'string' ? payload.linkedin.trim() : null;

  if (!name || !contact || !email) {
    throw new EdgeFunctionError('missing-required-fields', 400);
  }

  const { data, error } = await supabase
    .from('companies')
    .insert({
      name,
      website: website || null,
      contact_person: contact,
      email,
      linkedin: linkedin || null,
    })
    .select('id,name,website,contact_person,email,linkedin')
    .single();

  if (error) {
    throw new EdgeFunctionError('companies-insert-failed', 500, error);
  }

  return { data };
}

async function getUserByEmail(payload: Record<string, unknown>) {
  const email = normaliseEmail(payload?.email);
  if (!email) {
    throw new EdgeFunctionError('missing-email', 400);
  }

  const columns = typeof payload?.columns === 'string' && payload.columns.trim()
    ? payload.columns.trim()
    : 'id,email';

  const { data, error } = await supabase
    .from('users')
    .select(columns)
    .eq('email', email)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new EdgeFunctionError('users-lookup-failed', 500, error);
  }

  return { data: data ?? null };
}

async function upsertUserUnipile(payload: Record<string, unknown>) {
  const record = payload?.record;
  if (!record || typeof record !== 'object' || record === null) {
    throw new EdgeFunctionError('missing-record', 400);
  }

  const email = normaliseEmail((record as Record<string, unknown>).email);
  if (!email) {
    throw new EdgeFunctionError('missing-email', 400);
  }

  const upsertPayload = { ...record, email } as Record<string, unknown>;

  const { data, error } = await supabase
    .from('users')
    .upsert(upsertPayload, { onConflict: 'email', ignoreDuplicates: false, defaultToNull: false })
    .select('*');

  if (error) {
    throw new EdgeFunctionError('users-upsert-failed', 500, error);
  }

  return { data: data ?? [] };
}

const handlers: Record<string, (payload: Record<string, unknown>) => Promise<{ data: unknown }>> = {
  list_partners: listPartners,
  ensure_user: ensureUser,
  insert_tasks: insertTasks,
  fetch_company_by_domain_or_name: fetchCompanyByDomainOrName,
  fetch_company_tasks: fetchCompanyTasks,
  fetch_company_by_id: fetchCompanyById,
  fetch_outstanding_tasks: fetchOutstandingTasks,
  fetch_overdue_tasks: fetchOverdueTasks,
  fetch_upcoming_tasks: fetchUpcomingTasks,
  delete_task: deleteTask,
  insert_company: insertCompany,
  get_user_by_email: getUserByEmail,
  upsert_user_unipile: upsertUserUnipile,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method-not-allowed' });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return jsonResponse(400, { ok: false, error: 'invalid-json', details: err instanceof Error ? err.message : String(err) });
  }

  const action = typeof (body as Record<string, unknown>)?.action === 'string'
    ? (body as Record<string, unknown>).action
    : '';
  const payload = (body as Record<string, unknown>)?.payload;

  const handler = handlers[action];
  if (!handler) {
    return jsonResponse(400, { ok: false, error: 'unknown-action' });
  }

  try {
    const result = await handler((payload as Record<string, unknown>) ?? {});
    return jsonResponse(200, { ok: true, data: result?.data ?? null });
  } catch (err) {
    if (err instanceof EdgeFunctionError) {
      return jsonResponse(err.status, { ok: false, error: err.message, details: err.details });
    }
    return jsonResponse(500, {
      ok: false,
      error: err instanceof Error ? err.message : 'unknown-error',
      details: err instanceof Error ? err.stack : err,
    });
  }
});
