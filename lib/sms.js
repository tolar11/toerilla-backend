// lib/sms.js — Twilio SMS wrapper with a safe no-credentials fallback.
//
// If TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER are not all
// set, this falls back to just logging what *would* have been sent (same
// behavior as the Phase 1 prototype's notifications_log table) instead of
// throwing. That lets you run and test the whole app before you've signed
// up for Twilio. Set all three env vars to switch on real sending.

let twilioClient = null;
const hasTwilioCreds =
  !!process.env.TWILIO_ACCOUNT_SID &&
  !!process.env.TWILIO_AUTH_TOKEN &&
  !!process.env.TWILIO_FROM_NUMBER;

if (hasTwilioCreds) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} else {
  console.warn(
    '[sms] TWILIO_* env vars not fully set — SMS will be logged, not actually sent. ' +
    'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER to go live.'
  );
}

/**
 * Send an SMS, or log it if Twilio isn't configured.
 * @returns {Promise<{sent: boolean, sid: string|null, channel: 'sms'|'log'}>}
 */
async function sendSMS(to, body) {
  if (!hasTwilioCreds) {
    console.log(`[sms:LOG-ONLY] to=${to} body="${body}"`);
    return { sent: false, sid: null, channel: 'log' };
  }

  try {
    const message = await twilioClient.messages.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER,
      body,
    });
    return { sent: true, sid: message.sid, channel: 'sms' };
  } catch (err) {
    console.error(`[sms] Twilio send failed for ${to}:`, err.message);
    return { sent: false, sid: null, channel: 'log' };
  }
}

module.exports = { sendSMS, hasTwilioCreds };
