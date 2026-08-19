# Running HexColony as a Discord Activity

An Activity is this same web app loaded in an iframe inside a Discord voice channel —
the way colonist.io works. Everyone in the channel lands in the same game without
typing a room code.

The code is done. What is left needs your Discord account, because it happens in the
developer portal and cannot be scripted.

## What the app already does

- Detects Discord automatically (`frame_id` on the iframe URL) and swaps the
  create/join card for a single **Join the Table** button.
- Uses the voice channel's `instance_id` as the room, so the channel *is* the lobby.
  Those rooms are stored under a `D`-prefixed id and the Firestore rules already allow
  them.
- Rewrites every external request to Discord's `/.proxy/...` form (see `discord.js`).
- Completes the `ready()` handshake, without which Discord shows a loading spinner
  forever.
- Falls back to the normal website behaviour when it is not inside Discord, and to
  solo-only if Firebase cannot be reached at all.

## Setup

### 1. Create the application

<https://discord.com/developers/applications> → **New Application**.

Copy the **Application ID** into `public/discord-config.js`:

```js
export const DISCORD_CLIENT_ID = '1234567890123456789';
```

Until that is filled in, the app never enters Activity mode — which is why the live
site is unaffected today.

### 2. Enable Activities

**Activities → Settings** → enable them, and set the entry point. Discord will serve
the activity from `https://<application-id>.discordsays.com`.

### 3. URL Mappings

**Activities → URL Mappings.** These matter more than they look: Discord blocks every
host that is not listed, and a missing mapping fails in a way that looks like the
player's network being down.

| Prefix | Target |
|---|---|
| `/` | `androidbill.github.io/hexcolony` |
| `/gstatic` | `www.gstatic.com` |
| `/firestore` | `firestore.googleapis.com` |

The last two must stay identical to `URL_MAPPINGS` in `public/discord.js`. If you add a
service later, add it in both places.

### 4. Test it

Discord desktop → **User Settings → Advanced → Developer Mode**, then launch the
activity from a voice channel. The browser console is available via
`ctrl+shift+i` in the activity frame.

## Known unknowns

I could not test any of this inside Discord — that needs your application ID and a real
Discord client. Everything above is verified only up to the point where Discord itself
takes over:

- Detection, room derivation, the proxy rewriting and the UI swap are **tested** by
  loading the app with Discord's query parameters.
- The `ready()` handshake and the URL mappings are **untested**. They are the most
  likely thing to need a tweak on first run.
- **Firestore through the proxy is the least certain part.** The SDK builds its own
  request URLs, so it is pointed at `<origin>/.proxy/firestore` via the `host` setting
  in `fb.js`. If live rooms fail inside Discord but solo works, that setting is the
  first thing to look at — and long-polling (`experimentalForceLongPolling`) is the
  usual fix when a proxy interferes with the streaming transport.

## Discord usernames and avatars

Deliberately not implemented. Filling in a player's Discord name and avatar means
OAuth2, and exchanging the authorization code for a token requires a server holding the
client secret — this app has no server, and putting a client secret in a static page
would leak it to anyone who opened devtools.

Players pick a nickname exactly as they do on the web, which costs one screen and no
infrastructure. If you want the real names, it needs a small backend endpoint (a
Cloudflare Worker is enough) that does the token exchange; say so and I will build it.
