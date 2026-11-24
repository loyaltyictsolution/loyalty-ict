const functions=require('firebase-functions/v1');
const admin=require('firebase-admin');
admin.initializeApp();
const db=admin.firestore();
const SECRETS=['MPESA_KEY','MPESA_SECRET','MPESA_PASSKEY','ANTHROPIC_API_KEY'];
const run=functions.runWith({secrets:SECRETS,timeoutSeconds:60});
const ORIGINS=['https://loyaltyictsolution.github.io']; // add your custom domain here

function cors(req,res){
  const o=req.headers.origin;
  if(ORIGINS.includes(o)||/^http:\/\/localhost/.test(o||'')) res.set('Access-Control-Allow-Origin',o);
  res.set('Access-Control-Allow-Methods','POST,OPTIONS').set('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.status(204).send('');return true}
  return false;
}
const base=()=>process.env.MPESA_ENV==='sandbox'?'https://sandbox.safaricom.co.ke':'https://api.safaricom.co.ke';
async function token(){
  const a=Buffer.from(process.env.MPESA_KEY+':'+process.env.MPESA_SECRET).toString('base64');
  const r=await fetch(base()+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+a}});
  if(!r.ok) throw new Error('daraja auth '+r.status);
  return (await r.json()).access_token;
}
const stamp=()=>new Date(Date.now()+3*3600e3).toISOString().replace(/\D/g,'').slice(0,14); // EAT

/* Customer pays. Amount is read from the order in Firestore, never from the browser. */
exports.stkPush=run.https.onRequest(async(req,res)=>{
  if(cors(req,res)) return;
  try{
    const {orderId,phone}=req.body||{};
    if(!orderId||!/^254[17]\d{8}$/.test(phone||'')) return res.status(400).json({error:'bad request'});
    const ref=db.collection('orders').doc(orderId),snap=await ref.get();
    if(!snap.exists) return res.status(404).json({error:'order not found'});
    const o=snap.data();
    if(o.payStatus==='paid') return res.status(409).json({error:'already paid'});
    const amount=Math.round(Number(o.total)); if(!(amount>=1)) return res.status(400).json({error:'bad amount'});
    const ts=stamp(),sc=process.env.MPESA_SHORTCODE;
    const body={BusinessShortCode:sc,Password:Buffer.from(sc+process.env.MPESA_PASSKEY+ts).toString('base64'),Timestamp:ts,
      TransactionType:'CustomerBuyGoodsOnline',Amount:amount,PartyA:phone,PartyB:process.env.MPESA_TILL,PhoneNumber:phone,
      CallBackURL:process.env.MPESA_CALLBACK,AccountReference:String(o.ref||orderId).slice(0,12),TransactionDesc:'Loyalty ICT order'};
    const r=await fetch(base()+'/mpesa/stkpush/v1/processrequest',{method:'POST',headers:{Authorization:'Bearer '+await token(),'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    if(j.ResponseCode!=='0'){console.error('stk',j);return res.status(502).json({error:j.errorMessage||j.ResponseDescription||'M-Pesa refused'})}
    await db.collection('payments').doc(j.CheckoutRequestID).set({orderId,amount,phone,status:'pending',created:Date.now()});
    await ref.update({checkoutId:j.CheckoutRequestID});
    res.json({checkoutId:j.CheckoutRequestID});
  }catch(e){console.error(e);res.status(500).json({error:'server error'})}
});

/* Safaricom calls this. We only trust payments we started, and check the amount. */
exports.mpesaCallback=run.https.onRequest(async(req,res)=>{
  res.json({ResultCode:0,ResultDesc:'Accepted'});
  try{
    const cb=req.body&&req.body.Body&&req.body.Body.stkCallback; if(!cb) return;
    const pref=db.collection('payments').doc(cb.CheckoutRequestID),ps=await pref.get();
    if(!ps.exists||ps.data().status!=='pending') return;
    const p=ps.data();
    if(cb.ResultCode!==0){
      const msg={1032:'You cancelled the payment.',1:'Insufficient M-Pesa balance.',2001:'Wrong PIN entered.',1037:'The prompt timed out.'}[cb.ResultCode]||'Payment was not completed.';
      return void await pref.update({status:'failed',message:msg,code:cb.ResultCode});
    }
    const m={};(cb.CallbackMetadata.Item||[]).forEach(i=>m[i.Name]=i.Value);
    if(Number(m.Amount)<p.amount){await pref.update({status:'failed',message:'Amount mismatch. Contact support.'});return}
    await pref.update({status:'paid',receipt:m.MpesaReceiptNumber,paidAt:Date.now()});
    await db.collection('orders').doc(p.orderId).update({payStatus:'paid',mpesaCode:m.MpesaReceiptNumber,paidAt:new Date().toISOString()});
  }catch(e){console.error(e)}
});

/* AI product advisor. Catalogue is read server-side, so the browser cannot inject prices. */
exports.askAI=run.https.onRequest(async(req,res)=>{
  if(cors(req,res)) return;
  try{
    const msgs=(req.body.messages||[]).slice(-10).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content).slice(0,600)}));
    if(!msgs.length||msgs[0].role!=='user') return res.status(400).json({error:'bad request'});
    const ps=(await db.collection('products').limit(150).get()).docs.map(d=>{const p=d.data();return `- ${p.name} | ${p.cat} | KSh ${p.price} | stock ${p.stock} | ${p.desc||''} | ${JSON.stringify(p.specs||'')}`}).join('\n');
    const system=`You are the shop assistant for Loyalty ICT Solutions, Nairobi, Kenya (hardware store plus IT support, cybersecurity and AI services).
Help customers choose products. When asked about a product, explain in plain language: what it is, key specs and what they mean, who it suits, what to check before buying (compatibility, warranty questions), and one or two alternatives from the catalogue.
Use ONLY the catalogue below for prices, stock and specs. If something is not listed, say you do not have it and offer the live team. Never invent prices, discounts, warranty terms or delivery fees; for those say the team will confirm.
Payment: M-Pesa prompt at checkout, or Till. Contact: WhatsApp +254713474115. Keep answers short, clear and friendly. Prices are in KSh.
CATALOGUE:\n${ps}`;
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body:JSON.stringify({model:process.env.AI_MODEL||'claude-sonnet-5-5',max_tokens:700,system,messages:msgs})});
    const j=await r.json(); if(!r.ok){console.error(j);return res.status(502).json({error:'ai'})}
    res.json({reply:(j.content||[]).map(c=>c.text||'').join('')});
  }catch(e){console.error(e);res.status(500).json({error:'server error'})}
});
