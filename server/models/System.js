const mongoose = require('mongoose');

const systemSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  type: { type: String, enum: ['safe', 'mining', 'hazard'] },
  connections: [String],
  resources: [{
    id: String,
    type: String,
    yield: Number,
    position: { x: Number, y: Number },
    active: { type: Boolean, default: true }
  }],
  npcs: [{ level: Number, type: String }],
  hub: { type: mongoose.Schema.Types.ObjectId, ref: 'Hub' },
});

module.exports = mongoose.models.System || mongoose.model('System', systemSchema);