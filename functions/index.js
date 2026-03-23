const functions  = require('firebase-functions/v1');
const admin      = require('firebase-admin');
const webPush    = require('web-push');

admin.initializeApp();
const db = admin.firestore();

// Triggered whenever a document is created in the 'pings' collection.
// The client writes the ping; this function sends the Web Push and cleans up.
exports.sendPing = functions.firestore
  .document('pings/{pingId}')
  .onCreate(async (snap) => {
    const { to, from, item, listName, sectionName } = snap.data();

    webPush.setVapidDetails(
      `mailto:${process.env.VAPID_EMAIL}`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    // Read the target user's push subscription from Firestore
    const shared = await db.collection('listplanner').doc('shared').get();
    const subscription = shared.data()?.pushSubscriptions?.[to];

    if (!subscription) {
      console.log(`No push subscription stored for ${to} — skipping`);
      return snap.ref.delete();
    }

    const payload = JSON.stringify({
      title: `${from} pinged you on ListPlanner`,
      body: `"${item}"${sectionName ? ` · ${sectionName}` : ''}${listName ? ` in ${listName}` : ''}`,
      url: 'https://3milus.github.io/ListPlanner/',
    });

    try {
      await webPush.sendNotification(subscription, payload);
      console.log(`Push sent to ${to} for item "${item}"`);
    } catch (err) {
      console.error('web-push error:', err.statusCode, err.body);
      // 410 Gone = subscription expired or unsubscribed — remove it
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.collection('listplanner').doc('shared').update({
          [`pushSubscriptions.${to}`]: admin.firestore.FieldValue.delete(),
        });
      }
    }

    // Always delete the ping doc after processing
    return snap.ref.delete();
  });
