const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.status(200).send('ok'));

/* =========================================================
   SHARED GAME CONSTANTS (must match client)
========================================================= */

const W = 320, H = 180;
const WALL = 10;
const GOAL_Y = H/2 - 24;
const GOAL_H = 48;
const GOAL_DEPTH = 18;

/* =========================================================
   ROOMS
========================================================= */

const rooms = new Map(); // roomId -> room

function makeRoomId(){
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createRoom(){
  const id = makeRoomId();

  const room = {
    id,
    players: new Map(), // socketId -> player obj
    state: null,
    tickInterval: null,
    lastGoal: null,
    winTimer: 0
  };

  rooms.set(id, room);
  return room;
}

/* =========================================================
   PLAYER + BALL FACTORIES
========================================================= */

function makePlayer(side){
  // side: 'left' or 'right'
  return {
    side,
    x: side === 'left' ? W/2 - 40 : W/2 + 40,
    y: H/2,
    r: 5.5,
    vx: 0,
    vy: 0,
    facingX: side === 'left' ? 1 : -1,
    facingY: 0,
    walk: 0,
    flying: false,
    // input (from client)
    input: { ix: 0, iy: 0, dash: false, dashX: 0, dashY: 0 },
    // dash state
    dashTimer: 0,
    dashCooldown: 0,
    dashX: 0,
    dashY: 0
  };
}

function makeBall(){
  return {
    x: W/2,
    y: H/2,
    r: 4.5,
    vx: 0,
    vy: 0
  };
}

const WALLS = [
  { x:0, y:0, w:W, h:WALL },
  { x:0, y:H-WALL, w:W, h:WALL },
  { x:0, y:0, w:WALL, h:GOAL_Y },
  { x:0, y:GOAL_Y+GOAL_H, w:WALL, h:H-(GOAL_Y+GOAL_H) },
  { x:WALL-GOAL_DEPTH, y:GOAL_Y-2, w:2, h:GOAL_H+4 },
  { x:WALL-GOAL_DEPTH, y:GOAL_Y-2, w:GOAL_DEPTH, h:2 },
  { x:WALL-GOAL_DEPTH, y:GOAL_Y+GOAL_H, w:GOAL_DEPTH, h:2 },
  { x:W-WALL, y:0, w:WALL, h:GOAL_Y },
  { x:W-WALL, y:GOAL_Y+GOAL_H, w:WALL, h:H-(GOAL_Y+GOAL_H) },
  { x:W-WALL+GOAL_DEPTH, y:GOAL_Y-2, w:2, h:GOAL_H+4 },
  { x:W-WALL, y:GOAL_Y-2, w:GOAL_DEPTH, h:2 },
  { x:W-WALL, y:GOAL_Y+GOAL_H, w:GOAL_DEPTH, h:2 }
];

const POSTS = [
  { x:WALL, y:GOAL_Y, r:2.5 },
  { x:WALL, y:GOAL_Y+GOAL_H, r:2.5 },
  { x:W-WALL, y:GOAL_Y, r:2.5 },
  { x:W-WALL, y:GOAL_Y+GOAL_H, r:2.5 }
];

const GOALS = [
  { x:WALL-GOAL_DEPTH, y:GOAL_Y, w:GOAL_DEPTH, h:GOAL_H, color:'#ff4b4b', side:'left' },
  { x:W-WALL,          y:GOAL_Y, w:GOAL_DEPTH, h:GOAL_H, color:'#2bff88', side:'right' }
];

/* =========================================================
   PHYSICS HELPERS (mirrors client)
========================================================= */

function clampCircleRect(c, r){
  const cx = Math.max(r.x, Math.min(c.x, r.x + r.w));
  const cy = Math.max(r.y, Math.min(c.y, r.y + r.h));

  let dx = c.x - cx;
  let dy = c.y - cy;
  let d2 = dx*dx + dy*dy;

  if(d2 < c.r*c.r){
    let dist = Math.sqrt(d2);
    let nx, ny, pen;

    if(dist === 0){
      const l = c.x - r.x;
      const rt = (r.x + r.w) - c.x;
      const t = c.y - r.y;
      const b = (r.y + r.h) - c.y;
      const m = Math.min(l, rt, t, b);

      if(m === l){ nx=-1; ny=0; pen=l+c.r; }
      else if(m === rt){ nx=1; ny=0; pen=rt+c.r; }
      else if(m === t){ nx=0; ny=-1; pen=t+c.r; }
      else { nx=0; ny=1; pen=b+c.r; }
    } else {
      nx = dx/dist;
      ny = dy/dist;
      pen = c.r - dist;
    }

    c.x += nx*pen;
    c.y += ny*pen;

    const vn = c.vx*nx + c.vy*ny;
    if(vn < 0){
      c.vx -= 1.6*vn*nx;
      c.vy -= 1.6*vn*ny;
    }
  }
}

function collideCircles(c1, c2, rest = 1.0){
  const dx = c1.x - c2.x;
  const dy = c1.y - c2.y;
  const dist = Math.hypot(dx, dy);
  const min = c1.r + c2.r;

  if(dist < min && dist > 0){
    const nx = dx/dist;
    const ny = dy/dist;
    const ov = min - dist;

    c1.x += nx*ov*.5;
    c1.y += ny*ov*.5;
    c2.x -= nx*ov*.5;
    c2.y -= ny*ov*.5;

    const vn = (c1.vx - c2.vx)*nx + (c1.vy - c2.vy)*ny;

    if(vn < 0){
      const im = -(1 + rest)*vn*.5;
      c1.vx += nx*im;
      c1.vy += ny*im;
      c2.vx -= nx*im;
      c2.vy -= ny*im;
    }

    return { hit:true, nx, ny, overlap:ov };
  }

  return { hit:false, nx:0, ny:0, overlap:0 };
}

function resolveWalls(body){
  for(const w of WALLS){
    clampCircleRect(body, w);
  }
}

function bounceOffPost(b, p){
  const dx = b.x - p.x;
  const dy = b.y - p.y;
  const d = Math.hypot(dx, dy);
  const m = b.r + p.r;

  if(d < m && d > 0){
    const nx = dx/d;
    const ny = dy/d;

    b.x += nx*(m - d);
    b.y += ny*(m - d);

    const vn = b.vx*nx + b.vy*ny;
    if(vn < 0){
      b.vx -= 1.7*vn*nx;
      b.vy -= 1.7*vn*ny;
    }
  }
}

/* =========================================================
   SIMULATION
========================================================= */

function stepRoom(room){
  const state = room.state;
  if(!state) return;

  if(state.won){
    // let ball drift, player fly, count down restart
    state.ball.vx *= .82;
    state.ball.vy *= .82;
    state.ball.x += state.ball.vx;
    state.ball.y += state.ball.vy;

    for(const p of state.players){
      if(p.flying){
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= .992;
        p.vy *= .992;
        p.walk += Math.hypot(p.vx, p.vy)*.2;
        if(p.vx) p.facingX = p.vx;
        if(p.vy) p.facingY = p.vy;
        resolveWalls(p);
      }
    }

    room.winTimer--;
    if(room.winTimer <= 0){
      resetState(room);
    }
    return;
  }

  const SS = 3;
  const ACC = .38;
  const MAX = 2.2;

  for(const p of state.players){
    // cooldowns
    if(p.dashCooldown > 0) p.dashCooldown--;
    if(p.dashTimer > 0) p.dashTimer--;

    // handle dash request
    if(p.input.dash && p.dashCooldown <= 0 && !p.flying){
      let dx = p.input.dashX - p.x;
      let dy = p.input.dashY - p.y;
      const d = Math.hypot(dx, dy);

      if(d >= 2){
        dx /= d;
        dy /= d;
        p.dashX = dx;
        p.dashY = dy;
        p.dashTimer = 7;
        p.dashCooldown = 180;
        p.facingX = dx;
        p.facingY = dy;
        p.vx = dx*6.5;
        p.vy = dy*6.5;
        p.walk += 1;
      }
    }
    p.input.dash = false;
  }

  for(let s = 0; s < SS; s++){
    for(const p of state.players){
      const ix = p.input.ix;
      const iy = p.input.iy;

      if(p.dashTimer <= 0){
        p.vx += ix*ACC;
        p.vy += iy*ACC;
        p.vx *= .88;
        p.vy *= .88;

        const sp = Math.hypot(p.vx, p.vy);
        if(sp > MAX){
          p.vx *= MAX/sp;
          p.vy *= MAX/sp;
        }
      } else {
        p.vx *= .93;
        p.vy *= .93;
      }

      if(Math.abs(ix) > .1 || Math.abs(iy) > .1){
        p.facingX = ix;
        p.facingY = iy;
        p.walk += Math.hypot(p.vx, p.vy)*.15;
      }

      p.x += p.vx/SS;
      p.y += p.vy/SS;

      resolveWalls(p);
    }

    // ball friction + movement
    state.ball.vx *= Math.pow(.991, 1/SS);
    state.ball.vy *= Math.pow(.991, 1/SS);
    state.ball.x += state.ball.vx/SS;
    state.ball.y += state.ball.vy/SS;

    for(const post of POSTS) bounceOffPost(state.ball, post);

    // player-ball collisions
    for(const p of state.players){
      const hit = collideCircles(p, state.ball, .85);

      if(hit.hit && p.dashTimer > 0){
        state.ball.vx += p.dashX * 0.45;
        state.ball.vy += p.dashY * 0.45;

        // pinch boost
        for(const w of WALLS){
          const cx = Math.max(w.x, Math.min(state.ball.x, w.x + w.w));
          const cy = Math.max(w.y, Math.min(state.ball.y, w.y + w.h));
          const dx = state.ball.x - cx;
          const dy = state.ball.y - cy;
          const dist = Math.hypot(dx, dy);

          if(dist < state.ball.r + 2 && dist > 0){
            const dashSpeed = Math.hypot(p.vx, p.vy);
            const pinchBoost = Math.min(1.5, dashSpeed*.28);
            state.ball.vx += (dx/dist)*pinchBoost;
            state.ball.vy += (dy/dist)*pinchBoost;
            break;
          }
        }
      }
    }

    resolveWalls(state.ball);
  }

  // check goals
  for(const g of GOALS){
    if(
      state.ball.x > g.x &&
      state.ball.x < g.x + g.w &&
      state.ball.y > g.y + 2 &&
      state.ball.y < g.y + g.h - 2
    ){
      const speedKph = Math.round(Math.hypot(state.ball.vx, state.ball.vy)*28);

      state.won = true;
      room.winTimer = 120;
      room.lastGoal = {
        side: g.side,
        color: g.color,
        speedKph,
        cx: g.x + g.w/2,
        cy: g.y + g.h/2
      };
      break;
    }
  }
}

function resetState(room){
  const players = [];
  let idx = 0;
  for(const p of room.players.values()){
    players.push(makePlayer(p.side));
    idx++;
  }

  room.state = {
    ball: makeBall(),
    players,
    won: false,
    goal: null
  };
  room.lastGoal = null;
}

/* =========================================================
   SOCKET
========================================================= */

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  let currentRoom = null;

  socket.on('createRoom', () => {
    const room = createRoom();
    joinRoom(room, socket, 'left');
    socket.emit('roomJoined', { roomId: room.id, side: 'left' });
  });

  socket.on('joinRoom', (roomId) => {
    const room = rooms.get(roomId?.toUpperCase?.() || roomId);

    if(!room){
      socket.emit('errorMsg', 'Room not found');
      return;
    }

    if(room.players.size >= 2){
      socket.emit('errorMsg', 'Room is full');
      return;
    }

    const takenSides = [...room.players.values()].map(p => p.side);
    const side = takenSides.includes('left') ? 'right' : 'left';

    joinRoom(room, socket, side);
    socket.emit('roomJoined', { roomId: room.id, side });
    io.to(room.id).emit('opponentJoined');
  });

  function joinRoom(room, sock, side){
    currentRoom = room;
    sock.join(room.id);

    room.players.set(sock.id, {
      side,
      socketId: sock.id
    });

    if(room.players.size === 1){
      // wait for opponent before starting
      room.state = null;
    }

    if(room.players.size === 2){
      // (re)start
      startRoom(room);
    }
  }

  function startRoom(room){
    // build fresh state with players in their sides
    const players = [];
    for(const p of room.players.values()){
      players.push(makePlayer(p.side));
    }
    room.state = {
      ball: makeBall(),
      players,
      won: false,
      goal: null
    };
    room.lastGoal = null;
    room.winTimer = 0;

    if(room.tickInterval) clearInterval(room.tickInterval);

    room.tickInterval = setInterval(() => {
      if(!room.state) return;
      stepRoom(room);

      io.to(room.id).emit('state', {
        ball: room.state.ball,
        players: room.state.players.map(p => ({
          x:p.x, y:p.y, r:p.r,
          facingX:p.facingX, facingY:p.facingY,
          walk:p.walk, flying:p.flying,
          dashCooldown:p.dashCooldown,
          side:p.side
        })),
        won: room.state.won,
        goal: room.lastGoal
      });
    }, 1000/60);
  }

  socket.on('input', (data) => {
    if(!currentRoom || !currentRoom.state) return;

    const entry = currentRoom.players.get(socket.id);
    if(!entry) return;

    // find player in state
    const idx = [...currentRoom.players.keys()].indexOf(socket.id);
    const p = currentRoom.state.players[idx];
    if(!p) return;

    p.input.ix = Math.max(-1, Math.min(1, data.ix || 0));
    p.input.iy = Math.max(-1, Math.min(1, data.iy || 0));

    if(data.dash){
      p.input.dash = true;
      p.input.dashX = data.dashX;
      p.input.dashY = data.dashY;
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnected:', socket.id);

    if(currentRoom){
      currentRoom.players.delete(socket.id);

      io.to(currentRoom.id).emit('opponentLeft');

      if(currentRoom.players.size === 0){
        if(currentRoom.tickInterval) clearInterval(currentRoom.tickInterval);
        rooms.delete(currentRoom.id);
      } else {
        // pause game — wait for a new joiner
        if(currentRoom.tickInterval) clearInterval(currentRoom.tickInterval);
        currentRoom.tickInterval = null;
        currentRoom.state = null;
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});