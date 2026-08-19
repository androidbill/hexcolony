# Recorded sounds

Drop an audio file in here and it replaces the synthesised version of that effect. Leave
one out and the synth keeps handling it. You can do them one at a time, in any order, and
the game never goes quiet if a file is missing, fails to download, or will not decode.

## Adding one

1. Put the file in this folder, e.g. `dice.mp3`.
2. Add it to `index.json`:

```json
{ "dice": { "file": "dice.mp3", "gain": 0.9 } }
```

`gain` is optional (default 1) and is the easy way to balance a loud download against
everything else without re-editing the audio. `room` is optional too (default 0.1) — how
much of the shared reverb it gets; set it to 0 for a recording that already has its own
space on it.

The short form works as well when the filename matches the effect and needs no balancing:

```json
{ "dice": "dice.mp3" }
```

`index.json` is the only file the app asks for when there are no recordings, so a build
with an empty `{}` costs one small request rather than a 404 for every effect.

## The names

Each one maps to a moment in the game. These are the only names that do anything:

| name       | when it plays                                    |
|------------|--------------------------------------------------|
| `dice`     | the dice are rolled                              |
| `build`    | a settlement goes down                           |
| `city`     | a settlement becomes a city                      |
| `road`     | a road goes down                                 |
| `card`     | a development card is bought or played           |
| `trade`    | a trade completes, with the bank or a player     |
| `gain`     | a roll pays you resources                        |
| `robber`   | the robber moves                                 |
| `steal`    | a card is taken from someone                     |
| `yourTurn` | your turn begins                                 |
| `tap`      | any button — keep this one very short and quiet  |
| `error`    | a move was refused                               |
| `win`      | you win                                          |
| `lose`     | somebody else wins                               |
| `join`     | you enter a room                                 |

## Format

**MP3.** It is the one format every phone decodes — iOS Safari's support for Ogg and Opus
is patchy enough not to risk it, and this app has to work on Bill's iPhone as well as
Android.

Mono, 128 kbps or lower, trimmed hard at both ends. `tap` should be under 100 ms; `dice`
can run to a second. Keep each file under about 30 KB — they are precached for offline
play, so the whole set is a download every player makes.

Trim the silence off the front especially. A recording with 80 ms of lead-in feels
laggy in a way that is hard to diagnose later.

## Licensing

This game is published publicly, so anything in here has to be cleared for that.
Prefer CC0 / public-domain sources, which need no attribution and no record-keeping.
If you use something that requires credit, add the source and licence to the table below
so it is not lost.

| file | source | licence |
|------|--------|---------|
| all `*-v2.mp3` | supplied by Bill | — |

## What is in here now

| file | effect | length |
|------|--------|--------|
| `dice-v2.mp3` | `dice` | 0.53s |
| `house-v2.mp3` | `build` | 2.06s |
| `city-v2.mp3` | `city` | 1.03s |
| `road-v2.mp3` | `road` | 2.06s |
| `resource-pickupv2.mp3` | `gain` | 2.06s |
| `your-turn-notifv2.mp3` | `yourTurn` | 2.06s |

Four of them are exactly 2.064s, which is a generator exporting to a fixed length rather
than four sounds that happen to match. If any of them turns out to be a short effect
padded with silence, `trim` fixes it without re-encoding anything:

```json
{ "road": { "file": "road-v2.mp3", "trim": 0.6 } }
```

`trim` stops playback after that many seconds, with a 30 ms fade so the cut does not
click. `offset` does the same at the front, for a clip that starts late. Both are in
seconds and both are optional.

Still synthesised: `card`, `trade`, `robber`, `steal`, `tap`, `error`, `win`, `lose`,
`join`.
