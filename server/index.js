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
const { MongoClient, ObjectId } = require('mongodb'); // For handling IDs
const onlineUsers = new Map();
const attackLocks = new Map(); // playerId: timestamp

// Global regen timer - runs once for the whole server
const regenInterval = setInterval(async () => {
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(mongoose.connection.db.databaseName);
    await db.collection('systems').updateMany({}, { $set: { 'resources.$[].active': true } });
    console.log('Global reset all mining nodes to active');
  } catch (err) {
    console.error('Global node regen error:', err);
  } finally {
    await client.close();
  }
}, 60000);

const app = express();
app.use(cors());
app.use(express.json()); // <-- Move this line here, before any routes

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
  onlineUsers.set(socket.playerId, socket); // Fix
  const player = await Player.findById(socket.playerId);

  socket.emit('playerInfo', { playerId: socket.playerId }); // Send your _id to client
  console.log('Sent playerInfo with id:', socket.playerId);

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

  // Join alliance room if in one (for chats/broadcasts)
  if (player.alliance) socket.join(`alliance_${player.alliance}`);

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
      player.ship.stats.shield = 100;
      player.ship.stats.armor = 100;
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

      // Force reset for testing
      await collection.updateOne({ id: systemId }, { $set: { 'resources.$[].active': true } });
      systemDoc = await collection.findOne({ id: systemId });
      console.log('Forced node reset to active for testing');

      // Adjustable counts
      const numPlanets = 5;
      const numResources = 10;
      const centerX = 625;  // 2200/2
      const centerY = 625;  // 2200/2
      const radius = 1000;

      // Spawn resources if missing - random orbit inside circle
      if (!systemDoc.resources || systemDoc.resources.length === 0) {
        const resourcesArray = [];
        for (let i = 0; i < numResources; i++) {
          let attempts = 0;
          let posX, posY;
          do {
            const angle = Math.random() * 2 * Math.PI;  // Random angle for orbit
            const dist = Math.random() * radius;  // Random distance from center
            posX = centerX + dist * Math.cos(angle);
            posY = centerY + dist * Math.sin(angle);
            attempts++;
          } while (Math.hypot(posX - centerX, posY - centerY) > radius && attempts < 10);  // Retry limit 10
          resourcesArray.push({ id: `node${i+1}`, type: 'ore', yield: 50, position: { x: posX, y: posY }, active: true });
        }
        await collection.updateOne({ id: systemId }, { $set: { resources: resourcesArray } });
        systemDoc = await collection.findOne({ id: systemId });
      }

      // Spawn planets if missing - similar random orbit
      if (!systemDoc.planets || systemDoc.planets.length === 0) {
        const planetsArray = [];
        for (let i = 0; i < numPlanets; i++) {
          let attempts = 0;
          let posX, posY;
          do {
            const angle = Math.random() * 2 * Math.PI;
            const dist = Math.random() * radius;
            posX = centerX + dist * Math.cos(angle);
            posY = centerY + dist * Math.sin(angle);
            attempts++;
          } while (Math.hypot(posX - centerX, posY - centerY) > radius && attempts < 10);
          planetsArray.push({ id: `planet${i+1}`, position: { x: posX, y: posY }, active: true, base: null });
        }
        await collection.updateOne({ id: systemId }, { $set: { planets: planetsArray } });
        systemDoc = await collection.findOne({ id: systemId });
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
      console.log('Emitting systemData with resources:', JSON.stringify({
        id: systemId,
        myPos: { x: player.ship.position.x, y: player.ship.position.y },
        existingPlayers,
        resources: systemDoc.resources,
        planets: systemDoc.planets,
        type: systemDoc.type
      }, null, 2));
      socket.emit('systemData', {
        id: systemId,
        myPos: { x: player.ship.position.x, y: player.ship.position.y },
        existingPlayers,
        resources: systemDoc.resources,
        planets: systemDoc.planets,
        type: systemDoc.type
      });

      // Broadcast entry
      socket.to(systemId).emit('playerEntered', { id: socket.playerId, x: player.ship.position.x, y: player.ship.position.y });
    } catch (err) {
      console.error('Error in joinSystem:', err);
    } finally {
      await client.close();
    }
  });

  socket.on('move', async ({ x, y }) => {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(mongoose.connection.db.databaseName); // Keep DB name
      const playerDoc = await db.collection('players').findOne({ _id: new ObjectId(socket.playerId) });
      if (!playerDoc) return;

      // Validate: Inside boundary (hardcode for now; match client)
      const centerX = 1100, centerY = 1100, radius = 1000;
      const dist = Math.hypot(x - centerX, y - centerY);
      if (dist > radius) return; // Ignore invalid

      // Optional: Dist limit from current pos (e.g., max speed)
      const currDist = Math.hypot(playerDoc.ship.position.x - x, playerDoc.ship.position.y - y);
      if (currDist > 500) return; // Anti-cheat

      await db.collection('players').updateOne(
        { _id: new ObjectId(socket.playerId) },
        { $set: { 'ship.position.x': x, 'ship.position.y': y } }
      );
      io.to(socket.currentSystem).emit('playerMoved', { id: socket.playerId, x, y });
    } catch (err) {
      console.error('Move error:', err);
    } finally {
      await client.close();
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

  // --- Mining Handler ---
  socket.on('startMining', async ({ nodeId }) => {
    console.log('Received startMining request for nodeId:', nodeId, 'in system:', socket.currentSystem); // Debug log
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const database = client.db(mongoose.connection.db.databaseName);
      const collection = database.collection('systems');
      const systemDoc = await collection.findOne({ id: socket.currentSystem });
      const nodeIndex = systemDoc.resources.findIndex(r => r.id === nodeId && r.active);
      console.log('Node found? Index:', nodeIndex); // Debug log
      if (nodeIndex === -1) {
        console.log('Node inactive or not found');
      }
      if (nodeIndex !== -1) {
        // Simulate 10s mining
        setTimeout(async () => {
          console.log('Processing mining complete for nodeId:', nodeId); // Debug log
          const miningClient = new MongoClient(process.env.MONGO_URI);
          try {
            await miningClient.connect();
            const miningDatabase = miningClient.db(mongoose.connection.db.databaseName);
            const miningCollection = miningDatabase.collection('systems');
            const updateResult = await miningCollection.updateOne(
              { id: socket.currentSystem },
              { $set: { [`resources.${nodeIndex}.active`]: false } }
            );
            if (updateResult.modifiedCount > 0) {
              const player = await Player.findById(socket.playerId);
              player.minerals += systemDoc.resources[nodeIndex].yield;
              player.ship.stats.cargo += systemDoc.resources[nodeIndex].yield;
              await player.save();
              socket.emit('miningComplete', { minerals: systemDoc.resources[nodeIndex].yield });
              socket.to(socket.currentSystem).emit('nodeDepleted', { nodeId });
              console.log('Mining complete for nodeId:', nodeId);
            }
          } catch (err) {
            console.error('Mining update error:', err);
          } finally {
            await miningClient.close();
          }
        }, 10000);
      }
    } catch (err) {
      console.error('Mining error:', err);
    } finally {
      await client.close();
    }
  });

  // --- Attack Handler ---
  socket.on('attack', async ({ targetId }) => {
    const attacker = await Player.findById(socket.playerId);
    const target = await Player.findById(targetId);
    const ax = attacker.ship.position.x;
    const ay = attacker.ship.position.y;
    const tx = target.ship.position.x;
    const ty = target.ship.position.y;
    const dist = Math.hypot(tx - ax, ty - ay);
    console.log(`Attack attempt: attacker ${socket.playerId} at (${ax},${ay}), target ${targetId} at (${tx},${ty}), dist=${dist}`);

    const lockTime = attackLocks.get(socket.playerId) || 0;
    if (Date.now() - lockTime < 1000) { // Anti-spam 1s
      console.log('Attack spam detected for', socket.playerId);
      return;
    }
    attackLocks.set(socket.playerId, Date.now());
    if (target && attacker.ship.position.systemId === target.ship.position.systemId) {

      // --- Safe zone PvP check ---
      const systemClient = new MongoClient(process.env.MONGO_URI);
      try {
        await systemClient.connect();
        const db = systemClient.db(mongoose.connection.db.databaseName);
        const systemDoc = await db.collection('systems').findOne({ id: attacker.ship.position.systemId });
        if (systemDoc.type === 'safe') {
          console.log('PvP blocked in safe zone');
          return socket.emit('attackError', { message: 'PvP disabled in safe zone' });
        }
      } finally {
        await systemClient.close();
      }
      // --- end safe check ---

      const dist = Math.hypot(attacker.ship.position.x - target.ship.position.x, attacker.ship.position.y - target.ship.position.y);
      if (dist <= 250) { // Allow attack at exactly 250 units
        const weapon = attacker.ship.weapons[0] || { cooldown: 5, lastFired: new Date(0) };
        const now = new Date();
        if (now - weapon.lastFired < 1000) { // Anti-spam 1s min
          console.log('Attack spam detected for', socket.playerId);
          return;
        }
        if (now - weapon.lastFired > weapon.cooldown * 1000) {

          const damage = 30;// Reduce to 5 to prevent insta-destroy
          target.ship.stats.shield -= damage;
          if (target.ship.stats.shield < 0) {
            target.ship.stats.armor += target.ship.stats.shield; // Overflow negative to armor
            target.ship.stats.shield = 0;
          }
          if (target.ship.stats.armor <= 0) {
            target.ship.stats.armor = 0;
            target.ship.stats.shield = 0; // Keep 0 on destroy
            target.ship.position = { systemId: '1', x: 400, y: 300 };
            await target.save();
            const targetSocket = onlineUsers.get(targetId);
            if (targetSocket) targetSocket.emit('destroyed');
            io.to(socket.currentSystem).emit('playerDestroyed', { id: targetId });
            console.log('Target destroyed:', targetId);
            return;
          }
          await target.save();
          weapon.lastFired = now;
          await attacker.save();
          io.to(socket.currentSystem).emit('attacked', {
            attackerId: socket.playerId,
            targetId,
            damage,
            targetShield: target.ship.stats.shield,
            targetArmor: target.ship.stats.armor
          });
          console.log('Attack applied, damage:', damage, 'shield:', target.ship.stats.shield, 'armor:', target.ship.stats.armor);
        } else {
          console.log('Weapon on cooldown for', socket.playerId);
          socket.emit('attackError', { message: 'Weapon on cooldown!' });
        }
      } else {
        console.log('Target out of range for', socket.playerId);
      }
    } else {
      console.log('Invalid attack target or range');
    }
  });

  socket.on('startMove', ({ targetX, targetY }) => {
    console.log('Broadcasting startMove for player:', socket.playerId, { targetX, targetY });
    socket.to(socket.currentSystem).emit('playerStartMove', { id: socket.playerId, targetX, targetY });
  });

  // Place this INSIDE the connection block:
  socket.on('joinAlliance', async ({ allianceId }) => {
    const player = await Player.findById(socket.playerId);
    if (player.alliance) return socket.emit('error', 'Already in alliance');
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(mongoose.connection.db.databaseName);
      const alliance = await db.collection('alliances').findOne({ _id: new ObjectId(allianceId) });
      if (!alliance) return socket.emit('error', 'Invalid alliance');
      await db.collection('alliances').updateOne({ _id: new ObjectId(allianceId) }, { $push: { members: socket.playerId } });
      await Player.findByIdAndUpdate(socket.playerId, { alliance: allianceId });
      socket.join(`alliance_${allianceId}`);
      socket.emit('allianceJoined', { allianceId });
    } catch (err) {
      socket.emit('error', 'Join failed');
    } finally {
      await client.close();
    }
  });

  // Place after the joinSystem block:

  // Build base on planet
  socket.on('buildBase', async ({ planetId }) => {
    const player = await Player.findById(socket.playerId);
    if (player.minerals < 100) return socket.emit('error', 'Insufficient minerals');
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(mongoose.connection.db.databaseName);
      const system = await db.collection('systems').findOne({ id: socket.currentSystem });
      const planetIndex = system.planets.findIndex(p => p.id === planetId && !p.base);
      if (planetIndex === -1) return socket.emit('error', 'Planet occupied or invalid');
      await db.collection('systems').updateOne(
        { id: socket.currentSystem },
        { $set: { [`planets.${planetIndex}.base`]: { ownerId: socket.playerId, builtAt: new Date(), research: { level: 0, unlocks: [] } } } }
      );
      await Player.findByIdAndUpdate(socket.playerId, { $inc: { minerals: -100 } });
      io.to(socket.currentSystem).emit('baseBuilt', { planetId, ownerId: socket.playerId });
    } catch (err) {
      socket.emit('error', 'Build failed');
    } finally {
      await client.close();
    }
  });

  // Dock at base
  socket.on('dockBase', async ({ planetId }) => {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(mongoose.connection.db.databaseName);
      const system = await db.collection('systems').findOne({ id: socket.currentSystem });
      const planet = system.planets.find(p => p.id === planetId);
      if (!planet.base) return socket.emit('error', 'No base');
      const player = await Player.findById(socket.playerId);
      const baseOwner = await Player.findById(planet.base.ownerId);
      if (planet.base.ownerId !== socket.playerId && player.alliance !== baseOwner.alliance) return socket.emit('error', 'Access denied');
      await Player.findByIdAndUpdate(socket.playerId, { 'ship.position.x': planet.position.x, 'ship.position.y': planet.position.y });
      socket.emit('docked', { base: planet.base });
    } catch (err) {
      socket.emit('error', 'Dock failed');
    } finally {
      await client.close();
    }
  });

  // Research hub (30s timer)
  socket.on('research', async ({ type }) => {
    if (type !== 'hub') return socket.emit('error', 'Invalid research');
    setTimeout(async () => {
      const client = new MongoClient(process.env.MONGO_URI);
      try {
        await client.connect();
        const db = client.db(mongoose.connection.db.databaseName);
        await db.collection('systems').updateOne(
          { id: socket.currentSystem, 'planets.base.ownerId': socket.playerId },
          { $push: { 'planets.$.base.research.unlocks': 'hub' }, $inc: { 'planets.$.base.research.level': 1 } }
        );
        socket.emit('researchComplete', { type });
      } catch (err) {
        socket.emit('error', 'Research failed');
      } finally {
        await client.close();
      }
    }, 30000);
  });

  // Place hub for control
  socket.on('placeHub', async () => {
    const player = await Player.findById(socket.playerId);
    if (!player.alliance) return socket.emit('error', 'Need alliance');
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(mongoose.connection.db.databaseName);
      const system = await db.collection('systems').findOne({ id: socket.currentSystem });
      const hasUnlock = system.planets.some(p => p.base && p.base.ownerId === socket.playerId && p.base.research.unlocks.includes('hub'));
      if (!hasUnlock || system.ownerAllianceId) return socket.emit('error', 'Cannot place hub');
      await db.collection('systems').updateOne({ id: socket.currentSystem }, { $set: { ownerAllianceId: player.alliance } });
      io.to(socket.currentSystem).emit('systemControlled', { allianceId: player.alliance });
    } catch (err) {
      socket.emit('error', 'Place failed');
    } finally {
      await client.close();
    }
  });
});

// API to create alliance (call from client later)
app.post('/createAlliance', async (req, res) => {
  console.log('Incoming req.body:', req.body);
  const { name } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token' });
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
      const db = client.db(mongoose.connection.db.databaseName);
      const alliances = db.collection('alliances');
      if (await alliances.findOne({ name })) return res.status(400).json({ error: 'Name taken' });
      const result = await alliances.insertOne({ name, members: [decoded.id], ownerId: decoded.id });
      await Player.findByIdAndUpdate(decoded.id, { alliance: result.insertedId.toString() });
      res.json({ allianceId: result.insertedId.toString() });
    } catch (err) {
      res.status(500).json({ error: 'Failed' });
    } finally {
      await client.close();
    }
  });
});

app.use(cors());
app.use(express.json());

// Connect to MongoDB and check/create index
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/test')
  .then(() => {
    console.log('Connected to MongoDB');
    const db = mongoose.connection.db;
    db.collection('systems').indexInformation()
      .then(indexes => {
        if (!indexes.id_1) {  // Check if 'id_1' key exists
          db.collection('systems').createIndex({ id: 1 }, { unique: true, name: 'id_1' })
            .then(() => console.log('Created index on systems.id'))
            .catch(err => console.error('Index creation error:', err));
        } else {
          console.log('Index on systems.id already exists - skipping creation');
        }
      })
      .catch(err => console.error('Error checking indexes:', err));
  })
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