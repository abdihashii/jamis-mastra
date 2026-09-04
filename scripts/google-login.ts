import { stat } from 'node:fs/promises';
/**
 * Headless Google OAuth login for the Gmail credential (ADR 0015, plan 011).
 * Starts a 127.0.0.1 loopback listener, prints the consent URL (never a
 * token), and writes data/google-oauth.json with mode 0600.
 *
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment; the
 * listener port is GOOGLE_LOGIN_PORT (default 53682). Do not change the
 * listener address without a matching `ssh -L` forward — the redirect URI that
 * Google records is exactly http://127.0.0.1:<port>.
 *
 * Mac (dev):  export GOOGLE_CLIENT_ID=... && export GOOGLE_CLIENT_SECRET=...
 *             pnpm run login:google
 * VPS (prod): ssh -L 53682:127.0.0.1:53682 vps   (then, on the box)
 *             set -a && . /root/jamis-mastra/.env.prod && set +a
 *             docker run --rm -it --network host --user 1000:1000 \
 *               -e GOOGLE_CLIENT_ID -e GOOGLE_CLIENT_SECRET \
 *               -v /root/jamis-mastra:/repo -w /repo \
 *               oven/bun:1.3.14-alpine bun scripts/google-login.ts
 *             `host` networking makes the container's 127.0.0.1 the host's, so
 *             the ssh -L forward reaches the listener; nothing is published.
 *             Then open the printed URL in the Mac's browser.
 */
import { createServer } from 'node:http';
import process from 'node:process';

import {
	buildAuthUrl,
	defaultCredentialPath,
	exchangeCode,
	generatePkceAndState,
	saveCredential,
} from '../src/lib/google-oauth.js';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing required env var: ${name} (see docs/setup-gmail.md)`);
		process.exit(1);
	}
	return value;
}

const clientId = requireEnv('GOOGLE_CLIENT_ID');
const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET');
const port = Number.parseInt(process.env.GOOGLE_LOGIN_PORT ?? '53682', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(`GOOGLE_LOGIN_PORT must be a valid port, got "${process.env.GOOGLE_LOGIN_PORT}"`);
	process.exit(1);
}
const redirectUri = `http://127.0.0.1:${port}`;

const { codeVerifier, codeChallenge, state } = generatePkceAndState();
const credentialPath = defaultCredentialPath();
/** One consent produces one exchange; repeat hits of the redirect URL must not race it. */
let exchangeStarted = false;

const CLOSE_PAGE = '<html><body style="font-family:system-ui"><p>Login complete. You can close this tab.</p></body></html>';
const DENIED_PAGE = '<html><body style="font-family:system-ui"><p>Consent was not granted. Re-run the login script to try again.</p></body></html>';

const server = createServer((req, res) => {
	let url: URL;
	try {
		url = new URL(req.url ?? '/', redirectUri);
	}
	catch {
		res.writeHead(400).end();
		return;
	}
	void (async () => {
		// State first: Google returns it on denials too, and anything else is
		// a stray same-host hit that must not kill the attempt.
		if (url.searchParams.get('state') !== state) {
			res.writeHead(400).end();
			return;
		}
		const error = url.searchParams.get('error');
		if (error) {
			console.error(`[google-login] consent denied (${error})`);
			res.writeHead(200, { 'Content-Type': 'text/html' }).end(DENIED_PAGE, () => finish(1));
			return;
		}
		const code = url.searchParams.get('code');
		if (!code) {
			res.writeHead(400).end();
			return;
		}
		// A repeat hit (browser refresh, retry) of this single-use code must not
		// race the first exchange: the second POST would fail invalid_grant and
		// its exit path would kill the in-flight one mid-save.
		if (exchangeStarted) {
			res.writeHead(200, { 'Content-Type': 'text/html' }).end(CLOSE_PAGE);
			return;
		}
		exchangeStarted = true;
		try {
			const cred = await exchangeCode({ code, codeVerifier, clientId, clientSecret, redirectUri });
			await saveCredential(cred, credentialPath);
			// Print confirmation BEFORE ending the response: finish() exits the process.
			const info = await stat(credentialPath);
			console.log(`Google credential saved to ${credentialPath} (0${(info.mode & 0o777).toString(8)}).`);
			console.log('Reminder: changing the Google account password invalidates Gmail-scoped refresh tokens. Re-run this script to recover.');
		}
		catch (exchangeError) {
			console.error(`[google-login] ${exchangeError instanceof Error ? exchangeError.message : String(exchangeError)}`);
			res.writeHead(500, { 'Content-Type': 'text/html' }).end(DENIED_PAGE, () => finish(1));
			return;
		}
		res.writeHead(200, { 'Content-Type': 'text/html' }).end(CLOSE_PAGE, () => finish(0));
	})();
});

function finish(code: number) {
	server.close();
	// Called from the response-end callback, so the reply has already flushed.
	process.exit(code);
}

// Give up if the operator never completes the consent (Codex 15-minute precedent).
setTimeout(() => {
	console.error('[google-login] timed out waiting for the consent callback (15 minutes). Re-run to try again.');
	finish(1);
}, 15 * 60 * 1000).unref();

server.listen(port, '127.0.0.1', () => {
	console.log(`Open this URL in your browser:\n\n${buildAuthUrl({ clientId, redirectUri, state, codeChallenge })}\n`);
});
