const REQUEST_TYPES = new Set(['volunteer','yard_sign','house_party','host_event','rsvp','general']);
const REQUEST_STATUSES = new Set(['new','contacted','scheduled','completed','declined','duplicate','spam']);
const EVENT_STATUSES = new Set(['draft','published','canceled','completed','archived']);
const publicAttempts = new Map();

function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }
function email(value) { const result = clean(value, 254).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) ? result : null; }
function phone(value) { const digits = clean(value, 40).replace(/\D/g, ''); return digits.length >= 10 && digits.length <= 15 ? digits : null; }
function integer(value, fallback = null) { const result = Number.parseInt(value, 10); return Number.isInteger(result) ? result : fallback; }
function jsonDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [clean(key, 60), clean(item, 2000)]));
}
function publicAllowed(ip) {
  const now = Date.now();
  const recent = (publicAttempts.get(ip) || []).filter((at) => now - at < 60 * 60 * 1000);
  publicAttempts.set(ip, recent);
  return recent.length < 30;
}
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function upsertContact(client, body) {
  const contactEmail = email(body.email);
  const contactPhone = phone(body.phone);
  if (!contactEmail && !contactPhone) throw Object.assign(new Error('A valid email or phone is required.'), { status: 400 });
  const firstName = clean(body.firstName || body.name?.split(' ')[0], 100);
  const lastName = clean(body.lastName || body.name?.split(' ').slice(1).join(' '), 100);
  if (!firstName) throw Object.assign(new Error('First name is required.'), { status: 400 });
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [contactEmail || contactPhone]);
  const found = await client.query('SELECT * FROM contacts WHERE ($1::text IS NOT NULL AND lower(email)=$1) OR ($2::text IS NOT NULL AND phone=$2) ORDER BY id LIMIT 1', [contactEmail, contactPhone]);
  if (found.rowCount) {
    const row = found.rows[0];
    const updated = await client.query(`UPDATE contacts SET first_name=$2,last_name=CASE WHEN $3='' THEN last_name ELSE $3 END,email=COALESCE(email,$4),phone=COALESCE(phone,$5),address_line1=COALESCE(NULLIF($6,''),address_line1),address_line2=COALESCE(NULLIF($7,''),address_line2),city=COALESCE(NULLIF($8,''),city),postal_code=COALESCE(NULLIF($9,''),postal_code),preferred_contact=COALESCE($10,preferred_contact),consent=consent OR $11,consent_at=CASE WHEN $11 THEN COALESCE(consent_at,now()) ELSE consent_at END,updated_at=now() WHERE id=$1 RETURNING *`, [row.id, firstName, lastName, contactEmail, contactPhone, clean(body.addressLine1, 250), clean(body.addressLine2, 250), clean(body.city, 100), clean(body.postalCode, 20), ['email','phone','text'].includes(body.preferredContact) ? body.preferredContact : null, body.consent === true || body.consent === 'true']);
    return updated.rows[0];
  }
  const inserted = await client.query(`INSERT INTO contacts (first_name,last_name,email,phone,address_line1,address_line2,city,postal_code,preferred_contact,consent,consent_at) VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),$9,$10,CASE WHEN $10 THEN now() END) RETURNING *`, [firstName,lastName,contactEmail,contactPhone,clean(body.addressLine1,250),clean(body.addressLine2,250),clean(body.city,100),clean(body.postalCode,20),['email','phone','text'].includes(body.preferredContact)?body.preferredContact:null,body.consent===true||body.consent==='true']);
  return inserted.rows[0];
}

export function registerRoutes(app, { pool, requireAdmin }) {
  function requireCsrf(request, response, next) {
    if (request.get('x-csrf-token') !== request.adminSession.csrf_token) return response.status(403).json({ error: 'Invalid request token.' });
    next();
  }

  app.get('/api/public/events', async (_request, response, next) => {
    try {
      const result = await pool.query(`SELECT id,title,event_type,description,starts_at,ends_at,timezone,venue,address,city,state,postal_code,capacity,waitlist_enabled FROM events WHERE status='published' AND starts_at>=now() ORDER BY starts_at LIMIT 100`);
      response.json({ events: result.rows });
    } catch (error) { next(error); }
  });

  app.post('/api/public/submissions', async (request, response, next) => {
    if (!publicAllowed(request.ip)) return response.status(429).json({ error: 'Too many requests. Please try again later.' });
    publicAttempts.set(request.ip, [...(publicAttempts.get(request.ip) || []), Date.now()]);
    if (clean(request.body.website, 100)) return response.status(202).json({ ok: true });
    const requestType = clean(request.body.requestType, 30);
    if (!REQUEST_TYPES.has(requestType)) return response.status(400).json({ error: 'Invalid request type.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const contact = await upsertContact(client, request.body);
      const details = jsonDetails(request.body.details);
      let eventRsvp = null;
      if (requestType === 'rsvp') {
        const eventId = integer(request.body.eventId);
        const guests = Math.min(20, Math.max(1, integer(request.body.guestCount, 1)));
        const eventResult = await client.query(`SELECT * FROM events WHERE id=$1 AND status='published' FOR UPDATE`, [eventId]);
        if (!eventResult.rowCount) throw Object.assign(new Error('That event is not available.'), { status: 404 });
        const event = eventResult.rows[0];
        const reservedResult = await client.query(`SELECT COALESCE(SUM(guest_count),0)::int AS reserved FROM event_rsvps WHERE event_id=$1 AND status IN ('confirmed','checked_in')`, [event.id]);
        const priorResult = await client.query(`SELECT guest_count,status FROM event_rsvps WHERE event_id=$1 AND contact_id=$2 FOR UPDATE`,[event.id,contact.id]);
        const priorConfirmed = priorResult.rows[0] && ['confirmed','checked_in'].includes(priorResult.rows[0].status) ? priorResult.rows[0].guest_count : 0;
        const projectedGuests = reservedResult.rows[0].reserved - priorConfirmed + guests;
        const rsvpStatus = event.capacity && projectedGuests > event.capacity ? (event.waitlist_enabled ? 'waitlisted' : null) : 'confirmed';
        if (!rsvpStatus) throw Object.assign(new Error('That event is full.'), { status: 409 });
        eventRsvp = await client.query(`INSERT INTO event_rsvps (event_id,contact_id,guest_count,status,notes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id,contact_id) DO UPDATE SET guest_count=EXCLUDED.guest_count,status=EXCLUDED.status,notes=EXCLUDED.notes,updated_at=now() RETURNING *`, [event.id,contact.id,guests,rsvpStatus,clean(details.notes,1000)]);
        details.eventId = String(event.id);
        details.rsvpStatus = rsvpStatus;
      }
      const created = await client.query(`INSERT INTO crm_requests (contact_id,request_type,source,details) VALUES ($1,$2,$3,$4) RETURNING id`, [contact.id,requestType,clean(request.body.source||'website',100),JSON.stringify(details)]);
      await client.query(`INSERT INTO consent_events (contact_id,consent,source) VALUES ($1,$2,$3)`,[contact.id,request.body.consent===true||request.body.consent==='true',clean(request.body.source||'website',100)]);
      await client.query('COMMIT');
      response.status(201).json({ ok: true, requestId: created.rows[0].id, rsvpStatus: eventRsvp?.rows[0]?.status || null });
    } catch (error) { await client.query('ROLLBACK'); next(error); } finally { client.release(); }
  });

  app.get('/api/admin/dashboard', requireAdmin, async (_request, response, next) => {
    try {
      const [counts, recent, upcoming, overdue] = await Promise.all([
        pool.query(`SELECT request_type,count(*)::int FROM crm_requests WHERE status='new' GROUP BY request_type`),
        pool.query(`SELECT r.id,r.request_type,r.status,r.created_at,c.id contact_id,c.first_name,c.last_name,c.email,c.phone FROM crm_requests r JOIN contacts c ON c.id=r.contact_id ORDER BY r.created_at DESC LIMIT 12`),
        pool.query(`SELECT e.id,e.title,e.starts_at,e.status,count(r.id)::int rsvp_count FROM events e LEFT JOIN event_rsvps r ON r.event_id=e.id AND r.status<>'canceled' WHERE e.starts_at>=now() GROUP BY e.id ORDER BY e.starts_at LIMIT 8`),
        pool.query(`SELECT count(*)::int AS count FROM crm_requests WHERE status NOT IN ('completed','declined','duplicate','spam') AND next_follow_up_at<now()`),
      ]);
      response.json({ newRequests: Object.fromEntries(counts.rows.map((r) => [r.request_type,r.count])), recent: recent.rows, upcoming: upcoming.rows, overdue: overdue.rows[0].count });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/requests', requireAdmin, async (request, response, next) => {
    try {
      const values = [];
      const where = [];
      if (REQUEST_TYPES.has(request.query.type)) { values.push(request.query.type); where.push(`r.request_type=$${values.length}`); }
      if (REQUEST_STATUSES.has(request.query.status)) { values.push(request.query.status); where.push(`r.status=$${values.length}`); }
      if (clean(request.query.q,100)) { values.push(`%${clean(request.query.q,100)}%`); where.push(`concat_ws(' ',c.first_name,c.last_name,c.email,c.phone,c.city,c.postal_code) ILIKE $${values.length}`); }
      values.push(Math.min(200,Math.max(1,integer(request.query.limit,50))));
      const result = await pool.query(`SELECT r.*,c.first_name,c.last_name,c.email,c.phone,c.city,c.postal_code FROM crm_requests r JOIN contacts c ON c.id=r.contact_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY r.created_at DESC LIMIT $${values.length}`, values);
      response.json({ requests: result.rows });
    } catch (error) { next(error); }
  });

  app.patch('/api/admin/requests/:id', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      if (!REQUEST_STATUSES.has(request.body.status)) return response.status(400).json({ error: 'Invalid status.' });
      const result = await pool.query(`UPDATE crm_requests SET status=$2,next_follow_up_at=$3,owner_user_id=COALESCE($4,owner_user_id),updated_at=now() WHERE id=$1 RETURNING *`, [integer(request.params.id),request.body.status,request.body.nextFollowUpAt||null,integer(request.body.ownerUserId)]);
      if (!result.rowCount) return response.status(404).json({ error: 'Request not found.' });
      await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,metadata,ip_address) VALUES ($1,'request.updated','crm_request',$2,$3,$4)`, [request.adminSession.user_id,String(result.rows[0].id),JSON.stringify({status:request.body.status}),request.ip]);
      response.json({ request: result.rows[0] });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/contacts/:id', requireAdmin, async (request, response, next) => {
    try {
      const id = integer(request.params.id);
      const [contact, requests, notes, rsvps, tasks] = await Promise.all([
        pool.query('SELECT * FROM contacts WHERE id=$1',[id]),
        pool.query('SELECT * FROM crm_requests WHERE contact_id=$1 ORDER BY created_at DESC',[id]),
        pool.query(`SELECT n.*,u.email author_email FROM contact_notes n LEFT JOIN admin_users u ON u.id=n.author_user_id WHERE n.contact_id=$1 ORDER BY n.created_at DESC`,[id]),
        pool.query(`SELECT r.*,e.title,e.starts_at FROM event_rsvps r JOIN events e ON e.id=r.event_id WHERE r.contact_id=$1 ORDER BY e.starts_at DESC`,[id]),
        pool.query('SELECT * FROM follow_up_tasks WHERE contact_id=$1 ORDER BY completed_at NULLS FIRST,due_at',[id]),
      ]);
      if (!contact.rowCount) return response.status(404).json({ error: 'Contact not found.' });
      response.json({ contact:contact.rows[0],requests:requests.rows,notes:notes.rows,rsvps:rsvps.rows,tasks:tasks.rows });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/contacts/:id/notes', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const body = clean(request.body.body,5000);
      if (!body) return response.status(400).json({ error: 'Note is required.' });
      const result = await pool.query('INSERT INTO contact_notes (contact_id,author_user_id,body) VALUES ($1,$2,$3) RETURNING *',[integer(request.params.id),request.adminSession.user_id,body]);
      await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,ip_address) VALUES ($1,'contact.note_added','contact',$2,$3)`,[request.adminSession.user_id,String(request.params.id),request.ip]);
      response.status(201).json({ note:result.rows[0] });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/contacts/:id/tasks', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const title=clean(request.body.title,300);
      if(!title) return response.status(400).json({error:'Task title is required.'});
      const result=await pool.query(`INSERT INTO follow_up_tasks (contact_id,owner_user_id,title,due_at) VALUES ($1,$2,$3,$4) RETURNING *`,[integer(request.params.id),request.adminSession.user_id,title,request.body.dueAt||null]);
      await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,ip_address) VALUES ($1,'task.created','follow_up_task',$2,$3)`,[request.adminSession.user_id,String(result.rows[0].id),request.ip]);
      response.status(201).json({task:result.rows[0]});
    } catch(error){next(error);}
  });

  app.post('/api/admin/contacts/:id/anonymize', requireAdmin, requireCsrf, async (request,response,next)=>{
    const client=await pool.connect();
    try {
      if(request.body.confirm!=='ANONYMIZE') return response.status(400).json({error:'Explicit ANONYMIZE confirmation is required.'});
      await client.query('BEGIN');
      const id=integer(request.params.id);
      const result=await client.query(`UPDATE contacts SET first_name='Deleted',last_name='Contact',email=NULL,phone=NULL,address_line1=NULL,address_line2=NULL,city=NULL,postal_code=NULL,preferred_contact=NULL,consent=false,owner_user_id=NULL,next_follow_up_at=NULL,deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,[id]);
      if(!result.rowCount){await client.query('ROLLBACK');return response.status(404).json({error:'Active contact not found.'})}
      await client.query('DELETE FROM contact_notes WHERE contact_id=$1',[id]);
      await client.query(`UPDATE crm_requests SET details='{}'::jsonb,updated_at=now() WHERE contact_id=$1`,[id]);
      await client.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,ip_address) VALUES ($1,'contact.anonymized','contact',$2,$3)`,[request.adminSession.user_id,String(id),request.ip]);
      await client.query('COMMIT');response.json({ok:true});
    } catch(error){await client.query('ROLLBACK');next(error)}finally{client.release()}
  });

  app.patch('/api/admin/tasks/:id', requireAdmin, requireCsrf, async (request,response,next)=>{
    try {
      const result=await pool.query(`UPDATE follow_up_tasks SET completed_at=CASE WHEN $2 THEN COALESCE(completed_at,now()) ELSE NULL END,due_at=COALESCE($3,due_at) WHERE id=$1 RETURNING *`,[integer(request.params.id),request.body.completed===true,request.body.dueAt||null]);
      if(!result.rowCount) return response.status(404).json({error:'Task not found.'});
      await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,metadata,ip_address) VALUES ($1,'task.updated','follow_up_task',$2,$3,$4)`,[request.adminSession.user_id,String(result.rows[0].id),JSON.stringify({completed:request.body.completed===true}),request.ip]);
      response.json({task:result.rows[0]});
    } catch(error){next(error);}
  });

  app.get('/api/admin/tags', requireAdmin, async (_request,response,next)=>{try{const result=await pool.query('SELECT * FROM tags ORDER BY lower(name)');response.json({tags:result.rows})}catch(error){next(error)}});
  app.post('/api/admin/tags', requireAdmin, requireCsrf, async (request,response,next)=>{try{const name=clean(request.body.name,100);if(!name)return response.status(400).json({error:'Tag name is required.'});const result=await pool.query(`INSERT INTO tags (name,color) VALUES ($1,$2) ON CONFLICT (lower(name)) DO UPDATE SET color=EXCLUDED.color RETURNING *`,[name,/^#[0-9a-f]{6}$/i.test(request.body.color)?request.body.color:'#7A1FB8']);response.status(201).json({tag:result.rows[0]})}catch(error){next(error)}});
  app.post('/api/admin/contacts/:id/tags', requireAdmin, requireCsrf, async (request,response,next)=>{try{const result=await pool.query(`INSERT INTO contact_tags (contact_id,tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *`,[integer(request.params.id),integer(request.body.tagId)]);response.status(201).json({added:result.rowCount===1})}catch(error){next(error)}});

  app.post('/api/admin/requests/bulk', requireAdmin, requireCsrf, async (request,response,next)=>{
    try {
      const ids=Array.isArray(request.body.ids)?request.body.ids.map(integer).filter(Boolean).slice(0,500):[];
      if(!ids.length||!REQUEST_STATUSES.has(request.body.status)) return response.status(400).json({error:'Request IDs and a valid status are required.'});
      const result=await pool.query(`UPDATE crm_requests SET status=$2,updated_at=now() WHERE id=ANY($1::bigint[]) RETURNING id`,[ids,request.body.status]);
      await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,metadata,ip_address) VALUES ($1,'request.bulk_updated','crm_request',$2,$3)`,[request.adminSession.user_id,JSON.stringify({ids:result.rows.map(r=>r.id),status:request.body.status}),request.ip]);
      response.json({updated:result.rowCount});
    } catch(error){next(error);}
  });

  app.get('/api/admin/events', requireAdmin, async (_request, response, next) => {
    try { const result=await pool.query(`SELECT e.*,count(r.id)::int rsvp_count,COALESCE(sum(r.guest_count) FILTER (WHERE r.status IN ('confirmed','checked_in')),0)::int guest_count FROM events e LEFT JOIN event_rsvps r ON r.event_id=e.id GROUP BY e.id ORDER BY e.starts_at DESC`); response.json({events:result.rows}); } catch(error){ next(error); }
  });

  app.get('/api/admin/events/:id/rsvps', requireAdmin, async (request,response,next)=>{
    try {
      const result=await pool.query(`SELECT r.id,r.guest_count,r.status,r.notes,r.created_at,c.id contact_id,c.first_name,c.last_name,c.email,c.phone FROM event_rsvps r JOIN contacts c ON c.id=r.contact_id WHERE r.event_id=$1 ORDER BY r.created_at`,[integer(request.params.id)]);
      response.json({rsvps:result.rows});
    } catch(error){next(error);}
  });

  app.get('/api/admin/events/:id/rsvps.csv', requireAdmin, async (request,response,next)=>{
    try {
      const result=await pool.query(`SELECT r.status,r.guest_count,r.created_at,c.first_name,c.last_name,c.email,c.phone FROM event_rsvps r JOIN contacts c ON c.id=r.contact_id WHERE r.event_id=$1 ORDER BY r.created_at`,[integer(request.params.id)]);
      const headers=['status','guest_count','created_at','first_name','last_name','email','phone'];
      const csv=[headers.map(csvCell).join(','),...result.rows.map(row=>headers.map(key=>csvCell(row[key])).join(','))].join('\r\n');
      response.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="event-${integer(request.params.id)}-rsvps.csv"`}).send(csv);
    } catch(error){next(error);}
  });

  app.post('/api/admin/events', requireAdmin, requireCsrf, async (request, response, next) => {
    try {
      const b=request.body;
      if(!clean(b.title,200)||!b.startsAt||!EVENT_STATUSES.has(b.status||'draft')) return response.status(400).json({error:'Title, start time, and valid status are required.'});
      const result=await pool.query(`INSERT INTO events (title,event_type,description,starts_at,ends_at,timezone,venue,address,city,state,postal_code,capacity,waitlist_enabled,status,organizer,contact_email,accessibility_notes,internal_notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,[clean(b.title,200),clean(b.eventType||'campaign',80),clean(b.description,5000),b.startsAt,b.endsAt||null,clean(b.timezone||'America/Chicago',80),clean(b.venue,200)||null,clean(b.address,300)||null,clean(b.city,100)||null,clean(b.state||'LA',10),clean(b.postalCode,20)||null,integer(b.capacity),b.waitlistEnabled!==false,b.status||'draft',clean(b.organizer,200)||null,email(b.contactEmail),clean(b.accessibilityNotes,2000)||null,clean(b.internalNotes,5000)||null,request.adminSession.user_id]);
      await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,ip_address) VALUES ($1,'event.created','event',$2,$3)`,[request.adminSession.user_id,String(result.rows[0].id),request.ip]);
      response.status(201).json({event:result.rows[0]});
    } catch(error){ next(error); }
  });

  app.patch('/api/admin/events/:id', requireAdmin, requireCsrf, async (request,response,next)=>{
    try {
      const current=await pool.query('SELECT * FROM events WHERE id=$1',[integer(request.params.id)]);
      if(!current.rowCount) return response.status(404).json({error:'Event not found.'});
      const old=current.rows[0];const body=request.body;
      const status=body.status??old.status;
      if(!EVENT_STATUSES.has(status)) return response.status(400).json({error:'Invalid status.'});
      const endsAt=Object.hasOwn(body,'endsAt')?body.endsAt:(Object.hasOwn(body,'ends_at')?body.ends_at:old.ends_at);
      const capacity=Object.hasOwn(body,'capacity')?integer(body.capacity):old.capacity;
      const result=await pool.query(`UPDATE events SET title=$2,event_type=$3,description=$4,starts_at=$5,ends_at=$6,timezone=$7,venue=$8,address=$9,city=$10,state=$11,postal_code=$12,capacity=$13,waitlist_enabled=$14,status=$15,organizer=$16,contact_email=$17,accessibility_notes=$18,internal_notes=$19,updated_at=now() WHERE id=$1 RETURNING *`,[integer(request.params.id),clean(body.title??old.title,200),clean(body.eventType??body.event_type??old.event_type,80),clean(body.description??old.description,5000),body.startsAt??body.starts_at??old.starts_at,endsAt,clean(body.timezone??old.timezone,80),clean(body.venue??old.venue,200)||null,clean(body.address??old.address,300)||null,clean(body.city??old.city,100)||null,clean(body.state??old.state,10),clean(body.postalCode??body.postal_code??old.postal_code,20)||null,capacity,body.waitlistEnabled??body.waitlist_enabled??old.waitlist_enabled,status,clean(body.organizer??old.organizer,200)||null,email(body.contactEmail??body.contact_email??old.contact_email),clean(body.accessibilityNotes??body.accessibility_notes??old.accessibility_notes,2000)||null,clean(body.internalNotes??body.internal_notes??old.internal_notes,5000)||null]);
      await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,metadata,ip_address) VALUES ($1,'event.updated','event',$2,$3,$4)`,[request.adminSession.user_id,String(request.params.id),JSON.stringify({status}),request.ip]);
      response.json({event:result.rows[0]});
    } catch(error){next(error);}
  });

  app.get('/api/admin/export/requests.csv', requireAdmin, async (_request,response,next)=>{
    try {
      const result=await pool.query(`SELECT r.id,r.request_type,r.status,r.source,r.created_at,c.first_name,c.last_name,c.email,c.phone,c.address_line1,c.city,c.state,c.postal_code FROM crm_requests r JOIN contacts c ON c.id=r.contact_id ORDER BY r.created_at DESC`);
      const headers=['id','request_type','status','source','created_at','first_name','last_name','email','phone','address_line1','city','state','postal_code'];
      const csv=[headers.map(csvCell).join(','),...result.rows.map(row=>headers.map(key=>csvCell(row[key])).join(','))].join('\r\n');
      response.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="campaign-requests.csv"'}).send(csv);
    } catch(error){next(error);}
  });
}
