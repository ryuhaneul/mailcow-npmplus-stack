export function logOptions(level = 'info') {
  return {
    level,
    redact: {
      paths: [
        'req.headers.cookie', 'req.headers["x-webmail-csrf"]', 'req.body',
        'seed', 'manualKey', 'qrDataUrl', 'otpKey', 'ciphertext', 'OTP_KEY', 'WEBMAIL_OTP_KEY', 'secret_ciphertext', 'nonce', 'tag',
        'otp.code', '*.otp.code', '*.seed', '*.manualKey', '*.qrDataUrl', '*.otpKey', '*.ciphertext', '*.secret_ciphertext', '*.nonce', '*.tag',
        '*.OTP_KEY', '*.WEBMAIL_OTP_KEY', '*.envelope', '*.enrollmentDraft',
        '*.password', '*.current', '*.next', '*.next2',
      ],
      remove: true,
    },
    serializers: {
      req: req => ({ method: req.method, ip: req.ip }),
    },
  };
}
