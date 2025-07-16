require('dotenv').config(); // Loads .env
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // Allows browser connections

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