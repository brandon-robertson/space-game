const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: String,
  ship: {
    type: { type: String, enum: ['miner', 'destroyer'], default: 'miner' },
    position: { systemId: String, x: Number, y: Number },
    stats: {
      shield: { type: Number, default: 100 },
      armor: { type: Number, default: 100 },
      cargo: { type: Number, default: 0 }
    },
    weapons: [{
      type: { type: String, default: 'laser' },
      cooldown: { type: Number, default: 5 },
      lastFired: { type: Date, default: new Date(0) }
    }]
  },
  alliance: String,
  credits: { type: Number, default: 0 },
  minerals: { type: Number, default: 0 }
});

module.exports = mongoose.model('Player', playerSchema);