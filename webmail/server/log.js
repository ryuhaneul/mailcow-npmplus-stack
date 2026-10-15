export function logOptions(level = 'info') {
  return {
    level,
    redact: {
      paths: [
        'req.headers.cookie', 'req.headers["x-webmail-csrf"]', 'req.body',
        '*.password', '*.current', '*.next', '*.next2',
      ],
      remove: true,
    },
    serializers: {
      req: req => ({ method: req.method, ip: req.ip }),
    },
  };
}
