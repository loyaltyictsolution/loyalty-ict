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
const BASE = { region: 'europe-west1', secrets: [MAIL_USER, MAIL_PASS, OTP_PEPPER] };

const TTL = 10 * 60 * 1000;
const GAP = 60 * 1000;
const MAX_TRIES = 5;
const OTP_HOURS = 12;

const clean = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const slot = (email, purpose) => sha(email + '|' + purpose);
const hashCode = (email, purpose, code) => sha([email, purpose, code, OTP_PEPPER.value()].join('|'));
const bad = m => new HttpsError('invalid-argument', m);
const denied = m => new HttpsError('permission-denied', m);
const needLogin = () => new HttpsError('unauthenticated', 'Please log in first.');

async function mail(to, subject, html) {
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER.value(), pass: MAIL_PASS.value() } });
  await t.sendMail({ from: `"Loyalty ICT Solutions" <${MAIL_USER.value()}>`, to, subject, html });
}
async function roleOf(uid) {
  const s = await db.doc('users/' + uid).get();
  return s.exists ? s.data().role : null;
}

async function issueOtp(email, purpose) {
  const ref = db.collection('otps').doc(slot(email, purpose)), s = await ref.get(), now = Date.now();
  if (s.exists && now - s.data().sent < GAP) throw new HttpsError('resource-exhausted', 'Please wait a minute before asking for another code.');
  const code = String(crypto.randomInt(100000, 1000000));
  await ref.set({ hash: hashCode(email, purpose, code), exp: now + TTL, tries: 0, sent: now });
  await mail(email, 'Your Loyalty ICT Solutions code',
    `<p>Your verification code is:</p><p style="font-size:30px;font-weight:700;letter-spacing:6px">${code}</p><p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p>`);
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
}

exports.sendOtp = onCall(BASE, async req => {
  const purpose = req.data && req.data.purpose;
  if (purpose === 'login') {
    if (!req.auth) throw needLogin();
    const email = clean(req.auth.token.email), role = await roleOf(req.auth.uid);
    if (!okEmail(email)) throw bad('This account has no email.');
    if (!role || role === 'customer') throw denied('A sign-in code is not needed for this account.');
    await issueOtp(email, 'login');
    return { ok: true };
  }
  if (purpose === 'register') {
    const email = clean(req.data.email);
    if (!okEmail(email)) throw bad('Enter a valid email.');
    try {
      await admin.auth().getUserByEmail(email);
      throw new HttpsError('already-exists', 'That email already has an account. Log in instead.');
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      if (e.code !== 'auth/user-not-found') throw e;
    }
    await issueOtp(email, 'register');
    return { ok: true };
  }
  throw bad('Unknown request.');
});

exports.registerCustomer = onCall(BASE, async req => {
  const d = req.data || {}, email = clean(d.email), name = String(d.name || '').trim().slice(0, 80), password = String(d.password || '');
  if (!okEmail(email) || name.length < 2) throw bad('Enter your name and a valid email.');
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  await checkOtp(email, 'register', d.code);
  let user;
  try { user = await admin.auth().createUser({ email, password, displayName: name, emailVerified: true }); }
  catch (e) {
    if (e.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'That email already has an account.');
    throw new HttpsError('internal', 'Could not create the account.');
  }
  await db.doc('users/' + user.uid).set({ name, email, role: 'customer', created: new Date().toISOString() });
  return { ok: true };
});

exports.verifyLoginOtp = onCall(BASE, async req => {
  if (!req.auth) throw needLogin();
  const email = clean(req.auth.token.email), role = await roleOf(req.auth.uid);
  if (!role || role === 'customer') throw denied('A sign-in code is not needed for this account.');
  await checkOtp(email, 'login', (req.data || {}).code);
  const u = await admin.auth().getUser(req.auth.uid);
  await admin.auth().setCustomUserClaims(req.auth.uid, { ...(u.customClaims || {}), otpAt: Date.now() });
  return { ok: true };
});

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

  let user = null, upgraded = false, invite = false;
  try { user = await admin.auth().getUserByEmail(email); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; }

  if (user) {
    const r = await roleOf(user.uid);
    if (r && r !== 'customer' && r !== 'employee') throw new HttpsError('already-exists', 'That email already belongs to a staff account.');
    if (r === 'customer') upgraded = true; else invite = true;
    await db.doc('users/' + user.uid).set({ role: 'employee', name: emp.name, email }, { merge: true });
  } else {
    user = await admin.auth().createUser({ email, password: crypto.randomBytes(18).toString('base64url'), displayName: emp.name, emailVerified: true });
    await db.doc('users/' + user.uid).set({ name: emp.name, email, role: 'employee', created: now, createdBy: req.auth.uid });
    invite = true;
  }
  if (invite) {
    const link = await admin.auth().generatePasswordResetLink(email);
    await mail(email, 'Your Loyalty ICT Solutions staff account',
      `<p>Hello ${String(emp.name || '').replace(/[<>&]/g, '')},</p><p>An account has been opened for you on the Loyalty ICT Solutions staff portal.</p><p><a href="${link}">Set your password</a></p><p>After that, log in with this email. A code is sent to this inbox each time you sign in.</p>`);
  }
  await es.ref.update({ uid: user.uid, accountAt: now, accountBy: req.auth.uid });
  return { ok: true, email, upgraded };
});
