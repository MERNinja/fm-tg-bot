const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define Message Schema
const messageSchema = new Schema({
    role: {
        type: String,
        enum: ['user', 'assistant', 'system'],
        required: true
    },
    content: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

// Define Conversation Schema
const conversationSchema = new Schema(
    {
        telegramUserId: {
            type: String,
            required: true,
            index: true
        },
        telegramChatId: {
            type: String,
            required: true,
            index: true
        },
        agentId: {
            type: Schema.Types.ObjectId,
            ref: 'agent',
            required: true,
            index: true
        },
        messages: [messageSchema],
        summary: {
            type: String,
            default: ''
        },
        lastActive: {
            type: Date,
            default: Date.now
        },
        metadata: {
            type: Map,
            of: Schema.Types.Mixed,
            default: {}
        }
    },
    { timestamps: true }
);

// Create compound index for faster queries
conversationSchema.index({ telegramUserId: 1, agentId: 1 });

// Set JSON options
conversationSchema.set('toJSON', { getters: true });
conversationSchema.set('toObject', { getters: true });

// Create model
const Conversation = mongoose.model('conversation', conversationSchema);

module.exports = Conversation; 