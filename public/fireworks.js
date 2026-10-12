// Fireworks for the win: rockets climb from the bottom of the screen and burst into
// sparks that fall under gravity. One full-screen canvas, drawn only while it is running,
// removed from view the moment it finishes. Pure decoration — nothing depends on it.

const TAU = Math.PI * 2;

/**
 * Run a display on `canvas` for `ms` milliseconds.
 * `colors` is the palette the bursts draw from; `onPop` is called as each rocket bursts,
 * so the caller can play a sound for it.
 */
export function launchFireworks(canvas, colors, ms, onPop) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.hidden = false;

  const rockets = [];
  const sparks = [];
  // Five rockets, spread over the first two thirds of the show.
  const launches = [0, 0.1, 0.25, 0.4, 0.55].map((f) => f * ms);
  let started = null;
  let launched = 0;
  let last = null;
  let raf = 0;

  function launch() {
    const x = W * (0.18 + Math.random() * 0.64);
    rockets.push({
      x, y: H + 10, vx: (Math.random() - 0.5) * 40, vy: -(H * (0.85 + Math.random() * 0.25)),
      fuse: 0.55 + Math.random() * 0.2, age: 0, color: colors[Math.floor(Math.random() * colors.length)],
    });
  }

  function burst(r) {
    const n = 48 + Math.floor(Math.random() * 20);
    const second = colors[Math.floor(Math.random() * colors.length)];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.2;
      const sp = 70 + Math.random() * 130;
      sparks.push({
        x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, max: 0.9 + Math.random() * 0.7, color: i % 3 === 0 ? second : r.color,
      });
    }
    onPop?.();
  }

  function frame(now) {
    if (started === null) { started = now; last = now; }
    const t = now - started;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    while (launched < launches.length && t >= launches[launched]) { launch(); launched++; }

    c.globalCompositeOperation = 'destination-out';      // fade the old frame instead of wiping it: trails
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.age += dt;
      r.x += r.vx * dt; r.y += r.vy * dt;
      r.vy += 90 * dt;
      c.fillStyle = '#fff6d0';
      c.fillRect(r.x - 1.5, r.y - 1.5, 3, 3);
      if (r.age >= r.fuse) { burst(r); rockets.splice(i, 1); }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life += dt;
      if (s.life >= s.max) { sparks.splice(i, 1); continue; }
      s.vx *= 0.985; s.vy = s.vy * 0.985 + 110 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      c.globalAlpha = 1 - s.life / s.max;
      c.fillStyle = s.color;
      c.beginPath(); c.arc(s.x, s.y, 2.2, 0, TAU); c.fill();
    }
    c.globalAlpha = 1;

    if (t < ms + 1500 && (t < ms || rockets.length || sparks.length)) raf = requestAnimationFrame(frame);
    else done();
  }

  function done() {
    cancelAnimationFrame(raf);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
  }

  raf = requestAnimationFrame(frame);
  return done;
}
