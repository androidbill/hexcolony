// Running HexColony as a Discord Activity.
//
// A Discord Activity is this same web app, loaded in an iframe inside a voice channel.
// Discord serves it from `https://<application-id>.discordsays.com`, which is a proxy
// in front of wherever the app actually lives, and it blocks requests to any host that
// has not been declared as a URL Mapping in the developer portal. So two things change
// inside Discord and nothing else does:
//
//   1. Every external URL has to be rewritten to a same-origin proxy path, which
//      Discord's own SDK helper does — the exact path convention is theirs to define.
//   2. The room is not typed in — everyone in the voice channel shares one
//      `instance_id`, which is a far better room key than a four-letter word.
//
// Outside Discord every function here is inert, so the normal site is unaffected.

import { DISCORD_CLIENT_ID } from './discord-config.js';

const params = new URLSearchParams(location.search);

/**
 * Discord always adds `frame_id` to the activity iframe's URL. Checking for it is how
 * the app knows to behave as an Activity, and it is available immediately — long
 * before the SDK has finished its handshake.
 */
export const IN_DISCORD = params.has('frame_id');

/** The voice-channel session everyone in this activity shares. */
export const INSTANCE_ID = params.get('instance_id') || null;
export const CHANNEL_ID = params.get('channel_id') || null;
export const GUILD_ID = params.get('guild_id') || null;

// Hosts this app talks to, and the prefix each must be mapped to in the developer
// portal. Keep this table and the portal's URL Mappings identical — a host that is
// missing here is a request Discord will block, and the failure looks like the player's
// network being down rather than a configuration mistake.
export const URL_MAPPINGS = [
  { prefix: '/gstatic', target: 'www.gstatic.com' },      // the Firebase SDK modules
  { prefix: '/firestore', target: 'firestore.googleapis.com' }, // the Firestore backend
];

// Rewriting is done by Discord's own helper rather than by hand. It is shipped in the
// SDK precisely because getting the proxy path convention right from the outside is
// guesswork, and it patches fetch, WebSocket AND XMLHttpRequest — which is what makes
// Firestore work, since its long-polling transport builds request URLs internally where
// no amount of care at the call site could reach them.
let patchMod = null;
async function proxyModule() {
  if (!patchMod) patchMod = await import('./vendor/discord-sdk/utils/patchUrlMappings.mjs');
  return patchMod;
}

let patched = false;

/** Redirect all runtime traffic through Discord's proxy. Must run before Firestore connects. */
export async function applyUrlMappings() {
  if (!IN_DISCORD || patched) return;
  try {
    const { patchUrlMappings } = await proxyModule();
    patchUrlMappings(URL_MAPPINGS);
    patched = true;
  } catch (e) {
    console.error('HexColony: could not install Discord URL mappings', e);
  }
}

/**
 * Rewrite one absolute URL. Needed separately from the patch above because an ES module
 * `import()` is not a fetch and so is never intercepted — the specifier itself has to
 * already be correct.
 */
export async function remap(absolute) {
  if (!IN_DISCORD) return absolute;
  try {
    const { attemptRemap } = await proxyModule();
    return attemptRemap({ url: new URL(absolute), mappings: URL_MAPPINGS }).toString();
  } catch (e) {
    console.error('HexColony: could not remap', absolute, e);
    return absolute;
  }
}

let sdk = null;
let readyPromise = null;

/**
 * Complete the handshake with Discord. Until an activity calls `ready()`, Discord shows
 * a loading spinner instead of the app, so this has to run even though the game does
 * not otherwise need the SDK.
 *
 * Deliberately not authenticating: OAuth would give us Discord usernames and avatars,
 * but exchanging the code for a token needs a server holding the client secret, and
 * this app has no server. Players pick a nickname exactly as they do on the web.
 */
export async function initDiscord() {
  if (!IN_DISCORD) return null;
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    if (!DISCORD_CLIENT_ID) {
      console.warn('HexColony: running inside Discord but DISCORD_CLIENT_ID is not set '
        + '— see public/discord-config.js. The game will still run.');
      return null;
    }
    try {
      const { DiscordSDK } = await import('./vendor/discord-sdk/index.mjs');
      sdk = new DiscordSDK(DISCORD_CLIENT_ID);
      await sdk.ready();
      return {
        instanceId: sdk.instanceId || INSTANCE_ID,
        channelId: sdk.channelId || CHANNEL_ID,
        guildId: sdk.guildId || GUILD_ID,
      };
    } catch (e) {
      // A failed handshake must not take the game down with it — the board still plays.
      console.error('HexColony: Discord handshake failed', e);
      return null;
    }
  })();
  return readyPromise;
}

/**
 * The Firestore document id for this voice channel's game.
 *
 * Not squeezed into a four-letter word: instance ids are unique per activity session,
 * and hashing one down to four letters would let two unrelated voice channels collide
 * into the same game. The `D` prefix keeps them obviously distinct from typed codes.
 */
export function discordRoomCode() {
  if (!INSTANCE_ID) return null;
  const safe = INSTANCE_ID.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  return `D${safe}`;
}

export const isDiscordRoom = (code) => typeof code === 'string' && code.startsWith('D') && code.length > 4;
