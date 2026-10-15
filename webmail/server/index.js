import { createApp } from './app.js';

let app;
try {
  app = await createApp();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      await app.close();
    });
  }
  await app.listen({ host: '0.0.0.0', port: 8080 });
} catch {
  // 환경변수 값이나 원래 오류에 포함된 비밀을 출력하지 않는다.
  if (app) app.log.error({ code: 'STARTUP_FAILED' }, '웹메일 서버를 시작할 수 없습니다.');
  else process.stderr.write('웹메일 설정을 확인해 주세요. 서버 시작에 실패했습니다.\n');
  process.exitCode = 1;
}
