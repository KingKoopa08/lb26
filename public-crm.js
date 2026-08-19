const involvement='/get-involved';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let publicEvents=null;
let eventsRequest=null;
function renderEvents(list,events){
  list.dataset.liveEvents='1';
  list.innerHTML=events.length?events.map(e=>{const when=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:e.timezone}).format(new Date(e.starts_at));return `<div style="display:flex;gap:16px;align-items:center;background:#fff;border:1px solid rgba(30,7,51,.1);border-radius:14px;padding:16px 18px"><div style="flex:1"><div style="font:700 15px/1.3 'Libre Franklin'">${esc(e.title)}</div><div style="font:400 12.5px/1.5 'Libre Franklin';color:rgba(30,7,51,.6)">${esc([e.venue,e.city].filter(Boolean).join(', '))} · ${esc(when)}</div></div><a href="${involvement}?type=rsvp&amp;eventId=${e.id}&amp;title=${encodeURIComponent(e.title)}" style="background:#1E0733;color:#fff;font:800 11px/1 'Libre Franklin';letter-spacing:.08em;padding:12px 15px;border-radius:7px;text-decoration:none">RSVP</a></div>`}).join(''):'<p style="font:400 14px/1.6 Libre Franklin;color:rgba(30,7,51,.65)">No public events are scheduled yet. Check back soon.</p>';
}
function wire(){
  document.querySelectorAll('button').forEach(button=>{if(button.dataset.crmWired)return;const text=button.textContent.trim().toLowerCase();let type=null;if(text.includes('offer my living room')||text==='host an event')type='house_party';if(type){button.dataset.crmWired='1';button.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();location.assign(`${involvement}?type=${type}`)},{capture:true})}});
  const marker=document.getElementById('live-event-status');
  const list=marker?.parentElement?.nextElementSibling;
  if(!list)return;
  marker.hidden=true;
  if(publicEvents){if(list.dataset.liveEvents!=='1')renderEvents(list,publicEvents);return}
  if(eventsRequest)return;
  eventsRequest=fetch('/api/public/events').then(r=>{if(!r.ok)throw new Error();return r.json()}).then(({events})=>{publicEvents=events;eventsRequest=null;wire()}).catch(()=>{eventsRequest=null;list.dataset.liveEvents='1';list.innerHTML='<p>Events are temporarily unavailable.</p>'});
}
new MutationObserver(wire).observe(document.body,{childList:true,subtree:true});wire();
