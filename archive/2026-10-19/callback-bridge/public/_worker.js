export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const callback = url.pathname === '/feishu/card-actions' && request.method === 'POST';
    const monitor = (url.pathname === '/monitor/health' && request.method === 'GET') ||
      (url.pathname === '/monitor/heartbeat' && request.method === 'POST');
    if (!callback && !monitor) {
      return new Response('Not found', { status: 404 });
    }
    return env.BOT.fetch(request);
  }
};
