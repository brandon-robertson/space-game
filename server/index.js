require('dotenv').config(); // Loads .env
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Player = require('./models/Player');
const ChatMessage = require('./models/ChatMessage');
const onlineUsers = new Map(); // Key: playerId (string), Value: socket instance

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // Allows browser connections

// Authenticate sockets with JWT
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Invalid token'));
    socket.playerId = decoded.id;
    next();
  });
});

io.on('connection', async (socket) => {
  console.log('Player connected:', socket.playerId);
  const player = await Player.findById(socket.playerId);

  socket.on('joinSystem', (systemId) => {
    socket.leave(socket.currentSystem); // Leave old
    socket.join(systemId);
    socket.currentSystem = systemId;
    socket.emit('systemData', { id: systemId /* Load from DB */ });
    io.to(systemId).emit('playerEntered', { id: socket.playerId, x: 400, y: 300 }); // Hardcoded
  });
  socket.on('move', ({ x, y }) => {
    io.to(socket.currentSystem).emit('playerMoved', { id: socket.playerId, x, y });
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
  onlineUsers.delete(socket.playerId); // Remove from online map
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