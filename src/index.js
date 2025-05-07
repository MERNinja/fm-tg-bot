const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
require('dotenv').config();
const fs = require('fs');

// Import controllers and services
const messageController = require('./controllers/messageController');
const { connectDB } = require('./config/database');
const Agent = require('./models/Agent');
const User = require('./models/User');
const moderationService = require('./services/moderationService');

// Connect to the database
connectDB();

// Store active bots with their corresponding agent IDs and updatedAt timestamps
const activeBots = new Map();

// Track bot tokens to prevent duplicates
const activeTokens = new Set();

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
        const botToken = agent.summary.telegram.token;

        // Check if we already have a bot with this token
        if (activeTokens.has(botToken)) {
          console.log(`WARNING: Bot token for ${agent.name} is already in use by another bot. Skipping to prevent conflicts.`);
          continue;
        }

        // Check if we already have this bot running
        const existingBot = activeBots.get(agentId);

        // Determine if we need to launch a new bot or relaunch an existing one
        const shouldLaunchNewBot = !existingBot;
        const shouldRelaunchBot = existingBot && currentUpdatedAt > existingBot.updatedAt;

        if (shouldRelaunchBot) {
          console.log(`Agent ${agent.name} has been modified, relaunching bot...`);
          try {
            // Remove from active tokens set
            activeTokens.delete(botToken);
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

                // Add test command for debugging
                bot.command('test', async (ctx) => {
                  console.log(`TEST command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                  console.log(`Chat type: ${ctx.chat.type}, Chat ID: ${ctx.chat.id}`);
                  await ctx.reply('Test command received! Bot is working.');
                });

                // Special handler just for group commands
                // bot.on(['text'], (ctx) => {
                //   if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
                //     const messageText = ctx.message.text;

                //     // Check if this is a command
                //     if (messageText.startsWith('/')) {
                //       console.log('GROUP COMMAND DETECTED');
                //       console.log(`Group ID: ${ctx.chat.id}, Group Type: ${ctx.chat.type}`);
                //       console.log(`Command text: ${messageText}`);
                //       console.log(`From user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                //       console.log('Full message:', JSON.stringify(ctx.message, null, 2));

                //       // Parse command
                //       const parts = messageText.split(' ');
                //       const command = parts[0].toLowerCase();
                //       const commandName = command.split('@')[0].substring(1);

                //       // Check if directed to this bot
                //       const targetBot = command.includes('@') ? command.split('@')[1] : null;
                //       const botUsername = ctx.botInfo.username;

                //       console.log(`Command: ${commandName}, Target: ${targetBot || 'unspecified'}, My username: ${botUsername}`);

                //       // If command is explicitly for another bot, or not for this bot
                //       if (targetBot && targetBot !== botUsername) {
                //         console.log(`Command is for another bot (${targetBot}), ignoring`);
                //         return;
                //       }

                //       // For debug purposes, let's respond manually to test commands
                //       if (commandName === 'test') {
                //         console.log('Responding to test command in group');
                //         ctx.reply('Group test command received! This is a direct handler response.').catch(err => {
                //           console.error('Error sending test response:', err);
                //         });
                //       }

                //       if (commandName === 'modstatus') {
                //         console.log('Responding to modstatus command in group');
                //         ctx.reply('Moderation status command received through direct handler.').catch(err => {
                //           console.error('Error sending modstatus response:', err);
                //         });
                //       }
                //     }
                //   }
                // });

                // Debug handler for ANY update from Telegram
                bot.use((ctx, next) => {
                  console.log('====== RAW UPDATE RECEIVED ======');
                  console.log(`Update type: ${ctx.updateType}`);
                  console.log(`Chat ID: ${ctx.chat?.id}, Chat Type: ${ctx.chat?.type}`);

                  // Check for message text in any form
                  if (ctx.message?.text) {
                    console.log(`MESSAGE TEXT: "${ctx.message.text}"`);
                  }

                  // Continue to the next middleware
                  return next();
                });

                // Simple message listener to catch ANY text message
                bot.on('text', (ctx) => {
                  console.log('*** TEXT MESSAGE HANDLER TRIGGERED ***');
                  console.log(`From user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                  console.log(`Chat type: ${ctx.chat.type}, Chat ID: ${ctx.chat.id}`);
                  console.log(`Message: "${ctx.message.text}"`);

                  // Test for a specific message to confirm reception
                  if (ctx.message.text.toLowerCase() === 'testing bot') {
                    ctx.reply('I can see your message! Bot is working.').catch(err => {
                      console.error('Error replying to test message:', err);
                    });
                    return;
                  }

                  // Only process for moderation if in a group chat
                  const isGroupChat = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
                  if (isGroupChat) {
                    // Check if moderation is enabled for this agent
                    const shouldModerate = agent.summary?.telegram?.moderation !== false;
                    if (shouldModerate) {
                      console.log(`Processing message for moderation in group ${ctx.chat.id}`);

                      // Skip moderation for admin users
                      ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)
                        .then(member => {
                          // const isAdmin = ['creator', 'administrator'].includes(member.status);
                          // if (isAdmin) {
                          //   console.log(`Skipping moderation for admin user ${ctx.from.id}`);
                          //   return;
                          // }

                          // Process with moderation
                          moderationService.moderateMessage(ctx.message.text, ctx, agent)
                            .then(result => {
                              console.log(`Moderation result: ${JSON.stringify(result)}`);
                            })
                            .catch(error => {
                              console.error('Error in moderation:', error);
                            });
                        })
                        .catch(error => {
                          console.error('Error checking user status:', error);
                        });
                    }
                  }
                });

                // Add moderation-specific commands
                bot.command('modstatus', async (ctx) => {
                  console.log(`Moderation status command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                  // Only chat administrators can use this command
                  try {
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('Only administrators can use this command.');
                    }

                    // Get bot permissions
                    const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);
                    const permissions = {
                      canRestrictMembers: botMember.can_restrict_members,
                      canDeleteMessages: botMember.can_delete_messages,
                      canPinMessages: botMember.can_pin_messages
                    };

                    const statusMessage = `🤖 *Moderation Status*\n\n` +
                      `*Bot Permissions*:\n` +
                      `- Restrict Members: ${permissions.canRestrictMembers ? '✅' : '❌'}\n` +
                      `- Delete Messages: ${permissions.canDeleteMessages ? '✅' : '❌'}\n` +
                      `- Pin Messages: ${permissions.canPinMessages ? '✅' : '❌'}\n\n` +
                      `*Moderation is ${agent.summary.telegram?.moderation ? 'enabled' : 'disabled'}*\n\n` +
                      `Use /modon to enable moderation or /modoff to disable it.`;

                    ctx.replyWithMarkdown(statusMessage);
                  } catch (error) {
                    console.error('Error checking moderation status:', error);
                    ctx.reply('⚠️ An error occurred while checking moderation status.');
                  }
                });

                bot.command('modon', async (ctx) => {
                  console.log(`Moderation ON command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                  // Only chat administrators can use this command
                  try {
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('Only administrators can use this command.');
                    }

                    // Enable moderation for this agent in this chat
                    if (!agent.summary.telegram) {
                      agent.summary.telegram = {};
                    }

                    agent.summary.telegram.moderation = true;
                    await Agent.findByIdAndUpdate(agent._id, {
                      'summary.telegram.moderation': true
                    });

                    ctx.reply('✅ Moderation has been enabled for this group.');
                  } catch (error) {
                    console.error('Error enabling moderation:', error);
                    ctx.reply('⚠️ An error occurred while enabling moderation.');
                  }
                });

                bot.command('modoff', async (ctx) => {
                  console.log(`Moderation OFF command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                  // Only chat administrators can use this command
                  try {
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('Only administrators can use this command.');
                    }

                    // Disable moderation for this agent in this chat
                    if (!agent.summary.telegram) {
                      agent.summary.telegram = {};
                    }

                    agent.summary.telegram.moderation = false;
                    await Agent.findByIdAndUpdate(agent._id, {
                      'summary.telegram.moderation': false
                    });

                    ctx.reply('❌ Moderation has been disabled for this group.');
                  } catch (error) {
                    console.error('Error disabling moderation:', error);
                    ctx.reply('⚠️ An error occurred while disabling moderation.');
                  }
                });

                // Catch-all handler to detect ANY updates
                bot.on('message', (ctx) => {
                  console.log('====== GENERIC MESSAGE RECEIVED ======');
                  console.log(`Update type: ${ctx.updateType}, Chat type: ${ctx.chat.type}`);
                  console.log('Update object:', JSON.stringify(ctx.update, null, 2));
                });

                // Handle text messages
                bot.on(message('text'), async (ctx) => {
                  // Very first line - log that we received something
                  console.log('========= MESSAGE RECEIVED =========');
                  console.log(`CHAT TYPE: ${ctx.chat.type} (${ctx.chat.id}), FROM: ${ctx.from.username || ctx.from.id}`);

                  // Debug raw message for troubleshooting 
                  console.log('Raw message object:', JSON.stringify(ctx.message, null, 2));
                  console.log('Raw update object:', JSON.stringify(ctx.update, null, 2));

                  const userId = ctx.from.id;
                  const messageId = ctx.message.message_id;
                  const messageText = ctx.message.text;
                  const isGroupChat = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

                  console.log(`Message received from ${userId} (${ctx.from.username || 'no username'}): ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
                  console.log(`Chat type: ${ctx.chat.type}, Chat ID: ${ctx.chat.id}, Is group: ${isGroupChat}`);

                  // Check if this is a command
                  if (messageText.startsWith('/')) {
                    const parts = messageText.split(' ');
                    const command = parts[0].toLowerCase();

                    // Strip bot username from command if present
                    const commandName = command.split('@')[0].substring(1);
                    console.log(`Detected command: ${commandName}`);

                    // Let the command handlers work on it
                    return;
                  }

                  // Check for duplicate requests
                  if (isDuplicateRequest(userId, messageId, messageText)) {
                    console.log(`Skipping duplicate message ${messageId} from user ${userId}`);
                    return;
                  }

                  try {
                    // Handle group chats differently - apply moderation if enabled
                    if (isGroupChat) {
                      console.log(`Processing group message from ${ctx.from.username || userId} in ${ctx.chat.title || 'a group'}`);

                      // Check if moderation is enabled for this agent
                      // Default to true if not explicitly set to false
                      const shouldModerate = agent.summary?.telegram?.moderation !== false;
                      console.log(`Moderation enabled for this agent? ${shouldModerate}`);

                      if (shouldModerate) {
                        console.log(`Moderation enabled for group ${ctx.chat.id}, analyzing message...`);

                        // Get bot member to check permissions
                        const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);
                        console.log(`Bot permissions: restrictMembers=${botMember.can_restrict_members}, deleteMessages=${botMember.can_delete_messages}`);

                        // Check if the bot is not an admin, skip moderation
                        if (!botMember.can_restrict_members && !botMember.can_delete_messages) {
                          console.log(`Bot doesn't have moderation permissions in this group`);
                          // Still process the message normally if it's directed to the bot
                          if (messageText.includes(`@${ctx.botInfo.username}`) || ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) {
                            await messageController.processMessage(messageText, ctx, agent);
                          }
                          return;
                        }

                        // Skip moderation for admins
                        const senderMember = await ctx.telegram.getChatMember(ctx.chat.id, userId);
                        const isSenderAdmin = ['creator', 'administrator'].includes(senderMember.status);

                        if (isSenderAdmin) {
                          console.log(`Skipping moderation for admin user ${userId}`);
                          // Still process the message if it's directed to the bot
                          if (messageText.includes(`@${ctx.botInfo.username}`) || ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) {
                            await messageController.processMessage(messageText, ctx, agent);
                          }
                          return;
                        }

                        // Moderate the message
                        console.log(`Sending message to moderation service for analysis`);
                        const moderationResult = await moderationService.moderateMessage(messageText, ctx, agent);

                        console.log(`Moderation result for message ${messageId}: ${JSON.stringify(moderationResult)}`);

                        // If no action required or action was not successful, process the message normally
                        // if directed to the bot
                        if (!moderationResult.actionRequired || !moderationResult.actionTaken) {
                          if (messageText.includes(`@${ctx.botInfo.username}`) || ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) {
                            await messageController.processMessage(messageText, ctx, agent);
                          }
                        }
                      } else {
                        // Moderation not enabled, process as normal if directed to the bot
                        console.log(`Moderation not enabled, processing as normal chat`);
                        if (messageText.includes(`@${ctx.botInfo.username}`) || ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) {
                          await messageController.processMessage(messageText, ctx, agent);
                        }
                      }
                    } else {
                      // Handle private chats normally (no moderation)
                      console.log(`Processing private chat message`);
                      await messageController.processMessage(messageText, ctx, agent);
                    }
                  } catch (error) {
                    console.error('Error processing message:', error);
                    ctx.reply('⚠️ An error occurred while processing your request.');
                  }
                });

                // Register bot commands with BotFather
                bot.telegram.setMyCommands([
                  { command: 'start', description: 'Start the bot' },
                  { command: 'clearmemory', description: 'Clear your conversation history' },
                  { command: 'showmemory', description: 'Show a summary of your conversation history' },
                  { command: 'test', description: 'Test if the bot is working properly' },
                  { command: 'modstatus', description: 'Check moderation status (admin only)' },
                  { command: 'modon', description: 'Enable moderation (admin only)' },
                  { command: 'modoff', description: 'Disable moderation (admin only)' }
                ], { scope: { type: 'all_chat_administrators' } }).catch(error => {
                  console.error('Failed to register admin commands:', error);
                }).then(() => {
                  // Also register for all users
                  return bot.telegram.setMyCommands([
                    { command: 'start', description: 'Start the bot' },
                    { command: 'clearmemory', description: 'Clear your conversation history' },
                    { command: 'showmemory', description: 'Show a summary of your conversation history' },
                    { command: 'test', description: 'Test if the bot is working properly' }
                  ], { scope: { type: 'all_private_chats' } });
                }).then(() => {
                  // Also register for default scope (all users in all chats)
                  return bot.telegram.setMyCommands([
                    { command: 'start', description: 'Start the bot' },
                    { command: 'test', description: 'Test if the bot is working properly' }
                  ]);
                }).then(() => {
                  console.log('Bot commands registered with Telegram');
                }).catch(error => {
                  console.error('Failed to register commands:', error);
                });

                try {
                  // Start the bot
                  console.log('Launching bot...');
                  bot.launch();
                  console.log('Bot launched successfully for agent:', agent.name);

                  // Add token to active tokens set to prevent duplicates
                  activeTokens.add(botToken);

                  // Store the bot in our active bots map
                  activeBots.set(agentId, {
                    bot: bot,
                    updatedAt: currentUpdatedAt,
                    name: agent.name
                  });

                  // Enable graceful stop for this specific bot
                  process.once('SIGINT', () => {
                    console.log('SIGINT received, stopping bot');
                    activeTokens.delete(botToken);
                    bot.stop('SIGINT');
                  });
                  process.once('SIGTERM', () => {
                    console.log('SIGTERM received, stopping bot');
                    activeTokens.delete(botToken);
                    bot.stop('SIGTERM');
                  });
                } catch (error) {
                  console.error('Error starting bot:', error);
                  // Clean up if launch fails
                  activeTokens.delete(botToken);
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
            // Find and remove the token from activeTokens
            let tokenToRemove = null;
            for (const agent of agents) {
              if (agent._id.toString() === agentId) {
                tokenToRemove = agent.summary.telegram.token;
                break;
              }
            }
            if (tokenToRemove) {
              activeTokens.delete(tokenToRemove);
              console.log(`Removed token for deleted agent ${botInfo.name}`);
            }
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
  scheduleAgentUpdates(100);
  console.log('Agent update scheduler initialized');

  // Setup heartbeat mechanism
  setupHeartbeat();
})();