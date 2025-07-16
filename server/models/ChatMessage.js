const mongoose = require('mongoose');
const chatSchema = new mongoose.Schema({
  type: { type: String, enum: ['global', 'alliance', 'dm'] }, // Chat type
  alliance: String, // For alliance chats
  from: String, // Username
  to: String, // For DMs
  message: String,
  timestamp: { type: Date, default: Date.now },
});
module.exports = mongoose.model('ChatMessage', chatSchema);