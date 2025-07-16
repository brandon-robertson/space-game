const mongoose = require('mongoose');
const playerSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: String, // In real app, hash this!
  ship: {
    type: { type: String, default: 'miner' },
    position: { systemId: String, x: Number, y: Number },
    stats: { hull: { type: Number, default: 100 }, shields: { type: Number, default: 100 } },
    weapons: [{ type: String, cooldown: Number }],
  },
  alliance: String,
  credits: { type: Number, default: 0 },
  minerals: { type: Number, default: 0 },
});
module.exports = mongoose.model('Player', playerSchema);