// A GitHub Actions OIDC token for Studio's audience (needs `permissions: id-token: write`).
export async function oidcToken(audience = process.env.STUDIO_AUDIENCE || 'mindfulstudio') {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('No OIDC token available: the job needs "permissions: id-token: write".');
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${bearer}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || typeof j.value !== 'string') throw new Error(`GitHub did not give an OIDC token (${res.status}).`);
  return j.value;
}
