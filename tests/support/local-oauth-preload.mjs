// Explicit test preload, never imported by the application. No real GitHub calls.
if (process.env.READABLE_REVIEW_LOCAL_FIXTURE !== '1') throw new Error('Local fixture opt-in required');
const original = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(options.body);
    return Response.json(body.code === 'local-fixture-code' ? { access_token: 'local-fixture-token' } : {});
  }
  if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'local-fixture-admin', avatar_url: '' });
  if (url.includes('github.com')) throw new Error('No live GitHub access in local fixture');
  return original(input, options);
};
