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
const warningService = require('./services/warningService');

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

                // Debug handler for ANY update from Telegram
                bot.use((ctx, next) => {
                  console.log('====== RAW UPDATE RECEIVED ======');
                  console.log(`Update type: ${ctx.updateType}`);
                  console.log(`Chat ID: ${ctx.chat?.id}, Chat Type: ${ctx.chat?.type}`);

                  // Check for message text in any form
                  if (ctx.message?.text) {
                    console.log(`MESSAGE TEXT: "${ctx.message.text}"`);
                  } else if (ctx.channelPost?.text) {
                    console.log(`CHANNEL POST TEXT: "${ctx.channelPost.text}"`);
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

                // Add handler for channel posts
                bot.on('channel_post', async (ctx) => {
                  console.log('*** CHANNEL POST RECEIVED ***');
                  console.log(`Channel ID: ${ctx.chat.id}, Channel title: ${ctx.chat.title || 'Unnamed channel'}`);
                  console.log('Ignoring channel post as bot is not needed for channels');
                  // No processing for channel posts
                });

                // Add handler for edited channel posts
                bot.on('edited_channel_post', async (ctx) => {
                  console.log('*** EDITED CHANNEL POST RECEIVED ***');
                  console.log(`Channel ID: ${ctx.chat.id}, Channel title: ${ctx.chat.title || 'Unnamed channel'}`);
                  console.log('Ignoring edited channel post as bot is not needed for channels');
                  // No processing for edited channel posts
                });

                // Handle forwarded messages in channels and groups
                bot.on('message', (ctx) => {
                  if (ctx.message?.forward_from || ctx.message?.forward_from_chat) {
                    console.log('*** FORWARDED MESSAGE RECEIVED ***');
                    const chatType = ctx.chat.type;
                    const isChannelOrGroup = chatType === 'channel' || chatType === 'group' || chatType === 'supergroup';

                    if (isChannelOrGroup) {
                      console.log(`Forwarded message in ${chatType} chat: ${ctx.chat.id}`);

                      // Skip processing for channels
                      if (chatType === 'channel') {
                        console.log('Ignoring forwarded message in channel as bot is not needed for channels');
                        return;
                      }

                      // First check if the forwarder is an admin for groups and supergroups
                      const checkAdminAndProcess = async () => {
                        // For groups and supergroups, check admin status
                        let isAdmin = false;
                        if (ctx.from) {
                          try {
                            const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                            isAdmin = ['creator', 'administrator'].includes(member.status);
                            console.log(`Forwarded message sender admin status: ${isAdmin ? 'Admin' : 'Not admin'}`);
                          } catch (error) {
                            console.error('Error checking forwarded message sender admin status:', error);
                            // Assume not an admin if we can't verify
                            isAdmin = false;
                          }
                        }

                        // We don't process forwarded messages automatically, only if they mention the bot
                        if (ctx.message.caption && ctx.message.caption.includes(`@${ctx.botInfo.username}`)) {
                          console.log(`Processing forwarded message with caption mentioning the bot`);
                          // Process the caption as the message
                          const messageText = ctx.message.caption.replace(`@${ctx.botInfo.username}`, '').trim();

                          // If it's an admin, always process without moderation
                          if (isAdmin) {
                            console.log(`Forwarded message is from an admin, processing without moderation`);
                          }

                          messageController.processMessage(messageText, ctx, agent).catch(error => {
                            console.error('Error processing forwarded message:', error);
                          });
                        }
                      };

                      // Execute the check and processing
                      checkAdminAndProcess().catch(error => {
                        console.error('Error in forwarded message admin check and processing:', error);
                      });
                    }
                  }
                });

                // Add handler for channel post comments
                bot.on('channel_post_comment', async (ctx) => {
                  console.log('*** CHANNEL COMMENT RECEIVED ***');
                  console.log(`Channel ID: ${ctx.chat.id}, From: ${ctx.from?.username || ctx.from?.id || 'unknown'}`);
                  console.log('Ignoring channel comment as bot is not needed for channels');
                  // No processing for channel post comments
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
                      `*Warning Thresholds*:\n` +
                      `- ${warningService.WARNING_THRESHOLDS.TEMP_MUTE} warnings: 1 hour mute\n` +
                      `- ${warningService.WARNING_THRESHOLDS.KICK} warnings: Removal from group\n` +
                      `- ${warningService.WARNING_THRESHOLDS.BAN} warnings: Permanent ban\n\n` +
                      `Use /modon to enable moderation or /modoff to disable it.\n` +
                      `Use /warnings to check warnings for users.`;

                    ctx.replyWithMarkdown(statusMessage);
                  } catch (error) {
                    console.error('Error checking moderation status:', error);
                    ctx.reply('⚠️ An error occurred while checking moderation status.');
                  }
                });

                // Add a command to check warnings
                bot.command('warnings', async (ctx) => {
                  console.log(`Warnings command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);

                  // Get parameters
                  const args = ctx.message.text.split(' ');

                  try {
                    // Check if user is an admin
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('Only administrators can use this command.');
                    }

                    // If no user specified, show help
                    if (args.length < 2) {
                      return ctx.reply('Usage: /warnings <user_id_or_username> - Check warnings for a user\nExample: /warnings @username');
                    }

                    // Get target user
                    let targetUser = args[1];
                    let targetUserId = null;

                    // Check if it's a username or reply
                    if (targetUser.startsWith('@')) {
                      // Handle username
                      const username = targetUser.substring(1);

                      // Try to find user in the chat
                      try {
                        // This is a limitation - we need the actual user ID, but Telegram doesn't provide
                        // a direct way to get user ID from username. We'll ask for user ID instead.
                        return ctx.reply(`Please use user ID instead of username for now.\nTo get the user ID, you can use a bot like @userinfobot.`);
                      } catch (error) {
                        console.error('Error finding user by username:', error);
                        return ctx.reply(`Could not find user with username ${targetUser} in this chat.`);
                      }
                    } else if (ctx.message.reply_to_message) {
                      // If replying to a message, use that user
                      targetUserId = ctx.message.reply_to_message.from.id.toString();
                    } else {
                      // Assume it's a user ID
                      targetUserId = targetUser;
                    }

                    // Get warnings for the user
                    const warningInfo = await warningService.getWarningInfo(targetUserId, ctx.chat.id.toString());

                    if (!warningInfo || warningInfo.warningCount === 0) {
                      return ctx.reply(`No warnings found for this user.`);
                    }

                    // Format warning information
                    let warningMessage = `*Warning Information*\n\n`;
                    warningMessage += `User ID: \`${warningInfo.userId}\`\n`;
                    if (warningInfo.username) {
                      warningMessage += `Username: @${warningInfo.username}\n`;
                    }
                    warningMessage += `Warning Count: ${warningInfo.warningCount}/${warningService.WARNING_THRESHOLDS.BAN}\n`;
                    warningMessage += `Last Warning: ${warningInfo.lastWarningDate ? new Date(warningInfo.lastWarningDate).toLocaleString() : 'N/A'}\n\n`;

                    if (warningInfo.isBanned) {
                      warningMessage += `*Status: BANNED*\n`;
                      warningMessage += `Ban Date: ${warningInfo.banDate ? new Date(warningInfo.banDate).toLocaleString() : 'N/A'}\n`;
                      warningMessage += `Ban Reason: ${warningInfo.banReason || 'No reason provided'}\n\n`;
                    }

                    // Show recent warnings
                    if (warningInfo.recentWarnings && warningInfo.recentWarnings.length > 0) {
                      warningMessage += `*Recent Warnings:*\n`;

                      warningInfo.recentWarnings.forEach((warning, index) => {
                        const date = new Date(warning.timestamp).toLocaleString();
                        warningMessage += `${index + 1}. ${warning.reason} (${date})\n`;
                      });
                    }

                    // Add actions that can be taken
                    warningMessage += `\nUse /clearwarnings ${targetUserId} to clear all warnings for this user.`;

                    // Send the message
                    ctx.replyWithMarkdown(warningMessage);
                  } catch (error) {
                    console.error('Error checking warnings:', error);
                    ctx.reply('⚠️ An error occurred while checking warnings.');
                  }
                });

                // Add a command to clear warnings for a user
                bot.command('clearwarnings', async (ctx) => {
                  console.log(`Clear warnings command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);

                  // Get parameters
                  const args = ctx.message.text.split(' ');

                  try {
                    // Check if user is an admin
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('Only administrators can use this command.');
                    }

                    // If no user specified, show help
                    if (args.length < 2) {
                      return ctx.reply('Usage: /clearwarnings <user_id> - Clear all warnings for a user');
                    }

                    // Get target user ID
                    const targetUserId = args[1];

                    // Clear warnings
                    const result = await warningService.clearWarnings(targetUserId, ctx.chat.id.toString());

                    if (result) {
                      ctx.reply(`✅ All warnings have been cleared for user ID: ${targetUserId}`);
                    } else {
                      ctx.reply(`No warnings found for user ID: ${targetUserId}`);
                    }
                  } catch (error) {
                    console.error('Error clearing warnings:', error);
                    ctx.reply('⚠️ An error occurred while clearing warnings.');
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
                  const isChannelChat = ctx.chat.type === 'channel';
                  // Check if this is a reply to the bot's message
                  const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.botInfo.id;
                  // Check if the bot is mentioned
                  const isBotMentioned = messageText.includes(`@${ctx.botInfo.username}`);

                  console.log(`Message received from ${userId} (${ctx.from.username || 'no username'}): ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
                  console.log(`Chat type: ${ctx.chat.type}, Chat ID: ${ctx.chat.id}, Is group: ${isGroupChat}, Is channel: ${isChannelChat}`);
                  console.log(`Is reply to bot: ${isReplyToBot}, Is bot mentioned: ${isBotMentioned}`);

                  // Skip processing for channels
                  if (isChannelChat) {
                    console.log('Ignoring message in channel as bot is not needed for channels');
                    return;
                  }

                  // Check if this is a command
                  if (messageText.startsWith('/')) {
                    const parts = messageText.split(' ');
                    const command = parts[0].toLowerCase();

                    // Strip bot username from command if present
                    const commandName = command.split('@')[0].substring(1);
                    console.log(`Detected command: ${commandName}`);

                    // Check if the command is directed to another bot
                    if (command.includes('@')) {
                      const targetBot = command.split('@')[1];
                      if (targetBot !== ctx.botInfo.username) {
                        console.log(`Command is targeted at another bot (@${targetBot}), ignoring`);
                        return;
                      }
                    }

                    // Let the command handlers work on it
                    return;
                  }

                  // Check for duplicate requests
                  if (isDuplicateRequest(userId, messageId, messageText)) {
                    console.log(`Skipping duplicate message ${messageId} from user ${userId}`);
                    return;
                  }

                  try {
                    // First check if the user is an admin in group/channel scenarios
                    let isUserAdmin = false;

                    if (isGroupChat) {
                      try {
                        const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
                        isUserAdmin = ['creator', 'administrator'].includes(member.status);
                        console.log(`User ${userId} admin status: ${isUserAdmin ? 'Admin' : 'Not admin'}`);
                      } catch (error) {
                        console.error(`Error checking admin status for user ${userId}:`, error);
                        // Default to not an admin if we can't verify
                        isUserAdmin = false;
                      }
                    }

                    // Handle group chats differently - apply moderation if enabled
                    if (isGroupChat) {
                      console.log(`Processing group message from ${ctx.from.username || userId} in ${ctx.chat.title || 'a group'}`);

                      // Only respond in groups if the bot is mentioned or replied to
                      const shouldProcessInGroup = isBotMentioned || isReplyToBot;

                      if (!shouldProcessInGroup) {
                        console.log('Message in group does not mention or reply to the bot, ignoring');
                        return;
                      }

                      // Remove the bot mention from the text if present
                      let cleanMessageText = messageText;
                      if (isBotMentioned) {
                        cleanMessageText = messageText.replace(`@${ctx.botInfo.username}`, '').trim();
                      }

                      // If user is an admin, always process without moderation
                      if (isUserAdmin) {
                        console.log(`User ${userId} is an admin, processing message without moderation`);
                        await messageController.processMessage(cleanMessageText, ctx, agent);
                        return;
                      }

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
                          // Process the message since it's directed to the bot
                          await messageController.processMessage(cleanMessageText, ctx, agent);
                          return;
                        }

                        // No need to check admin status again since we did it above

                        // Moderate the message
                        console.log(`Sending message to moderation service for analysis`);
                        const moderationResult = await moderationService.moderateMessage(messageText, ctx, agent);

                        console.log(`Moderation result for message ${messageId}: ${JSON.stringify(moderationResult)}`);

                        // If no action required or action was not successful, process the message
                        if (!moderationResult.actionRequired || !moderationResult.actionTaken) {
                          await messageController.processMessage(cleanMessageText, ctx, agent);
                        }
                      } else {
                        // Moderation not enabled, process as normal since it's directed to the bot
                        console.log(`Moderation not enabled, processing as normal group chat`);
                        await messageController.processMessage(cleanMessageText, ctx, agent);
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
                  { command: 'warnings', description: 'Check warnings for a user (admin only)' },
                  { command: 'clearwarnings', description: 'Clear warnings for a user (admin only)' },
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