import { stat } from 'node:fs/promises';
/**
 * Headless Google OAuth login for the personal-credentials file (ADR 0015,
 * plan 011; superset scope per plan 012). Starts a 127.0.0.1 loopback
 * listener, prints the consent URL (never a token), writes
 * data/google-oauth.json with mode 0600, then — when the granted scope has
 * calendar.calendarlist.readonly — offers a calendar-pool pick stored under
 * the credential's `calendars` key (skip with GOOGLE_LOGIN_CALENDAR_POOL=skip
 * or non-tty stdin).
 *
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment; the
 * listener port is GOOGLE_LOGIN_PORT (default 53682). Do not change the
 * listener address without a matching `ssh -L` forward — the redirect URI that
 * Google records is exactly http://127.0.0.1:<port>.
 *
 * Mac (dev):  export GOOGLE_CLIENT_ID=... && export GOOGLE_CLIENT_SECRET=...
 *             bun run login:google
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
import { createInterface } from 'node:readline/promises';

import {
	buildAuthUrl,
	defaultCredentialPath,
	exchangeCode,
	generatePkceAndState,
	hasCalendarListScope,
	listOperatorCalendars,
	saveCalendarPool,
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
/** Skip flag for re-logins that must not overwrite the stored pool. */
const skipPool = process.env.GOOGLE_LOGIN_CALENDAR_POOL === 'skip' || !process.stdin.isTTY;
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
			if (!skipPool && hasCalendarListScope(cred.scope)) {
				// Optional step: a failure here must not misreport the whole login
				// as failed (the credential above was already saved).
				try {
					await pickCalendarPool(cred.access);
				}
				catch (poolError) {
					console.error('[google-login] calendar pool step failed:', poolError);
					console.log('Credential stands. Re-run this script when you want to pick calendars.');
				}
			}
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

/** List calendars, prompt the operator to pick the pool, store it. */
async function pickCalendarPool(accessToken: string) {
	const calendars = await listOperatorCalendars(accessToken);
	if (calendars.length === 0) {
		console.log('[google-login] calendar list came back empty; pool step skipped.');
		return;
	}
	console.log('Calendars discovered:');
	calendars.forEach((cal, index) => {
		console.log(`  ${index + 1}. ${cal.summary} (${cal.timeZone})${cal.primary ? ' [primary]' : ''}`);
	});
	console.log('Enter indices to include, comma-separated (default: primary only), or press Enter for default:');
	const picked = await pickFromStdin(calendars);
	await saveCalendarPool(picked, credentialPath);
	console.log(`Pool stored: ${picked.map(c => c.summary).join(', ')}`);
}

async function pickFromStdin(calendars: Array<{ id: string; summary: string; timeZone: string; primary?: boolean }>) {
	const primary = calendars.find(c => c.primary) ?? calendars[0];
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question('> ');
		const trimmed = answer.trim();
		if (!trimmed)
			return [primary];
		const indices = trimmed
			.split(',')
			.map(part => Number.parseInt(part.trim(), 10) - 1)
			.filter(i => Number.isInteger(i) && i >= 0 && i < calendars.length);
		// Dedupe: "1,1" must not store the same calendar twice (stage 2 queries once per id).
		const unique = [...new Set(indices)];
		return unique.length > 0 ? unique.map(i => calendars[i]) : [primary];
	}
	finally {
		rl.close();
	}
}

// Give up if the operator never completes the consent (Codex 15-minute precedent).
setTimeout(() => {
	console.error('[google-login] timed out waiting for the consent callback (15 minutes). Re-run to try again.');
	finish(1);
}, 15 * 60 * 1000).unref();

server.listen(port, '127.0.0.1', () => {
	console.log(`Open this URL in your browser:\n\n${buildAuthUrl({ clientId, redirectUri, state, codeChallenge })}\n`);
});
