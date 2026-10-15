import nodemailer from 'nodemailer';
import { mailTlsOptions } from './imap-pool.js';
import { AppError } from '../errors.js';

const smtpMessage = value => String(value || '메일 서버가 보내기를 거절했어요.').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 1000);

export function createSmtpService({ config, transportFactory = nodemailer.createTransport }) {
  async function send(session, raw, envelope) {
    const options = {
      host: config.smtpHost, port: config.smtpPort, secure: false, requireTLS: true,
      tls: mailTlsOptions(config),
      auth: { user: session.email, pass: session.password.toString('utf8') },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 60000,
      logger: false, debug: false,
    };
    const transport = transportFactory(options);
    try {
      const result = await transport.sendMail({ raw, envelope });
      if (result.rejected?.length && !result.accepted?.length) {
        const error = new AppError(502, 'SMTP_REJECTED', '메일 서버가 받는 주소를 거절했어요.');
        error.smtpMessage = smtpMessage(result.rejectedErrors?.[0]?.response);
        throw error;
      }
      return { rejected: (result.rejected || []).map(address => ({
        address, smtpMessage: smtpMessage(result.rejectedErrors?.find(error => error.recipient === address)?.response),
      })) };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (Number.isInteger(error.responseCode) && error.responseCode >= 400) {
        const rejected = new AppError(502, 'SMTP_REJECTED', '메일 서버가 보내기를 거절했어요.');
        rejected.smtpMessage = smtpMessage(error.response);
        throw rejected;
      }
      throw new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
    } finally {
      transport.close();
      options.auth.pass = '';
    }
  }
  return { send };
}
