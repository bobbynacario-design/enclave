"use strict";

// Builds the project-invite email (subject/html/text). Pure module — no
// Firebase imports — so it can be rendered locally.

const APP_URL = "https://bobbynacario-design.github.io/enclave/";
const ICON_URL = APP_URL + "icon-192.png";

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

/**
 * Builds the email sent when a member is invited to a project by email.
 *
 * @param {Object} opts {projectName, inviterName}
 * @return {{subject: string, html: string, text: string}} Email message.
 */
const buildProjectInviteEmail = (opts) => {
  const projectName = String(opts.projectName || "a project");
  const inviterName = String(opts.inviterName || "An Enclave member");
  const subject = inviterName + " invited you to “" + projectName +
    "” on Enclave";

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
    `margin:0 0 8px 0;">You&#39;re invited to a project</h1>` +
    `<p style="${FONT}font-size:16px;color:#1a1a1a;line-height:1.6;` +
    `margin:0;"><strong>` + escapeHtml(inviterName) + `</strong> invited ` +
    `you to collaborate on <strong>&#8220;` + escapeHtml(projectName) +
    `&#8221;</strong>. Open Enclave and accept the invitation banner on ` +
    `the Projects page to join.</p></td></tr>` +
    `<tr><td style="padding:8px 32px 32px;" align="center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"` +
    ` border="0"><tr><td bgcolor="#7c5cbf" style="border-radius:8px;">` +
    `<a href="${APP_URL}?page=projects" target="_blank"` +
    ` style="display:inline-block;padding:14px 32px;${FONT}` +
    `font-size:16px;font-weight:600;color:#ffffff;` +
    `text-decoration:none;border-radius:8px;">` +
    `Open Projects</a></td></tr></table></td></tr>` +
    `<tr><td style="border-top:1px solid #e5e5e5;padding:24px 32px;">` +
    `<p style="${FONT}font-size:12px;color:#6b6b6b;line-height:1.5;` +
    `text-align:center;margin:0;">You received this because ` +
    escapeHtml(inviterName) + ` invited this address to an Enclave ` +
    `project. If you can&#39;t sign in to Enclave yet, ask them for an ` +
    `invite first.</p></td></tr>` +
    `</table></td></tr></table>`;

  const text = [
    inviterName + " invited you to collaborate on “" + projectName +
      "” in Enclave.",
    "",
    "Open Enclave and accept the invitation banner on the Projects page" +
      " to join.",
    "",
    "Open Projects: " + APP_URL + "?page=projects",
    "",
    "If you can't sign in to Enclave yet, ask " + inviterName +
      " for an invite first.",
  ].join("\n");

  return {subject: subject, html: html, text: text};
};

module.exports = {buildProjectInviteEmail};
