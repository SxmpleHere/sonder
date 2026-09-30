'use strict';
const { performance } = require('perf_hooks');
const Engine = require('./shared/engine');
const { CONFIG, ARENA, World } = Engine;

const CFG = { countdownMs: 3000, goalMs: 2200, replayMs: 5000, endedMs: 8000 };
const OPTIONS = { time: [60, 120, 180, 300], goals: [0, 3, 5, 7, 10] };   // goals 0 = no limit
const TICK_MS = 1000 / CONFIG.TICK_HZ;
const r2 = v => Math.round(v * 100) / 100;

class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.players = new Map();          // id -> { id, name, team, client, connected, ack, queue, last, body }
    this.hostId = null;
    this.world = new World();
    this.settings = { timeLimit: 120, goalLimit: 5 };
    this.phase = 'lobby';              // lobby | countdown | playing | goal | replay | ended
    this.phaseLeft = 0;
    this.score = [0, 0];
    this.clock = this.settings.timeLimit;
    this.overtime = false;
    this.tickCount = 0;
  }

  /* ---------- networking helpers ---------- */
  sendRaw(p, str) {
    const ws = p.client.ws;
    if (ws && ws.readyState === 1) ws.send(str);
  }
  send(p, obj) { this.sendRaw(p, JSON.stringify(obj)); }
  broadcast(obj) {
    const str = JSON.stringify(obj);
    for (const p of this.players.values()) this.sendRaw(p, str);
  }
  sendMeta() {
    this.broadcast({
      t: 'room', code: this.code, host: this.hostId, settings: this.settings, options: OPTIONS,
      max: CONFIG.MAX_PER_TEAM * 2,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, on: p.connected }))
    });
  }

  /* ---------- roster ---------- */
  join(client) {
    if (this.players.size >= CONFIG.MAX_PER_TEAM * 2) return null;
    const n = [0, 0];
    for (const p of this.players.values()) n[p.team]++;
    const team = n[0] <= n[1] ? 0 : 1;
    const p = { id: client.id, name: client.name, team, client, connected: true, ack: 0, queue: [], last: { seq: 0, ix: 0, iy: 0 }, body: null };
    p.body = this.world.addPlayer(p.id, team);
    this.players.set(p.id, p);
    if (this.hostId === null) this.hostId = p.id;
    this.sendMeta();
    return p;
  }

  leave(id) {
    if (!this.players.delete(id)) return;
    this.world.removePlayer(id);
    if (this.hostId === id) this.hostId = this.players.size ? this.players.keys().next().value : null;
    if (!this.players.size) { this.onEmpty(); return; }
    this.sendMeta();
  }

  setTeam(id, team) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'lobby' || (team !== 0 && team !== 1) || p.team === team) return 'Cannot switch team now';
    let count = 0;
    for (const q of this.players.values()) if (q.team === team) count++;
    if (count >= CONFIG.MAX_PER_TEAM) return 'That team is full';
    p.team = team;
    this.world.setTeam(id, team);
    this.sendMeta();
    return null;
  }

  setSettings(id, s) {
    if (id !== this.hostId || this.phase !== 'lobby' || !s) return;
    if (OPTIONS.time.includes(s.timeLimit)) this.settings.timeLimit = s.timeLimit;
    if (OPTIONS.goals.includes(s.goalLimit)) this.settings.goalLimit = s.goalLimit;
    this.clock = this.settings.timeLimit;
    this.sendMeta();
  }

  /* ---------- match flow ---------- */
  start(id) {
    if (id !== this.hostId || this.phase !== 'lobby') return;
    this.score = [0, 0];
    this.overtime = false;
    this.clock = this.settings.timeLimit;
    this.startCountdown();
  }

  startCountdown() {
    this.world.kickoff();
    this.phase = 'countdown';
    this.phaseLeft = CFG.countdownMs;
  }

  detectGoal() {
    return ARENA.goals.find(g => Engine.ballInGoal(this.world.ball, g)) || null;
  }

  onGoal(goal) {
    const team = 1 - goal.owner, ball = this.world.ball;
    this.score[team]++;
    const kph = Math.round(Math.hypot(ball.vx, ball.vy) * CONFIG.KPH_PER_PX);
    const scorer = this.players.get(ball.lastTouch);
    const own = !!scorer && scorer.team === goal.owner;
    if (scorer && !own) this.world.celebrate(scorer.body, -goal.side);
    this.world.ballDrag = CONFIG.BALL.GOAL_DRAG;
    this.world.ballGhost = true;
    ball.vx *= 0.2; ball.vy *= 0.2;   // ball settles in the net instead of rebounding out
    this.phase = 'goal';
    this.phaseLeft = CFG.goalMs;
    this.broadcast({ t: 'ev', k: 'goal', team, scorer: scorer ? scorer.id : null, kph, own });
  }

  matchOver() {
    const [a, b] = this.score, limit = this.settings.goalLimit;
    return (limit > 0 && Math.max(a, b) >= limit) || this.overtime || (this.clock <= 0 && a !== b);
  }

  endMatch() {
    this.phase = 'ended';
    this.phaseLeft = CFG.endedMs;
    const [a, b] = this.score;
    this.broadcast({ t: 'ev', k: 'end', winner: a > b ? 0 : b > a ? 1 : -1, score: this.score });
  }

  toLobby() {
    this.phase = 'lobby';
    this.score = [0, 0];
    this.overtime = false;
    this.clock = this.settings.timeLimit;
    this.world.kickoff();
    this.sendMeta();
  }

  advance() {
    switch (this.phase) {
      case 'countdown': this.phase = 'playing'; break;
      case 'goal': this.phase = 'replay'; this.phaseLeft = CFG.replayMs; break;
      case 'replay': if (this.matchOver()) this.endMatch(); else this.startCountdown(); break;
      case 'ended': this.toLobby(); break;
    }
  }

  tickPlaying() {
    const goal = this.detectGoal();
    if (goal) { this.onGoal(goal); return; }
    if (this.overtime) return;
    this.clock -= TICK_MS / 1000;
    if (this.clock > 0) return;
    this.clock = 0;
    if (this.score[0] === this.score[1]) {
      this.overtime = true;
      this.broadcast({ t: 'ev', k: 'overtime' });
    } else this.endMatch();
  }

  /* ---------- input ---------- */
  pushInput(id, seq, ix, iy) {
    const p = this.players.get(id);
    if (!p) return;
    p.queue.push({ seq, ix, iy });
    if (p.queue.length > 8) p.queue.splice(0, p.queue.length - 4);
  }

  consumeInputs() {
    for (const p of this.players.values()) {
      while (p.queue.length > 3) p.queue.shift();          // client is ahead: catch up
      const inp = p.queue.shift();
      if (inp) { p.last = inp; p.ack = inp.seq; }          // starved: repeat the last input
      if (!p.connected) p.last = { seq: p.ack, ix: 0, iy: 0 };
      p.body.input = p.last;
    }
  }

  /* ---------- main tick (60 Hz) ---------- */
  tick() {
    this.tickCount++;
    this.consumeInputs();
    if (this.phase === 'lobby' || this.phase === 'playing' || this.phase === 'goal') {
      this.world.inputsEnabled = this.phase !== 'goal';
      this.world.step();
      for (const ev of this.world.events) this.broadcast({ t: 'ev', ...ev });
      this.world.events.length = 0;
    }
    switch (this.phase) {
      case 'lobby': if (this.detectGoal()) this.world.resetBall(); break;   // warm-up: goals don't count
      case 'playing': this.tickPlaying(); break;
      default:
        this.phaseLeft -= TICK_MS;
        if (this.phaseLeft <= 0) this.advance();
    }
    if (this.tickCount % 2 === 0) this.sendSnapshot();
  }

  sendSnapshot() {
    const p = [];
    for (const pl of this.players.values()) {
      const b = pl.body;
      p.push([pl.id, r2(b.x), r2(b.y), r2(b.vx), r2(b.vy), r2(b.fx), r2(b.fy), pl.ack, b.flying ? 1 : 0]);
    }
    const b = this.world.ball;
    this.broadcast({
      t: 's', ts: Math.round(performance.now()), ph: this.phase, pl: Math.max(0, Math.round(this.phaseLeft)),
      clk: r2(this.clock), ot: this.overtime ? 1 : 0, sc: this.score, p, b: [r2(b.x), r2(b.y), r2(b.vx), r2(b.vy)]
    });
  }
}

module.exports = { Room, CFG };
