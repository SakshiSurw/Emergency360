/**
 * Configurable SMS Dispatch Service
 * Supports Twilio or compatible REST API when credentials are provided.
 */

const maskPhoneNumber = (phone) => {
  if (!phone || typeof phone !== 'string' || phone.length < 7) return '***';
  return phone.slice(0, 5) + '****' + phone.slice(-3);
};

export const sendSmsAlert = async ({ to, body }) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  // Validate phone number presence
  if (!to || typeof to !== 'string' || to.trim() === '') {
    return { success: false, message: 'No recipient phone number provided' };
  }

  // Validate message body presence
  if (!body || typeof body !== 'string' || body.trim() === '') {
    return { success: false, message: 'No message body provided' };
  }

  // Sanitize: strip whitespace, dashes, and parentheses
  const sanitizedTo = to.replace(/[\s\-\(\)]/g, '').trim();

  // Validate E.164 international format (+ followed by 8-15 digits)
  const e164Regex = /^\+[1-9]\d{7,14}$/;
  if (!e164Regex.test(sanitizedTo)) {
    return {
      success: false,
      message: 'Recipient phone must use international E.164 format, for example +14155552671',
    };
  }

  // If live credentials are provided, attempt real SMS dispatch via Twilio REST API
  if (accountSid && authToken && fromNumber) {
    try {
      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

      const params = new URLSearchParams();
      params.append('To', sanitizedTo);
      params.append('From', fromNumber);
      params.append('Body', body);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json();

      if (response.ok && data.sid) {
        console.log(`[SMS Service] Provider accepted trusted-contact SMS (SID: ${data.sid})`);
        return {
          success: true,
          mode: 'production',
          sid: data.sid,
          status: data.status,
        };
      } else {
        console.warn(`[SMS Service Error] Twilio returned: ${data.message || 'Failed'}`);
        return {
          success: false,
          mode: 'production',
          error: data.message || 'Failed to dispatch SMS',
        };
      }
    } catch (err) {
      console.error(`[SMS Service Exception] ${err.message}`);
      return { success: false, mode: 'production', error: err.message };
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('[SMS Service (Unconfigured)] Validated alert for recipient ' + maskPhoneNumber(sanitizedTo) + ' (' + body.length + ' chars). No external SMS dispatched.');
  }

  return {
    success: false,
    mode: 'unconfigured',
    error: 'SMS provider is not configured; no SMS was sent.',
    recipient: maskPhoneNumber(sanitizedTo),
    bodyLength: body.length,
  };
};

export default { sendSmsAlert };
