import { Resend } from "resend";
import type { DiffLine } from "../../lib/types.js";
import { env } from "../config.js";

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

export class EmailProviderError extends Error {
  readonly code = "EMAIL_PROVIDER_ERROR";

  constructor(message = "The email provider could not accept the message.") {
    super(message);
    this.name = "EmailProviderError";
  }
}

export async function sendVerificationEmail(
  to: string,
  token: string,
): Promise<void> {
  const url = `${env.appBaseUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  await sendEmail(
    {
      to,
      subject: "Verify your Watchtower email",
      text: `Verify your email address by opening this link: ${url}\n\nThis link expires in 24 hours. If you did not create a Watchtower account, you can ignore this message.`,
      html: emailShell(
        "Verify your email",
        "Confirm your address to start monitoring the pages you care about.",
        url,
        "Verify email address",
        "This link expires in 24 hours.",
      ),
    },
    `verify-${token}`,
  );
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<void> {
  const url = `${env.appBaseUrl}/api/auth/reset-password-form?token=${encodeURIComponent(token)}`;
  await sendEmail(
    {
      to,
      subject: "Reset your Watchtower password",
      text: `Reset your password by opening this link: ${url}\n\nThis link expires in 30 minutes. If you did not request a reset, you can ignore this message.`,
      html: emailShell(
        "Reset your password",
        "We received a request to reset the password for your Watchtower account.",
        url,
        "Reset password",
        "This link expires in 30 minutes. If you did not request this, you can ignore this email.",
      ),
    },
    `reset-${token}`,
  );
}

export async function sendChangeEmail(input: {
  to: string;
  monitorName: string;
  url: string;
  detectedAt: Date;
  changeId: string;
  diff: DiffLine[];
}): Promise<string | null> {
  const changeUrl = `${env.appBaseUrl}/?change=${encodeURIComponent(input.changeId)}`;
  const additions = input.diff
    .filter((line) => line.kind === "added")
    .slice(0, 8);
  const removals = input.diff
    .filter((line) => line.kind === "removed")
    .slice(0, 8);
  const textLines = [
    `A change was detected on ${input.monitorName}.`,
    input.url,
    `Detected: ${input.detectedAt.toISOString()}`,
    "",
    ...additions.map((line) => `+ ${line.text.slice(0, 300)}`),
    ...removals.map((line) => `- ${line.text.slice(0, 300)}`),
    "",
    `View change: ${changeUrl}`,
  ];
  const diffHtml = [
    ...additions.map((line) => diffLineHtml("added", line.text)),
    ...removals.map((line) => diffLineHtml("removed", line.text)),
  ].join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f7f4;font-family:Arial,sans-serif;color:#24352a"><div style="max-width:560px;margin:36px auto;padding:28px;background:#fff;border:1px solid #e4ebe5;border-radius:12px"><div style="font-size:11px;font-weight:bold;letter-spacing:1px;color:#448260">WATCHTOWER · CHANGE ALERT</div><h1 style="font-size:22px;margin:16px 0 8px">A page changed</h1><p style="font-size:14px;line-height:1.5;color:#647269"><strong>${escapeHtml(input.monitorName)}</strong> has new content.</p><p style="font-size:12px"><a href="${escapeHtml(input.url)}" style="color:#347e56">${escapeHtml(input.url)}</a></p><p style="font-size:11px;color:#89968e">Detected ${escapeHtml(input.detectedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }))} UTC</p><div style="margin:20px 0;border:1px solid #edf1ee;border-radius:8px;overflow:hidden">${diffHtml || '<div style="padding:12px;color:#748178">Content updated.</div>'}</div><p><a href="${escapeHtml(changeUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:#267e58;color:#fff;text-decoration:none;font-size:13px;font-weight:bold">Review change</a></p><p style="font-size:10px;line-height:1.5;color:#9aa59e">You are receiving this because email change alerts are enabled for your monitor.</p></div></body></html>`;

  return sendEmail(
    {
      to: input.to,
      subject: safeSubject(`Change detected: ${input.monitorName}`),
      text: textLines.join("\n"),
      html,
    },
    `change-${input.changeId}`,
  );
}

export async function sendMonitorFailureEmail(input: {
  to: string;
  monitorName: string;
  monitorId: string;
  url: string;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  occurredAt: string;
  dedupeKey: string;
}): Promise<string | null> {
  const monitorUrl = `${env.appBaseUrl}/?monitor=${encodeURIComponent(input.monitorId)}`;
  const subject = safeSubject(`Monitoring paused: ${input.monitorName}`);
  const text = [
    `Watchtower paused checks for ${input.monitorName} after ${input.consecutiveFailures} consecutive failures.`,
    input.url,
    `Most recent error: ${input.lastErrorCode ?? "CHECK_FAILED"}`,
    `Detected: ${input.occurredAt}`,
    `Review monitor: ${monitorUrl}`,
  ].join("\n");
  const html = `<p>Watchtower paused checks for <strong>${escapeHtml(input.monitorName)}</strong> after ${input.consecutiveFailures} consecutive failures.</p><p><a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a></p><p>Most recent error: ${escapeHtml(input.lastErrorCode ?? "CHECK_FAILED")}</p><p>Detected ${escapeHtml(input.occurredAt)}</p><p><a href="${escapeHtml(monitorUrl)}">Review monitor</a></p>`;
  return sendEmail(
    {
      to: input.to,
      subject,
      text,
      html: emailShell(
        subject,
        "A monitored website could not be checked reliably.",
        monitorUrl,
        "Review monitor",
        "Checks have paused until you resume the monitor.",
        html,
      ),
    },
    `system-${input.dedupeKey}`,
  );
}

export async function sendWeeklyDigestEmail(input: {
  to: string;
  periodStart: string;
  periodEnd: string;
  changes: {
    changeId: string;
    monitorName: string;
    url: string;
    detectedAt: string;
    addedCount: number;
    removedCount: number;
  }[];
  dedupeKey: string;
}): Promise<string | null> {
  const rows = input.changes.map((change) => {
    const changeUrl = `${env.appBaseUrl}/?change=${encodeURIComponent(change.changeId)}`;
    const summary = `${change.addedCount} additions · ${change.removedCount} removals`;
    return {
      text: `• ${change.monitorName} — ${change.detectedAt} — ${summary}\n  ${change.url}\n  ${changeUrl}`,
      html: `<li style="margin:0 0 16px"><strong>${escapeHtml(change.monitorName)}</strong> · ${escapeHtml(change.detectedAt)}<br><span>${escapeHtml(summary)}</span><br><a href="${escapeHtml(changeUrl)}">Review change</a><br><a href="${escapeHtml(change.url)}">${escapeHtml(change.url)}</a></li>`,
    };
  });
  const subject = `Your Watchtower weekly change digest (${input.changes.length})`;
  const text = [
    `Changes detected from ${input.periodStart} through ${input.periodEnd}:`,
    "",
    ...rows.map((row) => row.text),
  ].join("\n");
  const html = `<p>Here are the changes detected from ${escapeHtml(input.periodStart)} through ${escapeHtml(input.periodEnd)}.</p><ul>${rows.map((row) => row.html).join("")}</ul>`;
  return sendEmail(
    {
      to: input.to,
      subject,
      text,
      html: emailShell(
        subject,
        "Your monitored pages, in one weekly summary.",
        env.appBaseUrl,
        "Open Watchtower",
        "You can change digest preferences in Settings.",
        html,
      ),
    },
    `system-${input.dedupeKey}`,
  );
}

async function sendEmail(
  message: { to: string; subject: string; text: string; html: string },
  idempotencyKey: string,
): Promise<string | null> {
  if (!resend) {
    if (env.nodeEnv === "production")
      throw new EmailProviderError("Email delivery is not configured.");
    return null;
  }
  const result = await resend.emails.send(
    {
      from: `Watchtower <${env.emailFrom}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    },
    { idempotencyKey },
  );
  if (result.error) throw new EmailProviderError();
  return result.data?.id ?? null;
}

function emailShell(
  title: string,
  description: string,
  url: string,
  action: string,
  footnote: string,
  extraHtml = "",
): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f7f4;font-family:Arial,sans-serif;color:#24352a"><div style="max-width:520px;margin:36px auto;padding:30px;background:#fff;border:1px solid #e4ebe5;border-radius:12px"><div style="font-size:11px;font-weight:bold;letter-spacing:1px;color:#448260">WATCHTOWER</div><h1 style="font-size:22px;margin:18px 0 8px">${escapeHtml(title)}</h1><p style="font-size:13px;line-height:1.6;color:#68766d">${escapeHtml(description)}</p>${extraHtml}<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 15px;border-radius:7px;background:#267e58;color:#fff;text-decoration:none;font-size:13px;font-weight:bold">${escapeHtml(action)}</a></p><p style="font-size:10px;line-height:1.5;color:#9aa59e">${escapeHtml(footnote)}</p></div></body></html>`;
}

function diffLineHtml(kind: "added" | "removed", text: string): string {
  const color = kind === "added" ? "#367c53" : "#a56355";
  const background = kind === "added" ? "#eff8f1" : "#fbf1ed";
  const sign = kind === "added" ? "+" : "−";
  return `<div style="padding:8px 10px;background:${background};color:${color};font-size:12px;border-bottom:1px solid #fff"><strong style="display:inline-block;width:18px">${sign}</strong>${escapeHtml(text.slice(0, 300))}</div>`;
}

function safeSubject(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
