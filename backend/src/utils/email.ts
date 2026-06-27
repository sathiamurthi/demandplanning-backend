/**
 * Email utility — uses nodemailer with Gmail SMTP.
 * Falls back to console.log if nodemailer is not yet installed.
 *
 * Configure in .env:
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
 *   SMTP_FROM_NAME, SMTP_FROM_EMAIL
 */

let _transporter: any = null;

async function getTransporter() {
  if (_transporter) return _transporter;
  try {
    // Dynamic import so the app starts even if nodemailer not yet installed
    const nodemailer = require('nodemailer');
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return _transporter;
  } catch (_e) {
    console.warn('[email] nodemailer is not installed — run: npm install nodemailer @types/nodemailer');
    return null;
  }
}

export interface MailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendMail(options: MailOptions): Promise<any> {
  const from = `"${process.env.SMTP_FROM_NAME || 'DemandGenius'}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || 'noreply@example.com'}>`;

  // No SMTP configured → log to console (dev / test)
  if (!process.env.SMTP_USER || process.env.SMTP_PASS === 'your_gmail_app_password_here') {
    console.log('[email:DEV] Would send email →', { to: options.to, subject: options.subject });
    return { messageId: 'dev-skipped' };
  }

  const transporter = await getTransporter();
  if (!transporter) {
    console.error('[email] Cannot send — nodemailer unavailable.');
    return null;
  }

  const info = await transporter.sendMail({
    from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text ?? options.html.replace(/<[^>]+>/g, ''),
  });

  console.log('[email] Sent:', info.messageId);
  return info;
}

// ── Pre-built email templates ───────────────────────────────────

export async function sendPasswordResetEmail(email: string, resetToken: string) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4000').split(',')[0];
  const link = `${frontendUrl}/reset-password?token=${resetToken}`;

  return sendMail({
    to: email,
    subject: 'Reset your DemandGenius password',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0d0f14;color:#e2e8f0;border-radius:12px;">
        <h2 style="color:#60a5fa;margin-top:0;">Password Reset</h2>
        <p>We received a request to reset your password. Click the button below to choose a new one:</p>
        <a href="${link}"
           style="display:inline-block;margin:16px 0;padding:12px 28px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
          Reset Password
        </a>
        <p style="color:#94a3b8;font-size:13px;">This link expires in <strong>1 hour</strong>.</p>
        <p style="color:#94a3b8;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
        <hr style="border-color:#1e293b;margin:20px 0;" />
        <p style="color:#475569;font-size:12px;">DemandGenius · paariwalaconnect@gmail.com</p>
      </div>
    `,
  });
}

export async function sendWelcomeEmail(email: string, firstName: string, companyName: string) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4000').split(',')[0];

  return sendMail({
    to: email,
    subject: `Welcome to DemandGenius, ${firstName || companyName}!`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0d0f14;color:#e2e8f0;border-radius:12px;">
        <h2 style="color:#34d399;margin-top:0;">Welcome aboard 🎉</h2>
        <p>Hi <strong>${firstName || 'there'}</strong>,</p>
        <p>Your <strong>${companyName}</strong> account on DemandGenius is ready.</p>
        <a href="${frontendUrl}/login"
           style="display:inline-block;margin:16px 0;padding:12px 28px;background:#059669;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
          Log In Now
        </a>
        <p style="color:#94a3b8;font-size:13px;">Use the email and password you registered with.</p>
        <hr style="border-color:#1e293b;margin:20px 0;" />
        <p style="color:#475569;font-size:12px;">DemandGenius · paariwalaconnect@gmail.com</p>
      </div>
    `,
  });
}
