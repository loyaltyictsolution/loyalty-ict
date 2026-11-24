/* Loyalty ICT — live chat, AI advisor, automated M-Pesa (STK push), page sections */
(()=>{
const CFG={
  TILL:'1934417',                     // <-- your M-Pesa Till number (shown to customers as backup)
  TILL_NAME:'Loyalty ICT Solutions',
  FN:'https://us-central1-loyaltyitsolutions-a82f0.cloudfunctions.net',
  WA:'254713474115'
};
const $=s=>document.querySelector(s);
const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const KES=n=>'KSh '+Number(n||0).toLocaleString('en-KE');
const fb=()=>window.FB;
const ready=f=>window.FB?f():window.addEventListener('firebase-ready',f,{once:true});
const prods=()=>{try{return cache.products||[]}catch(e){return[]}};
const tillOk=()=>/^\d{5,7}$/.test(CFG.TILL);

/* ---------- page sections ---------- */
function sections(){
  const why=$('#why'); if(!why||$('#lx-how')) return;
  const h=`<section class="lx-sec lx-rev" id="lx-how"><div class="ey">How it works</div><h2>Buy in three simple steps</h2>
  <p class="sub">No account needed. Pay from your phone and get a receipt instantly.</p>
  <div class="lx-steps">
  <div class="lx-step"><b class="n">1</b><h3>Pick your product</h3><p>Browse the store, or ask our AI assistant which one fits your budget and needs.</p></div>
  <div class="lx-step"><b class="n">2</b><h3>Pay with M-Pesa</h3><p>Enter your number. A prompt appears on your phone. Enter your PIN. Done.</p></div>
  <div class="lx-step"><b class="n">3</b><h3>We deliver or you collect</h3><p>Our team confirms your order and arranges delivery in Nairobi and beyond.</p></div></div></section>
  <section class="lx-sec lx-rev"><div class="lx-pay"><div><span class="mp">M-PESA</span><h2 style="color:#fff;margin:10px 0 4px">Lipa na M-Pesa. Instant and secure.</h2>
  <p style="opacity:.85;max-width:460px">Pay at checkout with a phone prompt. Your PIN never touches our website.</p></div>
  ${tillOk()?`<div style="text-align:right"><small style="opacity:.8">BUY GOODS TILL NUMBER</small><div class="till">${CFG.TILL}</div><small>${E(CFG.TILL_NAME)}</small></div>`:''}</div></section>
  <section class="lx-sec lx-faq lx-rev"><div class="ey">Questions</div><h2>Frequently asked</h2><br>
  <details><summary>How do I pay?</summary><p>Choose M-Pesa at checkout. You get a prompt on your phone. Enter your PIN to confirm. You can also pay manually to our Till number.</p></details>
  <details><summary>Are the products genuine?</summary><p>Yes. We sell genuine, tested hardware. Ask the AI assistant or our team for the exact specs of any item.</p></details>
  <details><summary>Do you deliver?</summary><p>Yes. Add your delivery area at checkout. We confirm cost and timing with you on call or WhatsApp.</p></details>
  <details><summary>Can you help me choose?</summary><p>Yes. Tap the chat button. Ask the AI assistant, or switch to a live person.</p></details>
  <details><summary>Do you offer IT and cybersecurity services?</summary><p>Yes. See the services section to book a consultation.</p></details></section>`;
  why.insertAdjacentHTML('beforebegin',h);
  const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.12});
  document.querySelectorAll('.lx-rev').forEach(x=>io.observe(x));
}

/* ---------- chat widget ---------- */
let mode='ai',hist=[],cid=localStorage.getItem('lx_cid'),unsub=null;
function mount(){
  if($('#lx-fab')) return;
  document.body.insertAdjacentHTML('beforeend',`<button id="lx-fab" aria-label="Chat with us"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
  <div id="lx-chat" role="dialog" aria-label="Chat"><div class="lx-h"><b>Loyalty ICT Support</b><small>AI answers instantly. People reply in working hours.</small>
  <div class="lx-tabs"><button class="on" data-m="ai">AI Assistant</button><button data-m="human">Live person</button></div></div>
  <div class="lx-m" id="lx-m"></div><div class="lx-chips" id="lx-c"></div>
  <form class="lx-in" id="lx-f"><input id="lx-i" placeholder="Type your question…" autocomplete="off" maxlength="500"><button>Send</button></form></div>`);
  $('#lx-fab').onclick=()=>{$('#lx-chat').classList.toggle('open');if(!$('#lx-m').children.length)setMode('ai')};
  document.querySelectorAll('.lx-tabs button').forEach(b=>b.onclick=()=>setMode(b.dataset.m));
  $('#lx-f').onsubmit=e=>{e.preventDefault();const t=$('#lx-i').value.trim();if(t){$('#lx-i').value='';send(t)}};
}
function bub(t,who){const m=$('#lx-m');m.insertAdjacentHTML('beforeend',`<div class="lx-b ${who}">${E(t)}</div>`);m.scrollTop=m.scrollHeight}
function chips(a){$('#lx-c').innerHTML=a.map(x=>`<button>${E(x)}</button>`).join('');$('#lx-c').querySelectorAll('button').forEach(b=>b.onclick=()=>send(b.textContent))}
function setMode(m){
  mode=m;document.querySelectorAll('.lx-tabs button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));
  $('#lx-m').innerHTML='';if(unsub){unsub();unsub=null}
  if(m==='ai'){bub('Hi! I can tell you everything about any product in our store: specs, price, what it suits and what to check before buying. What do you need?','bot');
    chips(['Best laptop for students','Printer for a small office','How do I pay with M-Pesa?','Compare SSD and HDD']);}
  else{chips([]);bub('You are now chatting with our team. Leave your question and we will reply here. For urgent help, WhatsApp +'+CFG.WA+'.','bot');listen()}
}
async function send(t){
  bub(t,'me');
  if(mode==='human') return sendHuman(t);
  hist.push({role:'user',content:t});$('#lx-c').innerHTML='';
  bub('…','bot');const w=$('#lx-m').lastChild;let r;
  try{
    const res=await fetch(CFG.FN+'/askAI',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:hist.slice(-10)})});
    if(!res.ok) throw 0; r=(await res.json()).reply; if(!r) throw 0;
  }catch(e){r=localAnswer(t)}
  w.textContent=r;hist.push({role:'assistant',content:r});$('#lx-m').scrollTop=1e9;
}
/* offline fallback so the assistant still helps if the cloud function is down */
function specText(p){const s=p.specs;if(!s)return'';if(Array.isArray(s))return s.map(x=>typeof x==='object'?Object.values(x).join(': '):x).join('\n');if(typeof s==='object')return Object.entries(s).map(([k,v])=>k+': '+v).join('\n');return String(s)}
function localAnswer(q){
  const l=q.toLowerCase();
  if(/mpesa|m-pesa|pay|till/.test(l)) return 'Pay with M-Pesa at checkout. Enter your number, wait for the prompt on your phone and enter your PIN. Your order is confirmed automatically.';
  if(/deliver|ship/.test(l)) return 'We deliver. Add your area at checkout and our team confirms cost and timing by call or WhatsApp.';
  const w=l.split(/\W+/).filter(x=>x.length>2);
  const sc=prods().map(p=>({p,s:w.reduce((a,x)=>a+((p.name+' '+p.cat+' '+(p.desc||'')).toLowerCase().includes(x)?1:0),0)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,3);
  if(sc.length) return 'Here is what we have:\n\n'+sc.map(({p})=>`${p.name}\n${KES(p.price)} · ${p.stock>0?p.stock+' in stock':'out of stock'}\n${p.desc||''}\n${specText(p)}`.trim()).join('\n\n')+'\n\nWant a comparison or help choosing? Switch to "Live person" to talk to our team.';
  return 'I could not find that in our store right now. Tell me the product type and your budget, or switch to "Live person". WhatsApp: +'+CFG.WA;
}
function listen(){
  if(!cid) return;
  ready(()=>{const {fdb,collection,query,orderBy,onSnapshot}=fb();
    unsub=onSnapshot(query(collection(fdb,'chats',cid,'messages'),orderBy('t')),s=>{
      $('#lx-m').innerHTML='';bub('You are chatting with our team. We reply here.','bot');
      s.forEach(d=>{const m=d.data();bub(m.text,m.from==='staff'?'bot':'me')})},()=>{});});
}
async function sendHuman(t){
  const {fdb,doc,setDoc,addDoc,collection}=fb();
  if(!cid){cid=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2)).replace(/-/g,'');localStorage.setItem('lx_cid',cid);}
  const nm=localStorage.getItem('lx_name')||prompt('Your name (so we can greet you):')||'Customer';localStorage.setItem('lx_name',nm);
  try{
    await setDoc(doc(fdb,'chats',cid),{name:nm,last:t,updated:Date.now(),unread:true},{merge:true});
    await addDoc(collection(fdb,'chats',cid,'messages'),{from:'cust',text:t,t:Date.now()});
    if(!unsub) listen();
  }catch(e){bub('Could not send. WhatsApp us on +'+CFG.WA,'bot')}
}
window.lxAsk=q=>{mount();$('#lx-chat').classList.add('open');setMode('ai');send(q)};

/* "Ask AI about this product" button inside the product modal */
function watchModal(){
  const mb=$('#modalBody'); if(!mb) return;
  new MutationObserver(()=>{
    if(mb.querySelector('.lx-ask')||!/Specifications/.test(mb.textContent)) return;
    const b=document.createElement('button');b.className='lx-ask';b.textContent='Ask AI about this product';
    b.onclick=()=>{const n=($('#modalTitle')||{}).textContent||'this product';closeModal();lxAsk('Tell me everything about '+n+': specs, who it suits, what to check before buying, and alternatives.')};
    mb.appendChild(b);
  }).observe(mb,{childList:true});
}

/* ---------- M-Pesa STK push checkout ---------- */
const phone254=p=>{p=String(p).replace(/\D/g,'');if(/^0[17]\d{8}$/.test(p))return'254'+p.slice(1);if(/^[17]\d{8}$/.test(p))return'254'+p;if(/^254[17]\d{8}$/.test(p))return p;return null};
window.openCheckout=function(){
  if(!cart.length){toast('Your cart is empty','bad');return}
  const total=cart.reduce((s,c)=>s+c.price*c.qty,0);
  openModal('Checkout',`
  <div class="field"><label>Full name</label><input id="ck-name" placeholder="e.g. Jane Wanjiru"></div>
  <div class="field-row"><div class="field"><label>M-Pesa phone number</label><input id="ck-phone" inputmode="tel" placeholder="07XX XXX XXX"></div>
  <div class="field"><label>Delivery area</label><input id="ck-area" placeholder="e.g. CBD"></div></div>
  <div class="field"><label>Delivery notes (optional)</label><textarea id="ck-notes" placeholder="Building, floor, landmark…"></textarea></div>
  <div class="lx-method">
   <label><input type="radio" name="pm" value="mpesa" checked><span><b>Pay now with M-Pesa</b><br><small>A prompt appears on your phone. Confirmed automatically.</small></span></label>
   <label><input type="radio" name="pm" value="later"><span><b>Order now, pay later</b><br><small>Our team calls to arrange payment and delivery.</small></span></label></div>
  <div class="tot-row grand" style="padding:0 4px"><span>Total</span><span>${KES(total)}</span></div>
  <button class="btn-full" id="lx-pay" style="background:#16A34A">Continue</button>
  ${tillOk()?`<div class="lx-till">Prefer manual payment? Lipa na M-Pesa, Buy Goods, Till <b>${CFG.TILL}</b> (${E(CFG.TILL_NAME)}).</div>`:''}`);
  $('#lx-pay').onclick=()=>pay(total);
};
async function pay(total){
  const name=val('ck-name'),raw=val('ck-phone'),later=document.querySelector('input[name=pm]:checked').value==='later';
  const ph=phone254(raw);
  if(!name||!raw){toast('Enter name and phone','bad');return}
  if(!later&&!ph){toast('Enter a valid Safaricom number, e.g. 0712 345 678','bad');return}
  if(later) return window.placeOrder(total);
  const order={ref:'LY'+Math.floor(100000+Math.random()*899999),name,phone:raw,area:val('ck-area'),notes:val('ck-notes'),
    items:JSON.parse(JSON.stringify(cart)),total,status:'pending',payStatus:'awaiting',payMethod:'mpesa',
    date:new Date().toISOString(),account:(typeof currentUser!=='undefined'&&currentUser)?currentUser.email:'guest',mpesaCode:''};
  openModal('M-Pesa payment',`<div class="lx-stk"><div class="spinner"></div><p style="font-weight:700;margin-top:8px">Check your phone</p><p style="color:var(--muted);font-size:14px">Enter your M-Pesa PIN to pay ${KES(total)}.</p></div>`);
  let id;try{id=await fbAdd('orders',order)}catch(e){return fail('Could not save your order. Try again.',total)}
  try{
    const r=await fetch(CFG.FN+'/stkPush',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:id,phone:ph})});
    const j=await r.json();if(!r.ok||!j.checkoutId) throw new Error(j.error||'failed');
    const {fdb,doc,onSnapshot}=fb();let done=false;
    const stop=onSnapshot(doc(fdb,'payments',j.checkoutId),s=>{const d=s.data();if(!d||done||d.status==='pending')return;done=true;stop();clearTimeout(tm);
      if(d.status==='paid'){cart=[];saveCart();closeCart();order.mpesaCode=d.receipt||order.mpesaCode;order.payStatus='paid';receipt(order,d.receipt)}
      else fail(d.message||'Payment was not completed.',total)},()=>{});
    const tm=setTimeout(()=>{if(!done){done=true;stop();fail('No confirmation received. If money left your account, our team will confirm it shortly.',total)}},120000);
  }catch(e){fail('Could not start M-Pesa. Check the number and try again.',total)}
}
function fail(msg,total){
  openModal('Payment not completed',`<div class="lx-stk"><p style="font-weight:700;margin-bottom:6px">${E(msg)}</p><p style="color:var(--muted);font-size:14px">Your order is saved. Your cart is kept.</p></div>
  <button class="btn-full" onclick="openCheckout()" style="background:#16A34A">Try again</button>
  <button class="btn-full" style="margin-top:10px;background:var(--bg);color:var(--brand);border:1px solid var(--line)" onclick="lxAsk('My M-Pesa payment failed. What should I do?')">Get help</button>`);
}
function receipt(o,code){
  showReceipt(o);
  const st=document.querySelector('.paid-stamp');if(st)st.textContent='PAID · M-PESA';
  const f=document.querySelector('.r-foot');if(f)f.innerHTML='Payment received'+(code?' ('+E(code)+')':'')+'. Thank you for choosing Loyalty ICT Solutions.<br>Our team will contact you about delivery. Keep this receipt.';
}

/* ---------- boot ---------- */
function boot(){sections();mount();watchModal()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
