import nodemailer from 'nodemailer';
import { config, isProd } from '../config.js';

let transport: nodemailer.Transporter | null = null;
export const sentMail: { to: string; subject: string; text: string }[] = []; // test inspection only

export async function sendMail(to: string, subject: string, text: string) {
  if (config.NODE_ENV === 'test') { sentMail.push({ to, subject, text }); return; }
  if (!config.SMTP_URL) {
    if (isProd) throw new Error('SMTP_URL is required in production');
    console.log(`[mail:dev] to=${to} subject=${subject}\n${text}`);
    return;
  }
  transport ??= nodemailer.createTransport(config.SMTP_URL);
  await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
}
