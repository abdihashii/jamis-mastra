# Google setup for the personal-accounts agent

One-time setup of the Google side and the Jamis runtime secrets. End state: a
gitignored `data/google-oauth.json` (0600) on each machine that runs Google
tooling, holding exactly the scopes Jamis needs (`gmail.readonly` plus the two
calendar scopes) and the operator's picked calendar pool. See ADR 0015 for the
design, plan 012 for the calendar extension, and CONTEXT.md for terminology.

## 1. Google Cloud project

1. console.cloud.google.com → create a project named `jamis`.
2. Enable the **Gmail API** and **Google Calendar API** (APIs & Services → Library).
3. OAuth consent screen → External:
   - App name `Jamis`, support email and developer contact email: the
     operator's address.
   - Add the scopes `.../auth/gmail.readonly`, `.../auth/calendar.events.readonly`,
     and `.../auth/calendar.calendarlist.readonly`.
   - Set **Publishing status: In production**. In Testing, refresh tokens die
     after 7 days; In production, the unverified-app warning is accepted for
     one operator (see [Google's verification exceptions](https://support.google.com/cloud/answer/13463073)).
4. APIs & Services → Credentials → Create OAuth client ID, type **Desktop
   app**, name `jamis-desktop`. One client serves both dev and prod; capture
   whichever environment needs one.
5. Note the **Client ID** and **Client secret**; they go into env vars, never
   into the repo.

## 2. Runtime configuration

Put the client config (not tokens) in env:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

- Local dev: `.env`. Production: `/root/jamis-mastra/.env.prod` on the box before deploy.
- Templates in the repo (`/.env.example`, `/.env.prod.example`) document these; do not
  commit real values. Missing env fails boot on purpose, same as other keys.

## 3. Capture the credential

**Local (Mac):**

```bash
bun run login:google
```

The script opens the Google consent URL; complete it in the browser. Google
redirects to `http://127.0.0.1:53682/?code=...`; the script writes
`data/google-oauth.json` (mode 0600) and confirms the path and mode. It never
prints a token.

### 3a. Calendar pool pick

With the calendar scopes granted, the script then lists every calendar on the
account (name + zone) and asks which to keep, comma-separated (Enter = primary
only): the pool lands under the credential's `calendars` key and is what the
`calendar-events` tool queries. Pool change = re-run the script and re-pick.
To re-login without changing the pool: `GOOGLE_LOGIN_CALENDAR_POOL=skip`.

Day boundaries for asks like "tomorrow" come from the primary calendar's zone
(the first pick's zone if the primary calendar was not picked); the rule lives
in `src/mastra/tools/calendar-events.ts`, plan 012 for the why.

**VPS (prod):** the box has no browser, and Google requires a loopback
redirect, so the trick is: the consent flow runs in your Mac's browser, the
redirect is forwarded over SSH. The script runs inside a throwaway `oven/bun`
container on the box, mounted on the running checkout (same pattern as plan
009's Codex login).

On the VPS:

```bash
cd /root/jamis-mastra
install -d -m 700 -o 1000 -g 1000 data   # data/ owned by the app's uid 1000
set -a && . ./.env.prod && set +a        # exports GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
docker run --rm -it --network host \
  --user 1000:1000 \
  -v /root/jamis-mastra:/repo -w /repo \
  -e GOOGLE_CLIENT_ID -e GOOGLE_CLIENT_SECRET \
  oven/bun:1.3.14-alpine bun --bun scripts/google-login.ts
```

On your Mac, forward the loopback port and open the printed URL:

```bash
ssh -L 53682:127.0.0.1:53682 vps
# then open the printed consent URL in your browser
```

Complete consent in the browser. The redirect reaches the script through the
tunnel, and the script writes `/root/jamis-mastra/data/google-oauth.json`
directly (mounted at `/app/data/` in the running app container). Keep mode
0600 and owner uid 1000; the script prints the mode at the end, and a `stat
data/google-oauth.json` on the box confirms the owner.

Optional: override the port with `GOOGLE_LOGIN_PORT` and a matching
`ssh -L` mapping.

## 4. Outages and recovery

A missing or dead credential is a hard failure with a generic channel text
(`Authentication failed. The error was logged.`); the channel never says what
broke. Server logs carry the detail. Refresh tokens for Gmail scopes die when:

- the operator changes their Google account password,
- the operator revokes access at myaccount.google.com,
- the token sits unused for six months,
- the live-token grant limit is exceeded,
- the consent screen is in Testing (7-day expiry).

Recovery in every case: re-run `login:google` for that environment (Section
3). There is no auto-submenu; this is deliberate, per ADR 0015.

## 5. Verifying

```bash
# after login
stat -f %Op data/google-oauth.json          # expect 100600
git check-ignore data/google-oauth.json     # expect exit 0

# local dev API check
bun dev &
bun run --bun mastra api --url http://127.0.0.1:4111 \
  --header "Authorization: Bearer $API_TOKEN" tool list | grep -E 'gmail-search|calendar-events'
bun run --bun mastra api --timeout 60000 --url http://127.0.0.1:4111 \
  --header "Authorization: Bearer $API_TOKEN" \
  tool execute gmail-search '{"query":"is:unread"}'
bun run --bun mastra api --timeout 60000 --url http://127.0.0.1:4111 \
  --header "Authorization: Bearer $API_TOKEN" \
  tool execute calendar-events '{"daysAhead":1}'
```
