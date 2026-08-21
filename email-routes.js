import crypto from 'node:crypto';
import { Resend } from 'resend';

const EMAIL_STATUSES = new Set(['open', 'archived', 'spam']);
const DELIVERY_EVENTS = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }
function integer(value, fallback = null) { const result = Number.parseInt(value, 10); return Number.isInteger(result) ? result : fallback; }
function emailAddress(value) {
  const match = clean(value, 500).match(/<?([^<>\s]+@[^<>\s]+)>?$/);
  return match ? match[1].toLowerCase() : null;
}
function senderName(value) {
  const raw = clean(value, 500);
  const named = raw.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  if (named) return named;
  const address = emailAddress(raw);
  return address ? address.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Email contact';
}
function configured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL && process.env.RESEND_WEBHOOK_SECRET);
}
function resendClient() { return new Resend(process.env.RESEND_API_KEY); }

async function audit(pool, request, action, targetId, metadata = {}) {
  await pool.query(`INSERT INTO audit_events (actor_user_id,action,target_type,target_id,metadata,ip_address) VALUES ($1,$2,'email_conversation',$3,$4,$5)`, [request.adminSession?.user_id || null, action, String(targetId || ''), JSON.stringify(metadata), request.ip]);
}

async function findOrCreateInboundConversation(client, content) {
  const from = emailAddress(content.from);
  const inReplyTo = clean(content.headers?.['in-reply-to'] || content.headers?.['In-Reply-To'], 1000);
  if (inReplyTo) {
    const reply = await client.query(`SELECT c.* FROM email_messages m JOIN email_conversations c ON c.id=m.conversation_id WHERE m.internet_message_id=$1 ORDER BY m.id DESC LIMIT 1`, [inReplyTo]);
    if (reply.rowCount) return reply.rows[0];
  }
  const contact = from ? await client.query('SELECT id FROM contacts WHERE lower(email)=$1 LIMIT 1', [from]) : { rows: [] };
  const subject = clean(content.subject, 500).replace(/^\s*(re|fwd):\s*/i, '') || '(no subject)';
  const existing = await client.query(`SELECT * FROM email_conversations WHERE status='open' AND lower(subject)=lower($1) AND ($2::bigint IS NULL OR contact_id=$2) ORDER BY last_message_at DESC LIMIT 1`, [subject, contact.rows[0]?.id || null]);
  if (existing.rowCount) return existing.rows[0];
  const created = await client.query(`INSERT INTO email_conversations (subject,contact_id) VALUES ($1,$2) RETURNING *`, [subject, contact.rows[0]?.id || null]);
  return created.rows[0];
}

async function processInbound(pool, event) {
  const resend = resendClient();
  const received = await resend.emails.receiving.get(event.data.email_id, { html_format: 'cid' });
  if (received.error || !received.data) throw new Error(received.error?.message || 'Unable to retrieve inbound email content.');
  const content = received.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversation = await findOrCreateInboundConversation(client, content);
    const inserted = await client.query(`INSERT INTO email_messages (conversation_id,direction,resend_email_id,internet_message_id,in_reply_to,from_address,to_addresses,cc_addresses,bcc_addresses,subject,text_body,html_body,delivery_status,created_at) VALUES ($1,'inbound',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'received',$12) ON CONFLICT (resend_email_id) DO NOTHING RETURNING id`, [conversation.id, content.id, clean(content.message_id,1000)||null, clean(content.headers?.['in-reply-to']||content.headers?.['In-Reply-To'],1000)||null, clean(content.from,500), JSON.stringify(content.to||[]), JSON.stringify(content.cc||[]), JSON.stringify(content.bcc||[]), clean(content.subject,500)||'(no subject)', clean(content.text,100000), content.html ? clean(content.html,500000) : null, content.created_at||new Date()]);
    if (inserted.rowCount) {
      for (const attachment of content.attachments || []) {
        await client.query(`INSERT INTO email_attachments (message_id,resend_attachment_id,filename,content_type,size_bytes,content_disposition,content_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [inserted.rows[0].id, attachment.id, clean(attachment.filename,500)||'attachment', clean(attachment.content_type,200)||'application/octet-stream', attachment.size||null, clean(attachment.content_disposition,100)||null, clean(attachment.content_id,500)||null]);
      }
      await client.query(`UPDATE email_conversations SET unread=true,needs_follow_up=true,status='open',last_message_at=$2,updated_at=now() WHERE id=$1`, [conversation.id, content.created_at||new Date()]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export function registerEmailRoutes(app, { pool, requireAdmin }) {
  function requireCsrf(request, response, next) {
    if (request.get('x-csrf-token') !== request.adminSession.csrf_token) return response.status(403).json({ error: 'Invalid request token.' });
    next();
  }

  app.post('/api/webhooks/resend', async (request, response, next) => {
    try {
      if (!process.env.RESEND_WEBHOOK_SECRET || !process.env.RESEND_API_KEY) return response.status(503).json({ error: 'Email integration is not configured.' });
      const eventId = clean(request.get('svix-id'), 500);
      const rawBody = request.rawBody?.toString('utf8');
      if (!eventId || !rawBody) return response.status(400).json({ error: 'Invalid webhook request.' });
      let event;
      try {
        event = resendClient().webhooks.verify({
          payload: rawBody,
          headers: { id: eventId, timestamp: request.get('svix-timestamp') || '', signature: request.get('svix-signature') || '' },
          webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
        });
      } catch { return response.status(400).json({ error: 'Invalid webhook signature.' }); }
      const stored = await pool.query(`INSERT INTO email_webhook_events (event_id,event_type,resend_email_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`, [eventId, event.type, event.data?.email_id||null, JSON.stringify(event)]);
      if (!stored.rowCount) return response.json({ ok: true, duplicate: true });
      try {
        if (event.type === 'email.received') await processInbound(pool, event);
        else if (DELIVERY_EVENTS[event.type] && event.data?.email_id) {
          await pool.query(`UPDATE email_messages SET delivery_status=$2,error_message=$3 WHERE resend_email_id=$1`, [event.data.email_id, DELIVERY_EVENTS[event.type], clean(event.data?.reason||event.data?.error?.message,2000)||null]);
        }
      } catch (error) {
        await pool.query('DELETE FROM email_webhook_events WHERE event_id=$1', [eventId]);
        throw error;
      }
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/email/status', requireAdmin, (_request, response) => response.json({ enabled: configured(), from: process.env.RESEND_FROM_EMAIL || null }));

  app.get('/api/admin/email/conversations', requireAdmin, async (request, response, next) => {
    try {
      const values=[]; const where=[];
      const folder=clean(request.query.folder,30);
      if (folder==='unread') where.push('c.unread=true');
      else if (folder==='assigned') { values.push(request.adminSession.user_id); where.push(`c.assigned_user_id=$${values.length}`); }
      else if (folder==='archived') where.push(`c.status='archived'`);
      else if (folder==='spam') where.push(`c.status='spam'`);
      else where.push(`c.status='open'`);
      if (clean(request.query.q,100)) { values.push(`%${clean(request.query.q,100)}%`); where.push(`concat_ws(' ',c.subject,m.from_address,m.text_body,ct.first_name,ct.last_name,ct.email) ILIKE $${values.length}`); }
      const result=await pool.query(`SELECT c.*,ct.first_name,ct.last_name,ct.email contact_email,COALESCE(u.username,u.email) assigned_email,m.from_address,m.text_body preview FROM email_conversations c LEFT JOIN contacts ct ON ct.id=c.contact_id LEFT JOIN admin_users u ON u.id=c.assigned_user_id LEFT JOIN LATERAL (SELECT from_address,text_body FROM email_messages WHERE conversation_id=c.id AND direction='inbound' ORDER BY created_at DESC LIMIT 1) m ON true WHERE ${where.join(' AND ')} ORDER BY c.unread DESC,c.last_message_at DESC LIMIT 200`,values);
      response.json({ conversations: result.rows, enabled: configured() });
    } catch(error){ next(error); }
  });

  app.get('/api/admin/email/conversations/:id', requireAdmin, async (request,response,next)=>{
    try{
      const id=integer(request.params.id);
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const conversation=await client.query(`SELECT c.*,ct.first_name,ct.last_name,ct.email contact_email,COALESCE(u.username,u.email) assigned_email FROM email_conversations c LEFT JOIN contacts ct ON ct.id=c.contact_id LEFT JOIN admin_users u ON u.id=c.assigned_user_id WHERE c.id=$1`,[id]);
        if(!conversation.rowCount){await client.query('ROLLBACK');return response.status(404).json({error:'Conversation not found.'});}
        const [messages,notes,users]=await Promise.all([
          client.query(`SELECT m.*,COALESCE(json_agg(a ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL),'[]') attachments FROM email_messages m LEFT JOIN email_attachments a ON a.message_id=m.id WHERE m.conversation_id=$1 GROUP BY m.id ORDER BY m.created_at`,[id]),
          client.query(`SELECT n.*,COALESCE(u.username,u.email) author_email FROM email_internal_notes n LEFT JOIN admin_users u ON u.id=n.author_user_id WHERE n.conversation_id=$1 ORDER BY n.created_at`,[id]),
          client.query(`SELECT id,username FROM admin_users WHERE active=true ORDER BY lower(username)`),
        ]);
        await client.query(`UPDATE email_conversations SET unread=false,updated_at=now() WHERE id=$1`,[id]);
        await client.query('COMMIT');
        if(conversation.rows[0].unread) await audit(pool,request,'email.read',id);
        response.json({conversation:{...conversation.rows[0],unread:false},messages:messages.rows,notes:notes.rows,users:users.rows,enabled:configured()});
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }catch(error){next(error);}
  });

  app.patch('/api/admin/email/conversations/:id',requireAdmin,requireCsrf,async(request,response,next)=>{
    try{
      const id=integer(request.params.id); const fields=[]; const values=[id];
      if(request.body.status!==undefined){if(!EMAIL_STATUSES.has(request.body.status))return response.status(400).json({error:'Invalid status.'});values.push(request.body.status);fields.push(`status=$${values.length}`);}
      if(request.body.unread!==undefined){values.push(Boolean(request.body.unread));fields.push(`unread=$${values.length}`);}
      if(request.body.needsFollowUp!==undefined){values.push(Boolean(request.body.needsFollowUp));fields.push(`needs_follow_up=$${values.length}`);}
      if(request.body.assignedUserId!==undefined){values.push(integer(request.body.assignedUserId));fields.push(`assigned_user_id=$${values.length}`);}
      if(request.body.contactId!==undefined){values.push(integer(request.body.contactId));fields.push(`contact_id=$${values.length}`);}
      if(!fields.length)return response.status(400).json({error:'No changes supplied.'});
      const result=await pool.query(`UPDATE email_conversations SET ${fields.join(',')},updated_at=now() WHERE id=$1 RETURNING *`,values);
      if(!result.rowCount)return response.status(404).json({error:'Conversation not found.'});
      await audit(pool,request,'email.updated',id,{fields:Object.keys(request.body)});
      response.json({conversation:result.rows[0]});
    }catch(error){next(error);}
  });

  app.post('/api/admin/email/conversations/:id/notes',requireAdmin,requireCsrf,async(request,response,next)=>{
    try{const body=clean(request.body.body,5000);if(!body)return response.status(400).json({error:'Note is required.'});const result=await pool.query(`INSERT INTO email_internal_notes (conversation_id,author_user_id,body) VALUES ($1,$2,$3) RETURNING *`,[integer(request.params.id),request.adminSession.user_id,body]);await audit(pool,request,'email.note_added',request.params.id);response.status(201).json({note:result.rows[0]});}catch(error){next(error);}
  });

  app.post('/api/admin/email/conversations/:id/replies',requireAdmin,requireCsrf,async(request,response,next)=>{
    try{
      if(!configured())return response.status(503).json({error:'Resend is not configured yet. Your reply was not sent.'});
      const id=integer(request.params.id);const text=clean(request.body.text,100000);if(!text)return response.status(400).json({error:'Reply text is required.'});
      const attachments=Array.isArray(request.body.attachments)?request.body.attachments.slice(0,5):[];
      let attachmentBytes=0;
      const safeAttachments=attachments.map((attachment)=>{
        const filename=clean(attachment.filename,255);const contentType=clean(attachment.contentType,150).toLowerCase();const content=clean(attachment.content,12_000_000);
        if(!filename||!content||!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(contentType))throw Object.assign(new Error('An attachment is invalid.'),{status:400});
        if(/\.(exe|dll|bat|cmd|com|js|jar|msi|ps1|scr|vbs)$/i.test(filename)||/(x-msdownload|x-executable|javascript)/i.test(contentType))throw Object.assign(new Error('Executable attachments are not allowed.'),{status:400});
        const bytes=Buffer.byteLength(content,'base64');attachmentBytes+=bytes;return{filename,content_type:contentType,content,bytes};
      });
      if(attachmentBytes>8*1024*1024)return response.status(413).json({error:'Attachments may total no more than 8 MB.'});
      const context=await pool.query(`SELECT c.subject,m.from_address,m.internet_message_id FROM email_conversations c JOIN LATERAL (SELECT from_address,internet_message_id FROM email_messages WHERE conversation_id=c.id AND direction='inbound' ORDER BY created_at DESC LIMIT 1) m ON true WHERE c.id=$1`,[id]);
      if(!context.rowCount)return response.status(404).json({error:'Conversation or recipient not found.'});
      const recipient=emailAddress(context.rows[0].from_address);if(!recipient)return response.status(400).json({error:'The sender address is invalid.'});
      const subject=/^re:/i.test(context.rows[0].subject)?context.rows[0].subject:`Re: ${context.rows[0].subject}`;
      const draft=await pool.query(`INSERT INTO email_messages (conversation_id,direction,from_address,to_addresses,subject,text_body,delivery_status,sent_by_user_id) VALUES ($1,'outbound',$2,$3,$4,$5,'queued',$6) RETURNING id`,[id,process.env.RESEND_FROM_EMAIL,JSON.stringify([recipient]),subject,text,request.adminSession.user_id]);
      const sent=await resendClient().emails.send({from:process.env.RESEND_FROM_EMAIL,to:[recipient],subject,text,reply_to:process.env.RESEND_REPLY_TO||undefined,attachments:safeAttachments.map(({filename,content_type,content})=>({filename,content_type,content})),headers:context.rows[0].internet_message_id?{'In-Reply-To':context.rows[0].internet_message_id,'References':context.rows[0].internet_message_id}:undefined},{idempotencyKey:`lb26-reply-${draft.rows[0].id}`});
      if(sent.error){await pool.query(`UPDATE email_messages SET delivery_status='failed',error_message=$2 WHERE id=$1`,[draft.rows[0].id,clean(sent.error.message,2000)]);throw Object.assign(new Error(`Resend rejected the reply: ${sent.error.message}`),{status:502});}
      await pool.query(`UPDATE email_messages SET resend_email_id=$2,delivery_status='sent',sent_at=now() WHERE id=$1`,[draft.rows[0].id,sent.data.id]);
      for(const attachment of safeAttachments)await pool.query(`INSERT INTO email_attachments (message_id,filename,content_type,size_bytes,content_disposition) VALUES ($1,$2,$3,$4,'attachment')`,[draft.rows[0].id,attachment.filename,attachment.content_type,attachment.bytes]);
      await pool.query(`UPDATE email_conversations SET unread=false,needs_follow_up=false,last_message_at=now(),updated_at=now() WHERE id=$1`,[id]);
      await audit(pool,request,'email.reply_sent',id,{messageId:draft.rows[0].id});
      response.status(201).json({ok:true,messageId:draft.rows[0].id});
    }catch(error){next(error);}
  });

  app.post('/api/admin/email/conversations/:id/link-contact',requireAdmin,requireCsrf,async(request,response,next)=>{
    try{
      const id=integer(request.params.id);let contactId=integer(request.body.contactId);
      if(!contactId){
        const latest=await pool.query(`SELECT from_address FROM email_messages WHERE conversation_id=$1 AND direction='inbound' ORDER BY created_at DESC LIMIT 1`,[id]);
        const address=emailAddress(latest.rows[0]?.from_address);if(!address)return response.status(400).json({error:'No valid sender email was found.'});
        const found=await pool.query('SELECT id FROM contacts WHERE lower(email)=$1',[address]);
        if(found.rowCount)contactId=found.rows[0].id;
        else{const name=senderName(latest.rows[0].from_address).split(/\s+/);const created=await pool.query(`INSERT INTO contacts (first_name,last_name,email,preferred_contact) VALUES ($1,$2,$3,'email') RETURNING id`,[name.shift()||'Email',name.join(' '),address]);contactId=created.rows[0].id;}
      }
      await pool.query(`UPDATE email_conversations SET contact_id=$2,updated_at=now() WHERE id=$1`,[id,contactId]);
      await audit(pool,request,'email.contact_linked',id,{contactId});response.json({ok:true,contactId});
    }catch(error){next(error);}
  });
}
