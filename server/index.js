require('dotenv').config(); // Loads .env
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Player = require('./models/Player');
const ChatMessage = require('./models/ChatMessage');

// Clear Mongoose model cache for System to avoid OverwriteModelError
delete mongoose.connection.models['System'];

const System = require('./models/System');
const onlineUsers = new Map(); // Key: playerId (string), Value: socket instance

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // Allows browser connections

// Authenticate sockets with JWT
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    console.error('No token provided');
    return next(new Error('No token'));
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error('Invalid token:', err);
      return next(new Error('Invalid token'));
    }
    socket.playerId = decoded.id;
    next();
  });
});

io.on('connection', async (socket) => {
  console.log('Player connected:', socket.playerId);
  const player = await Player.findById(socket.playerId);

  socket.on('joinSystem', async (systemId) => {
    if (socket.currentSystem) {
      socket.to(socket.currentSystem).emit('playerLeft', { id: socket.playerId });
      socket.leave(socket.currentSystem);
    }
    socket.join(systemId);
    socket.currentSystem = systemId;

    const player = await Player.findById(socket.playerId);
    if (!player.ship.position || player.ship.position.systemId !== systemId) {
      player.ship.position = { systemId, x: 400, y: 300 };
      await player.save();
    }

    // Fetch existing
    const existingPlayers = [];
    const socketsInRoom = await io.in(systemId).fetchSockets();
    for (let s of socketsInRoom) {
      if (s.playerId !== socket.playerId) {
        const existingPlayer = await Player.findById(s.playerId);
        existingPlayers.push({ id: s.playerId, x: existingPlayer.ship.position.x, y: existingPlayer.ship.position.y });
      }
    }

    // Load system data (nodes/resources)
    let system = await System.findOne({ id: systemId });
    if (!system) {
      system = new System({
        id: systemId,
        name: 'Test System',
        type: 'mining',
        resources: [
          { id: 'node1', type: 'ore', yield: 50, position: { x: 600, y: 400 }, active: true }
        ]
      });
      await system.save();
    }

    // Send to joiner (now includes resources)
    socket.emit('systemData', {
      id: systemId,
      myPos: { x: player.ship.position.x, y: player.ship.position.y },
      existingPlayers,
      resources: system.resources
    });

    // Broadcast entry
    socket.to(systemId).emit('playerEntered', { id: socket.playerId, x: player.ship.position.x, y: player.ship.position.y });
  });

  // Add 'startMove' for during animation (client emits this on tween start)
  socket.on('startMove', ({ targetX, targetY }) => {
    socket.to(socket.currentSystem).emit('playerStartMove', { id: socket.playerId, targetX, targetY });
  });
  socket.on('move', async ({ x, y }) => {
    const player = await Player.findById(socket.playerId);
    if (player) {
      player.ship.position.x = x;
      player.ship.position.y = y;
      await player.save();
      socket.to(socket.currentSystem).emit('playerMoved', { id: socket.playerId, x, y });
    }
  });

  // Join alliance room if player is in one
  if (player.alliance) socket.join(`alliance_${player.alliance}`);

  // Add to online map
  onlineUsers.set(socket.playerId, socket);

  // Load chat history on connect
  // Global: Last 50 global messages
  const globalHistory = await ChatMessage.find({ type: 'global' }).sort({ timestamp: -1 }).limit(50);
  socket.emit('chatHistory', { type: 'global', messages: globalHistory.reverse() }); // Reverse for chronological

  // Alliance: If in alliance, last 50
  if (player.alliance) {
    const allianceHistory = await ChatMessage.find({ type: 'alliance', alliance: player.alliance }).sort({ timestamp: -1 }).limit(50);
    socket.emit('chatHistory', { type: 'alliance', messages: allianceHistory.reverse() });
  }

  // DMs: Fetch open DMs (e.g., unique 'to/from' pairs with recent messages)
  const dmPartners = await ChatMessage.aggregate([
    { $match: { type: 'dm', $or: [{ from: player.username }, { to: player.username }] } },
    { $group: { _id: { $cond: [{ $eq: ['$from', player.username] }, '$to', '$from'] } } }
  ]);
  for (let partner of dmPartners) {
    const dmHistory = await ChatMessage.find({
      type: 'dm',
      $or: [
        { from: player.username, to: partner._id },
        { from: partner._id, to: player.username }
      ]
    }).sort({ timestamp: -1 }).limit(50);
    socket.emit('chatHistory', { type: 'dm', to: partner._id, messages: dmHistory.reverse() });
  }

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.playerId);
    if (socket.currentSystem) {
      socket.to(socket.currentSystem).emit('playerLeft', { id: socket.playerId });
    }
    onlineUsers.delete(socket.playerId);
  });

  // Send chat message
  socket.on('sendChat', async (data) => {
    const { type, message, to, alliance } = data; // 'to' for DM, 'alliance' for alliance chat
    const from = player.username;

    const chatMsg = new ChatMessage({ type, from, message, timestamp: new Date() });
    if (type === 'alliance') chatMsg.alliance = player.alliance;
    if (type === 'dm') chatMsg.to = to;

    await chatMsg.save();

    if (type === 'global') {
      io.emit('newChat', { type: 'global', from, message });
    } else if (type === 'alliance' && player.alliance) {
      io.to(`alliance_${player.alliance}`).emit('newChat', { type: 'alliance', from, message });
      // Join alliance room on connect (add earlier: socket.join(`alliance_${player.alliance}`);)
    } else if (type === 'dm') {
      // Find receiver's player doc to get ID
      const receiver = await Player.findOne({ username: to });
      if (!receiver) return; // Invalid recipient
      const receiverId = receiver._id.toString();

      // Emit to sender
      socket.emit('newChat', { type: 'dm', from, to, message });

      // Emit to receiver if online
      const receiverSocket = onlineUsers.get(receiverId);
      if (receiverSocket) {
        receiverSocket.emit('newChat', { type: 'dm', from, to: receiver.username, message });
      }
    }
  });

  socket.on('startMining', async ({ nodeId }) => {
    const system = await System.findOne({ id: socket.currentSystem });
    const node = system.resources.find(r => r.id === nodeId && r.active);
    if (node) {
      // Simulate mining time (e.g., 10s)
      setTimeout(async () => {
        const player = await Player.findById(socket.playerId);
        player.minerals += node.yield;
        player.ship.stats.cargo += node.yield; // Update cargo
        await player.save();
        node.active = false; // Deplete node
        await system.save();
        socket.emit('miningComplete', { minerals: node.yield });
        socket.to(socket.currentSystem).emit('nodeDepleted', { nodeId });
      }, 10000); // 10s delay
    }
  });

  socket.on('attack', async ({ targetId }) => {
    const attacker = await Player.findById(socket.playerId);
    const target = await Player.findById(targetId);
    if (target && attacker.ship.position.systemId === target.ship.position.systemId) {
      const weapon = attacker.ship.weapons[0]; // First weapon for simplicity
      const now = new Date();
      if (now - weapon.lastFired > weapon.cooldown * 1000) {
        const damage = 20; // Example; based on weapon
        target.ship.stats.shield -= damage;
        if (target.ship.stats.shield < 0) {
          target.ship.stats.armor += target.ship.stats.shield; // Overflow to armor
          target.ship.stats.shield = 0;
          if (target.ship.stats.armor <= 0) {
            // Death: Respawn
            target.ship.stats.armor = 100;
            target.ship.stats.shield = 100;
            target.ship.position = { systemId: '1', x: 400, y: 300 }; // Safe zone
            await target.save();
            const targetSocket = onlineUsers.get(targetId);
            if (targetSocket) targetSocket.emit('destroyed');
          }
        }
        await target.save();
        weapon.lastFired = now;
        await attacker.save();
        io.to(socket.currentSystem).emit('attacked', { attackerId: socket.playerId, targetId, damage });
      }
    }
  });
});

app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('DB connection error:', err));

// Basic route to test
app.get('/', (req, res) => res.send('Space Game Server Running'));

// Start server
server.listen(3000, () => console.log('Server listening on port 3000'));

// Register
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const existing = await Player.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username taken' });
    const player = new Player({ username, password }); // TODO: Hash password later!
    await player.save();
    const token = jwt.sign({ id: player._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, username });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const player = await Player.findOne({ username });
    if (!player || player.password !== password) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: player._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, username });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});