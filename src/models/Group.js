const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define Group Schema for Telegram groups
const groupSchema = new Schema(
    {
        telegramGroupId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        groupName: {
            type: String,
            default: 'Unnamed Group'
        },
        groupType: {
            type: String,
            enum: ['group', 'supergroup'],
            default: 'group'
        },
        memberCount: {
            type: Number,
            default: 0
        },
        agentId: {
            type: Schema.Types.ObjectId,
            ref: 'agent',
            required: true
        },
        addedByUserId: {
            type: Schema.Types.ObjectId,
            ref: 'user'
        },
        apiKeyUserId: {
            type: Schema.Types.ObjectId,
            ref: 'user'
        },
        isActive: {
            type: Boolean,
            default: true
        },
        moderationEnabled: {
            type: Boolean,
            default: true
        },
        moderationSettings: {
            deleteMessages: { type: Boolean, default: true },
            warnUsers: { type: Boolean, default: true },
            muteUsers: { type: Boolean, default: true },
            kickUsers: { type: Boolean, default: true },
            banUsers: { type: Boolean, default: false }
        },
        lastActivity: {
            type: Date,
            default: Date.now
        },
        apiUsage: {
            messageCount: { type: Number, default: 0 },
            moderationCount: { type: Number, default: 0 },
            commandCount: { type: Number, default: 0 }
        }
    },
    {
        timestamps: true
    }
);

// Set virtual for ID
groupSchema.virtual('id').get(function () {
    return this._id.toHexString();
});

// Set JSON options
groupSchema.set('toJSON', {
    getters: true
});

groupSchema.set('toObject', {
    getters: true
});

// Create and export Group model
const Group = mongoose.model('group', groupSchema);

module.exports = Group; 