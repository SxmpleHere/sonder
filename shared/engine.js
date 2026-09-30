/* Shared physics engine. Runs on the server (authoritative) and in the browser (prediction). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONFIG = {
    W: 320, H: 180,
    TICK_HZ: 60, SUBSTEPS: 3,
    PITCH: { L: 16, R: 304, T: 10, B: 170 },
    GOAL_H: 48, GOAL_DEPTH: 12, POST_R: 2.5,
    PLAYER: { R: 5.5, MASS: 2, ACC: 0.38, MAX: 2.2, DRAG: 0.88, FLY_DRAG: 0.992 },
    BALL: { R: 4.5, MASS: 1, DRAG: 0.991, GOAL_DRAG: 0.82 },
    REST: { NET: 0.05, WALL: 0.6, POST_BALL: 0.9, POST_PLAYER: 0.3, PLAYER_BALL: 0.85, PLAYER_PLAYER: 0.4 },
    PINCH: { DIST: 1.8, MIN_FORCE: 1.8, FORCE_PER_SPEED: 3.1, PLAYER_DAMP: 0.55, COOLDOWN: 12, DOT: 0.5 },
    CELEBRATE: { MIN: 6.5, VAR: 3.5 },
    KPH_PER_PX: 28,
    MAX_PER_TEAM: 4
  };
  const { W, H, PITCH, GOAL_H, GOAL_DEPTH, POST_R, PLAYER, BALL, REST, SUBSTEPS } = CONFIG;
  const GOAL_Y = H / 2 - GOAL_H / 2;
  const BACK = PITCH.L - GOAL_DEPTH;            // thickness of the wall behind each goal
  const ZERO = { ix: 0, iy: 0 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ---------- arena (walls, posts, goals) built once from CONFIG ---------- */
  function buildArena() {
    const goals = [
      { owner: 0, side: -1, lineX: PITCH.L, x: PITCH.L - GOAL_DEPTH, y: GOAL_Y, w: GOAL_DEPTH, h: GOAL_H },
      { owner: 1, side: 1, lineX: PITCH.R, x: PITCH.R, y: GOAL_Y, w: GOAL_DEPTH, h: GOAL_H }
    ];
    const walls = [
      { x: 0, y: 0, w: W, h: PITCH.T },
      { x: 0, y: PITCH.B, w: W, h: H - PITCH.B }
    ];
    const posts = [];
    for (const g of goals) {
      const x0 = g.side < 0 ? 0 : PITCH.R;
      const w = g.side < 0 ? PITCH.L : W - PITCH.R;
      walls.push({ x: x0, y: 0, w, h: GOAL_Y });
      walls.push({ x: x0, y: GOAL_Y + GOAL_H, w, h: H - GOAL_Y - GOAL_H });
      walls.push({ x: g.side < 0 ? 0 : W - BACK, y: GOAL_Y, w: BACK, h: GOAL_H });
      posts.push({ x: g.lineX, y: g.y, r: POST_R }, { x: g.lineX, y: g.y + GOAL_H, r: POST_R });
    }
    // Players may stand in the goal mouth but can never enter the net.
    const blockers = goals.map(g => ({ x: g.x, y: g.y, w: g.w, h: g.h }));
    return { goals, walls, posts, blockers };
  }
  const ARENA = buildArena();

  /* ---------- collision primitives ---------- */
  // Nearest point probe. dist is negative when the circle centre is inside the rect.
  function rectProbe(c, r) {
    const cx = clamp(c.x, r.x, r.x + r.w), cy = clamp(c.y, r.y, r.y + r.h);
    const dx = c.x - cx, dy = c.y - cy, d = Math.hypot(dx, dy);
    if (d > 0) return { nx: dx / d, ny: dy / d, dist: d };
    const l = c.x - r.x, rr = r.x + r.w - c.x, t = c.y - r.y, b = r.y + r.h - c.y;
    const m = Math.min(l, rr, t, b);
    if (m === l) return { nx: -1, ny: 0, dist: -m };
    if (m === rr) return { nx: 1, ny: 0, dist: -m };
    if (m === t) return { nx: 0, ny: -1, dist: -m };
    return { nx: 0, ny: 1, dist: -m };
  }

  function bounce(c, nx, ny, rest) {
    const vn = c.vx * nx + c.vy * ny;
    if (vn < 0) { c.vx -= (1 + rest) * vn * nx; c.vy -= (1 + rest) * vn * ny; }
  }

  function circleVsRect(c, r, rest) {
    const pr = rectProbe(c, r);
    if (pr.dist >= c.r) return null;
    const pen = c.r - pr.dist;
    c.x += pr.nx * pen; c.y += pr.ny * pen;
    bounce(c, pr.nx, pr.ny, rest);
    return pr;
  }

  function circleVsStatic(c, s, rest) {
    const dx = c.x - s.x, dy = c.y - s.y, min = c.r + s.r, d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return null;
    const d = Math.sqrt(d2);
    const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
    const pen = min - d;
    c.x += nx * pen; c.y += ny * pen;
    bounce(c, nx, ny, rest);
    return { nx, ny };
  }

  // Both bodies move, weighted by mass. Normal points from b to a.
  function circleVsCircle(a, b, rest) {
    const dx = a.x - b.x, dy = a.y - b.y, min = a.r + b.r, d2 = dx * dx + dy * dy;
    if (d2 >= min * min) return null;
    const d = Math.sqrt(d2);
    const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
    const ia = 1 / a.mass, ib = 1 / b.mass, sum = ia + ib;
    const pen = min - d;
    a.x += nx * pen * ia / sum; a.y += ny * pen * ia / sum;
    b.x -= nx * pen * ib / sum; b.y -= ny * pen * ib / sum;
    const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (vn < 0) {
      const j = -(1 + rest) * vn / sum;
      a.vx += nx * j * ia; a.vy += ny * j * ia;
      b.vx -= nx * j * ib; b.vy -= ny * j * ib;
    }
    return { nx, ny };
  }

  /* ---------- player movement (shared with client prediction) ---------- */
  function applyInput(p, input) {
    if (p.flying) {                                   // goal celebration: no control, keeps momentum
      p.vx *= PLAYER.FLY_DRAG; p.vy *= PLAYER.FLY_DRAG;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.05) { p.fx = p.vx / sp; p.fy = p.vy / sp; }
      p.walk += sp * 0.2;
      return;
    }
    let ix = input.ix, iy = input.iy;
    const len = Math.hypot(ix, iy);
    if (len > 1) { ix /= len; iy /= len; }
    p.vx = (p.vx + ix * PLAYER.ACC) * PLAYER.DRAG;
    p.vy = (p.vy + iy * PLAYER.ACC) * PLAYER.DRAG;
    let sp = Math.hypot(p.vx, p.vy);
    if (sp > PLAYER.MAX) { p.vx *= PLAYER.MAX / sp; p.vy *= PLAYER.MAX / sp; sp = PLAYER.MAX; }
    if (len > 0.1) { p.fx = ix / len; p.fy = iy / len; p.walk += sp * 0.15; }
  }

  function resolvePlayerStatics(p) {
    for (const w of ARENA.walls) circleVsRect(p, w, REST.WALL);
    for (const w of ARENA.blockers) circleVsRect(p, w, REST.WALL);
    for (const s of ARENA.posts) circleVsStatic(p, s, REST.POST_PLAYER);
  }

  function movePlayerSub(p, frac) {
    p.x += p.vx * frac; p.y += p.vy * frac;
    resolvePlayerStatics(p);
  }

  function predictStep(p, input) {
    applyInput(p, input);
    for (let s = 0; s < SUBSTEPS; s++) movePlayerSub(p, 1 / SUBSTEPS);
  }

  /* ---------- helpers ---------- */
  const SLOTS = [[-46, 0], [-74, -30], [-74, 30], [-112, 0]];
  function spawnPoint(team, slot) {
    const s = SLOTS[slot % SLOTS.length];
    return { x: W / 2 + s[0] * (team === 0 ? 1 : -1), y: H / 2 + s[1] };
  }

  // The ball must be completely over the line. One formula for both goals.
  function ballInGoal(ball, g) {
    const depth = g.side < 0 ? g.lineX - (ball.x + ball.r) : (ball.x - ball.r) - g.lineX;
    return depth > 0 && ball.y > g.y && ball.y < g.y + g.h;
  }

  /* ---------- world ---------- */
  class World {
    constructor() {
      this.players = new Map();
      this.ball = { x: W / 2, y: H / 2, r: BALL.R, mass: BALL.MASS, vx: 0, vy: 0, pinchCd: 0, lastTouch: null };
      this.ballDrag = BALL.DRAG;
      this.inputsEnabled = true;
      this.ballGhost = false;          // after a goal players pass through the ball so it stays in the net
      this.events = [];
    }
    teamCount(team) { let n = 0; for (const p of this.players.values()) if (p.team === team) n++; return n; }
    placePlayer(p, slot) {
      const s = spawnPoint(p.team, slot);
      p.x = s.x; p.y = s.y; p.vx = 0; p.vy = 0; p.flying = false;
      p.fx = p.team === 0 ? 1 : -1; p.fy = 0;
    }
    addPlayer(id, team) {
      const p = { id, team, x: 0, y: 0, r: PLAYER.R, mass: PLAYER.MASS, vx: 0, vy: 0, fx: 1, fy: 0, walk: 0, flying: false, input: ZERO };
      this.placePlayer(p, this.teamCount(team));
      this.players.set(id, p);
      return p;
    }
    setTeam(id, team) {
      const p = this.players.get(id);
      if (!p) return;
      p.team = team;
      this.placePlayer(p, this.teamCount(team) - 1);
    }
    removePlayer(id) { this.players.delete(id); }
    resetBall() {
      Object.assign(this.ball, { x: W / 2, y: H / 2, vx: 0, vy: 0, pinchCd: 0, lastTouch: null });
    }
    kickoff() {
      this.resetBall();
      this.ballDrag = BALL.DRAG;
      this.ballGhost = false;
      const n = [0, 0];
      for (const p of this.players.values()) this.placePlayer(p, n[p.team]++);
    }
    celebrate(p, dirX) {
      const a = (Math.random() - 0.5) * 1.4, len = Math.hypot(dirX, a);
      const speed = CONFIG.CELEBRATE.MIN + Math.random() * CONFIG.CELEBRATE.VAR;
      p.vx = dirX / len * speed; p.vy = a / len * speed; p.flying = true;
    }
    step() {
      const f = 1 / SUBSTEPS, ball = this.ball, list = [...this.players.values()];
      for (const p of list) applyInput(p, this.inputsEnabled ? p.input : ZERO);
      const drag = Math.pow(this.ballDrag, f);
      let contact = null;
      if (ball.pinchCd > 0) ball.pinchCd--;
      for (let s = 0; s < SUBSTEPS; s++) {
        for (const p of list) movePlayerSub(p, f);
        ball.vx *= drag; ball.vy *= drag;
        ball.x += ball.vx * f; ball.y += ball.vy * f;
        for (const post of ARENA.posts) circleVsStatic(ball, post, REST.POST_BALL);
        for (const p of this.ballGhost ? [] : list) {
          const c = circleVsCircle(p, ball, REST.PLAYER_BALL);   // normal: ball -> player
          if (c) { ball.lastTouch = p.id; contact = { nx: c.nx, ny: c.ny, p }; }
        }
        for (let i = 0; i < list.length; i++)
          for (let j = i + 1; j < list.length; j++) circleVsCircle(list[i], list[j], REST.PLAYER_PLAYER);
        for (const p of list) resolvePlayerStatics(p);
        for (const w of ARENA.walls) circleVsRect(ball, w, this.ballGhost ? REST.NET : REST.WALL);   // dead in the net after a goal
      }
      this.applyPinch(contact);
    }
    // Ball squeezed between a player and a wall pops away from the wall (once per cooldown).
    applyPinch(contact) {
      const P = CONFIG.PINCH, b = this.ball;
      if (!contact || b.pinchCd > 0) return;
      for (const w of ARENA.walls) {
        const pr = rectProbe(b, w);
        if (pr.dist >= b.r + P.DIST) continue;
        if (pr.nx * contact.nx + pr.ny * contact.ny < P.DOT) continue;   // player must be on the open side
        const force = Math.max(P.MIN_FORCE, Math.hypot(contact.p.vx, contact.p.vy) * P.FORCE_PER_SPEED);
        b.vx += pr.nx * force; b.vy += pr.ny * force;
        contact.p.vx *= P.PLAYER_DAMP; contact.p.vy *= P.PLAYER_DAMP;
        b.pinchCd = P.COOLDOWN;
        this.events.push({ k: 'pinch', x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10 });
        return;
      }
    }
  }

  return { CONFIG, ARENA, ZERO, World, applyInput, predictStep, ballInGoal, spawnPoint, clamp };
});
