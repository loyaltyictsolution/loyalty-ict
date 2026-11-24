# Launch checklist

Files to upload to your GitHub Pages repo: `index.html`, `loyalty-extras.css`, `loyalty-extras.js`.
`functions/` deploys to Firebase (not GitHub).

## 1. Till number
Open `loyalty-extras.js`, set `TILL:'123456'` (your number). It then shows on the site and at checkout.

## 2. Daraja (Safaricom) for a Till
In your production Daraja app you need: Consumer Key, Consumer Secret, Passkey, and the **Store (Head Office) number**.
For a Till, the Store number goes in `MPESA_SHORTCODE`. The Till number goes in `MPESA_TILL`.
Safaricom must have enabled "Lipa na M-Pesa Online" for your Till. If the push is refused, ask Safaricom to confirm that.

## 3. Deploy functions (needs Firebase Blaze plan, pay-as-you-go; usage here is tiny)
```
npm i -g firebase-tools && firebase login
cd functions && npm i && cp .env.example .env   # fill in .env
firebase functions:secrets:set MPESA_KEY
firebase functions:secrets:set MPESA_SECRET
firebase functions:secrets:set MPESA_PASSKEY
firebase functions:secrets:set ANTHROPIC_API_KEY   # key from console.anthropic.com
firebase deploy --only functions --project loyaltyitsolutions-a82f0
```
Add your custom domain to `ORIGINS` in `functions/index.js` if you use one.

## 4. Firestore rules (add inside your existing `match /databases/{db}/documents`)
Replace `isStaff()` with your existing staff/admin check.
```
match /payments/{id}  { allow get: if true; allow list, write: if false; }
match /chats/{cid} {
  allow create: if true;
  allow get: if true;
  allow update: if isStaff() || request.resource.data.diff(resource.data).affectedKeys().hasOnly(['last','updated','unread','name']);
  allow list: if isStaff();
  match /messages/{m} {
    allow read: if true;
    allow create: if (request.resource.data.from == 'cust' && request.resource.data.text.size() < 600) || isStaff();
  }
}
```
Chat ids are random and unguessable. Only someone holding the id can read that thread.
Orders: your existing rule must let the public **create** orders. Clients must not be able to set `payStatus:'paid'` on update. Keep order updates staff-only.

## 5. Test (do this before launch)
1. Set `MPESA_ENV=sandbox` in `.env`, use sandbox keys, redeploy, run one order.
2. Switch to `production` and pay KSh 1 for real from your own phone. Check the order shows paid with the M-Pesa code.
3. Open the staff portal, go to Communication > Customer chat, send a message from the site's "Live person" tab and reply.
4. Ask the AI about a product. If the function is down, the chat falls back to a basic catalogue answer.

## Known limits
- Abandoned M-Pesa attempts leave an order with `payStatus:'awaiting'`. Filter these in the admin panel or clean them weekly.
- Staff are not notified of new chats by sound or push yet. The portal shows a badge, a bell alert and a notification for new customer chats while it is open.
