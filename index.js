/* ============================================================
   Loyalty ICT Solutions: accounts + one-time codes
   Codes go by EMAIL (Gmail) or SMS (Africa's Talking).
   Region: europe-west1  (accounts.js uses the same region)
   Secrets:
     MAIL_USER, MAIL_PASS   Gmail address + app password
     OTP_PEPPER             any long random string
     AT_USER, AT_KEY        Africa's Talking username + API key
                            (type the word none if you are not using SMS yet)
   ============================================================ */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const MAIL_USER = defineSecret('MAIL_USER');
const MAIL_PASS = defineSecret('MAIL_PASS');
const OTP_PEPPER = defineSecret('OTP_PEPPER');
const AT_USER = defineSecret('AT_USER');
const AT_KEY = defineSecret('AT_KEY');
const BASE = { region: 'europe-west1', secrets: [MAIL_USER, MAIL_PASS, OTP_PEPPER, AT_USER, AT_KEY] };

const TTL = 10 * 60 * 1000;        // a code lives 10 minutes
const GAP = 60 * 1000;             // one code per minute per address
const MAX_TRIES = 5;               // wrong guesses before the code is burned
const OTP_HOURS = 12;              // must match accounts.js
const SMS_PER_NUMBER_DAY = 5;      // SMS cost protection
const EMAIL_PER_ADDRESS_DAY = 10;
const SMS_GLOBAL_DAY = 300;

const clean = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const slot = (email, purpose) => sha(email + '|' + purpose);
const hashCode = (email, purpose, code) => sha([email, purpose, code, OTP_PEPPER.value()].join('|'));
const bad = m => new HttpsError('invalid-argument', m);
const denied = m => new HttpsError('permission-denied', m);
const needLogin = () => new HttpsError('unauthenticated', 'Please log in first.');

/* +254 numbers: 07XXXXXXXX, 01XXXXXXXX, 7XXXXXXXX, 2547XXXXXXXX, +2547XXXXXXXX. Other countries: full number with country code. */
function normPhone(p) {
  let d = String(p || '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  if (!/^\d{8,15}$/.test(d)) return null;
  if (d.startsWith('254') && d.length !== 12) return null;
  return '+' + d;
}
const maskPhone = p => p.slice(0, 4) + '•••••' + p.slice(-3);
const maskEmail = e => { const [u, d] = e.split('@'); return u.slice(0, 1) + '•••@' + d; };

async function mail(to, subject, html) {
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER.value(), pass: MAIL_PASS.value() } });
  await t.sendMail({ from: `"Loyalty ICT Solutions" <${MAIL_USER.value()}>`, to, subject, html });
}

async function sms(to, text) {
  if (AT_KEY.value() === 'none') throw new HttpsError('failed-precondition', 'SMS is not set up yet. Please use email.');
  const sandbox = AT_USER.value() === 'sandbox';
  const url = sandbox ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';
  const res = await fetch(url, {
    method: 'POST',
    headers: { apiKey: AT_KEY.value(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ username: AT_USER.value(), to, message: text })
  });
  let data = null; try { data = await res.json(); } catch (e) { /* ignore */ }
  const r = data && data.SMSMessageData && data.SMSMessageData.Recipients && data.SMSMessageData.Recipients[0];
  if (!res.ok || !r || !(r.statusCode === 101 || r.status === 'Success')) {
    console.error('SMS failed', res.status, JSON.stringify(data));
    throw new HttpsError('unavailable', 'Could not send the SMS. Try email instead.');
  }
}

async function roleOf(uid) {
  const s = await db.doc('users/' + uid).get();
  return s.exists ? s.data().role : null;
}

/* daily counter used to stop SMS and email abuse */
async function bump(id, max, message) {
  const ref = db.collection('otpLimits').doc(id), day = new Date().toISOString().slice(0, 10);
  await db.runTransaction(async tx => {
    const s = await tx.get(ref), d = (s.exists && s.data().day === day) ? s.data() : { day, n: 0 };
    if (d.n >= max) throw new HttpsError('resource-exhausted', message);
    tx.set(ref, { day, n: d.n + 1 });
  });
}

/* ---- one-time codes: only a hash is stored, in a collection no client can read ---- */
async function issueOtp(email, purpose, channel, to) {
  const ref = db.collection('otps').doc(slot(email, purpose)), s = await ref.get(), now = Date.now();
  if (s.exists && now - s.data().sent < GAP) throw new HttpsError('resource-exhausted', 'Please wait a minute before asking for another code.');
  if (channel === 'sms') {
    await bump('sms_' + sha(to), SMS_PER_NUMBER_DAY, 'Too many SMS codes to this number today. Use email or try tomorrow.');
    await bump('smsall', SMS_GLOBAL_DAY, 'SMS is busy right now. Please use email.');
  } else {
    await bump('mail_' + sha(to), EMAIL_PER_ADDRESS_DAY, 'Too many codes to this address today. Try again tomorrow.');
  }
  const code = String(crypto.randomInt(100000, 1000000));
  await ref.set({ hash: hashCode(email, purpose, code), exp: now + TTL, tries: 0, sent: now, channel });
  try {
    if (channel === 'sms') await sms(to, `Loyalty ICT Solutions code: ${code}. Valid for 10 minutes. Never share it.`);
    else await mail(to, 'Your Loyalty ICT Solutions code',
      `<p>Your verification code is:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p>`);
  } catch (e) { await ref.delete().catch(() => {}); throw e; }
}
async function checkOtp(email, purpose, code) {
  const ref = db.collection('otps').doc(slot(email, purpose)), s = await ref.get();
  if (!s.exists) throw new HttpsError('failed-precondition', 'Ask for a new code.');
  const d = s.data();
  if (Date.now() > d.exp) { await ref.delete(); throw new HttpsError('deadline-exceeded', 'That code has expired. Ask for a new one.'); }
  if (d.tries >= MAX_TRIES) { await ref.delete(); throw new HttpsError('resource-exhausted', 'Too many wrong tries. Ask for a new code.'); }
  const a = Buffer.from(d.hash), b = Buffer.from(hashCode(email, purpose, String(code || '')));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await ref.update({ tries: d.tries + 1 });
    throw bad('Wrong code.');
  }
  await ref.delete();
  return d.channel || 'email';
}

/* where a signed-in staff member's phone number lives: users doc first, then their employee record */
async function phoneFor(uid, email) {
  const u = await db.doc('users/' + uid).get();
  let p = u.exists ? normPhone(u.data().phone) : null;
  if (p) return p;
  let q = await db.collection('employees').where('uid', '==', uid).limit(1).get();
  if (q.empty) q = await db.collection('employees').where('email', '==', email).limit(1).get();
  return q.empty ? null : normPhone(q.docs[0].data().phone);
}

/* ---- send a code: 'register' (public) or 'login' (staff, signed in); channel 'email' or 'sms' ---- */
exports.sendOtp = onCall(BASE, async req => {
  const d = req.data || {}, purpose = d.purpose, channel = d.channel === 'sms' ? 'sms' : 'email';
  if (purpose === 'login') {
    if (!req.auth) throw needLogin();
    const email = clean(req.auth.token.email), role = await roleOf(req.auth.uid);
    if (!okEmail(email)) throw bad('This account has no email.');
    if (!role || role === 'customer') throw denied('A sign-in code is not needed for this account.');
    let to = email;
    if (channel === 'sms') {
      to = await phoneFor(req.auth.uid, email);
      if (!to) throw bad('No phone number is saved for this account. Use email, or ask HR to add your number.');
    }
    await issueOtp(email, 'login', channel, to);
    return { ok: true, channel, to: channel === 'sms' ? maskPhone(to) : maskEmail(to) };
  }
  if (purpose === 'register') {
    const email = clean(d.email);
    if (!okEmail(email)) throw bad('Enter a valid email.');
    let to = email;
    if (channel === 'sms') {
      to = normPhone(d.phone);
      if (!to) throw bad('Enter a valid phone number, for example 0712 345 678.');
    }
    try {
      await admin.auth().getUserByEmail(email);
      throw new HttpsError('already-exists', 'That email already has an account. Log in instead.');
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      if (e.code !== 'auth/user-not-found') throw e;
    }
    await issueOtp(email, 'register', channel, to);
    return { ok: true, channel, to: channel === 'sms' ? maskPhone(to) : maskEmail(to) };
  }
  throw bad('Unknown request.');
});

/* ---- customer sign-up: the account only exists after the code is proven ---- */
exports.registerCustomer = onCall(BASE, async req => {
  const d = req.data || {}, email = clean(d.email), name = String(d.name || '').trim().slice(0, 80), password = String(d.password || '');
  if (!okEmail(email) || name.length < 2) throw bad('Enter your name and a valid email.');
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  const via = await checkOtp(email, 'register', d.code);
  const phone = normPhone(d.phone);
  let user;
  try { user = await admin.auth().createUser({ email, password, displayName: name, emailVerified: via === 'email' }); }
  catch (e) {
    if (e.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'That email already has an account.');
    throw new HttpsError('internal', 'Could not create the account.');
  }
  await db.doc('users/' + user.uid).set({
    name, email, role: 'customer', created: new Date().toISOString(),
    ...(phone ? { phone } : {}), verifiedBy: via
  });
  return { ok: true };
});

/* ---- staff sign-in: a proven code stamps the login with otpAt ---- */
exports.verifyLoginOtp = onCall(BASE, async req => {
  if (!req.auth) throw needLogin();
  const email = clean(req.auth.token.email), role = await roleOf(req.auth.uid);
  if (!role || role === 'customer') throw denied('A sign-in code is not needed for this account.');
  await checkOtp(email, 'login', (req.data || {}).code);
  const u = await admin.auth().getUser(req.auth.uid);
  await admin.auth().setCustomUserClaims(req.auth.uid, { ...(u.customClaims || {}), otpAt: Date.now() });
  return { ok: true };
});

/* ---- employee accounts: HR and admin only, never self-service ---- */
exports.createEmployeeAccount = onCall(BASE, async req => {
  if (!req.auth) throw needLogin();
  const me = await roleOf(req.auth.uid);
  if (!['admin', 'hr'].includes(me)) throw denied('Only HR or an administrator can open employee accounts.');
  if (!(Number(req.auth.token.otpAt) > Date.now() - OTP_HOURS * 3600 * 1000)) throw denied('Confirm your sign-in code first.');
  const id = String((req.data || {}).employeeId || '');
  if (!/^[A-Za-z0-9]+$/.test(id)) throw bad('Unknown employee.');
  const es = await db.doc('employees/' + id).get();
  if (!es.exists) throw new HttpsError('not-found', 'Employee record not found.');
  const emp = es.data(), email = clean(emp.email), now = new Date().toISOString();
  if (!okEmail(email)) throw bad('This employee has no valid email. Edit the record first.');
  if (emp.status === 'left') throw bad('This employee has left.');
  const phone = normPhone(emp.phone);

  let user = null, upgraded = false, invite = false;
  try { user = await admin.auth().getUserByEmail(email); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; }

  if (user) {
    const r = await roleOf(user.uid);
    if (r && r !== 'customer' && r !== 'employee') throw new HttpsError('already-exists', 'That email already belongs to a staff account.');
    if (r === 'customer') {
      // never promote an account whose email was not proven by its owner
      if (!user.emailVerified) throw new HttpsError('failed-precondition', 'A customer account with this email exists but its email was never verified. Use a different email for this employee.');
      upgraded = true;
    } else invite = true;
    await db.doc('users/' + user.uid).set({ role: 'employee', name: emp.name, email, ...(phone ? { phone } : {}) }, { merge: true });
  } else {
    user = await admin.auth().createUser({ email, password: crypto.randomBytes(18).toString('base64url'), displayName: emp.name, emailVerified: true });
    await db.doc('users/' + user.uid).set({ name: emp.name, email, role: 'employee', created: now, createdBy: req.auth.uid, ...(phone ? { phone } : {}) });
    invite = true;
  }
  if (invite) {
    const link = await admin.auth().generatePasswordResetLink(email);
    await mail(email, 'Your Loyalty ICT Solutions staff account',
      `<p>Hello ${String(emp.name || '').replace(/[<>&]/g, '')},</p><p>An account has been opened for you on the Loyalty ICT Solutions staff portal.</p><p><a href="${link}">Set your password</a></p><p>After that, log in with this email. A code is sent to your email or phone each time you sign in.</p>`);
  }
  await es.ref.update({ uid: user.uid, accountAt: now, accountBy: req.auth.uid });
  return { ok: true, email, upgraded };
});
