// Achievements and solo challenges. Pure: given how a finished game went, say what it earned.
// Nothing here touches storage; app.js keeps the profile and calls `judge` once per game.

/** What a finished game gives, before achievements and challenges. */
export const XP_GAME = 30;
export const XP_WIN = 60;
export const XP_CHALLENGE = 50;

/**
 * Solo challenges: a rule to win by, picked before the game starts. Each is judged from the
 * finished game; `ctx.mine` is how many turns the player took.
 */
export const CHALLENGES = [
  { key: 'sprint', name: 'Sprint', blurb: 'Win in 12 of your own turns or fewer.', test: (c) => c.won && c.mine <= 12 },
  { key: 'nodev', name: 'No cards', blurb: 'Win without buying a single development card.', test: (c) => c.won && !c.tally.devs },
  { key: 'notrade', name: 'Loner', blurb: 'Win without trading with anyone.', test: (c) => c.won && !c.tally.trades },
  { key: 'cities', name: 'Skyline', blurb: 'Win with four or more cities.', test: (c) => c.won && c.cities >= 4 },
  { key: 'road', name: 'Roadmaster', blurb: 'Win holding the Longest Road.', test: (c) => c.won && c.longRoad },
  { key: 'clean', name: 'Clean hands', blurb: 'Win without ever stealing from anyone.', test: (c) => c.won && !c.tally.steals },
];

/**
 * Achievements. `test` sees the finished game plus the career totals (already including this
 * game). All are earned once, for the XP shown.
 */
export const ACHIEVEMENTS = [
  { key: 'first', name: 'First blood', desc: 'Win your first game.', xp: 25, test: (c) => c.won && c.career.wins >= 1 },
  { key: 'wins5', name: 'Regular', desc: 'Win 5 games.', xp: 40, test: (c) => c.career.wins >= 5 },
  { key: 'wins25', name: 'Warlord', desc: 'Win 25 games.', xp: 75, test: (c) => c.career.wins >= 25 },
  { key: 'games10', name: 'Dedicated', desc: 'Finish 10 games.', xp: 30, test: (c) => c.career.games >= 10 },
  { key: 'games50', name: 'Veteran', desc: 'Finish 50 games.', xp: 75, test: (c) => c.career.games >= 50 },
  { key: 'metro', name: 'Metropolis', desc: 'Finish a game with four cities.', xp: 30, test: (c) => c.cities >= 4 },
  { key: 'longroad', name: 'Long haul', desc: 'Finish holding the Longest Road.', xp: 25, test: (c) => c.longRoad },
  { key: 'army', name: 'Iron fist', desc: 'Finish holding the Largest Army.', xp: 25, test: (c) => c.largestArmy },
  { key: 'lucky', name: 'Blessed', desc: 'Win with dice luck of +25% or better.', xp: 30, test: (c) => c.won && c.luck >= 25 },
  { key: 'grit', name: 'Against the dice', desc: 'Win with dice luck of -15% or worse.', xp: 50, test: (c) => c.won && c.luck !== null && c.luck <= -15 },
  { key: 'hard', name: 'Giant killer', desc: 'Beat Hard bots in a solo game.', xp: 50, test: (c) => c.won && c.solo && c.botLevel === 'hard' },
  { key: 'speedy', name: 'Quick draw', desc: 'Win in 10 of your own turns or fewer.', xp: 50, test: (c) => c.won && c.mine <= 10 },
  { key: 'trader', name: 'Dealmaker', desc: 'Make 8 trades in one game.', xp: 25, test: (c) => (c.tally.trades || 0) >= 8 },
  { key: 'thief', name: 'Sticky fingers', desc: 'Steal 5 times in one game.', xp: 25, test: (c) => (c.tally.steals || 0) >= 5 },
  { key: 'devs', name: 'Scholar', desc: 'Buy 5 development cards in one game.', xp: 25, test: (c) => (c.tally.devs || 0) >= 5 },
  { key: 'landslide', name: 'Landslide', desc: 'Win by 4 or more points.', xp: 40, test: (c) => c.won && c.margin >= 4 },
];

/**
 * What this game earned. `profile` is the career before the game; returns the new profile
 * pieces and a list for the results screen. Does not mutate `profile`.
 */
export function judge(profile, ctx) {
  const career = { games: profile.games + 1, wins: profile.wins + (ctx.won ? 1 : 0) };
  const c = { ...ctx, career };
  let xp = XP_GAME + (ctx.won ? XP_WIN : 0);
  const ach = { ...profile.ach };
  const newAch = [];
  for (const a of ACHIEVEMENTS) {
    if (ach[a.key] || !a.test(c)) continue;
    ach[a.key] = ctx.now;
    newAch.push(a);
    xp += a.xp;
  }
  const challenges = { ...profile.challenges };
  let challenge = null;
  const picked = CHALLENGES.find((x) => x.key === ctx.challenge);
  if (picked) {
    const done = !!picked.test(c);
    challenge = { ...picked, done, first: done && !challenges[picked.key] };
    if (challenge.first) { challenges[picked.key] = ctx.now; xp += XP_CHALLENGE; }
  }
  return {
    profile: { ...profile, xp: profile.xp + xp, games: career.games, wins: career.wins, ach, challenges },
    xp, newAch, challenge,
  };
}
