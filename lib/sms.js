const twilio = require('twilio');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

const client = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// Compares by last 10 digits so it doesn't matter whether numbers were
// stored as "5551234567", "(555) 123-4567", or "+15551234567".
function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '').slice(-10);
}

async function sendSMS(to, body) {
  if (!client) {
    console.warn(`[sms] Twilio not configured — would send to ${to}: ${body}`);
    return null;
  }
  if (!TWILIO_PHONE_NUMBER) {
    console.warn('[sms] TWILIO_PHONE_NUMBER is not set — cannot send SMS');
    return null;
  }
  try {
    const msg = await client.messages.create({ to, from: TWILIO_PHONE_NUMBER, body });
    return msg.sid;
  } catch (err) {
    console.error(`[sms] Failed to send to ${to}:`, err.message);
    return null;
  }
}

function validateTwilioRequest(signature, fullUrl, params) {
  if (!TWILIO_AUTH_TOKEN) return true; // not configured yet — allow through in dev
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, params);
}

module.exports = { sendSMS, normalizePhone, validateTwilioRequest, isConfigured: !!client };
