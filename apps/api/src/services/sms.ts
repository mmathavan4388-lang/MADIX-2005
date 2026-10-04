import { config, isProd } from '../config.js';

export const sentSms: { to: string; text: string }[] = []; // test inspection only

/** Pluggable SMS sender. Twilio REST is built in; add another provider by extending this function. */
export async function sendSms(to: string, text: string) {
  if (config.NODE_ENV === 'test') { sentSms.push({ to, text }); return; }
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    if (isProd) throw new Error('SMS provider is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM)');
    console.log(`[sms:dev] to=${to} ${text}`); return;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: text }),
  });
  if (!res.ok) throw new Error(`sms failed ${res.status}`);
}
