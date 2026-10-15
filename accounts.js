/* ============================================================
   accounts.js  (load AFTER the Firebase module in index.html)
   - Customers register themselves; the code goes by email, SMS or WhatsApp.
   - Employee logins are created by HR or an administrator only.
   - Staff and admins confirm sign-in with a code (email, SMS or WhatsApp).
   Everything here replaces or wraps functions from index.html.
   ============================================================ */
import { getApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js";

const OTP_STAFF = false;     // set to true to REQUIRE the staff sign-in code (false = switched off)
const OTP_HOURS = 12;        // a verified staff sign-in is trusted this long
const REGION = 'europe-west1';
const STAFF_DEFAULT_CH = 'whatsapp';   // channel used for the staff sign-in code

const fns = getFunctions(getApp(), REGION);
const call = (name, data) => httpsCallable(fns, name)(data || {}).then(r => r.data);
const msg = e => (e && e.message) ? e.message : 'Something went wrong. Try again.';

/* channels */
const CHANNELS = ['whatsapp'];   // channels switched on; add 'email' / 'sms' once the backend can send them
const chLabel = c => c === 'sms' ? 'SMS' : c === 'whatsapp' ? 'WhatsApp' : 'email';
const needsPhone = c => c === 'sms' || c === 'whatsapp';

const maskEmail = e => { const [u, d] = String(e || '').split('@'); return (u || '').slice(0, 1) + '•••@' + (d || ''); };

let pendingReg = null, otpMode = '', otpChannel = 'whatsapp', otpDest = '', regCh = 'whatsapp';
let resendTimer = null, resendAt = 0;
window.OTP_OK = !OTP_STAFF;

/* ---------- the code screen ---------- */
function otpFormHtml(mode) {
  // other channels the person can switch to
  const alts = CHANNELS.filter(c => c !== otpChannel &&
    (c === 'email' || mode === 'login' || !!(pendingReg && pendingReg.phone)));
  return `<p style="color:var(--muted);font-size:14px;margin-bottom:14px">We sent a 6-digit code by <b>${chLabel(otpChannel)}</b> to <b>${escHtml(otpDest)}</b>. It expires in 10 minutes.</p>
  <div class="field"><label>Verification code</label>
    <input id="otp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"
      style="font-size:24px;letter-spacing:.4em;text-align:center" onkeydown="if(event.key==='Enter')otpSubmit()"></div>
  <button class="btn-full" id="otp-go" onclick="otpSubmit()">${mode === 'register' ? 'Verify and create account' : 'Verify and continue'}</button>
  <button class="btn-full" id="otp-resend" style="margin-top:10px;background:var(--bg);color:var(--brand);border:1px solid var(--line)" onclick="otpResend()">Resend code</button>
  ${alts.map(c => `<button class="btn-full otp-alt" style="margin-top:10px;background:var(--bg);color:var(--ink);border:1px solid var(--line)" onclick="otpResend('${c}')">Send by ${chLabel(c)} instead</button>`).join('')}`;
}
function otpShow() {
  openModal(otpMode === 'register' ? 'Verify your account' : 'Staff sign-in code', otpFormHtml(otpMode));
}
function startCooldown(fresh) {
  clearInterval(resendTimer);
  if (fresh) resendAt = Date.now() + 60000;
  const tick = () => {
    const b = document.getElementById('otp-resend');
    const alts = document.querySelectorAll('.otp-alt');
    if (!b) { clearInterval(resendTimer); return; }
    const s = Math.ceil((resendAt - Date.now()) / 1000);
    if (s > 0) {
      b.disabled = true; b.textContent = 'Resend code in ' + s + 's';
      alts.forEach(a => a.disabled = true);
    } else {
      b.disabled = false; b.textContent = 'Resend code';
      alts.forEach(a => a.disabled = false);
      clearInterval(resendTimer);
    }
  };
  tick(); resendTimer = setInterval(tick, 1000);
  setTimeout(() => { const i = document.getElementById('otp-code'); if (i) i.focus(); }, 60);
}
window.otpResend = async function (ch) {
  const channel = ch || otpChannel;
  try {
    const r = await call('sendOtp', otpMode === 'register'
      ? { email: pendingReg.email, purpose: 'register', channel, phone: pendingReg.phone }
      : { purpose: 'login', channel });
    otpChannel = r.channel; otpDest = r.to;
    otpShow(); startCooldown(true); toast('Code sent by ' + chLabel(otpChannel), 'ok');
  } catch (e) { toast(msg(e), 'bad'); }
};
window.otpSubmit = async function () {
  const code = val('otp-code');
  if (!/^\d{6}$/.test(code)) { toast('Enter the 6-digit code', 'bad'); return; }
  const b = document.getElementById('otp-go'); if (b) b.disabled = true;
  try {
    if (otpMode === 'register') {
      const r = pendingReg;
      await call('registerCustomer', { name: r.name, email: r.email, password: r.password, phone: r.phone, code });
      await window.FB.signInWithEmailAndPassword(window.FB.auth, r.email, r.password);
      pendingReg = null; closeModal(); toast('Account created. You are logged in.', 'ok');
    } else {
      await call('verifyLoginOtp', { code });
      await window.FB.auth.currentUser.getIdToken(true);   // pull the new otpAt claim into the token
      sessionStorage.setItem('goAdmin', '1');
      location.reload();           // reload so every data stream starts with the verified token
    }
  } catch (e) { if (b) b.disabled = false; toast(msg(e), 'bad'); }
};

/* ---------- customer registration (customers only) ---------- */
window.pickCh = function (c) {
  regCh = c;
  document.querySelectorAll('#au-ch button').forEach(b => b.classList.toggle('active', b.dataset.v === c));
};
const _authForm = window.authFormHtml;
window.authFormHtml = function (mode) {
  let h = _authForm(mode)
    .replace('At least 6 characters', 'At least 8 characters')
    .replace('Create an account to check out faster and keep track of your orders and service requests.',
      mode === 'register'
        ? 'Customer accounts only. We send a code by WhatsApp to confirm you. Staff accounts are opened by HR or the administrator.'
        : 'Staff sign in here too. You will be asked for a code by WhatsApp.');
  if (mode === 'register') {
    regCh = CHANNELS[0];
    h = h.replace('<div class="field"><label>Password</label>',
      `<div class="field"><label>Phone number</label><input id="au-phone" type="tel" placeholder="07XX XXX XXX" autocomplete="tel">
         <small style="color:var(--muted);font-size:12px">Your confirmation code is sent to this number on WhatsApp, so WhatsApp must be active on it.</small></div>
       <div class="field"><label>Send my code by</label><div id="au-ch" style="display:flex;gap:8px;flex-wrap:wrap">${CHANNELS.map((c, i) => `<button type="button" class="chip${i === 0 ? ' active' : ''}" data-v="${c}" onclick="pickCh('${c}')">${chLabel(c)}</button>`).join('')}</div></div>
       <div class="field"><label>Password</label>`);
  }
  return h;
};
window.registerUser = async function () {
  const name = val('au-name'), email = val('au-email').toLowerCase(), password = val('au-pass'), phone = val('au-phone');
  if (!name || !email || !password) { toast('Fill in all fields', 'bad'); return; }
  if (password.length < 8) { toast('Password must be 8+ characters', 'bad'); return; }
  if (needsPhone(regCh) && !phone) { toast('Enter your phone number to get the code by ' + chLabel(regCh), 'bad'); return; }
  try {
    const r = await call('sendOtp', { email, purpose: 'register', channel: regCh, phone });
    pendingReg = { name, email, password, phone }; otpMode = 'register'; otpChannel = r.channel; otpDest = r.to;
  } catch (e) { toast(msg(e), 'bad'); return; }
  otpShow(); startCooldown(true);
};

/* ---------- staff and admin sign-in code ---------- */
function gateHtml() {
  return `<div class="login-wrap"><div class="login-card">
    <h3 style="text-align:center;margin-bottom:6px">Confirm it's you</h3>
    <p class="sub">Enter the 6-digit code we sent you to open the staff area.</p>
    <button class="btn-full" onclick="staffOtpOpen()">Enter code</button>
    <button class="btn-full" style="margin-top:10px;background:var(--bg);color:var(--bad);border:1px solid var(--line)" onclick="logoutUser()">Log out</button>
    <button style="width:100%;margin-top:12px;color:var(--muted);font-size:13px" onclick="go('home')">← Back to store</button>
  </div></div>`;
}
window.staffOtpOpen = function () {
  otpMode = 'login';
  if (!otpDest) { otpChannel = CHANNELS[0]; otpDest = 'your registered WhatsApp number'; }
  otpShow(); startCooldown(false);
};
async function staffOtpStart() {
  try {
    const r = await call('sendOtp', { purpose: 'login', channel: STAFF_DEFAULT_CH });
    otpChannel = r.channel; otpDest = r.to; resendAt = Date.now() + 60000;
  } catch (e) {
    // e.g. no phone saved for WhatsApp/SMS: fall back to email
    if (STAFF_DEFAULT_CH !== 'email' && CHANNELS.includes('email')) {
      try {
        const r = await call('sendOtp', { purpose: 'login', channel: 'email' });
        otpChannel = r.channel; otpDest = r.to; resendAt = Date.now() + 60000;
      } catch (e2) { toast(msg(e2), 'bad'); }
    } else toast(msg(e), 'bad');
  }
  window.staffOtpOpen();
}
const _renderAdmin = window.renderAdmin;
window.renderAdmin = function () {
  if (OTP_STAFF && currentUser && isStaffRole(currentUser.role) && window.OTP_OK !== true) {
    document.getElementById('admin-view').innerHTML = gateHtml(); return;
  }
  return _renderAdmin.apply(this, arguments);
};

let gateFor = '';
window.FB.onAuthStateChanged(window.FB.auth, async user => {
  if (!user) { window.OTP_OK = !OTP_STAFF; gateFor = ''; otpDest = ''; return; }
  if (!OTP_STAFF) return;
  try {
    const snap = await window.FB.getDoc(window.FB.doc(window.FB.fdb, 'users', user.uid));
    const role = snap.exists() ? snap.data().role : 'customer';
    if (!isStaffRole(role)) { window.OTP_OK = true; return; }
    let t = await user.getIdTokenResult();
    if (!t.claims.otpAt) t = await user.getIdTokenResult(true);   // cached token can be up to 1h old
    const at = Number(t.claims.otpAt || 0);
    window.OTP_OK = at > 0 && Date.now() - at < OTP_HOURS * 3600 * 1000;
    if (adminOpen()) renderAdmin();
    if (window.OTP_OK) {
      if (sessionStorage.getItem('goAdmin')) {
        sessionStorage.removeItem('goAdmin');
        const w = setInterval(() => { if (currentUser) { clearInterval(w); go('admin'); } }, 200);
      }
    } else if (gateFor !== user.uid) { gateFor = user.uid; staffOtpStart(); }
  } catch (e) { console.warn('otp gate', e); }
});

/* ---------- employee logins: HR and admin only ---------- */
const _employeesHtml = window.employeesHtml;
window.employeesHtml = function () {
  let h = _employeesHtml();
  (hrCache.employees || []).forEach(e => {
    if (e.uid) return;
    const key = `onclick="staffNoForm('${e.id}')">Staff no.</button>`;
    h = h.replace(key, key + ` <button class="mini mini-ok" onclick="empCreateLogin('${e.id}')">Create login</button>`);
  });
  return h;
};
window.empCreateLogin = function (id) {
  const e = hrCache.employees.find(x => x.id === id); if (!e) return;
  if (!e.email) { toast('Add the employee email first (Edit)', 'bad'); return; }
  if (!e.phone) { toast('Add the employee WhatsApp number first (Edit)', 'bad'); return; }
  openModal('Create staff login', `<div class="fin-meta"><div><span>Employee</span>${finEsc(e.name)}</div><div><span>Email</span>${finEsc(e.email)}</div><div><span>Phone</span>${finEsc(e.phone || 'Not saved')}</div><div><span>Role</span>Employee</div></div>
    <p class="fin-mut" style="margin:12px 0">The employee gets a link to set their own password. You never see it. Each sign-in is confirmed with a code sent to the employee's WhatsApp.</p>
    <button class="fbtn p" id="ecl-go" style="width:100%;justify-content:center" onclick="empCreateLoginGo('${id}')">Create login and send invite</button>`);
};
window.empCreateLoginGo = async function (id) {
  const b = document.getElementById('ecl-go'); if (b) { b.disabled = true; b.textContent = 'Creating…'; }
  try {
    const r = await call('createEmployeeAccount', { employeeId: id });
    logAction('Created employee login', r.email || id); closeModal();
    if (r.upgraded) { toast('Customer account upgraded to employee', 'ok'); return; }
    let sent = false;
    try {   // Firebase's own email carries the set-password link
      if (window.FB.sendPasswordResetEmail) { await window.FB.sendPasswordResetEmail(window.FB.auth, r.email); sent = true; }
    } catch (_) {}
    const emp = (hrCache.employees || []).find(x => x.id === id) || {};
    showInviteLink(Object.assign({}, r, { sent, name: emp.name, phone: emp.phone }));
  } catch (e) { if (b) { b.disabled = false; b.textContent = 'Create login and send invite'; } toast(msg(e), 'bad'); }
};

/* ---------- Security tab: the Block button shows the real state ---------- */
const _securityHtml = window.securityHtml;
window.securityHtml = function () {
  let h = _securityHtml();
  (teamCache || []).forEach(u => {
    const old = `<button class="mini mini-no" onclick="setBlocked('${u.uid}',true)">Block</button>`;
    const now = u.blocked
      ? `<button class="mini mini-ok" onclick="setBlocked('${u.uid}',false)">Unblock</button>`
      : old;
    h = h.split(old).join(now);
  });
  return h;
};

/* ---------- send the set-password link to the employee on WhatsApp ---------- */
const waNumber = raw => {            // 0712... / +254712... -> 254712...
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1); else if (p.startsWith('00')) p = p.slice(2); else if (p.startsWith('0')) p = '254' + p.slice(1);
  return /^\d{10,15}$/.test(p) ? p : '';
};
window.showInviteLink = function (r) {
  if (!r.inviteLink) { toast('Login created for ' + r.email, 'ok'); return; }
  const num = waNumber(r.phone);
  const text = `Hi ${r.name || ''}, your Loyalty ICT Solutions staff login is ready. Set your password here: ${r.inviteLink}`;
  const wa = num ? `https://wa.me/${num}?text=${encodeURIComponent(text)}` : '';
  openModal('Staff login created', `<p class="fin-mut" style="margin-bottom:10px">${r.sent ? 'An email with the link was also sent. ' : ''}Send the set-password link to <b>${escHtml(r.name || r.email)}</b>. It works once.</p>
    ${wa ? `<a class="btn-full" href="${escHtml(wa)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none">Send invite on WhatsApp</a>` : '<p class="fin-mut">No valid WhatsApp number saved. Copy the link instead.</p>'}
    <input id="inv-link" readonly value="${escHtml(r.inviteLink)}" style="width:100%;margin-top:10px" onclick="this.select()">
    <button class="btn-full" style="margin-top:10px;background:var(--bg);color:var(--ink);border:1px solid var(--line)" onclick="navigator.clipboard.writeText(document.getElementById('inv-link').value);toast('Link copied','ok')">Copy link</button>`);
};
