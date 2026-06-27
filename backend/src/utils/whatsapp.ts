/**
 * WhatsApp notifications via Meta Cloud API (WhatsApp Business Platform).
 *
 * Configure in .env:
 *   ENABLE_WHATSAPP=true
 *   WHATSAPP_API_VERSION=v21.0
 *   WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
 *   WHATSAPP_ACCESS_TOKEN=your_permanent_token
 */

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';

function isEnabled(): boolean {
  return process.env.ENABLE_WHATSAPP === 'true' && !!PHONE_NUMBER_ID && !!ACCESS_TOKEN;
}

/** Normalize to digits only; Meta API expects country code without + */
export function normalizeWhatsAppPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export interface WhatsAppSendResult {
  sent: boolean;
  messageId?: string;
  skipped?: boolean;
  error?: string;
}

export async function sendWhatsAppText(to: string, body: string): Promise<WhatsAppSendResult> {
  const phone = normalizeWhatsAppPhone(to);
  if (!phone) return { sent: false, error: 'Invalid phone number' };

  if (!isEnabled()) {
    console.log('[whatsapp:DEV] Would send →', { to: phone, body });
    return { sent: false, skipped: true };
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errMsg = (data as any)?.error?.message || `HTTP ${res.status}`;
      console.error('[whatsapp] Send failed:', errMsg);
      return { sent: false, error: errMsg };
    }

    const messageId = (data as any)?.messages?.[0]?.id;
    console.log('[whatsapp] Sent:', messageId);
    return { sent: true, messageId };
  } catch (e: any) {
    console.error('[whatsapp] Error:', e.message);
    return { sent: false, error: e.message };
  }
}

export async function sendRegistrationWhatsApp(
  phone: string,
  firstName: string,
  companyName?: string
): Promise<WhatsAppSendResult> {
  const name = firstName || 'there';
  const business = companyName ? ` for ${companyName}` : '';
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4000').split(',')[0];

  return sendWhatsAppText(
    phone,
    `Welcome to DemandGenius, ${name}! Your account${business} is ready. Sign in at ${frontendUrl}/login with your phone number and password.`
  );
}

export async function sendPasswordResetWhatsApp(
  phone: string,
  resetToken: string
): Promise<WhatsAppSendResult> {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4000').split(',')[0];
  const link = `${frontendUrl}/reset-password?token=${resetToken}`;

  return sendWhatsAppText(
    phone,
    `DemandGenius password reset: ${link}\nThis link expires in 1 hour. If you did not request this, ignore this message.`
  );
}
