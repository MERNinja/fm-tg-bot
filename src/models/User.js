const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define User Schema
const userSchema = new Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        password: {
            type: String,
            required: true,
        },
        firstName: {
            type: String,
        },
        lastName: {
            type: String,
        },
        fullName: {
            type: String,
        },
        phoneNumber: {
            type: String,
        },
        telegramUserId: {
            type: String,
            index: true, // Add index for faster lookups
        },
        social: {
            type: Boolean,
            default: false,
        },
        emailVerified: {
            type: Boolean,
            default: false,
        },
        avatars: {
            type: Array,
            default: [],
        },
        tenants: [
            {
                tenant: {
                    type: Schema.Types.ObjectId,
                    ref: 'tenant',
                },
                roles: [String],
                status: {
                    type: String,
                    enum: ['active', 'invited', 'empty-permissions'],
                },
                updatedAt: {
                    type: Date,
                },
                createdAt: {
                    type: Date,
                },
            },
        ],
        apiKey: {
            type: Array,
            default: [],
        },
        walletAddress: {
            type: String,
        },
        invitationCode: {
            type: String,
        },
        passwordResetToken: {
            type: String,
        },
        passwordResetTokenExpiresAt: {
            type: Date,
        },
        updatedBy: {
            type: Schema.Types.ObjectId,
            ref: 'user',
        },
    },
    {
        timestamps: true,
    }
);

// Virtual for id
userSchema.virtual('id').get(function () {
    return this._id.toHexString();
});

// Set JSON options
userSchema.set('toJSON', {
    getters: true,
});

userSchema.set('toObject', {
    getters: true,
});

// Create User model
const User = mongoose.model('user', userSchema);

module.exports = User; 