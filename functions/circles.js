"use strict";

// Member-created circles. Every change to who is in a circle goes through
// this one callable, because a member's circles live in two places that
// have to stay in step:
//   users/{uid}.circles      — what the Firestore rules check
//   allowlist/{email}.circles — what a new account starts with
// Clients can read circles/{id} (members only) but never write it.
//
// The three original circles are "legacy" circles owned by the
// owner-admin. Admins can still assign those from the Admin page; every
// other circle is private to its members, admins included.

const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {logger} = require("firebase-functions/v2");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {buildCircleInviteEmail} = require("./emails");

const OWNER_EMAIL = "bobbynacario@gmail.com";

const LEGACY_CIRCLES = [
  {id: "hustle-hub", name: "Hustle Hub"},
  {id: "work-network", name: "Work Network"},
  {id: "family", name: "Family"},
];
const LEGACY_IDS = LEGACY_CIRCLES.map((c) => c.id);

// Feed queries use where("circle", "in", ...), which takes 30 values:
// "all" + 3 legacy circles + 25 member circles stays under that.
const MAX_JOINED = 25;
const MAX_OWNED = 10;
const MAX_PEOPLE = 50;
const MAX_INVITES_PER_DAY = 20;
const MAX_EMAILS_PER_CALL = 10;
const MAX_NAME_LENGTH = 40;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isLegacy = (id) => LEGACY_IDS.indexOf(id) !== -1;

const memberCircleCount = (circles) => (Array.isArray(circles) ?
  circles : []).filter((c) => c !== "all" && !isLegacy(c)).length;

const fail = (code, message) => new HttpsError(code, message);

const cleanName = (value) => {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) throw fail("invalid-argument", "Give the circle a name.");
  if (name.length > MAX_NAME_LENGTH) {
    throw fail("invalid-argument",
        "Keep the name to " + MAX_NAME_LENGTH + " characters or fewer.");
  }
  return name;
};

const cleanId = (value) => {
  const id = String(value || "");
  if (!ID_RE.test(id)) throw fail("invalid-argument", "Unknown circle.");
  return id;
};

const todayKey = () => new Date().toISOString().slice(0, 10);

const displayName = (user, fallback) =>
  String((user && (user.name || user.email)) || fallback || "A member");

/**
 * Checks the caller is a signed-in, verified, still-invited member.
 *
 * @param {Object} db Firestore instance.
 * @param {Object} request Callable request.
 * @return {Promise<Object>} {uid, email, user, isAdmin, name}.
 */
const loadCaller = async (db, request) => {
  const auth = request.auth;
  if (!auth || !auth.token || !auth.token.email) {
    throw fail("unauthenticated", "Sign in first.");
  }
  if (auth.token.email_verified !== true) {
    throw fail("permission-denied", "Verify your email address first.");
  }

  const email = String(auth.token.email).toLowerCase();
  const [userSnap, allowSnap] = await Promise.all([
    db.collection("users").doc(auth.uid).get(),
    db.collection("allowlist").doc(email).get(),
  ]);
  if (!userSnap.exists || !allowSnap.exists) {
    throw fail("permission-denied", "Your Enclave invite isn't active.");
  }

  const user = userSnap.data() || {};
  return {
    uid: auth.uid,
    email: email,
    user: user,
    isAdmin: user.isAdmin === true || email === OWNER_EMAIL,
    name: displayName(user, email),
  };
};

const loadCircle = async (db, circleId) => {
  const ref = db.collection("circles").doc(cleanId(circleId));
  const snap = await ref.get();
  if (!snap.exists) throw fail("not-found", "That circle no longer exists.");
  return {ref: ref, id: ref.id, data: snap.data() || {}};
};

const requireMember = (caller, circle) => {
  const circles = Array.isArray(caller.user.circles) ?
    caller.user.circles : [];
  if (circles.indexOf(circle.id) === -1) {
    throw fail("permission-denied", "You're not in that circle.");
  }
};

const requireOwner = (caller, circle) => {
  if (circle.data.ownerId !== caller.uid) {
    throw fail("permission-denied",
        "Only the person who looks after this circle can do that.");
  }
};

const membersOf = async (db, circleId) => {
  const snap = await db.collection("users")
      .where("circles", "array-contains", circleId)
      .get();
  return snap.docs;
};

const joinedMs = (doc) => {
  const joined = (doc.data() || {}).joinedAt;
  return joined && typeof joined.toMillis === "function" ?
    joined.toMillis() : Number.MAX_SAFE_INTEGER;
};

// Adds or removes one circle on both copies of a member's list. The
// allowlist copy is skipped when the entry is gone (the person was
// removed from Enclave, so nothing will read it).
const setMembership = async (db, batch, userDoc, circleId, add) => {
  const change = add ? FieldValue.arrayUnion(circleId) :
    FieldValue.arrayRemove(circleId);
  batch.update(userDoc.ref, {circles: change});

  const email = String((userDoc.data() || {}).email || "").toLowerCase();
  if (!email) return;
  const allowRef = db.collection("allowlist").doc(email);
  const allowSnap = await allowRef.get();
  if (allowSnap.exists) batch.update(allowRef, {circles: change});
};

// Withdraws a pending invite. An allowlist entry that only existed
// because of circle invites is deleted once it has no circles left, so
// cancelling the invite also cancels their access to Enclave.
const withdrawInvite = async (db, batch, email, circleId) => {
  const allowRef = db.collection("allowlist").doc(email);
  const allowSnap = await allowRef.get();
  if (!allowSnap.exists) return;

  const entry = allowSnap.data() || {};
  const remaining = (Array.isArray(entry.circles) ? entry.circles : [])
      .filter((c) => c !== circleId);
  const userSnap = await db.collection("users")
      .where("email", "==", email).limit(1).get();

  if (entry.invitedVia === "circle" && remaining.length === 0 &&
      userSnap.empty) {
    batch.delete(allowRef);
  } else {
    batch.update(allowRef, {circles: FieldValue.arrayRemove(circleId)});
  }
};

const notify = (db, batch, recipientId, caller, message) => {
  batch.set(db.collection("notifications").doc(), {
    recipientId: recipientId,
    type: "circle",
    message: message,
    link: {page: "circles", params: {}},
    read: false,
    createdAt: FieldValue.serverTimestamp(),
    actorId: caller.uid,
    actorName: caller.name,
  });
};

// Deletes a circle, everything posted to it, and every membership.
const destroyCircle = async (db, circle) => {
  const members = await membersOf(db, circle.id);
  const batch = db.batch();
  for (const member of members) {
    await setMembership(db, batch, member, circle.id, false);
  }
  const pending = Array.isArray(circle.data.invitedEmails) ?
    circle.data.invitedEmails : [];
  for (const email of pending) {
    await withdrawInvite(db, batch, email, circle.id);
  }
  await batch.commit();

  // Posts and events can be numerous; recursiveDelete pages through them
  // and also removes event RSVPs. Post images are cleaned up by the
  // cleanupPostImages trigger as each post is deleted.
  const [posts, events] = await Promise.all([
    db.collection("posts").where("circle", "==", circle.id).get(),
    db.collection("events").where("circle", "==", circle.id).get(),
  ]);
  for (const snap of posts.docs.concat(events.docs)) {
    await db.recursiveDelete(snap.ref);
  }
  await circle.ref.delete();

  return {posts: posts.size, events: events.size};
};

// Passes a circle to its longest-standing remaining member, or deletes it
// if nobody is left. Used when the owner leaves or is removed.
const handOver = async (db, circle, leavingUid, caller) => {
  const others = (await membersOf(db, circle.id))
      .filter((doc) => doc.id !== leavingUid)
      .sort((a, b) => joinedMs(a) - joinedMs(b));

  if (others.length === 0) {
    await destroyCircle(db, circle);
    return {deleted: true};
  }

  const next = others[0];
  const batch = db.batch();
  batch.update(circle.ref, {
    ownerId: next.id,
    ownerName: displayName(next.data(), ""),
    updatedAt: FieldValue.serverTimestamp(),
  });
  notify(db, batch, next.id, caller,
      "You now look after the circle \"" + circle.data.name + "\".");
  await batch.commit();
  return {newOwnerId: next.id};
};

// ─── Actions ─────────────────────────────────────────────────────────────

const createCircle = async (db, caller, data) => {
  const name = cleanName(data.name);

  if (memberCircleCount(caller.user.circles) >= MAX_JOINED) {
    throw fail("resource-exhausted", "You're in " + MAX_JOINED +
      " circles already. Leave one before creating another.");
  }
  const owned = await db.collection("circles")
      .where("ownerId", "==", caller.uid).get();
  const ownedMember = owned.docs.filter((d) => !isLegacy(d.id)).length;
  if (ownedMember >= MAX_OWNED) {
    throw fail("resource-exhausted", "You can look after up to " +
      MAX_OWNED + " circles.");
  }

  const ref = db.collection("circles").doc();
  const batch = db.batch();
  batch.set(ref, {
    name: name,
    ownerId: caller.uid,
    ownerName: caller.name,
    legacy: false,
    invitedEmails: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(db.collection("users").doc(caller.uid),
      {circles: FieldValue.arrayUnion(ref.id)});
  batch.update(db.collection("allowlist").doc(caller.email),
      {circles: FieldValue.arrayUnion(ref.id)});
  await batch.commit();

  logger.info("Circle created", {circleId: ref.id, ownerId: caller.uid});
  return {id: ref.id, name: name};
};

const renameCircle = async (db, caller, data) => {
  const circle = await loadCircle(db, data.circleId);
  requireOwner(caller, circle);
  const name = cleanName(data.name);
  await circle.ref.update({
    name: name,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return {id: circle.id, name: name};
};

// Counts invites against a per-person daily allowance. Runs before any
// email goes out so a failed call can't be retried into a flood.
const spendInviteAllowance = async (db, uid, count) => {
  const ref = db.collection("circleInviteQuota").doc(uid);
  const day = todayKey();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists && snap.data().day === day ?
      (snap.data().count || 0) : 0;
    if (used + count > MAX_INVITES_PER_DAY) {
      throw fail("resource-exhausted", "You can invite up to " +
        MAX_INVITES_PER_DAY + " people a day. Try again tomorrow.");
    }
    tx.set(ref, {day: day, count: used + count});
  });
};

const inviteToCircle = async (db, caller, data) => {
  const circle = await loadCircle(db, data.circleId);
  requireOwner(caller, circle);

  const raw = Array.isArray(data.emails) ? data.emails : [data.emails];
  const emails = raw
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e, i, all) => e && all.indexOf(e) === i);
  if (emails.length === 0) {
    throw fail("invalid-argument", "Enter an email address.");
  }
  if (emails.length > MAX_EMAILS_PER_CALL) {
    throw fail("invalid-argument", "Invite up to " + MAX_EMAILS_PER_CALL +
      " people at a time.");
  }

  const members = await membersOf(db, circle.id);
  const memberEmails = members.map((d) =>
    String((d.data() || {}).email || "").toLowerCase());
  const pending = (Array.isArray(circle.data.invitedEmails) ?
    circle.data.invitedEmails : [])
      .filter((e) => memberEmails.indexOf(e) === -1);

  const results = [];
  const toInvite = [];
  emails.forEach((email) => {
    if (!EMAIL_RE.test(email)) {
      results.push({email: email, status: "invalid"});
    } else if (memberEmails.indexOf(email) !== -1) {
      results.push({email: email, status: "already-member"});
    } else if (pending.indexOf(email) !== -1) {
      results.push({email: email, status: "already-invited"});
    } else {
      toInvite.push(email);
    }
  });

  if (toInvite.length === 0) return {results: results};

  if (members.length + pending.length + toInvite.length > MAX_PEOPLE) {
    throw fail("resource-exhausted", "A circle can have up to " +
      MAX_PEOPLE + " people, including pending invites.");
  }
  await spendInviteAllowance(db, caller.uid, toInvite.length);

  const batch = db.batch();
  const newInvites = [];
  for (const email of toInvite) {
    const [userSnap, allowSnap] = await Promise.all([
      db.collection("users").where("email", "==", email).limit(1).get(),
      db.collection("allowlist").doc(email).get(),
    ]);
    const allowRef = allowSnap.ref;

    if (!userSnap.empty) {
      const userDoc = userSnap.docs[0];
      // Removed from Enclave by an admin: a circle invite must not
      // quietly let them back in.
      if (!allowSnap.exists) {
        results.push({email: email, status: "not-allowed"});
        continue;
      }
      if (memberCircleCount((userDoc.data() || {}).circles) >= MAX_JOINED) {
        results.push({email: email, status: "too-many-circles"});
        continue;
      }
      batch.update(userDoc.ref, {circles: FieldValue.arrayUnion(circle.id)});
      batch.update(allowRef, {circles: FieldValue.arrayUnion(circle.id)});
      notify(db, batch, userDoc.id, caller, caller.name +
        " added you to the circle \"" + circle.data.name + "\".");
      batch.set(db.collection("mail").doc(), {
        to: [email],
        createdAt: FieldValue.serverTimestamp(),
        metadata: {type: "circle-added", circleId: circle.id,
          invitedBy: caller.uid},
        message: buildCircleInviteEmail({circleName: circle.data.name,
          inviterName: caller.name, email: email, isMember: true}),
      });
      results.push({email: email, status: "added"});
      continue;
    }

    if (allowSnap.exists) {
      batch.update(allowRef, {circles: FieldValue.arrayUnion(circle.id)});
    } else {
      batch.set(allowRef, {
        email: email,
        circles: [circle.id],
        invitedBy: caller.uid,
        invitedVia: "circle",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    batch.set(db.collection("mail").doc(), {
      to: [email],
      createdAt: FieldValue.serverTimestamp(),
      metadata: {type: "circle-invite", circleId: circle.id,
        invitedBy: caller.uid},
      message: buildCircleInviteEmail({circleName: circle.data.name,
        inviterName: caller.name, email: email, isMember: false}),
    });
    newInvites.push(email);
    results.push({email: email, status: "invited"});
  }

  // Drop invitees who have since joined, then add the new ones.
  batch.update(circle.ref, {
    invitedEmails: pending.concat(newInvites),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  logger.info("Circle invites", {circleId: circle.id, by: caller.uid,
    added: results.filter((r) => r.status === "added").length,
    invited: newInvites.length});
  return {results: results};
};

const removeFromCircle = async (db, caller, data) => {
  const circle = await loadCircle(db, data.circleId);
  requireOwner(caller, circle);
  const batch = db.batch();

  if (data.email) {
    const email = String(data.email).trim().toLowerCase();
    const invited = Array.isArray(circle.data.invitedEmails) ?
      circle.data.invitedEmails : [];
    if (invited.indexOf(email) === -1) {
      throw fail("not-found", "That invite was already withdrawn.");
    }
    await withdrawInvite(db, batch, email, circle.id);
    batch.update(circle.ref, {
      invitedEmails: FieldValue.arrayRemove(email),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    return {removed: email};
  }

  const uid = cleanId(data.uid);
  if (uid === caller.uid) {
    throw fail("invalid-argument", "Use Leave to leave your own circle.");
  }
  const userSnap = await db.collection("users").doc(uid).get();
  const circles = userSnap.exists ?
    (userSnap.data().circles || []) : [];
  if (circles.indexOf(circle.id) === -1) {
    throw fail("not-found", "They're not in this circle any more.");
  }
  await setMembership(db, batch, userSnap, circle.id, false);
  await batch.commit();
  return {removed: uid};
};

const leaveCircle = async (db, caller, data) => {
  const circle = await loadCircle(db, data.circleId);
  requireMember(caller, circle);
  const isOwner = circle.data.ownerId === caller.uid;
  if (isOwner && isLegacy(circle.id)) {
    throw fail("failed-precondition",
        "The original circles stay with the admin who owns them.");
  }

  const selfDoc = await db.collection("users").doc(caller.uid).get();
  const batch = db.batch();
  await setMembership(db, batch, selfDoc, circle.id, false);
  await batch.commit();

  const outcome = isOwner ?
    await handOver(db, circle, caller.uid, caller) : {};
  return Object.assign({left: circle.id}, outcome);
};

const deleteCircle = async (db, caller, data) => {
  const circle = await loadCircle(db, data.circleId);
  requireOwner(caller, circle);
  if (isLegacy(circle.id)) {
    throw fail("failed-precondition", "The original circles can't be " +
      "deleted.");
  }
  const counts = await destroyCircle(db, circle);
  logger.info("Circle deleted", Object.assign({circleId: circle.id,
    by: caller.uid}, counts));
  return Object.assign({deleted: circle.id}, counts);
};

// One-off: creates records for the three original circles, owned by the
// calling admin, so they can be managed on the Circles page. Safe to run
// again — existing records are left alone.
const setupLegacyCircles = async (db, caller) => {
  if (!caller.isAdmin) throw fail("permission-denied", "Admins only.");

  const [usersSnap, allowSnap] = await Promise.all([
    db.collection("users").get(),
    db.collection("allowlist").get(),
  ]);
  const joined = {};
  usersSnap.forEach((d) => {
    const email = String((d.data() || {}).email || "").toLowerCase();
    if (email) joined[email] = true;
  });

  const batch = db.batch();
  let created = 0;
  for (const legacy of LEGACY_CIRCLES) {
    const ref = db.collection("circles").doc(legacy.id);
    const snap = await ref.get();
    if (snap.exists) continue;

    const invited = [];
    allowSnap.forEach((d) => {
      const entry = d.data() || {};
      const email = String(entry.email || d.id).toLowerCase();
      if (!joined[email] && Array.isArray(entry.circles) &&
          entry.circles.indexOf(legacy.id) !== -1) {
        invited.push(email);
      }
    });

    batch.set(ref, {
      name: legacy.name,
      ownerId: caller.uid,
      ownerName: caller.name,
      legacy: true,
      invitedEmails: invited,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    created++;
  }

  const selfChange = {circles: FieldValue.arrayUnion(...LEGACY_IDS)};
  batch.update(db.collection("users").doc(caller.uid), selfChange);
  batch.update(db.collection("allowlist").doc(caller.email), selfChange);
  await batch.commit();

  logger.info("Legacy circles set up", {by: caller.uid, created: created});
  return {created: created};
};

// Admin removal from Enclave. Deletes the invite, takes the person out of
// every circle (without the admin seeing which), withdraws their pending
// circle invites and hands over any circles they looked after.
const revokeMember = async (db, caller, data) => {
  if (!caller.isAdmin) throw fail("permission-denied", "Admins only.");
  const email = String(data.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw fail("invalid-argument", "Enter a valid email address.");
  }
  if (email === OWNER_EMAIL || email === caller.email) {
    throw fail("failed-precondition", "You can't remove that account.");
  }

  const [usersSnap, invitedSnap] = await Promise.all([
    db.collection("users").where("email", "==", email).get(),
    db.collection("circles").where("invitedEmails", "array-contains", email)
        .get(),
  ]);

  const batch = db.batch();
  batch.delete(db.collection("allowlist").doc(email));
  usersSnap.forEach((d) => batch.update(d.ref, {circles: []}));
  invitedSnap.forEach((d) => batch.update(d.ref, {
    invitedEmails: FieldValue.arrayRemove(email),
  }));
  await batch.commit();

  let handedOver = 0;
  for (const userDoc of usersSnap.docs) {
    const owned = await db.collection("circles")
        .where("ownerId", "==", userDoc.id).get();
    for (const snap of owned.docs) {
      await handOver(db, {ref: snap.ref, id: snap.id, data: snap.data()},
          userDoc.id, caller);
      handedOver++;
    }
  }

  logger.info("Member removed", {by: caller.uid, accounts: usersSnap.size,
    handedOver: handedOver});
  return {removed: email, accounts: usersSnap.size};
};

const ACTIONS = {
  create: createCircle,
  rename: renameCircle,
  invite: inviteToCircle,
  remove: removeFromCircle,
  leave: leaveCircle,
  delete: deleteCircle,
  setup: setupLegacyCircles,
  revokeMember: revokeMember,
};

exports.circles = onCall(
    {region: "asia-southeast1"},
    async (request) => {
      const data = request.data || {};
      const action = ACTIONS[data.action];
      if (!action) throw fail("invalid-argument", "Unknown action.");

      const db = getFirestore();
      const caller = await loadCaller(db, request);
      try {
        return await action(db, caller, data);
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        logger.error("Circle action failed", {action: data.action,
          uid: caller.uid, error: err.message});
        throw fail("internal", "Something went wrong. Try again shortly.");
      }
    },
);

