// Job "report" (runs when any job failed): tell Studio, so the failure shows in the round as well as
// in the plugin. Studio ignores it if this commit already uploaded or was stopped for a secret.
import { oidcToken } from './oidc.mjs';
const SERVER = (process.env.STUDIO_URL || 'https://studio.mindfuldesign.me').replace(/\/$/, '');
const step = process.env.FAILED_STEP || 'the save';
try {
  const token = await oidcToken();
  await fetch(`${SERVER}/api/uploads/failed`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(process.env.STUDIO_RENDER_TICKET ? { 'x-studio-render': process.env.STUDIO_RENDER_TICKET } : {}) },
    body: JSON.stringify({ failure: `${step[0].toUpperCase()}${step.slice(1)} failed, so ${process.env.STUDIO_RENDER_TICKET ? 'the screenshots and downloads were not made again' : 'this save didn\'t reach Studio'}. Details: ${process.env.RUN_URL || 'the GitHub Actions run'}`, message: String(process.env.COMMIT_MESSAGE || '').split('\n')[0] }),
    signal: AbortSignal.timeout(20e3)
  });
} catch (e) { console.error(`Could not tell Studio: ${e.message}`); }
