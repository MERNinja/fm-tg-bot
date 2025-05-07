const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define Agent Schema based on the provided structure
const agentSchema = new Schema(
  {
    name: {
      type: String,
      maxlength: 255,
      required: true,
    },
    coins: { type: Number, default: 0 },
    averageResponseTime: { type: Number, default: 0.0, required: false },
    isAvailable: { type: Boolean, default: true, required: false },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: true,
    },
    modelName: { type: Array },
    avgSpeed: { type: Number },
    numPromptServed: { type: Number },
    numRegenerate: { type: Number },
    tokenEarned: { type: Number, default: 0 },
    numRecords: { type: Number },
    contextLength: { type: Number },
    score: { type: Number },
    agentIpAddress: { type: String },
    isPublic: { type: Boolean, default: true },
    status: { type: Boolean },
    summary: {
      type: Object,
      required: true,
      default: {},
      // Define structure for the telegram configuration
      telegram: {
        type: Object,
        default: {},
        token: { type: String },
        moderation: { type: Boolean, default: false },
        moderationSettings: {
          type: Object,
          default: {},
          deleteMessages: { type: Boolean, default: true },
          warnUsers: { type: Boolean, default: true },
          muteUsers: { type: Boolean, default: true },
          kickUsers: { type: Boolean, default: true },
          banUsers: { type: Boolean, default: false }
        }
      }
    },
    avatar: {
      type: String,
    },
    model: {
      type: String,
    },
    role: {
      type: String,
    },
    promptServed: {
      type: Number,
      required: false,
      default: 0,
    },
    walletAddress: {
      type: String,
      required: false,
    },
    sol: {
      type: Number,
      required: false,
      default: 0,
    },
    bounty: {
      type: Number,
      required: false,
      default: 0,
    },
    tokenAddress: {
      type: String,
      required: false,
    },
    tokenImage: {
      type: String,
      required: false,
    },
    tokenName: {
      type: String,
      required: false,
    },
    tokenSymbol: {
      type: String,
      required: false,
    },
    tokenAmount: {
      type: Number,
      required: false,
      default: 0,
    },
    agentType: {
      type: String,
      enum: ['twitter', 'moddio', 'none', 'api'],
      required: false,
      default: 'none',
    },
    moddioSettings: {
      type: Object,
      required: false,
    },
    moddioId: {
      type: String,
      required: false,
    },
    moddioUsername: {
      type: String,
      required: false,
    },
    // Additional fields for our bot functionality
    agentId: { 
      type: String, 
      required: true, 
      unique: true 
    },
    prePrompt: { 
      type: String, 
      default: '' 
    },
    settings: { 
      type: mongoose.Schema.Types.Mixed, 
      default: {} 
    }
  },
  { timestamps: true }
);

// Virtual for id
agentSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

// Set JSON options
agentSchema.set('toJSON', {
  getters: true,
});

agentSchema.set('toObject', {
  getters: true,
});

// Create Agent model
const Agent = mongoose.model('agent', agentSchema);

module.exports = Agent; 