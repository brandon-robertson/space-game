const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: String, // Hash in production!
  ship: {
    type: { type: String, enum: ['miner', 'destroyer'], default: 'miner' },
    position: { systemId: String, x: Number, y: Number },
    stats: {
      shield: { type: Number, default: 100, max: 100 },
      armor: { type: Number, default: 100, max: 100 },
      cargo: { type: Number, default: 0 }, // For minerals
    },
    weapons: [{
      type: String,
      cooldown: { type: Number, default: 5 }, // Seconds
      lastFired: { type: Date, default: new Date(0) }
    }]
  },
  alliance: String,
  credits: { type: Number, default: 0 },
  minerals: { type: Number, default: 0 },
});

module.exports = mongoose.model('Player', playerSchema);