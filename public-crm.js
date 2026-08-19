const involvement='/get-involved';
function wire(){document.querySelectorAll('button').forEach(button=>{if(button.dataset.crmWired)return;const text=button.textContent.trim().toLowerCase();let type=null;if(text.includes('offer my living room')||text==='host an event')type='house_party';if(text==='rsvp')type='general';if(type){button.dataset.crmWired='1';button.addEventListener('click',()=>location.assign(`${involvement}?type=${type}`),{capture:true})}})}
new MutationObserver(wire).observe(document.body,{childList:true,subtree:true});wire();
