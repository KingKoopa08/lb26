(() => {
  if (navigator.doNotTrack === '1' || location.pathname.startsWith('/admin')) return;
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let visitorId;
  let sessionId;
  try {
    visitorId = localStorage.getItem('lb26_visitor') || uuid();
    localStorage.setItem('lb26_visitor', visitorId);
    sessionId = sessionStorage.getItem('lb26_session') || uuid();
    sessionStorage.setItem('lb26_session', sessionId);
  } catch { visitorId = uuid(); sessionId = uuid(); }
  const params = new URLSearchParams(location.search);
  const attribution = { utmSource:params.get('utm_source')||'', utmMedium:params.get('utm_medium')||'', utmCampaign:params.get('utm_campaign')||'', utmTerm:params.get('utm_term')||'', utmContent:params.get('utm_content')||'' };
  const send = (eventType, eventName = '', metadata = {}) => fetch('/api/public/analytics', { method:'POST', headers:{'Content-Type':'application/json'}, keepalive:true, body:JSON.stringify({eventType,eventName,metadata,visitorId,sessionId,path:location.pathname,title:document.title,referrer:document.referrer,...attribution}) }).catch(()=>{});
  send('page_view');
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (/donat|secure\.anedot|winred/i.test(href)) send('conversion','donate_click',{href});
    else if (/get-involved|volunteer|yard-sign/i.test(href)) send('conversion','engagement_click',{href});
    else if (/^mailto:|^tel:/i.test(href)) send('conversion','contact_click',{kind:href.split(':')[0]});
  });
  document.addEventListener('submit', (event) => send('conversion','form_submit',{form:event.target.id || 'public_form'}));
})();
