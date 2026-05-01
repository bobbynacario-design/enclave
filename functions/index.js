"use strict";

const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {logger} = require("firebase-functions/v2");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

const APP_URL = "https://bobbynacario-design.github.io/enclave/";

exports.sendNotificationPush = onDocumentCreated(
    {
      document: "notifications/{notificationId}",
      region: "us-central1",
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
      const tokens = Array.isArray(userData.fcmTokens) ?
        userData.fcmTokens : [];
      if (tokens.length === 0) {
        logger.info("No FCM tokens for recipient", {
          recipientId: notif.recipientId,
        });
        return;
      }

      // Build the multicast message
      const link = notif.link || {};
      const message = {
        notification: {
          title: "Enclave",
          body: notif.message || "You have a new notification",
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

      // Send to all tokens in one multicast call
      const response = await messaging.sendEachForMulticast(message);

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
        await userRef.update({
          fcmTokens: FieldValue.arrayRemove(...deadTokens),
        });
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
