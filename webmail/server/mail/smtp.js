import nodemailer from 'nodemailer';
import { Readable } from 'node:stream';
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
    let dataStarted = false;
    transport.use('stream', (mail, done) => {
      const createReadStream = mail.message.createReadStream.bind(mail.message);
      // A lazy raw input alone is insufficient: MimeNode prefetches raw bytes.
      // SMTPConnection only consumes this outer stream after DATA is accepted.
      // Keep the existing MIME/transform bytes and plugin ordering unchanged.
      mail.message.createReadStream = () => Readable.from((async function* () {
        dataStarted = true;
        yield* createReadStream();
      })());
      done();
    });
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
      // Nodemailer also labels socket loss after DATA as CONN/ECONNECTION.
      // Once DATA consumption starts, no response code means delivery is unknown.
      // Only known setup/envelope failures before that point prove non-delivery.
      const beforeData = !dataStarted && (/^(?:CONN|EHLO|HELO|LHLO|STARTTLS|AUTH(?:\s|$)|MAIL FROM|RCPT TO)/i.test(error.command || '')
        || ['EDNS', 'ECONNECTION', 'EAUTH', 'ETLS', 'EENVELOPE'].includes(error.code));
      throw beforeData
        ? new AppError(503, 'MAIL_UNAVAILABLE', '메일 서버에 연결하지 못해 보내지 않았어요. 잠시 뒤 다시 시도해 주세요.')
        : new AppError(503, 'SMTP_OUTCOME_UNKNOWN', '메일 서버의 발송 응답을 받지 못해 발송 여부를 확인할 수 없어요.');
    } finally {
      try { transport.close(); } catch { /* Cleanup cannot change SMTP's result. */ }
      finally { options.auth.pass = ''; }
    }
  }
  return { send };
}
