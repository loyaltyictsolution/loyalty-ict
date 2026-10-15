/* ============================================================
   functions/index.js   (Firebase Cloud Functions v2, Node 20)
   Codes are sent by WhatsApp (Meta Cloud API) only.

   Functions:
     sendOtp               - sends a 6-digit code (register or staff login)
     registerCustomer      - checks the code, then creates the customer account
     verifyLoginOtp        - checks the staff code, then sets the otpAt claim
     createEmployeeAccount - HR / admin only: opens a staff login
   ============================================================ */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();

/* ---------- settings ---------- */
const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");        // system user token
const WHATSAPP_PHONE_ID = defineSecret("WHATSAPP_PHONE_ID");  // Phone number ID

const REGION = "europe-west1";                 // must match accounts.js
const GRAPH = "https://graph.facebook.com/v21.0";
const TEMPLATE_NAME = "loyalty_otp";           // your approved AUTHENTICATION template
const TEMPLATE_LANG = "en";                    // must match the template language exactly
const TEMPLATE_HAS_COPY_BUTTON = true;         // true for the standard "Copy code" authentication template
const DEFAULT_COUNTRY = "254";                 // Kenya

const OTP_TTL_MS = 10 * 60 * 1000;             // code lives 10 minutes
const COOLDOWN_MS = 55 * 1000;                 // one code per ~minute
const MAX_TRIES = 5;                           // wrong guesses allowed per code
const KEEP_ROLES = ["admin", "manager", "hr", "finance", "stock", "staff"]; // never downgraded

/* ---------- helpers ---------- */
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const maskPhone = (p) => "•••" + String(p).slice(-3);

/** 07XX..., +2547XX..., 2547XX... -> 2547XXXXXXXX */
function normalizePhone(raw) {
  let p = String(raw || "").replace(/[^\d+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  else if (p.startsWith("00")) p = p.slice(2);
  else if (p.startsWith("0")) p = DEFAULT_COUNTRY + p.slice(1);
  if (!/^\d{10,15}$/.test(p)) {
    throw new HttpsError("invalid-argument", "Enter a valid phone number, for example 0712 345 678.");
  }
  return p;
}

async function sendWhatsAppOtp(phone, code) {
  const components = [{ type: "body", parameters: [{ type: "text", text: code }] }];
  if (TEMPLATE_HAS_COPY_BUTTON) {
    components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] });
  }
  const res = await fetch(`${GRAPH}/${WHATSAPP_PHONE_ID.value()}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: { name: TEMPLATE_NAME, language: { code: TEMPLATE_LANG }, components },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("WhatsApp send failed", JSON.stringify(data));
    const e = data.error || {};
    // the Meta code is included so you can see the cause; remove it once everything works
    throw new HttpsError("failed-precondition",
      `WhatsApp could not send the code (${e.code || res.status}: ${e.message || "unknown error"}).`);
  }
}

/** Phone used for the staff sign-in code: HR employee record first, then the user profile. */
async function staffPhone(uid, email) {
  const mail = String(email || "").toLowerCase();
  if (mail) {
    const q = await db.collection("employees").where("email", "==", mail).limit(1).get();
    if (!q.empty && q.docs[0].data().phone) return normalizePhone(q.docs[0].data().phone);
  }
  const u = await db.collection("users").doc(uid).get();
  if (u.exists && u.data().phone) return normalizePhone(u.data().phone);
  throw new HttpsError("failed-precondition",
    "No WhatsApp number is saved for this account. Ask HR or the administrator to add it.");
}

/** Checks a code and deletes it when it is right. Returns the stored record. */
async function consumeCode(key, code) {
  const ref = db.collection("otpCodes").doc(key);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "No code was requested. Ask for a new one.");
  const s = snap.data();
  if (Date.now() > s.expiresAt) {
    await ref.delete();
    throw new HttpsError("deadline-exceeded", "That code has expired. Ask for a new one.");
  }
  if (s.tries >= MAX_TRIES) {
    await ref.delete();
    throw new HttpsError("resource-exhausted", "Too many wrong attempts. Ask for a new code.");
  }
  if (!safeEq(sha(String(code) + ":" + key), s.hash)) {
    await ref.update({ tries: admin.firestore.FieldValue.increment(1) });
    throw new HttpsError("permission-denied", "Wrong code. Try again.");
  }
  await ref.delete();
  return s;
}

const regKey = (email) => "reg_" + sha(email).slice(0, 32);

/* ---------- sendOtp ---------- */
exports.sendOtp = onCall({ region: REGION, secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_ID] }, async (req) => {
  const d = req.data || {};
  if (d.channel && d.channel !== "whatsapp") {
    throw new HttpsError("failed-precondition", "Codes are sent by WhatsApp only.");
  }

  let key, phone;
  if (d.purpose === "register") {
    const email = String(d.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError("invalid-argument", "Enter a valid email address.");
    phone = normalizePhone(d.phone);
    try {
      await auth.getUserByEmail(email);
      throw new HttpsError("already-exists", "An account with this email already exists. Log in instead.");
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      if (e.code !== "auth/user-not-found") throw e;
    }
    key = regKey(email);
  } else if (d.purpose === "login") {
    if (!req.auth) throw new HttpsError("unauthenticated", "Log in first.");
    phone = await staffPhone(req.auth.uid, req.auth.token.email);
    key = "login_" + req.auth.uid;
  } else {
    throw new HttpsError("invalid-argument", "Unknown request.");
  }

  const ref = db.collection("otpCodes").doc(key);
  const old = await ref.get();
  if (old.exists && Date.now() - old.data().sentAt < COOLDOWN_MS) {
    throw new HttpsError("resource-exhausted", "Please wait a minute before asking for a new code.");
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await sendWhatsAppOtp(phone, code);
  await ref.set({ hash: sha(code + ":" + key), phone, tries: 0, sentAt: Date.now(), expiresAt: Date.now() + OTP_TTL_MS });
  return { channel: "whatsapp", to: maskPhone(phone) };
});

/* ---------- registerCustomer ---------- */
exports.registerCustomer = onCall({ region: REGION }, async (req) => {
  const d = req.data || {};
  const name = String(d.name || "").trim();
  const email = String(d.email || "").trim().toLowerCase();
  const password = String(d.password || "");
  if (!name || !email) throw new HttpsError("invalid-argument", "Fill in all fields.");
  if (password.length < 8) throw new HttpsError("invalid-argument", "Password must be 8+ characters.");

  const rec = await consumeCode(regKey(email), d.code);
  if (normalizePhone(d.phone) !== rec.phone) {
    throw new HttpsError("permission-denied", "The phone number does not match the one the code was sent to.");
  }

  let user;
  try {
    user = await auth.createUser({ email, password, displayName: name });
  } catch (e) {
    if (e.code === "auth/email-already-exists") throw new HttpsError("already-exists", "An account with this email already exists.");
    throw new HttpsError("internal", "Could not create the account.");
  }
  await db.collection("users").doc(user.uid).set({
    name, email, phone: rec.phone, phoneVerified: true, role: "customer",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/* ---------- verifyLoginOtp (staff / admin) ---------- */
exports.verifyLoginOtp = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Log in first.");
  await consumeCode("login_" + req.auth.uid, (req.data || {}).code);
  const u = await auth.getUser(req.auth.uid);
  await auth.setCustomUserClaims(req.auth.uid, { ...(u.customClaims || {}), otpAt: Date.now() });
  return { ok: true };
});

/* ---------- createEmployeeAccount (HR / admin only) ---------- */
exports.createEmployeeAccount = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Log in first.");
  const me = (await db.collection("users").doc(req.auth.uid).get()).data() || {};
  if (me.blocked || !["admin", "hr"].includes(me.role)) {
    throw new HttpsError("permission-denied", "Only HR or the administrator can create staff logins.");
  }

  const empRef = db.collection("employees").doc(String((req.data || {}).employeeId || "x"));
  const emp = await empRef.get();
  if (!emp.exists) throw new HttpsError("not-found", "Employee not found.");
  const e = emp.data();
  const email = String(e.email || "").trim().toLowerCase();
  if (!email) throw new HttpsError("failed-precondition", "Add the employee email first.");
  if (!e.phone) throw new HttpsError("failed-precondition", "Add the employee WhatsApp number first.");

  let user, upgraded = false;
  try {
    user = await auth.getUserByEmail(email);
    upgraded = true;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    user = await auth.createUser({ email, displayName: e.name || undefined });
  }

  const uref = db.collection("users").doc(user.uid);
  const cur = (await uref.get()).data() || {};
  const role = KEEP_ROLES.includes(cur.role) ? cur.role : "employee";   // never downgrade
  await uref.set({
    name: e.name || cur.name || "", email, phone: normalizePhone(e.phone), role,
    createdAt: cur.createdAt || admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await empRef.update({ uid: user.uid });

  const inviteLink = upgraded ? null : await auth.generatePasswordResetLink(email);
  return { email, upgraded, inviteLink };
});
