'use strict';

/**
 * ClownFish Extension — Firebase Cloud Functions
 *
 * Before deploying, store your Stripe keys as secrets:
 *   firebase functions:secrets:set STRIPE_SECRET
 *   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
 *
 * Deploy:
 *   firebase deploy --only functions
 */

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const cors      = require('cors')({ origin: true });

admin.initializeApp();

// Reads the secret from the environment — injected by Cloud Secret Manager at runtime.
const getStripe = () => require('stripe')(process.env.STRIPE_SECRET);

// ─── POST /createCheckoutSession ──────────────────────────────────────────────
// Called by the extension when the user clicks "Upgrade for $0.99".
// Verifies the Firebase ID token, creates a Stripe Checkout session, and
// returns { url } so the extension can open it in a new tab.
exports.createCheckoutSession = functions
  .runWith({ secrets: ['STRIPE_SECRET'] })
  .https.onRequest((req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method !== 'POST') {
          return res.status(405).json({ message: 'Method not allowed' });
        }

        // ── 1. Verify Firebase ID token ───────────────────────────────────────
        const authHeader = req.headers.authorization || '';
        const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!idToken) {
          return res.status(401).json({ message: 'Missing auth token' });
        }

        let decoded;
        try {
          decoded = await admin.auth().verifyIdToken(idToken);
        } catch (e) {
          return res.status(401).json({ message: 'Invalid auth token' });
        }

        // ── 2. Check if already subscribed ────────────────────────────────────
        const userDoc = await admin.firestore()
          .collection('users').doc(decoded.uid).get();
        if (userDoc.exists && userDoc.data()?.subscribed === true) {
          return res.status(400).json({ message: 'Already subscribed' });
        }

        // ── 3. Verify Stripe secret is configured ─────────────────────────────
        if (!process.env.STRIPE_SECRET) {
          console.error('STRIPE_SECRET is not set.');
          return res.status(500).json({ message: 'Stripe not configured — STRIPE_SECRET secret is missing. Run: firebase functions:secrets:set STRIPE_SECRET' });
        }

        // ── 4. Create Stripe Checkout session ─────────────────────────────────
        const stripe  = getStripe();
        let session;
        try {
          session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode:                 'payment',
            line_items: [{ price: 'price_1TCsvYRo1NmZSDVnfOaPOgja', quantity: 1 }],
            success_url: 'https://splintdeveloper.github.io/ClownFishAI/payment-success.html',
            cancel_url:  'https://splintdeveloper.github.io/ClownFishAI/',
            metadata: {
              uid:   decoded.uid,
              email: decoded.email || '',
            },
            customer_email: decoded.email || undefined,
          });
        } catch (stripeErr) {
          console.error('Stripe error:', stripeErr.message);
          return res.status(500).json({ message: `Stripe error: ${stripeErr.message}` });
        }

        return res.json({ url: session.url });

      } catch (err) {
        console.error('Unexpected error in createCheckoutSession:', err);
        return res.status(500).json({ message: `Server error: ${err.message}` });
      }
    });
  });

// ─── POST /redeemPromoCode ─────────────────────────────────────────────────────
// Called by the extension when a user submits a promo code.
// Validates the code server-side (so the real code is never in the extension bundle),
// then marks the user as subscribed in Firestore — same as a paid user.
const VALID_PROMO_CODES = new Set(['Cl@wF1sh']);

exports.redeemPromoCode = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({ message: 'Method not allowed' });
    }

    // ── 1. Verify Firebase ID token ─────────────────────────────────────────
    const authHeader = req.headers.authorization || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ message: 'Missing auth token' });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ message: 'Invalid auth token' });
    }

    // ── 2. Validate promo code ───────────────────────────────────────────────
    const code = (req.body?.code || '').trim();
    if (!VALID_PROMO_CODES.has(code)) {
      return res.status(400).json({ message: 'Invalid or expired promo code.' });
    }

    // ── 3. Check if already subscribed ──────────────────────────────────────
    const userDoc = await admin.firestore()
      .collection('users').doc(decoded.uid).get();
    if (userDoc.exists && userDoc.data()?.subscribed === true) {
      // Already Pro — return success silently
      return res.json({ success: true });
    }

    // ── 4. Grant Pro access ──────────────────────────────────────────────────
    await admin.firestore().collection('users').doc(decoded.uid).set(
      {
        subscribed:   true,
        subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        email:        decoded.email || '',
        promoCode:    code,
      },
      { merge: true }
    );
    console.log(`User ${decoded.uid} granted Pro via promo code.`);
    return res.json({ success: true });
  });
});

// ─── POST /stripeWebhook ──────────────────────────────────────────────────────
// Stripe calls this after a successful payment.
// Verifies the Stripe signature, then marks the user as subscribed in Firestore.
exports.stripeWebhook = functions
  .runWith({ secrets: ['STRIPE_SECRET', 'STRIPE_WEBHOOK_SECRET'] })
  .https.onRequest(async (req, res) => {
    const stripe = getStripe();
    const sig    = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Stripe webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid     = session.metadata?.uid;

      if (uid) {
        await admin.firestore().collection('users').doc(uid).set(
          {
            subscribed:   true,
            subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
            email:        session.metadata.email || session.customer_email || '',
            stripeSessionId: session.id,
          },
          { merge: true }
        );
        console.log(`User ${uid} marked as subscribed.`);
      }
    }

    res.json({ received: true });
  });
