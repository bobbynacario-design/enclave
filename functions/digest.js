"use strict";

// Builds the weekly digest email (subject/html/text) for one member.
// Pure module — no Firebase imports — so it can be rendered locally.

const APP_URL = "https://bobbynacario-design.github.io/enclave/";
const ICON_URL = APP_URL + "icon-192.png";
const ALL_CIRCLES = ["hustle-hub", "work-network", "family"];

const FONT = "font-family:Arial,Helvetica,sans-serif;";

const escapeHtml = (value) => {
  if (value === undefined || value === null) return "";
  return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
};

const postExcerpt = (body) => {
  const firstLine = String(body || "").split("\n")[0].trim();
  if (firstLine.length <= 90) return firstLine;
  return firstLine.slice(0, 87) + "...";
};

// One-line description of a post: its text, or what it shared when it
// has no text (photo-only and file-only posts), or "" if truly empty.
const postLine = (post) => {
  const excerpt = postExcerpt(post.body);
  if (excerpt) return excerpt;
  const imageCount = Array.isArray(post.images) ? post.images.length : 0;
  if (imageCount > 0) return "shared " + plural(imageCount, "photo");
  if (post.fileUrl) return "shared a file";
  return "";
};

const manilaDay = (date) => new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  weekday: "short",
  month: "short",
  day: "numeric",
}).format(date);

const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

const engagementOf = (post) => {
  const reacts = Array.isArray(post.reacts) ? post.reacts.length : 0;
  const comments = Array.isArray(post.comments) ? post.comments.length : 0;
  return reacts + comments;
};

const sectionHtml = (title, inner) =>
  `<tr><td style="padding:0 32px 18px;">` +
  `<p style="${FONT}font-size:12px;font-weight:600;letter-spacing:1px;` +
  `text-transform:uppercase;color:#7c5cbf;margin:0 0 8px 0;">` +
  escapeHtml(title) + `</p>` + inner + `</td></tr>`;

const rowHtml = (inner) =>
  `<p style="${FONT}font-size:14px;color:#1a1a1a;line-height:1.5;` +
  `margin:0 0 10px 0;">` + inner + `</p>`;

// Formats a "YYYY-MM-DD" due date as e.g. "Jun 15"; empty input passes
// through.
const dueLabel = (dueDate) => {
  if (!dueDate) return "";
  const parsed = new Date(dueDate + "T00:00:00");
  if (isNaN(parsed.getTime())) return dueDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(parsed);
};

/**
 * Builds the digest email for one member, or null when there is nothing
 * visible to them this week.
 *
 * @param {Object} user User doc data (uid, name, email, circles, isAdmin,
 *     digestOptOut).
 * @param {Object} week Weekly activity: {posts, events, newMembers,
 *     resources, briefingCount, tasksByUser}. Posts/events are filtered
 *     per member by circle; tasksByUser is keyed by uid; the rest are
 *     community-wide.
 * @return {?{subject: string, html: string, text: string}} Email message.
 */
const buildDigest = (user, week) => {
  const isAdmin = user.isAdmin === true;
  const own = Array.isArray(user.circles) ? user.circles : [];
  const visible = {all: true};
  (isAdmin ? ALL_CIRCLES : own).forEach((c) => {
    visible[c] = true;
  });

  const posts = week.posts.filter((p) => visible[p.circle || "all"] === true);
  const events = week.events.filter(
      (e) => visible[e.circle || "all"] === true);
  const myTasks = (week.tasksByUser && user.uid &&
    week.tasksByUser[user.uid]) || [];
  const overdueCount = myTasks.filter((t) => t.overdue).length;

  const counts = {
    posts: posts.length,
    events: events.length,
    members: week.newMembers.length,
    resources: week.resources.length,
    briefings: week.briefingCount,
    tasks: myTasks.length,
  };
  const total = counts.posts + counts.events + counts.members +
    counts.resources + counts.briefings + counts.tasks;
  if (total === 0) return null;

  const summaryParts = [];
  if (overdueCount > 0) {
    summaryParts.push(plural(overdueCount, "overdue task"));
  } else if (counts.tasks > 0) {
    summaryParts.push(plural(counts.tasks, "open task"));
  }
  if (counts.posts > 0) summaryParts.push(plural(counts.posts, "new post"));
  if (counts.events > 0) {
    summaryParts.push(plural(counts.events, "upcoming event"));
  }
  if (counts.members > 0) {
    summaryParts.push(plural(counts.members, "new member"));
  }
  if (counts.resources > 0) {
    summaryParts.push(plural(counts.resources, "new resource"));
  }
  if (counts.briefings > 0) {
    summaryParts.push(plural(counts.briefings, "briefing"));
  }

  const subject = "This week in Enclave: " +
    summaryParts.slice(0, 3).join(", ");
  const greetName = String(user.name || user.email || "there").split(" ")[0];

  const topPosts = posts.filter((p) => postLine(p) !== "")
      .sort((a, b) => engagementOf(b) - engagementOf(a))
      .slice(0, 3);

  let sections = "";

  if (myTasks.length > 0) {
    sections += sectionHtml("Your tasks", myTasks.slice(0, 4).map((t) => {
      const due = t.overdue ?
        ` <span style="color:#c0392b;font-weight:600;">Overdue &mdash; ` +
        `due ` + escapeHtml(dueLabel(t.dueDate)) + `</span>` :
        (t.dueDate ?
          ` <span style="color:#6b6b6b;">&middot; due ` +
          escapeHtml(dueLabel(t.dueDate)) + `</span>` : "");
      return rowHtml(
          `<strong>` + escapeHtml(t.title) + `</strong> &mdash; ` +
          escapeHtml(t.projectName) + due);
    }).join("") + (myTasks.length > 4 ?
      rowHtml(`<span style="color:#6b6b6b;">and ` +
        (myTasks.length - 4) + ` more in the app.</span>`) : ""));
  }

  if (topPosts.length > 0) {
    sections += sectionHtml("Top posts", topPosts.map((p) => {
      const eng = engagementOf(p);
      const engNote = eng > 0 ?
        ` <span style="color:#6b6b6b;">&middot; ` +
        escapeHtml(plural(eng, "interaction")) + `</span>` : "";
      return rowHtml(
          `<strong>` + escapeHtml(p.authorName || "Member") +
          `</strong> &mdash; ` + escapeHtml(postLine(p)) + engNote);
    }).join(""));
  }

  if (events.length > 0) {
    sections += sectionHtml("Coming up", events.slice(0, 3).map((e) => {
      const hasDate = e.date && typeof e.date.toDate === "function";
      const when = hasDate ? manilaDay(e.date.toDate()) : "";
      return rowHtml(
          `<strong>` + escapeHtml(e.title || "Event") + `</strong>` +
          (when ? " &mdash; " + escapeHtml(when) : "") +
          (e.location ? " &middot; " + escapeHtml(e.location) : ""));
    }).join(""));
  }

  if (week.newMembers.length > 0) {
    const names = week.newMembers
        .map((m) => m.name || m.email || "Member");
    sections += sectionHtml("New members",
        rowHtml(escapeHtml(names.join(", ")) + " joined this week."));
  }

  if (week.resources.length > 0) {
    const titles = week.resources.slice(0, 3)
        .map((r) => r.title || "Untitled");
    const more = week.resources.length > 3 ?
      " and " + (week.resources.length - 3) + " more" : "";
    sections += sectionHtml("New resources",
        rowHtml(escapeHtml(titles.join(", ") + more) +
        " were added to the library."));
  }

  if (week.briefingCount > 0) {
    const was = week.briefingCount === 1 ? " was" : " were";
    sections += sectionHtml("Briefings",
        rowHtml(escapeHtml(plural(week.briefingCount, "daily briefing")) +
        was + ` published this week &mdash; ` +
        `<a href="${APP_URL}?page=briefings" target="_blank" ` +
        `style="color:#7c5cbf;">catch up in the app</a>.`));
  }

  const html =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"` +
    ` width="100%" bgcolor="#f5f5f7">` +
    `<tr><td align="center" style="padding:24px 16px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"` +
    ` width="600" style="max-width:600px;width:100%;` +
    `background-color:#ffffff;border-radius:12px;overflow:hidden;">` +
    `<tr><td bgcolor="#7c5cbf" style="padding:24px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"` +
    ` border="0"><tr>` +
    `<td style="vertical-align:middle;">` +
    `<img src="${ICON_URL}" width="56" height="56" alt="Enclave"` +
    ` style="display:block;border:0;border-radius:12px;"></td>` +
    `<td style="vertical-align:middle;padding-left:16px;">` +
    `<span style="${FONT}font-size:22px;font-weight:600;color:#ffffff;">` +
    `Enclave</span></td>` +
    `</tr></table></td></tr>` +
    `<tr><td style="padding:40px 32px 24px;">` +
    `<h1 style="${FONT}font-size:24px;font-weight:600;color:#1a1a1a;` +
    `margin:0 0 8px 0;">Hey ` + escapeHtml(greetName) + `</h1>` +
    `<p style="${FONT}font-size:15px;color:#6b6b6b;margin:0;">` +
    `Your week in Enclave: ` +
    summaryParts.map(escapeHtml).join(" &middot; ") +
    `.</p></td></tr>` +
    sections +
    `<tr><td style="padding:8px 32px 32px;" align="center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"` +
    ` border="0"><tr><td bgcolor="#7c5cbf" style="border-radius:8px;">` +
    `<a href="${APP_URL}" target="_blank" style="display:inline-block;` +
    `padding:14px 32px;${FONT}font-size:16px;font-weight:600;` +
    `color:#ffffff;text-decoration:none;border-radius:8px;">` +
    `Open Enclave</a></td></tr></table></td></tr>` +
    `<tr><td style="border-top:1px solid #e5e5e5;padding:24px 32px;">` +
    `<p style="${FONT}font-size:12px;color:#6b6b6b;line-height:1.5;` +
    `text-align:center;margin:0;">You receive this weekly digest as a ` +
    `member of Enclave. Ask an admin to opt you out.</p></td></tr>` +
    `</table></td></tr></table>`;

  const textLines = [
    "Hey " + greetName + ",",
    "",
    "Your week in Enclave: " + summaryParts.join(" / "),
    "",
  ];
  if (myTasks.length > 0) {
    textLines.push("Your tasks:");
    myTasks.slice(0, 4).forEach((t) => {
      const due = t.overdue ?
        " — OVERDUE (due " + dueLabel(t.dueDate) + ")" :
        (t.dueDate ? " — due " + dueLabel(t.dueDate) : "");
      textLines.push("- " + t.title + " (" + t.projectName + ")" + due);
    });
    if (myTasks.length > 4) {
      textLines.push("...and " + (myTasks.length - 4) + " more in the app.");
    }
    textLines.push("");
  }
  if (topPosts.length > 0) {
    textLines.push("Top posts:");
    topPosts.forEach((p) => {
      textLines.push("- " + (p.authorName || "Member") + " — " +
        postLine(p));
    });
    textLines.push("");
  }
  if (events.length > 0) {
    textLines.push("Coming up:");
    events.slice(0, 3).forEach((e) => {
      const hasDate = e.date && typeof e.date.toDate === "function";
      const when = hasDate ? " — " + manilaDay(e.date.toDate()) : "";
      const where = e.location ? " · " + e.location : "";
      textLines.push("- " + (e.title || "Event") + when + where);
    });
    textLines.push("");
  }
  if (week.newMembers.length > 0) {
    const names = week.newMembers.map((m) => m.name || m.email || "Member");
    textLines.push("New members: " + names.join(", "));
    textLines.push("");
  }
  if (week.briefingCount > 0) {
    const was = week.briefingCount === 1 ? " was" : " were";
    textLines.push(plural(week.briefingCount, "daily briefing") + was +
      " published this week.");
    textLines.push("");
  }
  textLines.push("Open Enclave: " + APP_URL);

  return {subject: subject, html: html, text: textLines.join("\n")};
};

module.exports = {buildDigest};
