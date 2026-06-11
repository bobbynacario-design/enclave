"use strict";

const {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentWritten,
} = require("firebase-functions/v2/firestore");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {logger} = require("firebase-functions/v2");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");
const {getStorage} = require("firebase-admin/storage");
const {buildDigest} = require("./digest");
const {buildProjectInviteEmail} = require("./emails");

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

const APP_URL = "https://bobbynacario-design.github.io/enclave/";

// Deletes a post's uploaded images from Storage when the post is
// deleted, so files don't pile up orphaned in the bucket. Storage rules
// only let users delete their own files; this runs with admin SDK so
// admin-deleted posts get cleaned up too.
exports.cleanupPostImages = onDocumentDeleted(
    {
      document: "posts/{postId}",
      region: "asia-southeast1",
    },
    async (event) => {
      const snap = event.data;
      if (!snap) return;

      const images = (snap.data() || {}).images;
      if (!Array.isArray(images) || images.length === 0) return;

      const bucket = getStorage().bucket();
      const paths = images
          .map((im) => im && im.path)
          .filter((p) => typeof p === "string" &&
            p.indexOf("post-images/") === 0);

      await Promise.all(paths.map((p) =>
        bucket.file(p).delete().catch((err) => {
          logger.warn("Failed to delete post image", {
            path: p,
            error: err.message,
          });
        })));

      logger.info("Cleaned up post images", {
        postId: event.params.postId,
        count: paths.length,
      });
    },
);

// When an email is newly added to a project's pendingInvites, send the
// invitee an email (the in-app banner alone is invisible to anyone who
// doesn't open the app). If the email belongs to an existing member,
// also write an in-app notification so they get a push.
exports.sendProjectInviteEmails = onDocumentWritten(
    {
      document: "projects/{projectId}",
      region: "asia-southeast1",
    },
    async (event) => {
      const after = event.data.after.exists ? event.data.after.data() : null;
      if (!after) return;
      const before = event.data.before.exists ?
        event.data.before.data() : null;

      const beforeInvites = before && Array.isArray(before.pendingInvites) ?
        before.pendingInvites : [];
      const afterInvites = Array.isArray(after.pendingInvites) ?
        after.pendingInvites : [];
      const newEmails = afterInvites.filter(
          (e) => typeof e === "string" && e && beforeInvites.indexOf(e) < 0);
      if (newEmails.length === 0) return;

      const projectName = String(after.name || "a project");
      const inviterName = (after.memberNames &&
        after.memberNames[after.createdBy]) || "An Enclave member";

      const batch = db.batch();
      const message = buildProjectInviteEmail({
        projectName: projectName,
        inviterName: inviterName,
      });

      newEmails.forEach((email) => {
        const mailRef = db.collection("mail").doc();
        batch.set(mailRef, {
          to: [email],
          createdAt: FieldValue.serverTimestamp(),
          metadata: {
            type: "project-invite",
            projectId: event.params.projectId,
            invitedEmail: email,
          },
          message: message,
        });
      });

      // In-app notification for invitees who are already members.
      // "in" supports up to 30 values; invites arrive one or two at a time.
      const usersSnap = await db.collection("users")
          .where("email", "in", newEmails.slice(0, 30))
          .get();
      usersSnap.forEach((userDoc) => {
        const notifRef = db.collection("notifications").doc();
        batch.set(notifRef, {
          recipientId: userDoc.id,
          type: "project-invite",
          message: inviterName + " invited you to \"" + projectName +
            "\" — open Projects to accept.",
          link: {page: "projects", params: {}},
          read: false,
          createdAt: FieldValue.serverTimestamp(),
          actorId: after.createdBy || "system",
          actorName: inviterName,
        });
      });

      await batch.commit();
      logger.info("Project invites sent", {
        projectId: event.params.projectId,
        emails: newEmails.length,
        notified: usersSnap.size,
      });
    },
);

// Fetches every project's tasks: [{projectId, project, tasks: [...]}].
// Fine at this community's scale; revisit with a collection-group index
// if projects grow into the hundreds.
const fetchAllProjectTasks = async () => {
  const projectsSnap = await db.collection("projects").get();
  const taskSnaps = await Promise.all(
      projectsSnap.docs.map((p) => p.ref.collection("tasks").get()));
  return projectsSnap.docs.map((p, i) => ({
    projectId: p.id,
    project: p.data(),
    tasks: taskSnaps[i].docs.map((t) => t.data()),
  }));
};

const manilaDateString = (ms) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
}).format(new Date(ms));

// Daily 8:00 AM Manila: remind assignees about tasks due tomorrow, due
// today, or newly overdue (due yesterday). Older overdue tasks are left
// to the weekly digest, so nobody gets nagged daily.
exports.taskReminders = onSchedule(
    {
      schedule: "0 8 * * *",
      timeZone: "Asia/Manila",
      region: "asia-southeast1",
    },
    async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const today = manilaDateString(nowMs);
      const tomorrow = manilaDateString(nowMs + dayMs);
      const yesterday = manilaDateString(nowMs - dayMs);

      const projects = await fetchAllProjectTasks();
      const batch = db.batch();
      let count = 0;

      projects.forEach((entry) => {
        const projectName = String(entry.project.name || "a project");
        entry.tasks.forEach((t) => {
          if (t.status === "done" || !t.dueDate) return;
          let phrase = null;
          if (t.dueDate === tomorrow) phrase = "is due tomorrow";
          else if (t.dueDate === today) phrase = "is due today";
          else if (t.dueDate === yesterday) phrase = "is now overdue";
          if (!phrase) return;

          const recipient = t.assigneeId || t.createdBy;
          if (!recipient) return;

          const notifRef = db.collection("notifications").doc();
          batch.set(notifRef, {
            recipientId: recipient,
            type: "task-due",
            message: "⏰ \"" + String(t.title || "Task") + "\" in " +
              projectName + " " + phrase + ".",
            link: {page: "projects", params: {projectId: entry.projectId}},
            read: false,
            createdAt: FieldValue.serverTimestamp(),
            actorId: "system",
            actorName: "Task reminder",
          });
          count++;
        });
      });

      if (count > 0) await batch.commit();
      logger.info("Task reminders queued", {reminders: count});
    },
);

// Collects the past week's activity used to build digest emails.
// Returns {week, usersSnap}; usersSnap doubles as the recipient list.
const gatherWeekData = async (now) => {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [postsSnap, eventsSnap, usersSnap, resSnap, briefSnap, projects] =
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
      fetchAllProjectTasks(),
    ]);

  // Open tasks bucketed per member (assignee, falling back to creator),
  // overdue first then by due date, for the digest's "Your tasks" section.
  const today = manilaDateString(now.getTime());
  const tasksByUser = {};
  projects.forEach((entry) => {
    const projectName = String(entry.project.name || "a project");
    entry.tasks.forEach((t) => {
      if (t.status === "done") return;
      const uid = t.assigneeId || t.createdBy;
      if (!uid) return;
      if (!tasksByUser[uid]) tasksByUser[uid] = [];
      tasksByUser[uid].push({
        title: String(t.title || "Task"),
        projectName: projectName,
        dueDate: t.dueDate || "",
        overdue: Boolean(t.dueDate && t.dueDate < today),
      });
    });
  });
  Object.keys(tasksByUser).forEach((uid) => {
    tasksByUser[uid].sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
    });
  });

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
    tasksByUser: tasksByUser,
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
