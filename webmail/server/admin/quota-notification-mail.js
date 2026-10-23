import nodemailer from 'nodemailer';
import { mailTlsOptions } from '../mail/imap-pool.js';
import { AppError } from '../errors.js';
import { notificationAddress } from './quota-notification-state.js';
export function quotaNotificationMessage(sender, row) {
  if (!notificationAddress(sender) || !notificationAddress(row.username) || !Number.isFinite(row.quota) || row.quota <= 0 || !Number.isFinite(row.quota_used) || row.quota_used < 0) throw new AppError(422, 'INVALID_INPUT', '알림 메일 주소와 용량을 확인해 주세요.');
  const percent = (row.quota_used / row.quota * 100).toFixed(1);
  const usage = `${(row.quota_used / 1024 ** 3).toFixed(2)} GB / ${(row.quota / 1024 ** 3).toFixed(2)} GB (${percent}%)`;
  const text = `메일함 용량이 부족해요.\n현재 사용량: ${usage}\n\n휴지통을 비우고 큰 첨부 메일을 정리해 주세요. 용량이 더 필요하면 관리자에게 문의해 주세요.\n\n이 메일에는 답장하지 마세요.`;
  return { from: { address: sender }, to: [{ address: row.username }], envelope: { from: sender, to: [row.username] },
    subject: `[메일함 용량 경고] 사용률 ${percent}%`, text,
    html: `<p>메일함 용량이 부족해요.</p><p>현재 사용량: <strong>${usage}</strong></p><p>휴지통을 비우고 큰 첨부 메일을 정리해 주세요. 용량이 더 필요하면 관리자에게 문의해 주세요.</p><p>이 메일에는 답장하지 마세요.</p>`,
    disableFileAccess: true, disableUrlAccess: true };
}
export function createQuotaNotificationMailer({ config, transportFactory = nodemailer.createTransport }) {
  return async (sender, row) => {
    let transport, stage = 'setup';
    try {
      const message = quotaNotificationMessage(sender, row);
      transport = transportFactory({ host: config.smtpHost, port: 25, secure: false, requireTLS: true, tls: mailTlsOptions(config),
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 60_000, logger: false, debug: false });
      stage = 'send';
      const result = await transport.sendMail(message);
      if (!result.accepted?.some(address => String(address).toLowerCase() === row.username.toLowerCase()) || result.rejected?.length) throw Object.assign(new Error(), { responseCode: 550 });
    } catch (error) {
      const explicit = stage === 'setup' || Number.isInteger(error.responseCode) && error.responseCode >= 400 || ['CONN','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(error.command);
      throw Object.assign(new AppError(502, Number.isInteger(error.responseCode) ? 'SMTP_REJECTED' : 'SEND_FAILED', Number.isInteger(error.responseCode) ? '메일 서버가 관리 앱의 발송을 허용하지 않아요. 주소와 내부 릴레이 설정을 확인해 주세요.' : '알림 메일을 보내지 못했어요.'), { explicit });
    } finally { transport?.close(); }
  };
}
