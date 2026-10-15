/* ============================================================
   whatsappOtp.js  (Firebase Cloud Functions, Node 18+)
   Add this to your functions folder and call sendWhatsAppOtp()
   from inside your existing sendOtp function when channel === 'whatsapp'.
   ============================================================ */
const { defineSecret } = require("firebase-functions/params");

// Store these with:  firebase functions:secrets:set WHATSAPP_TOKEN
//                    firebase functions:secrets:set WHATSAPP_PHONE_ID
const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");       // system user token (loyalty-otp)
const WHATSAPP_PHONE_ID = defineSecret("WHATSAPP_PHONE_ID"); // Phone number ID from WhatsApp Manager

const GRAPH = "https://graph.facebook.com/v21.0";
const TEMPLATE_NAME = "loyalty_otp";   // your approved AUTHENTICATION template
const TEMPLATE_LANG = "en";

/** 07XX..., +2547XX..., 2547XX... -> 2547XXXXXXXX (digits only, Kenya default) */
function normalizePhone(raw, defaultCountry = "254") {
  let p = String(raw || "").replace(/[^\d+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  else if (p.startsWith("00")) p = p.slice(2);
  else if (p.startsWith("0")) p = defaultCountry + p.slice(1);
  if (!/^\d{10,15}$/.test(p)) throw new Error("Enter a valid phone number with country code.");
  return p;
}

async function sendWhatsAppOtp(phone, code) {
  const to = normalizePhone(phone);
  const res = await fetch(`${GRAPH}/${WHATSAPP_PHONE_ID.value()}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANG },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          // Authentication templates with the "Copy code" button need this too:
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("WhatsApp send failed", JSON.stringify(data));
    throw new Error("Could not send the WhatsApp code. Try SMS or email instead.");
  }
  return { to: "•••" + to.slice(-3) };   // masked, shown on the code screen
}

module.exports = { sendWhatsAppOtp, normalizePhone, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID };

/* ------------------------------------------------------------
   Inside your existing sendOtp function:

   const { onCall } = require("firebase-functions/v2/https");
   const { sendWhatsAppOtp, WHATSAPP_TOKEN, WHATSAPP_PHONE_ID } = require("./whatsappOtp");

   exports.sendOtp = onCall(
     { region: "europe-west1", secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_ID] },
     async (req) => {
       const channel = ["email", "sms", "whatsapp"].includes(req.data.channel) ? req.data.channel : "email";
       ... // your existing code that creates + stores the 6-digit code
       if (channel === "whatsapp") {
         const r = await sendWhatsAppOtp(phone, code);   // phone from req.data (register) or the user's saved phone (login)
         return { channel: "whatsapp", to: r.to };
       }
       ... // existing email / sms branches
     });
------------------------------------------------------------ */
