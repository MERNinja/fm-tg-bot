const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define single warning schema
const warningSchema = new Schema({
    reason: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    moderatorBotId: {
        type: String,
        required: true
    }
});

// Define UserWarning Schema
const userWarningSchema = new Schema(
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
        username: {
            type: String,
            index: true,
            sparse: true
        },
        warningCount: {
            type: Number,
            default: 0,
            min: 0
        },
        warnings: [warningSchema],
        lastWarningDate: {
            type: Date
        },
        isBanned: {
            type: Boolean,
            default: false
        },
        banDate: {
            type: Date
        },
        banReason: {
            type: String
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
userWarningSchema.index({ telegramUserId: 1, telegramChatId: 1 }, { unique: true });

// Set JSON options
userWarningSchema.set('toJSON', { getters: true });
userWarningSchema.set('toObject', { getters: true });

// Create model
const UserWarning = mongoose.model('userWarning', userWarningSchema);

module.exports = UserWarning; 