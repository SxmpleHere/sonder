const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// roomId -> { players: Map(socketId -> playerData), ball, hostId }
const rooms = new Map();

function createRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRoomState(room) {
  const players = [];
  for (const [id, p] of room.players) {
    players.push({
      id,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      facingX: p.facingX,
      facingY: p.facingY,
      walk: p.walk,
      color: p.color,
      name: p.name
    });
  }
  return {
    players,
    ball: room.ball,
    hostId: room.hostId
  };
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('createRoom', (name, cb) => {
    const code = createRoomCode();
    const room = {
      players: new Map(),
      ball: { x: 160, y: 90, vx: 0, vy: 0, r: 4.5 },
      hostId: socket.id
    };
    room.players.set(socket.id, {
      x: 80, y: 90, vx: 0, vy: 0,
      facingX: 1, facingY: 0, walk: 0,
      color: '#e63946',
      name: name || 'Player 1'
    });
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    console.log('room created:', code);
    cb && cb({ ok: true, code, playerId: socket.id });
    io.to(code).emit('state', getRoomState(room));
  });

  socket.on('joinRoom', (code, name, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      cb && cb({ ok: false, error: 'Room not found' });
      return;
    }
    if (room.players.size >= 2) {
      cb && cb({ ok: false, error: 'Room full' });
      return;
    }
    room.players.set(socket.id, {
      x: 240, y: 90, vx: 0, vy: 0,
      facingX: -1, facingY: 0, walk: 0,
      color: '#2bff88',
      name: name || 'Player 2'
    });
    socket.join(code);
    socket.roomCode = code;
    console.log('joined room:', code, socket.id);
    cb && cb({ ok: true, code, playerId: socket.id });
    io.to(code).emit('state', getRoomState(room));
  });

  // Client sends its own input / position
  socket.on('input', (data) => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    // Simple server-side movement (client-authoritative for responsiveness)
    if (typeof data.x === 'number') p.x = data.x;
    if (typeof data.y === 'number') p.y = data.y;
    if (typeof data.vx === 'number') p.vx = data.vx;
    if (typeof data.vy === 'number') p.vy = data.vy;
    if (typeof data.facingX === 'number') p.facingX = data.facingX;
    if (typeof data.facingY === 'number') p.facingY = data.facingY;
    if (typeof data.walk === 'number') p.walk = data.walk;

    // Ball is controlled by whoever last touched it (simple)
    if (data.ball) {
      room.ball.x = data.ball.x;
      room.ball.y = data.ball.y;
      room.ball.vx = data.ball.vx;
      room.ball.vy = data.ball.vy;
    }

    // Broadcast to the other player only (not echo)
    socket.to(code).emit('opponent', {
      id: socket.id,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      facingX: p.facingX, facingY: p.facingY, walk: p.walk,
      ball: room.ball
    });
  });

  socket.on('goal', (data) => {
    const code = socket.roomCode;
    if (!code) return;
    io.to(code).emit('goal', data);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    console.log('left room:', code, socket.id);
    if (room.players.size === 0) {
      rooms.delete(code);
    } else {
      // promote new host if needed
      if (room.hostId === socket.id) {
        room.hostId = [...room.players.keys()][0];
      }
      io.to(code).emit('state', getRoomState(room));
      io.to(code).emit('playerLeft', socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log('Football multiplayer server on port', PORT);
});