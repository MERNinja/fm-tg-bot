const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
require('dotenv').config();
const fs = require('fs');

// Import controllers and services
const messageController = require('./controllers/messageController');
const { connectDB } = require('./config/database');
const Agent = require('./models/Agent');
const User = require('./models/User');

// Connect to the database
connectDB();

// Store active bots with their corresponding agent IDs and updatedAt timestamps
const activeBots = new Map();

// Add heartbeat mechanism
function setupHeartbeat() {
  if (process.env.NODE_HEARTBEAT_FILE && process.env.NODE_HEARTBEAT_INTERVAL) {
    const heartbeatFile = process.env.NODE_HEARTBEAT_FILE;
    const interval = parseInt(process.env.NODE_HEARTBEAT_INTERVAL) || 30000;

    console.log(`Setting up heartbeat mechanism (interval: ${interval}ms, file: ${heartbeatFile})`);

    // Update heartbeat regularly
    setInterval(() => {
      try {
        fs.writeFileSync(heartbeatFile, Date.now().toString());
      } catch (error) {
        console.error(`Error writing heartbeat: ${error.message}`);
      }
    }, interval);

    // Also update on certain events
    process.on('message', () => {
      try {
        fs.writeFileSync(heartbeatFile, Date.now().toString());
      } catch (error) { /* ignore */ }
    });
  }
}

// Simple request deduplication
const processedMessages = new Map();
const MESSAGE_DEDUP_TTL = 10000; // 10 seconds

function isDuplicateRequest(userId, messageId, messageText) {
  const key = `${userId}-${messageId}`;
  const textKey = `${userId}-${messageText.substring(0, 20)}`;

  // Check if we've seen this exact message ID recently
  if (processedMessages.has(key)) {
    console.log(`Detected duplicate message ID: ${key}`);
    return true;
  }

  // Also check for same text from same user within short timeframe
  const recentMessages = [...processedMessages.entries()]
    .filter(([k, v]) => k.startsWith(`${userId}-`) && Date.now() - v.time < 3000);

  for (const [, data] of recentMessages) {
    if (data.text && data.text === messageText) {
      console.log(`Detected duplicate text from user ${userId} within 3 seconds`);
      return true;
    }
  }

  // Store this message as processed
  processedMessages.set(key, {
    time: Date.now(),
    text: messageText
  });
  processedMessages.set(textKey, {
    time: Date.now(),
    messageId
  });

  // Cleanup old entries
  setTimeout(() => {
    processedMessages.delete(key);
    processedMessages.delete(textKey);
  }, MESSAGE_DEDUP_TTL);

  return false;
}

// Async function to fetch agents and user data
async function initializeAgentData() {
  try {
    console.log('Fetching agents with Telegram tokens...');
    // Find agents with valid Telegram tokens and populate the user data in a single query
    const agents = await Agent.find({
      'summary.telegram.token': { $exists: true, $ne: null }
    }).populate('userId');

    if (agents.length > 0) {
      console.log(`Found ${agents.length} agents with Telegram tokens`);

      // Loop through agents for setup and bot initialization
      for (let index = 0; index < agents.length; index++) {
        const agent = agents[index];
        console.log(`Agent ${index + 1}: ${agent.name}`);
        console.log(`  ID: ${agent._id}`);
        console.log(`  Token: ${agent.summary.telegram.token.substring(0, 10)}...`);

        const agentId = agent._id.toString();
        const currentUpdatedAt = new Date(agent.updatedAt).getTime();

        // Check if we already have this bot running
        const existingBot = activeBots.get(agentId);

        // Determine if we need to launch a new bot or relaunch an existing one
        const shouldLaunchNewBot = !existingBot;
        const shouldRelaunchBot = existingBot && currentUpdatedAt > existingBot.updatedAt;

        if (shouldRelaunchBot) {
          console.log(`Agent ${agent.name} has been modified, relaunching bot...`);
          try {
            // Stop the existing bot
            await existingBot.bot.stop('UPDATE');
            console.log(`Successfully stopped bot for agent ${agent.name}`);
          } catch (error) {
            console.error(`Error stopping bot for agent ${agent.name}:`, error);
          }
        }

        if (shouldLaunchNewBot || shouldRelaunchBot) {
          // Check if user data is available
          if (agent.userId && agent.userId.apiKey && agent.userId.apiKey.length > 0) {
            console.log(`  User: ${agent.userId.name || agent.userId.email || 'Unknown'}`);
            console.log(`  API Key: ${agent.userId.apiKey[0].substring(0, 5)}...`);

            // Get user data directly from the populated field
            const user = agent.userId;

            if (user && user.apiKey) {
              console.log('User API key found and loaded');
              console.log(`User: ${user.name || user.email || 'Unknown'}, ID: ${user._id}`);
            } else {
              console.log('No user API key found, using default');
            }

            if (agent._id) {
              try {
                // Initialize the bot with extended timeout options
                const bot = new Telegraf(agent.summary.telegram.token, {
                  telegram: {
                    // API timeout in ms (default: 30000ms)
                    apiTimeout: 180000, // 3 minutes
                    // Polling parameters for webhook mode
                    webhookReply: false
                  },
                  // Telegram client options
                  handlerTimeout: 180000 // 3 minutes handler timeout
                });
                console.log('Bot initialized:', agent.summary.telegram.token.substring(0, 10) + '...', agent.name);

                // Wait for 1 second before continuing
                console.log('Waiting 1 second before starting the bot...');
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log('Wait complete, continuing bot initialization...');

                // Bot commands
                bot.start((ctx) => {
                  console.log(`Start command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                  const welcomeMessage = `👋 Hi! I'm ${agent.name}. ${agent.summary.description ? `${agent.summary.description}\n\n` : ''} Feel free to start chatting with me!`;
                  ctx.reply(welcomeMessage);
                });

                // Add memory-related commands
                bot.command('clearmemory', async (ctx) => {
                  console.log(`Clear memory command received from user: ${ctx.from.id}`);
                  try {
                    await messageController.clearMemory(ctx, agent);
                  } catch (error) {
                    console.error('Error clearing memory:', error);
                    ctx.reply('⚠️ An error occurred while clearing conversation history.');
                  }
                });

                bot.command('showmemory', async (ctx) => {
                  console.log(`Show memory command received from user: ${ctx.from.id}`);
                  try {
                    await messageController.showMemory(ctx, agent);
                  } catch (error) {
                    console.error('Error showing memory:', error);
                    ctx.reply('⚠️ An error occurred while retrieving conversation history.');
                  }
                });

                // Handle text messages
                bot.on(message('text'), async (ctx) => {
                  const userId = ctx.from.id;
                  const messageId = ctx.message.message_id;
                  const messageText = ctx.message.text;

                  console.log(`Message received from ${userId} (${ctx.from.username || 'no username'}): ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);

                  // Check for duplicate requests
                  if (isDuplicateRequest(userId, messageId, messageText)) {
                    console.log(`Skipping duplicate message ${messageId} from user ${userId}`);
                    return;
                  }

                  try {
                    await messageController.processMessage(messageText, ctx, agent);
                  } catch (error) {
                    console.error('Error processing message:', error);
                    ctx.reply('⚠️ An error occurred while processing your request.');
                  }
                });

                // Register bot commands with BotFather
                bot.telegram.setMyCommands([
                  { command: 'start', description: 'Start the bot' },
                  { command: 'clearmemory', description: 'Clear your conversation history' },
                  { command: 'showmemory', description: 'Show a summary of your conversation history' }
                ]).then(() => {
                  console.log('Bot commands registered with Telegram');
                }).catch(error => {
                  console.error('Failed to register commands:', error);
                });

                try {
                  // Start the bot
                  console.log('Launching bot...');
                  bot.launch();
                  console.log('Bot launched successfully for agent:', agent.name);

                  // Store the bot in our active bots map
                  activeBots.set(agentId, {
                    bot: bot,
                    updatedAt: currentUpdatedAt,
                    name: agent.name
                  });

                  // Enable graceful stop for this specific bot
                  process.once('SIGINT', () => {
                    console.log('SIGINT received, stopping bot');
                    bot.stop('SIGINT');
                  });
                  process.once('SIGTERM', () => {
                    console.log('SIGTERM received, stopping bot');
                    bot.stop('SIGTERM');
                  });
                } catch (error) {
                  console.error('Error starting bot:', error);
                }
              } catch (error) {
                console.error(`Error creating bot for agent ${agent.name}:`, error);
              }
            }
          } else {
            console.log(`  Warning: No valid API key found for this agent`);
          }
        } else {
          console.log(`Bot for agent ${agent.name} is already running and up to date.`);
        }
      }

      // Check for bots that need to be stopped (agents no longer in the database)
      const currentAgentIds = new Set(agents.map(agent => agent._id.toString()));
      for (const [agentId, botInfo] of activeBots.entries()) {
        if (!currentAgentIds.has(agentId)) {
          console.log(`Agent ${botInfo.name} no longer exists, stopping bot...`);
          try {
            await botInfo.bot.stop('REMOVED');
            activeBots.delete(agentId);
            console.log(`Successfully stopped and removed bot for deleted agent ${botInfo.name}`);
          } catch (error) {
            console.error(`Error stopping bot for deleted agent ${botInfo.name}:`, error);
          }
        }
      }
    } else {
      console.log('No agents found with Telegram tokens, using default values');
    }
  } catch (error) {
    console.error('Error initializing agent data:', error);
  }
}

// Function to periodically check for new or updated agents
function scheduleAgentUpdates(intervalMinutes = 1) {
  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`Scheduling agent updates every ${intervalMinutes} minute(s)...`);

  // Set up interval for periodic checks
  setInterval(async () => {
    console.log('Running scheduled agent update check...');
    await initializeAgentData();
    console.log(`Agent update complete. Currently managing ${activeBots.size} active bots.`);
  }, intervalMs);
}

// Initialize agent data and start the bot
(async () => {
  console.log('Starting initialization process...');
  await initializeAgentData();
  console.log('Initial setup complete');

  // Schedule periodic updates
  scheduleAgentUpdates();
  console.log('Agent update scheduler initialized');

  // Setup heartbeat mechanism
  setupHeartbeat();
})();