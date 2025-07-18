require('dotenv').config();
console.log('MONGO_URI from env:', process.env.MONGO_URI);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Player = require('./models/Player');
const ChatMessage = require('./models/ChatMessage');
const { MongoClient } = require('mongodb');
const onlineUsers = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

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

  // --- Chat History Loading with Logging ---

  // Global: Last 50 global messages
  const globalHistory = await ChatMessage.find({ type: 'global' }).sort({ timestamp: -1 }).limit(50);
  socket.emit('chatHistory', { type: 'global', messages: globalHistory.reverse() });
  console.log('Sent global chat history:', globalHistory.length, 'messages');

  // Alliance: If in alliance, last 50
  if (player.alliance) {
    const allianceHistory = await ChatMessage.find({ type: 'alliance', alliance: player.alliance }).sort({ timestamp: -1 }).limit(50);
    socket.emit('chatHistory', { type: 'alliance', messages: allianceHistory.reverse() });
    console.log('Sent alliance chat history:', allianceHistory.length, 'messages');
  }

  // DMs: Fetch open DMs
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
    console.log('Sent DM chat history to:', partner._id, 'messages');
  }

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

    // Use MongoDB native driver for system management
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const database = client.db(mongoose.connection.db.databaseName);
      const collection = database.collection('systems');
      let systemDoc = await collection.findOne({ id: systemId });
      if (!systemDoc) {
        const resourcesArray = [{ id: 'node1', type: 'ore', yield: 50, position: { x: 600, y: 400 }, active: true }];
        console.log('Inserting new system with resources:', JSON.stringify({ id: systemId, name: 'Test System', type: 'mining', resources: resourcesArray, connections: [], npcs: [], hub: null }, null, 2));
        await collection.insertOne({
          id: systemId,
          name: 'Test System',
          type: 'mining',
          resources: resourcesArray,
          connections: [],
          npcs: [],
          hub: null
        });
        systemDoc = await collection.findOne({ id: systemId });
        console.log('Inserted system document:', JSON.stringify(systemDoc, null, 2));
      } else {
        console.log('Using existing system document:', JSON.stringify(systemDoc, null, 2));
        // Update resources if missing
        if (!systemDoc.resources || systemDoc.resources.length === 0) {
          await collection.updateOne({ id: systemId }, { $set: { resources: [{ id: 'node1', type: 'ore', yield: 50, position: { x: 600, y: 400 }, active: true }] } });
          systemDoc = await collection.findOne({ id: systemId });
          console.log('Updated system document:', JSON.stringify(systemDoc, null, 2));
        }
      }

      // Fetch existing players
      const existingPlayers = [];
      const socketsInRoom = await io.in(systemId).fetchSockets();
      for (let s of socketsInRoom) {
        if (s.playerId !== socket.playerId) {
          const existingPlayer = await Player.findById(s.playerId);
          existingPlayers.push({ id: s.playerId, x: existingPlayer.ship.position.x, y: existingPlayer.ship.position.y });
        }
      }

      // Send to joiner with resources
      console.log('Emitting systemData with resources:', JSON.stringify({ id: systemId, myPos: { x: player.ship.position.x, y: player.ship.position.y }, existingPlayers, resources: systemDoc.resources }, null, 2));
      socket.emit('systemData', { id: systemId, myPos: { x: player.ship.position.x, y: player.ship.position.y }, existingPlayers, resources: systemDoc.resources });

      // Broadcast entry
      socket.to(systemId).emit('playerEntered', { id: socket.playerId, x: player.ship.position.x, y: player.ship.position.y });
    } catch (err) {
      console.error('Error in joinSystem:', err);
    } finally {
      await client.close();
    }
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

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.playerId);
    if (socket.currentSystem) {
      socket.to(socket.currentSystem).emit('playerLeft', { id: socket.playerId });
    }
    onlineUsers.delete(socket.playerId);
  });

  socket.on('sendChat', async (data) => {
    console.log('Received sendChat:', data); // Debug
    const { type, message, to, alliance } = data;
    const from = player.username;
    const chatMsg = new ChatMessage({ type, from, message, timestamp: new Date() });
    if (type === 'alliance') chatMsg.alliance = player.alliance;
    if (type === 'dm') chatMsg.to = to;
    await chatMsg.save();
    if (type === 'global') {
      io.emit('newChat', { type: 'global', from, message });
    } else if (type === 'alliance' && player.alliance) {
      io.to(`alliance_${player.alliance}`).emit('newChat', { type: 'alliance', from, message });
    } else if (type === 'dm') {
      const receiver = await Player.findOne({ username: to });
      if (receiver) {
        socket.emit('newChat', { type: 'dm', from, to, message });
        const receiverSocket = onlineUsers.get(receiver._id.toString());
        if (receiverSocket) receiverSocket.emit('newChat', { type: 'dm', from, to: receiver.username, message });
      }
    }
  });

  socket.on('startMining', async ({ nodeId }) => {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const database = client.db(mongoose.connection.db.databaseName);
      const collection = database.collection('systems');
      const systemDoc = await collection.findOne({ id: socket.currentSystem });
      const node = systemDoc.resources.find(r => r.id === nodeId && r.active);
      if (node) {
        // Simulate mining time
        setTimeout(async () => {
          const miningClient = new MongoClient(process.env.MONGO_URI); // Reconnect for timeout
          try {
            await miningClient.connect();
            const miningDatabase = miningClient.db(mongoose.connection.db.databaseName);
            const miningCollection = miningDatabase.collection('systems');
            await miningCollection.updateOne(
              { id: socket.currentSystem, "resources.id": nodeId },
              { $set: { "resources.$.active": false } }
            );
            const player = await Player.findById(socket.playerId);
            player.minerals += node.yield;
            player.ship.stats.cargo += node.yield;
            await player.save();
            socket.emit('miningComplete', { minerals: node.yield });
            socket.to(socket.currentSystem).emit('nodeDepleted', { nodeId });
            console.log('Mining complete for nodeId:', nodeId);
          } catch (err) {
            console.error('Mining update error:', err);
          } finally {
            await miningClient.close();
          }
        }, 10000); // 10 seconds
      }
    } catch (err) {
      console.error('Mining error:', err);
    } finally {
      await client.close();
    }
  });

  socket.on('startMove', ({ targetX, targetY }) => {
    console.log('Broadcasting startMove for player:', socket.playerId, { targetX, targetY });
    socket.to(socket.currentSystem).emit('playerStartMove', { id: socket.playerId, targetX, targetY });
  });
});

app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/test', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
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
    const player = new Player({ username, password });
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