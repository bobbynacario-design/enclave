"use strict";

const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions/v2");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");
const {buildDigest} = require("./digest");

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

const APP_URL = "https://bobbynacario-design.github.io/enclave/";

// Collects the past week's activity used to build digest emails.
// Returns {week, usersSnap}; usersSnap doubles as the recipient list.
const gatherWeekData = async (now) => {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [postsSnap, eventsSnap, usersSnap, resSnap, briefSnap] =
    await Promise.all([
      db.collection("posts")
          .where("timestamp", ">=", weekAgo)
          .orderBy("timestamp", "desc")
          .get(),
      db.collection("events")
          .where("date", ">=", now)
          .orderBy("date", "asc")
          .limit(10)
          .get(),
      db.collection("users").get(),
      db.collection("resources")
          .where("createdAt", ">=", weekAgo)
          .get(),
      db.collection("briefings")
          .where("publishedAt", ">=", weekAgo)
          .get(),
    ]);

  const week = {
    posts: postsSnap.docs.map((d) => d.data()),
    events: eventsSnap.docs.map((d) => d.data()),
    newMembers: usersSnap.docs
        .map((d) => d.data())
        .filter((u) => u.joinedAt &&
          typeof u.joinedAt.toMillis === "function" &&
          u.joinedAt.toMillis() >= weekAgo.getTime()),
    resources: resSnap.docs.map((d) => d.data()),
    briefingCount: briefSnap.size,
  };

  return {week: week, usersSnap: usersSnap};
};

// Every Monday 8:00 AM Manila time, queue one digest email per member
// summarizing the past week (posts/events filtered to their circles).
// Emails are delivered by the Trigger Email extension watching `mail`.
// Members with digestOptOut == true on their user doc are skipped.
exports.weeklyDigest = onSchedule(
    {
      schedule: "0 8 * * 1",
      timeZone: "Asia/Manila",
      region: "asia-southeast1",
    },
    async () => {
      const {week, usersSnap} = await gatherWeekData(new Date());

      const batch = db.batch();
      let queued = 0;
      let skipped = 0;
      usersSnap.docs.forEach((userDoc) => {
        const user = userDoc.data();
        if (!user.email || user.digestOptOut === true) {
          skipped++;
          return;
        }
        const digest = buildDigest(user, week);
        if (!digest) {
          skipped++;
          return;
        }
        const ref = db.collection("mail").doc();
        batch.set(ref, {
          to: [user.email],
          createdAt: FieldValue.serverTimestamp(),
          metadata: {
            type: "weekly-digest",
            recipientUid: userDoc.id,
          },
          message: digest,
        });
        queued++;
      });

      if (queued > 0) {
        await batch.commit();
      }

      logger.info("Weekly digest queued", {
        recipients: queued,
        skipped: skipped,
        posts: week.posts.length,
        events: week.events.length,
        newMembers: week.newMembers.length,
        resources: week.resources.length,
        briefings: week.briefingCount,
      });
    },
);

// Admin-requested test digest: the Admin page writes a digestRequests doc
// (rules restrict creation to admins); this builds the current week's
// digest for the requester only, queues the email, and reports back by
// updating the request doc with status/mailId for the UI to observe.
exports.sendTestDigest = onDocumentCreated(
    {
      document: "digestRequests/{requestId}",
      region: "asia-southeast1",
    },
    async (event) => {
      const snap = event.data;
      if (!snap) return;

      const requestedBy = (snap.data() || {}).requestedBy;
      const fail = (error) => snap.ref.update({
        status: "error",
        error: error,
        processedAt: FieldValue.serverTimestamp(),
      });

      if (!requestedBy || typeof requestedBy !== "string") {
        await fail("Request is missing requestedBy.");
        return;
      }

      const userSnap = await db.doc("users/" + requestedBy).get();
      if (!userSnap.exists) {
        await fail("Requesting user not found.");
        return;
      }

      const user = userSnap.data();
      // Rules already restrict creation to admins; re-check here because
      // this function runs with admin privileges.
      if (user.isAdmin !== true || !user.email) {
        await fail("Requester is not an admin with an email address.");
        return;
      }

      const {week} = await gatherWeekData(new Date());
      const digest = buildDigest(user, week);
      if (!digest) {
        await snap.ref.update({
          status: "empty",
          processedAt: FieldValue.serverTimestamp(),
        });
        logger.info("Test digest skipped — empty week", {
          requestedBy: requestedBy,
        });
        return;
      }

      digest.subject = "[Test] " + digest.subject;
      const mailRef = await db.collection("mail").add({
        to: [user.email],
        createdAt: FieldValue.serverTimestamp(),
        metadata: {
          type: "weekly-digest-test",
          recipientUid: requestedBy,
        },
        message: digest,
      });

      await snap.ref.update({
        status: "queued",
        mailId: mailRef.id,
        processedAt: FieldValue.serverTimestamp(),
      });

      logger.info("Test digest queued", {
        requestedBy: requestedBy,
        mailId: mailRef.id,
      });
    },
);

// When a briefing is published, fan out one in-app notification per member.
// Each notification doc then triggers sendNotificationPush below, so members
// with FCM tokens also get a web push.
exports.announceBriefing = onDocumentCreated(
    {
      document: "briefings/{briefingId}",
      region: "asia-southeast1",
    },
    async (event) => {
      const snap = event.data;
      if (!snap) return;

      const briefing = snap.data() || {};
      const publishedBy = briefing.publishedBy || "";
      const dateLabel = briefing.date ? String(briefing.date) : "Today";

      const usersSnap = await db.collection("users").get();
      const batch = db.batch();
      let recipients = 0;
      usersSnap.forEach((userDoc) => {
        if (userDoc.id === publishedBy) return;
        const ref = db.collection("notifications").doc();
        batch.set(ref, {
          recipientId: userDoc.id,
          type: "briefing",
          message: "☕ " + dateLabel + " briefing is up — tap to read.",
          link: {page: "briefings", params: {}},
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          actorId: publishedBy || "system",
          actorName: "Daily Briefing",
        });
        recipients++;
      });

      if (recipients > 0) {
        await batch.commit();
      }

      logger.info("Briefing announced", {
        briefingId: event.params.briefingId,
        recipients: recipients,
      });
    },
);

exports.sendNotificationPush = onDocumentCreated(
    {
      document: "notifications/{notificationId}",
      region: "asia-southeast1",
    },
    async (event) => {
      const snap = event.data;
      if (!snap) return;

      const notif = snap.data();
      if (!notif || !notif.recipientId) {
        logger.warn("Notification missing recipientId", {
          id: event.params.notificationId,
        });
        return;
      }

      // Fetch recipient's FCM tokens
      const userRef = db.doc("users/" + notif.recipientId);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        logger.warn("Recipient user doc not found", {
          recipientId: notif.recipientId,
        });
        return;
      }

      const userData = userSnap.data();
      const rawTokens = Array.isArray(userData.fcmTokens) ?
        userData.fcmTokens : [];
      const tokens = rawTokens.filter((t) =>
        typeof t === "string" && t.length > 0);
      if (tokens.length === 0) {
        logger.info("No valid FCM tokens for recipient", {
          recipientId: notif.recipientId,
          rawTokenCount: rawTokens.length,
        });
        return;
      }

      // Build the multicast message
      const link = notif.link || {};
      const message = {
        notification: {
          title: "Enclave",
          body: String(notif.message || "You have a new notification"),
        },
        data: {
          type: String(notif.type || "general"),
          page: String(link.page || "feed"),
          params: JSON.stringify(link.params || {}),
        },
        webpush: {
          fcmOptions: {
            link: APP_URL,
          },
        },
        tokens: tokens,
      };

      // Send to all tokens in one multicast call.
      // Any throw here would cause a retry of the entire function,
      // potentially delivering duplicate pushes — so we catch.
      let response;
      try {
        response = await messaging.sendEachForMulticast(message);
      } catch (err) {
        logger.error("FCM send failed", {
          recipientId: notif.recipientId,
          error: err.message,
          code: err.code,
        });
        return;
      }

      // Remove any tokens that are no longer valid
      const deadTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token" ||
            code === "messaging/invalid-argument"
          ) {
            deadTokens.push(tokens[idx]);
          }
        }
      });

      if (deadTokens.length > 0) {
        try {
          await userRef.update({
            fcmTokens: FieldValue.arrayRemove(...deadTokens),
          });
        } catch (err) {
          // Cleanup is best-effort. Don't retry the function over this.
          logger.warn("Failed to remove dead tokens", {
            recipientId: notif.recipientId,
            error: err.message,
          });
        }
      }

      logger.info("Push send summary", {
        recipientId: notif.recipientId,
        totalTokens: tokens.length,
        successCount: response.successCount,
        failureCount: response.failureCount,
        deadTokensRemoved: deadTokens.length,
      });
    },
);
