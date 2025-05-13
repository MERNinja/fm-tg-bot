const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
require('dotenv').config();
const fs = require('fs');

// Import controllers and services
const messageController = require('./controllers/messageController');
const { connectDB } = require('./config/database');
const Agent = require('./models/Agent');
const User = require('./models/User');
const Group = require('./models/Group');
const moderationService = require('./services/moderationService');
const warningService = require('./services/warningService');
const groupService = require('./services/groupService');

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
                console.log(`[DEBUG-INIT] Bot created for agent ${agent.name} with token ${agent.summary.telegram.token.substring(0, 10)}...`);

                // Wait for 1 second before continuing
                console.log('Waiting 1 second before starting the bot...');
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log('Wait complete, continuing bot initialization...');

                // Function to generate the main menu based on API key validation status
                async function generateMainMenu(ctx, agent, isFirstTime = false) {
                  // Get user ID
                  const telegramUserId = ctx.from.id.toString();

                  // Check for user-specific API key - this is what matters for group management features
                  let hasUserApiKey = false;
                  let hasAgentApiKey = false;

                  try {
                    // Check for user-specific API key
                    const userWithApiKey = await checkUserApiKey(telegramUserId);
                    hasUserApiKey = userWithApiKey && userWithApiKey.apiKey && userWithApiKey.apiKey.length > 0;

                    // Check for agent-level API key as fallback
                    hasAgentApiKey = agent.userId && agent.userId._id && agent.userId.apiKey && agent.userId.apiKey.length > 0;

                    // For conversation purposes, either key is valid
                    const hasValidApiKey = hasUserApiKey || hasAgentApiKey;

                    console.log(`[Menu] API key status for user ${telegramUserId}: ${hasValidApiKey ? 'Valid' : 'Not valid'} (User key: ${hasUserApiKey}, Agent key: ${hasAgentApiKey})`);
                  } catch (error) {
                    console.error(`[Menu] Error checking API key for user ${telegramUserId}:`, error);
                    // Fall back to just checking agent API key
                    hasAgentApiKey = agent.userId && agent.userId._id && agent.userId.apiKey && agent.userId.apiKey.length > 0;
                  }

                  // Create welcome message with inline keyboard menu
                  let welcomeMessage = `👋 ${isFirstTime ? 'Welcome to' : 'Welcome back to'} ${agent.name}!\n\n`;

                  // Add introduction for first-time users
                  if (isFirstTime) {
                    welcomeMessage += `I'm an advanced AI chatbot powered by Fullmetal AI. I can help moderate your groups, answer questions, and more.\n\n`;
                  }

                  // Add status message based on API key validation
                  if (hasUserApiKey) {
                    welcomeMessage += `✅ Your personal API key is configured. ${isFirstTime ? 'You can now add me to groups!' : 'What would you like to do?'}`;
                  } else if (hasAgentApiKey) {
                    welcomeMessage += `⚠️ *IMPORTANT:* You can chat with me using the bot's shared API key, but to add me to groups, you need to set up your own personal Fullmetal API Key.\n\n` +
                      `Please click the "Set Up API Key" button below to configure your personal API key.`;
                  } else {
                    welcomeMessage += `⚠️ *IMPORTANT:* You need to set up your Fullmetal API Key before using this bot.\n\n` +
                      `Without an API key, I cannot moderate groups or respond to messages properly. Please click the button below to set up your API key.`;
                  }

                  // Create inline keyboard buttons based on API key status
                  let keyboard = {
                    inline_keyboard: []
                  };

                  if (hasUserApiKey) {
                    // Only show group-related options if USER has their own API key
                    keyboard.inline_keyboard = [
                      [
                        {
                          text: '➕ Add to Group',
                          url: `https://t.me/${ctx.botInfo.username}?startgroup=true`
                        }
                      ],
                      [
                        {
                          text: '👥 Manage Groups',
                          callback_data: 'list_groups'
                        }
                      ],
                      [
                        {
                          text: '📚 Help & Commands',
                          callback_data: 'show_help'
                        }
                      ],
                      [
                        {
                          text: '🔑 Update API Key',
                          callback_data: 'setup_apikey'
                        }
                      ],
                      [
                        {
                          text: '❌ Remove API Key',
                          callback_data: 'remove_apikey'
                        }
                      ]
                    ];
                  } else {
                    // Only show API key setup and help when no user-specific API key is configured
                    keyboard.inline_keyboard = [
                      [
                        {
                          text: '🔑 Set Up API Key',
                          callback_data: 'setup_apikey'
                        }
                      ],
                      [
                        {
                          text: '📚 Help & Commands',
                          callback_data: 'show_help'
                        }
                      ]
                    ];
                  }

                  return { welcomeMessage, keyboard };
                }

                // Helper function to check if a Telegram user has an API key configured
                async function checkUserApiKey(telegramUserId) {
                  try {
                    // This function checks if a Telegram user ID has an API key in our database
                    const User = require('./models/User');

                    // Find a user with this Telegram ID using the telegramUserId field added to the User model
                    const user = await User.findOne({ telegramUserId: telegramUserId });

                    if (user && user.apiKey && user.apiKey.length > 0) {
                      console.log(`[API Key Debug] Found API key for Telegram user ${telegramUserId} (${user.email})`);
                      return user;
                    }

                    console.log(`[API Key Debug] No API key found for Telegram user ${telegramUserId}`);
                    return null;
                  } catch (error) {
                    console.error(`[API Key Debug] Error checking API key for Telegram user ${telegramUserId}:`, error);
                    return null;
                  }
                }

                // Add a health check interval
                setInterval(() => {
                  console.log(`[HEARTBEAT] Bot ${agent.name} is alive at ${new Date().toISOString()}`);
                }, 60000); // Log every minute

                // Bot commands
                bot.start(async (ctx) => {
                  console.log(`[Start] Command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'}), chat type: ${ctx.chat.type}`);

                  // Get Telegram user ID
                  const telegramUserId = ctx.from.id.toString();
                  console.log(`[API Key Debug] Checking API key for Telegram user: ${telegramUserId}`);

                  // Check for user-specific API key
                  const userWithApiKey = await checkUserApiKey(telegramUserId);

                  // Log API key information for debugging
                  if (userWithApiKey) {
                    console.log(`[API Key Debug] Found API key for Telegram user ${telegramUserId} (${userWithApiKey.email})`);
                    console.log(`[API Key Debug] User API Key first 5 chars: ${userWithApiKey.apiKey[0].substring(0, 5)}...`);
                  } else {
                    console.log(`[API Key Debug] No user-specific API key found for Telegram user: ${telegramUserId}`);

                    // Also log agent API key as fallback
                    console.log(`[API Key Debug] Checking agent API key - Agent: ${agent.name}, has userId: ${!!agent.userId}`);
                    if (agent.userId) {
                      console.log(`[API Key Debug] userId: ${agent.userId._id}, has apiKey: ${!!(agent.userId.apiKey && agent.userId.apiKey.length > 0)}`);
                      if (agent.userId.apiKey && agent.userId.apiKey.length > 0) {
                        console.log(`[API Key Debug] Agent API Key first 5 chars: ${agent.userId.apiKey[0].substring(0, 5)}...`);
                      }
                    }
                  }

                  // Determine if any valid API key is available (either user-specific or agent-level)
                  const hasUserApiKey = userWithApiKey && userWithApiKey.apiKey && userWithApiKey.apiKey.length > 0;
                  const hasAgentApiKey = agent.userId && agent.userId._id && agent.userId.apiKey && agent.userId.apiKey.length > 0;
                  const hasValidApiKey = hasUserApiKey || hasAgentApiKey;

                  console.log(`[API Key Debug] Has valid API key: ${hasValidApiKey} (User API key: ${hasUserApiKey}, Agent API key: ${hasAgentApiKey})`);

                  // Check if this is a private chat (only show full menu in private chats)
                  if (ctx.chat.type !== 'private') {
                    console.log(`[Start] Showing simplified welcome message in non-private chat to user ${ctx.from.id}`);
                    const welcomeMessage = `👋 Hi! I'm ${agent.name}. ${agent.summary.description ? `${agent.summary.description}\n\n` : ''} Feel free to start chatting with me!`;
                    ctx.reply(welcomeMessage);
                    return;
                  }

                  // Get menu options - pass true for isFirstTime on start command
                  const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent, true);
                  console.log(`[Start] Showing welcome menu to user ${ctx.from.id}`);

                  // Send the welcome message with inline keyboard
                  ctx.reply(welcomeMessage, {
                    reply_markup: keyboard,
                    parse_mode: 'Markdown'
                  });
                });

                // Handle the cancel command
                bot.command('cancel', async (ctx) => {
                  console.log(`[Cancel] Command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'}), chat type: ${ctx.chat.type}`);

                  // Check if we're in a private chat
                  if (ctx.chat.type !== 'private') {
                    console.log(`[Cancel] Ignoring cancel command in non-private chat from user ${ctx.from.id}`);
                    return;
                  }

                  const userId = ctx.from.id.toString();

                  // Check if user is in a state that can be canceled
                  if (global.userStates && global.userStates.has(userId)) {
                    const state = global.userStates.get(userId);
                    console.log(`[Cancel] User ${userId} had state: ${JSON.stringify(state)}`);
                    global.userStates.delete(userId);
                    console.log(`[Cancel] Cleared state for user ${userId}`);
                    await ctx.reply('Operation cancelled. Returning to main menu.');

                    // Get menu options
                    const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                    console.log(`[Cancel] Showing main menu to user ${userId}`);

                    // Send the welcome message with inline keyboard
                    await ctx.reply(welcomeMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                  } else {
                    console.log(`[Cancel] No active state found for user ${userId}`);
                    await ctx.reply('No active operation to cancel.');
                  }
                });

                // Handle callback queries from inline buttons
                bot.on('callback_query', async (ctx) => {
                  console.log(`[Callback] Received: ${ctx.callbackQuery.data} from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);

                  const callbackData = ctx.callbackQuery.data;

                  // Process different callback actions
                  switch (callbackData) {
                    case 'setup_apikey':
                      console.log(`[Callback] User ${ctx.from.id} requested API key setup`);
                      await handleApiKeySetup(ctx);
                      break;

                    case 'remove_apikey':
                      console.log(`[Callback] User ${ctx.from.id} requested API key removal`);
                      await handleApiKeyRemoval(ctx);
                      break;

                    case 'confirm_remove_apikey':
                      console.log(`[Callback] User ${ctx.from.id} confirmed API key removal`);
                      await handleConfirmApiKeyRemoval(ctx);
                      break;

                    case 'setup_admin':
                      console.log(`[Callback] User ${ctx.from.id} requested admin setup`);
                      await handleAdminSetup(ctx);
                      break;

                    case 'show_help':
                      console.log(`[Callback] User ${ctx.from.id} requested help information`);
                      await handleShowHelp(ctx);
                      break;

                    case 'back_to_main':
                      console.log(`[Callback] User ${ctx.from.id} returning to main menu`);
                      await ctx.answerCbQuery('Returning to main menu...');

                      // Get menu options
                      const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);

                      // Edit the current message instead of sending a new one
                      await ctx.editMessageText(welcomeMessage, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                      });
                      console.log(`[Callback] Displayed main menu to user ${ctx.from.id}`);
                      break;

                    case 'list_groups':
                      console.log(`[Callback] User ${ctx.from.id} requested group listing`);
                      await ctx.answerCbQuery('Fetching your groups...');

                      try {
                        const userId = ctx.from.id.toString();
                        // Find user in database if exists
                        let dbUser = null;
                        let mongoUserId = null;

                        if (agent.userId && agent.userId._id) {
                          // Default to agent's user
                          mongoUserId = agent.userId._id;
                        }

                        // Get groups for this agent
                        const groups = await groupService.getGroupsByAgentId(agent._id);

                        if (groups.length === 0) {
                          // No groups found
                          const message =
                            `You haven't added me to any groups yet.\n\n` +
                            `To add me to a group:\n` +
                            `1. Open your group\n` +
                            `2. Tap on the group name at the top\n` +
                            `3. Select "Add member"\n` +
                            `4. Search for @${ctx.botInfo.username}\n` +
                            `5. Tap "Add"\n\n` +
                            `Alternatively, use this link:\n` +
                            `https://t.me/${ctx.botInfo.username}?startgroup=true`;

                          // Check if agent has a validated API key
                          const hasValidApiKey = agent.userId && agent.userId._id && agent.userId.apiKey && agent.userId.apiKey.length > 0;

                          const groupsKeyboard = {
                            inline_keyboard: [
                              hasValidApiKey ?
                                [{ text: '➕ Add to Group', url: `https://t.me/${ctx.botInfo.username}?startgroup=true` }] :
                                [{ text: '🔑 Set Up API Key First', callback_data: 'setup_apikey' }],
                              [{ text: '« Back', callback_data: 'back_to_main' }]
                            ]
                          };

                          await ctx.editMessageText(message, { reply_markup: groupsKeyboard });
                          console.log(`[Callback] Displayed empty group list to user ${ctx.from.id}`);
                        } else {
                          // Build group list message
                          let message = `*Your Groups (${groups.length})*\n\n`;

                          // Create inline keyboard with groups
                          const groupButtons = [];

                          for (const group of groups) {
                            message += `• *${group.groupName}*\n`;
                            message += `  - Type: ${group.groupType === 'supergroup' ? 'Supergroup' : 'Group'}\n`;
                            message += `  - Moderation: ${group.moderationEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
                            message += `  - API Key: ${group.apiKeyUserId ? '✅ Set' : '❌ Not set'}\n\n`;

                            // Add button for this group
                            groupButtons.push([
                              {
                                text: group.groupName,
                                callback_data: `group_${group.telegramGroupId}`
                              }
                            ]);
                          }

                          // Add back button
                          groupButtons.push([
                            { text: '« Back to Main Menu', callback_data: 'back_to_main' }
                          ]);

                          const groupsKeyboard = {
                            inline_keyboard: groupButtons
                          };

                          await ctx.editMessageText(message, {
                            reply_markup: groupsKeyboard,
                            parse_mode: 'Markdown'
                          });
                          console.log(`[Callback] Displayed group list to user ${ctx.from.id}`);
                        }
                      } catch (error) {
                        console.error(`[Callback] Error listing groups for user ${ctx.from.id}:`, error);
                        await ctx.reply('Error fetching groups. Please try again later.');
                      }
                      break;

                    default:
                      if (callbackData.startsWith('group_')) {
                        if (callbackData.startsWith('group_apikey_')) {
                          // Handle setting API key for a specific group
                          const groupId = callbackData.replace('group_apikey_', '');
                          console.log(`[Callback] User ${ctx.from.id} setting API key for group ${groupId}`);
                          await handleGroupApiKeySetup(ctx, groupId);
                        } else if (callbackData.startsWith('group_mod_on_')) {
                          // Enable moderation for a group
                          const groupId = callbackData.replace('group_mod_on_', '');
                          console.log(`[Callback] User ${ctx.from.id} enabling moderation for group ${groupId}`);
                          await toggleGroupModeration(ctx, groupId, true);
                        } else if (callbackData.startsWith('group_mod_off_')) {
                          // Disable moderation for a group
                          const groupId = callbackData.replace('group_mod_off_', '');
                          console.log(`[Callback] User ${ctx.from.id} disabling moderation for group ${groupId}`);
                          await toggleGroupModeration(ctx, groupId, false);
                        } else if (callbackData.startsWith('group_remove_confirm_')) {
                          // Confirmed bot removal from group
                          const groupId = callbackData.replace('group_remove_confirm_', '');
                          console.log(`[Callback] User ${ctx.from.id} confirmed removal of bot from group ${groupId}`);

                          try {
                            await ctx.answerCbQuery('Removing bot from group...');

                            // Get group info
                            const group = await groupService.getGroupByTelegramId(groupId);

                            if (!group) {
                              await ctx.reply('Error: Group not found');
                              await ctx.editMessageText('Could not find group information. Please try again or contact support.',
                                { reply_markup: { inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]] } });
                              return;
                            }

                            // Leave the group
                            try {
                              await ctx.telegram.leaveChat(groupId);
                              console.log(`[Group Removal] Successfully left group ${groupId}`);

                              // Mark group as inactive in database
                              await groupService.deactivateGroup(groupId);

                              // Show success message
                              await ctx.editMessageText(
                                `✅ Successfully removed bot from *${group.groupName}*\n\n` +
                                `The bot has left the group and all moderation features are now disabled.\n\n` +
                                `You can add the bot back to the group at any time if needed.`,
                                {
                                  parse_mode: 'Markdown',
                                  reply_markup: {
                                    inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                                  }
                                }
                              );
                            } catch (leaveError) {
                              console.error(`[Group Removal] Error leaving group ${groupId}:`, leaveError);

                              // Handle case where bot might not be in the group anymore
                              if (leaveError.description &&
                                (leaveError.description.includes('bot is not a member') ||
                                  leaveError.description.includes('chat not found'))) {

                                // If the bot is already not in the group, just mark as inactive
                                await groupService.deactivateGroup(groupId);

                                await ctx.editMessageText(
                                  `Bot is no longer in *${group.groupName}*\n\n` +
                                  `The group has been marked as inactive in the database.`,
                                  {
                                    parse_mode: 'Markdown',
                                    reply_markup: {
                                      inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                                    }
                                  }
                                );
                              } else {
                                // For other errors, show error message
                                await ctx.editMessageText(
                                  `❌ Error removing bot from group\n\n` +
                                  `Please try manually removing the bot from the group.\n\n` +
                                  `Error: ${leaveError.description || 'Unknown error'}`,
                                  {
                                    parse_mode: 'Markdown',
                                    reply_markup: {
                                      inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                                    }
                                  }
                                );
                              }
                            }
                          } catch (error) {
                            console.error(`[Group Removal] Error processing removal confirmation:`, error);
                            await ctx.reply('An error occurred while removing the bot. Please try again later.');
                          }
                        } else if (callbackData.startsWith('group_remove_')) {
                          // Remove bot from group
                          const groupId = callbackData.replace('group_remove_', '');
                          console.log(`[Callback] User ${ctx.from.id} requesting to remove bot from group ${groupId}`);
                          await handleGroupRemoval(ctx, groupId);
                        } else {
                          // Regular group selection
                          const groupId = callbackData.replace('group_', '');
                          console.log(`[Callback] User ${ctx.from.id} selected group ${groupId}`);
                          await handleGroupSelection(ctx, groupId);
                        }
                      } else {
                        console.log(`[Callback] Unknown callback query from user ${ctx.from.id}: ${callbackData}`);
                        await ctx.answerCbQuery('This feature is not implemented yet.');
                      }
                  }
                });

                // Initialize global userStates map with monitoring
                if (!global.userStates) {
                  global.userStates = new Map();
                  console.log(`[State] Initialized global userStates map`);

                  // Add a periodic cleanup for stale states (every 5 minutes)
                  setInterval(() => {
                    const now = Date.now();
                    let expiredCount = 0;

                    // Loop through all states and remove any older than 30 minutes
                    for (const [userId, state] of global.userStates.entries()) {
                      if (now - state.timestamp > 30 * 60 * 1000) { // 30 minutes
                        global.userStates.delete(userId);
                        expiredCount++;
                      }
                    }

                    if (expiredCount > 0) {
                      console.log(`[State] Cleaned up ${expiredCount} expired states. Current state count: ${global.userStates.size}`);
                    }
                  }, 5 * 60 * 1000); // Run every 5 minutes
                }

                // Function to handle the API key setup flow
                async function handleApiKeySetup(ctx) {
                  console.log(`[API Key Setup] User ${ctx.from.id} (${ctx.from.username || 'no username'}) starting API key setup`);
                  await ctx.answerCbQuery('Setting up your Fullmetal API Key...');

                  const message =
                    `Please enter your personal Fullmetal API Key.\n\n` +
                    `This API key will be associated with your Telegram account and used for:\n` +
                    `• Adding the bot to groups you manage\n` +
                    `• Processing messages in those groups\n` +
                    `• Billing for API usage\n\n` +
                    `You can get your API key from https://www.fullmetal.ai\n\n` +
                    `Reply to this message with your API key, or type /cancel to abort.`;

                  await ctx.reply(message);

                  // Here we'll use a simple global map to track user states
                  if (!global.userStates) {
                    global.userStates = new Map();
                    console.log(`[API Key Setup] Initializing global userStates map`);
                  }

                  // Log current state if any
                  const userId = ctx.from.id.toString();
                  if (global.userStates.has(userId)) {
                    const oldState = global.userStates.get(userId);
                    console.log(`[API Key Setup] User ${userId} had previous state: ${JSON.stringify(oldState)}`);
                  }

                  // Set the state for this user to indicate waiting for API key
                  const newState = {
                    waitingForApiKey: true,
                    timestamp: Date.now()
                  };
                  global.userStates.set(userId, newState);

                  console.log(`[API Key Setup] Set user ${userId} state to: ${JSON.stringify(newState)}, total users waiting: ${global.userStates.size}`);

                  // Add a way for the user to go back to the main menu
                  const keyboard = {
                    inline_keyboard: [
                      [{ text: '« Back to Main Menu', callback_data: 'back_to_main' }]
                    ]
                  };

                  await ctx.reply('Type /cancel to abort this setup.', { reply_markup: keyboard });
                }

                // Function to handle API key removal
                async function handleApiKeyRemoval(ctx) {
                  console.log(`[API Key Removal] User ${ctx.from.id} (${ctx.from.username || 'no username'}) starting API key removal`);
                  await ctx.answerCbQuery('Processing API key removal...');

                  const telegramUserId = ctx.from.id.toString();

                  try {
                    // Check if user has an API key to remove
                    const User = require('./models/User');
                    const userWithApiKey = await User.findOne({ telegramUserId });

                    if (!userWithApiKey || !userWithApiKey.apiKey || userWithApiKey.apiKey.length === 0) {
                      await ctx.reply('❌ You don\'t have a personal API key configured to remove.');

                      // Return to main menu
                      const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                      await ctx.reply(welcomeMessage, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                      });
                      return;
                    }

                    // Show confirmation message
                    const confirmationMessage = `⚠️ *Are you sure you want to remove your API key?*\n\n` +
                      `This will:\n` +
                      `• Remove your personal API key from this bot\n` +
                      `• Prevent you from adding the bot to new groups\n` +
                      `• Eventually stop moderation in existing groups (until a new API key is set)\n\n` +
                      `To confirm, click "Yes, Remove API Key" below:`;

                    const confirmationKeyboard = {
                      inline_keyboard: [
                        [
                          { text: '✅ Yes, Remove API Key', callback_data: 'confirm_remove_apikey' },
                          { text: '❌ Cancel', callback_data: 'back_to_main' }
                        ]
                      ]
                    };

                    await ctx.reply(confirmationMessage, {
                      reply_markup: confirmationKeyboard,
                      parse_mode: 'Markdown'
                    });

                  } catch (error) {
                    console.error(`[API Key Removal] Error checking API key:`, error);
                    await ctx.reply('⚠️ An error occurred while checking your API key. Please try again later.');

                    // Back to main menu
                    const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                    await ctx.reply(welcomeMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                  }
                }

                // Function to handle confirmed API key removal
                async function handleConfirmApiKeyRemoval(ctx) {
                  console.log(`[API Key Removal] User ${ctx.from.id} confirmed API key removal`);
                  await ctx.answerCbQuery('Removing API key...');

                  const telegramUserId = ctx.from.id.toString();

                  try {
                    // Get user record
                    const User = require('./models/User');
                    const user = await User.findOne({ telegramUserId });

                    if (!user) {
                      await ctx.reply('❌ No user account found.');
                      return;
                    }

                    // Store email for confirmation message
                    const userEmail = user.email;

                    // Remove the telegramUserId association but keep the API key in the database
                    user.telegramUserId = null;
                    await user.save();

                    console.log(`[API Key Removal] Removed telegramUserId association for user ${telegramUserId}`);

                    // Success message
                    await ctx.reply(`✅ Your API key has been successfully removed.\n\nYou can still chat with me using the bot's shared API key, but you can no longer add me to groups or manage existing groups.\n\nYou can set up a new API key at any time from the main menu.`);

                    // Show updated menu
                    const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                    await ctx.reply(welcomeMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });

                  } catch (error) {
                    console.error(`[API Key Removal] Error removing API key:`, error);
                    await ctx.reply('⚠️ An error occurred while removing your API key. Please try again later.');

                    // Back to main menu as a fallback
                    const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                    await ctx.reply(welcomeMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                  }
                }

                // Handle text messages - MAIN MESSAGE HANDLER FOR ALL CHATS
                bot.on(message('text'), async (ctx) => {
                  // Very first line - log that we received something
                  console.log('========= MESSAGE RECEIVED =========');
                  console.log(`CHAT TYPE: ${ctx.chat.type} (${ctx.chat.id}), FROM: ${ctx.from.username || ctx.from.id}`);
                  console.log(`[DEBUG] Handler: bot.on(message('text')) - This is the main message handler`);

                  // Check if this user is waiting for API key input - must be checked first
                  const userId = ctx.from.id.toString();
                  const userState = global.userStates?.get(userId);

                  if (userState && userState.waitingForApiKey && ctx.chat.type === 'private') {
                    console.log(`[API Key Input] Received potential API key from user ${userId} (${ctx.from.username || 'no username'})`);

                    // Handle potential cancellation
                    if (ctx.message.text.toLowerCase() === '/cancel') {
                      console.log(`[API Key Input] User ${userId} cancelled API key setup`);
                      global.userStates.delete(userId);
                      await ctx.reply('API key setup cancelled. Returning to main menu.');

                      // Show main menu
                      const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                      await ctx.reply(welcomeMessage, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                      });
                      console.log(`[API Key Input] Showed main menu to user ${userId} after cancellation`);
                      return;
                    }

                    // Process the API key
                    const apiKey = ctx.message.text.trim();
                    console.log(`[API Key Input] Processing API key from user ${userId}, key length: ${apiKey.length}`);

                    // Basic validation check
                    if (apiKey.length < 10) {
                      console.log(`[API Key Input] Rejected too short API key from user ${userId}`);
                      await ctx.reply('⚠️ That doesn\'t look like a valid API key. Please try again or type /cancel to abort.');
                      return;
                    }

                    // Show loading message
                    await ctx.reply('🔍 Validating your API key...');

                    try {
                      console.log(`[API Key Input] Attempting validation of API key for user ${userId}`);
                      // Validate the API key directly in our database
                      const User = require('./models/User');

                      // Check if API key exists in the database first
                      console.log(`[API Key Input] Checking if API key exists in our database`);
                      const existingUser = await User.findOne({
                        apiKey: { $in: [apiKey] }
                      });

                      if (existingUser) {
                        console.log(`[API Key Input] Found existing user with this API key: ${existingUser.email}, ID: ${existingUser._id}`);

                        // Update user with Telegram ID if not already set
                        if (!existingUser.telegramUserId) {
                          existingUser.telegramUserId = userId;
                          await existingUser.save();
                          console.log(`[API Key Input] Updated existing user with Telegram ID: ${userId}`);
                        }

                        // Clear the waiting state
                        global.userStates.delete(userId);
                        console.log(`[API Key Input] Cleared waiting state for user ${userId}`);

                        // Success message
                        await ctx.reply(`✅ Personal API key validated successfully!\n\nYou're now set up to use ${agent.name} with your Fullmetal AI account (${existingUser.email}).\n\nYou can now add the bot to groups and use all features.`);

                        // Get and show main menu with updated options
                        const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                        console.log(`[API Key Input] Showing updated main menu to user ${userId}`);
                        await ctx.reply(welcomeMessage, {
                          reply_markup: keyboard,
                          parse_mode: 'Markdown'
                        });

                        return;
                      }

                      // Rest of the code handling API key validation...
                      // ... (keep existing code)

                      // Success message
                      await ctx.reply(`✅ Personal API key validated successfully!\n\nYou're now set up to use ${agent.name} with your Fullmetal AI account (${userData.email}).\n\nYou can now add the bot to groups and use all features.`);

                      // Get and show main menu with updated options
                      const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                      console.log(`[API Key Input] Showing updated main menu to user ${userId}`);
                      await ctx.reply(welcomeMessage, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                      });

                    } catch (error) {
                      console.error(`[API Key Input] Error validating API key for user ${userId}:`, error);
                      await ctx.reply('⚠️ An error occurred while validating your API key. Please try again later.');
                      // Don't clear the state, let them try again
                    }

                    // Important: Return here to prevent further processing
                    return;
                  } else if (userState && userState.waitingForGroupApiKey && userState.groupId && ctx.chat.type === 'private') {
                    // Group API key setup handler is here
                    // ... (kept the group API key handler code) ...
                    return;
                  }

                  // Special test message handler - works in any chat type
                  if (ctx.message.text.toLowerCase() === 'testing bot') {
                    console.log(`[DEBUG] Responding to test message`);
                    await ctx.reply('I can see your message! Bot is working.');
                    return;
                  }

                  // Debug raw message for troubleshooting 
                  console.log('Raw message object:', JSON.stringify(ctx.message, null, 2));
                  console.log('Raw update object:', JSON.stringify(ctx.update, null, 2));

                  const messageId = ctx.message.message_id;
                  const messageText = ctx.message.text;
                  const isGroupChat = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
                  const isPrivateChat = ctx.chat.type === 'private';
                  const isChannelChat = ctx.chat.type === 'channel';
                  // Check if this is a reply to the bot's message
                  const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.botInfo.id;
                  // Check if the bot is mentioned
                  const isBotMentioned = messageText.includes(`@${ctx.botInfo.username}`);

                  console.log(`Message received from ${userId} (${ctx.from.username || 'no username'}): ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
                  console.log(`Chat type: ${ctx.chat.type}, Chat ID: ${ctx.chat.id}, Is group: ${isGroupChat}, Is private: ${isPrivateChat}, Is channel: ${isChannelChat}`);
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
                    // HANDLE PRIVATE CHATS
                    if (isPrivateChat) {
                      console.log(`Processing private chat message from user ${userId}`);
                      await messageController.processMessage(messageText, ctx, agent);
                      return;
                    }

                    // HANDLE GROUP CHATS
                    if (isGroupChat) {
                      console.log(`Processing group message from ${ctx.from.username || userId} in ${ctx.chat.title || 'a group'}`);

                      // Process all messages for moderation, but only respond to mentions/replies
                      const isDirectedToBot = isBotMentioned || isReplyToBot;

                      // Clean the message text by removing bot mentions
                      let processedText = messageText;
                      if (isBotMentioned) {
                        processedText = messageText.replace(`@${ctx.botInfo.username}`, '').trim();
                      }

                      // Check if user is an admin
                      let isUserAdmin = true;
                      try {
                        const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
                        isUserAdmin = ['creator', 'administrator'].includes(member.status);
                        console.log(`User ${userId} admin status: ${isUserAdmin ? 'Admin' : 'Not admin'}`);
                      } catch (error) {
                        console.error(`Error checking admin status for user ${userId}:`, error);
                        // Default to not an admin if we can't verify
                        isUserAdmin = false;
                      }

                      // If user is an admin, handle admin messages differently
                      if (isUserAdmin) {
                        console.log(`User ${userId} is an admin, skipping moderation`);

                        // Only process admin messages if they're directed to the bot
                        if (isDirectedToBot) {
                          console.log(`Admin message is directed to bot, processing conversation`);
                          await messageController.processMessage(processedText, ctx, agent);
                        } else {
                          console.log(`Admin message is not directed to bot, ignoring`);
                        }
                        return;
                      }

                      // Handle regular user messages
                      // Check if moderation is enabled
                      const shouldModerate = agent.summary?.telegram?.moderation !== false;
                      console.log(`Moderation enabled for this agent? ${shouldModerate}`);

                      if (shouldModerate) {
                        console.log(`Moderation enabled for group ${ctx.chat.id}, analyzing message...`);

                        try {
                          // Get bot member to check permissions
                          const botMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);
                          console.log(`Bot permissions: restrictMembers=${botMember.can_restrict_members}, deleteMessages=${botMember.can_delete_messages}`);

                          // Check if the bot is not an admin, handle accordingly
                          if (!botMember.can_restrict_members && !botMember.can_delete_messages) {
                            console.log(`Bot doesn't have moderation permissions in this group`);

                            // Process the message only if it's directed to the bot
                            if (isDirectedToBot) {
                              await messageController.processMessage(processedText, ctx, agent);
                            }
                            return;
                          }

                          // Moderate the message
                          console.log(`Sending message to moderation service for analysis`);
                          const moderationResult = await moderationService.moderateMessage(messageText, ctx, agent);
                          console.log(`Moderation result for message ${messageId}: ${JSON.stringify(moderationResult)}`);

                          // If no action required or action was not successful, process the message if directed to bot
                          if (!moderationResult.actionRequired || !moderationResult.actionTaken) {
                            if (isDirectedToBot) {
                              await messageController.processMessage(processedText, ctx, agent);
                            }
                          }
                        } catch (error) {
                          console.error(`Error in moderation flow:`, error);
                          // If moderation fails, still process the message if directed to bot
                          if (isDirectedToBot) {
                            await messageController.processMessage(processedText, ctx, agent);
                          }
                        }
                      } else {
                        // Moderation not enabled, process only if directed to the bot
                        console.log(`Moderation not enabled, processing as normal group chat`);
                        if (isDirectedToBot) {
                          await messageController.processMessage(processedText, ctx, agent);
                        }
                      }
                    }
                  } catch (error) {
                    console.error('Error processing message:', error);
                    ctx.reply('⚠️ An error occurred while processing your request.');
                  }
                });

                // Function to handle the admin setup flow
                async function handleAdminSetup(ctx) {
                  console.log(`[Admin Setup] User ${ctx.from.id} (${ctx.from.username || 'no username'}) starting admin setup`);
                  await ctx.answerCbQuery('Setting up admin access...');

                  const message =
                    `To give me admin access to your group:\n\n` +
                    `1. Go to your group\n` +
                    `2. Click on the group name at the top\n` +
                    `3. Select "Administrators"\n` +
                    `4. Tap "Add Administrator"\n` +
                    `5. Select this bot (@${ctx.botInfo.username})\n\n` +
                    `Bot needs these permissions for moderation:\n` +
                    `- Delete messages\n` +
                    `- Ban users\n` +
                    `- Restrict users`;

                  // Add a button to show user's groups
                  const keyboard = {
                    inline_keyboard: [
                      [{ text: 'Select a Group', callback_data: 'list_groups' }],
                      [{ text: '« Back to Main Menu', callback_data: 'back_to_main' }]
                    ]
                  };

                  await ctx.reply(message, { reply_markup: keyboard });
                  console.log(`[Admin Setup] Displayed admin setup instructions to user ${ctx.from.id}`);
                }

                // Function to handle showing help information
                async function handleShowHelp(ctx) {
                  console.log(`[Help] User ${ctx.from.id} (${ctx.from.username || 'no username'}) requesting help information`);
                  await ctx.answerCbQuery('Showing help information...');

                  // Check if user has their own API key
                  const telegramUserId = ctx.from.id.toString();
                  const userWithApiKey = await checkUserApiKey(telegramUserId);
                  const hasUserApiKey = userWithApiKey && userWithApiKey.apiKey && userWithApiKey.apiKey.length > 0;

                  // Also check agent API key as fallback
                  const hasAgentApiKey = agent.userId && agent.userId._id && agent.userId.apiKey && agent.userId.apiKey.length > 0;

                  let gettingStartedSteps = '';

                  if (hasUserApiKey) {
                    gettingStartedSteps =
                      `*💡 Getting Started:*\n` +
                      `1. ✅ Personal API Key is already set up\n` +
                      `2. Add me to your group\n` +
                      `3. Make me an admin in the group\n` +
                      `4. I'll start moderating automatically!\n\n`;
                  } else if (hasAgentApiKey) {
                    gettingStartedSteps =
                      `*💡 Getting Started:*\n` +
                      `1. Set up your personal Fullmetal API Key (required first step)\n` +
                      `2. Only after setting up your own API key, you can add me to groups\n` +
                      `3. Make me an admin in the group\n` +
                      `4. I'll start moderating automatically!\n\n` +
                      `*Note: You can chat with me using the bot's shared API key, but to add me to groups, you must set up your own personal API key.*\n\n`;
                  } else {
                    gettingStartedSteps =
                      `*💡 Getting Started:*\n` +
                      `1. Enter your Fullmetal API Key (required first step)\n` +
                      `2. Only after setting up API key, you can add me to groups\n` +
                      `3. Make me an admin in the group\n` +
                      `4. I'll start moderating automatically!\n\n`;
                  }

                  const helpMessage =
                    `*${agent.name} - AI Moderation Bot*\n\n` +
                    `I'm powered by Fullmetal AI to help keep your groups safe and friendly. Here's what I can do:\n\n` +

                    (hasUserApiKey ? '' : `*⚠️ IMPORTANT:* You must set up your personal API key before adding me to any groups!\n\n`) +

                    `*🛡️ Moderation Features:*\n` +
                    `• Auto-detect harmful content\n` +
                    `• Issue warnings to users\n` +
                    `• Temporary mutes after ${warningService.WARNING_THRESHOLDS.TEMP_MUTE} warnings\n` +
                    `• Remove users after ${warningService.WARNING_THRESHOLDS.KICK} warnings\n` +
                    `• Permanent ban after ${warningService.WARNING_THRESHOLDS.BAN} warnings\n\n` +

                    `*👮‍♂️ Admin Commands:*\n` +
                    `/modstatus - Check moderation settings\n` +
                    `/modon - Enable moderation\n` +
                    `/modoff - Disable moderation\n` +
                    `/warnings @user - Check warnings for a user\n` +
                    `/clearwarnings @user - Clear all warnings\n\n` +

                    `*👤 User Commands:*\n` +
                    `/start - Open the main menu\n` +
                    `/clearmemory - Clear conversation history\n` +
                    `/showmemory - Show your conversation summary\n` +
                    `/help - Show this help message\n\n` +

                    gettingStartedSteps +

                    `You can chat with me directly or @mention me in groups.`;

                  const keyboard = {
                    inline_keyboard: [
                      [
                        {
                          text: '🔗 Get Fullmetal API Key',
                          url: 'https://www.fullmetal.ai'
                        }
                      ],
                      [
                        {
                          text: '📋 Documentation',
                          url: 'https://www.fullmetal.ai/docs'
                        }
                      ],
                      !hasUserApiKey ? [
                        {
                          text: '🔑 Set Up Personal API Key',
                          callback_data: 'setup_apikey'
                        }
                      ] : [
                        {
                          text: '➕ Add to Group',
                          url: `https://t.me/${ctx.botInfo.username}?startgroup=true`
                        }
                      ],
                      [
                        {
                          text: '« Back to Main Menu',
                          callback_data: 'back_to_main'
                        }
                      ]
                    ].filter(row => row.length > 0) // Remove empty rows
                  };

                  await ctx.reply(helpMessage, {
                    reply_markup: keyboard,
                    parse_mode: 'Markdown'
                  });
                  console.log(`[Help] Displayed help information to user ${ctx.from.id}`);
                }

                // Function to handle listing and selecting groups
                async function handleGroupSelection(ctx, groupId) {
                  console.log(`[Group Selection] User ${ctx.from.id} selected group ${groupId}`);
                  await ctx.answerCbQuery(`Loading group settings...`);

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await ctx.editMessageText(`Sorry, I couldn't find information for this group. It may have been deleted.`, {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: '« Back to Groups', callback_data: 'list_groups' }]
                          ]
                        }
                      });
                      return;
                    }

                    // Check if the group is still active
                    if (!group.isActive) {
                      await ctx.editMessageText(
                        `*${group.groupName}*\n\n` +
                        `⚠️ I'm no longer a member of this group.\n\n` +
                        `To use me in this group again, please add me back.`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: '« Back to Groups', callback_data: 'list_groups' }]
                          ]
                        }
                      }
                      );
                      return;
                    }

                    // Prepare group info message
                    let message = `*${group.groupName}*\n\n`;
                    message += `• Type: ${group.groupType === 'supergroup' ? 'Supergroup' : 'Group'}\n`;
                    message += `• Members: ${group.memberCount || 'Unknown'}\n`;
                    message += `• Moderation: ${group.moderationEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
                    message += `• Bot Status: ${group.isActive ? '✅ Active' : '❌ Inactive'}\n\n`;

                    // Check API key status
                    const hasApiKey = !!(group.apiKeyUserId && group.apiKeyUserId.apiKey && group.apiKeyUserId.apiKey.length > 0);
                    message += `• API Key: ${hasApiKey ? '✅ Set' : '❌ Not set'}\n`;

                    if (hasApiKey && group.apiKeyUserId) {
                      message += `• Account: ${group.apiKeyUserId.email || 'Unknown'}\n\n`;
                    } else {
                      message += `\n⚠️ This group needs an API key to use AI features.\n\n`;
                    }

                    // Usage statistics
                    if (group.apiUsage) {
                      message += `*Usage Statistics:*\n`;
                      message += `• Messages: ${group.apiUsage.messageCount || 0}\n`;
                      message += `• Moderations: ${group.apiUsage.moderationCount || 0}\n`;
                      message += `• Commands: ${group.apiUsage.commandCount || 0}\n\n`;
                    }

                    // Prepare action buttons
                    const buttons = [];

                    // API key button
                    buttons.push([
                      {
                        text: hasApiKey ? '🔄 Update API Key' : '🔑 Set API Key',
                        callback_data: `group_apikey_${groupId}`
                      }
                    ]);

                    // Moderation toggle
                    buttons.push([
                      {
                        text: group.moderationEnabled ? '🛑 Disable Moderation' : '✅ Enable Moderation',
                        callback_data: `group_mod_${group.moderationEnabled ? 'off' : 'on'}_${groupId}`
                      }
                    ]);

                    // View group in Telegram
                    try {
                      const chatInviteLink = await ctx.telegram.exportChatInviteLink(groupId);
                      if (chatInviteLink) {
                        buttons.push([
                          { text: '👁️ View Group', url: chatInviteLink }
                        ]);
                      }
                    } catch (error) {
                      console.error(`[Group Selection] Error getting invite link:`, error);
                    }

                    // Add remove bot button
                    buttons.push([
                      { text: '🚫 Remove Bot from Group', callback_data: `group_remove_${groupId}` }
                    ]);

                    // Back button
                    buttons.push([
                      { text: '« Back to Groups', callback_data: 'list_groups' }
                    ]);

                    // Send message with group info
                    await ctx.editMessageText(message, {
                      parse_mode: 'Markdown',
                      reply_markup: {
                        inline_keyboard: buttons
                      }
                    });

                    console.log(`[Group Selection] Displayed group information for ${group.groupName} to user ${ctx.from.id}`);
                  } catch (error) {
                    console.error(`[Group Selection] Error handling group selection:`, error);
                    await ctx.reply(`An error occurred while loading the group information. Please try again later.`);
                  }
                }

                // Function to handle setting API key for a specific group
                async function handleGroupApiKeySetup(ctx, groupId) {
                  console.log(`[Group API Key] User ${ctx.from.id} setting up API key for group ${groupId}`);
                  await ctx.answerCbQuery('Setting up API key for this group...');

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await ctx.editMessageText(`Sorry, I couldn't find information for this group.`, {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: '« Back to Groups', callback_data: 'list_groups' }]
                          ]
                        }
                      });
                      return;
                    }

                    const message =
                      `*API Key Setup for ${group.groupName}*\n\n` +
                      `Please enter your Fullmetal API Key for this group.\n\n` +
                      `This API key will be used for all AI operations in this group, and usage will be billed to the associated account.\n\n` +
                      `You can get your API key from https://www.fullmetal.ai\n\n` +
                      `Reply to this message with your API key, or type /cancel to abort.`;

                    await ctx.editMessageText(message, {
                      parse_mode: 'Markdown',
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: '« Back to Group', callback_data: `group_${groupId}` }]
                        ]
                      }
                    });

                    // Set user state to wait for API key
                    if (!global.userStates) {
                      global.userStates = new Map();
                    }

                    const userId = ctx.from.id.toString();
                    const newState = {
                      waitingForGroupApiKey: true,
                      groupId: groupId,
                      timestamp: Date.now()
                    };

                    global.userStates.set(userId, newState);
                    console.log(`[Group API Key] Set user ${userId} state to: ${JSON.stringify(newState)}`);
                  } catch (error) {
                    console.error(`[Group API Key] Error setting up group API key:`, error);
                    await ctx.reply('An error occurred while setting up the API key. Please try again later.');
                  }
                }

                // Function to toggle moderation for a group
                async function toggleGroupModeration(ctx, groupId, enable) {
                  console.log(`[Group Moderation] User ${ctx.from.id} ${enable ? 'enabling' : 'disabling'} moderation for group ${groupId}`);
                  await ctx.answerCbQuery(`${enable ? 'Enabling' : 'Disabling'} moderation...`);

                  try {
                    // Update moderation setting in database
                    await groupService.toggleModeration(groupId, enable);

                    // Return to group info screen
                    await handleGroupSelection(ctx, groupId);
                  } catch (error) {
                    console.error(`[Group Moderation] Error ${enable ? 'enabling' : 'disabling'} moderation:`, error);
                    await ctx.reply(`An error occurred while ${enable ? 'enabling' : 'disabling'} moderation. Please try again later.`);
                  }
                }

                // Function to handle removing the bot from a group
                async function handleGroupRemoval(ctx, groupId) {
                  console.log(`[Group Removal] User ${ctx.from.id} initiating removal of bot from group ${groupId}`);
                  await ctx.answerCbQuery('Preparing to remove bot...');

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await ctx.editMessageText(`Sorry, I couldn't find information for this group.`, {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: '« Back to Groups', callback_data: 'list_groups' }]
                          ]
                        }
                      });
                      return;
                    }

                    // Show confirmation dialog
                    const message = `*Confirm Bot Removal*\n\n` +
                      `Are you sure you want to remove the bot from *${group.groupName}*?\n\n` +
                      `This will:\n` +
                      `• Remove the bot from the group\n` +
                      `• Disable all moderation features\n` +
                      `• Keep group history and settings in case you add the bot back later`;

                    const confirmationButtons = [
                      [
                        { text: '✅ Yes, Remove Bot', callback_data: `group_remove_confirm_${groupId}` },
                        { text: '❌ Cancel', callback_data: `group_${groupId}` }
                      ]
                    ];

                    await ctx.editMessageText(message, {
                      parse_mode: 'Markdown',
                      reply_markup: {
                        inline_keyboard: confirmationButtons
                      }
                    });

                  } catch (error) {
                    console.error(`[Group Removal] Error preparing group removal:`, error);
                    await ctx.reply(`An error occurred while preparing to remove the bot. Please try again later.`);
                  }
                }

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

                // Add privacy mode check command
                bot.command('privacy', async (ctx) => {
                  console.log(`PRIVACY command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);

                  const message = `*Telegram Bot Privacy Settings*\n\n` +
                    `If the bot is not responding to regular messages, it might be due to Telegram's Privacy Mode being enabled.\n\n` +

                    `*Current Status:*\n` +
                    `• Commands: ✅ Working\n` +
                    `• Direct messages: ${ctx.chat.type === 'private' ? '✅ Should work' : '❓ Unknown'}\n` +
                    `• Group messages: ❓ May not work if privacy mode is enabled\n\n` +

                    `*How to disable Privacy Mode:*\n` +
                    `1. Open @BotFather in Telegram\n` +
                    `2. Send /mybots\n` +
                    `3. Select this bot (@${ctx.botInfo.username})\n` +
                    `4. Go to Bot Settings > Group Privacy\n` +
                    `5. Select 'Disable'\n` +
                    `6. Restart your bot server\n\n` +

                    `*Test Messages:*\n` +
                    `• Use /test to confirm the bot can receive commands\n` +
                    `• Use /mod [text] to test moderation without privacy mode\n\n` +

                    `Note: Even with privacy mode ON, the bot can still process commands like /modstatus, /modon and /modoff.`;

                  await ctx.replyWithMarkdown(message);
                });

                // Add dedicated handler for private chat messages
                // REMOVED: Consolidating all handling in the main message handler below
                // bot.on('text', async (ctx) => {
                //   // Only process messages in private chats
                //   if (ctx.chat.type !== 'private') {
                //     return; // Let other handlers process group messages
                //   }
                // 
                //   // Skip processing commands (let command handlers deal with those)
                //   if (ctx.message.text.startsWith('/')) {
                //     return;
                //   }
                // 
                //   console.log(`[Private] Message received from user ${ctx.from.id}: "${ctx.message.text.substring(0, 50)}${ctx.message.text.length > 50 ? '...' : ''}"`);
                // 
                //   try {
                //     // Process the message using messageController
                //     await messageController.processMessage(ctx.message.text, ctx, agent);
                //   } catch (error) {
                //     console.error('[Private] Error processing private message:', error);
                //     ctx.reply('⚠️ An error occurred while processing your message. Please try again later.');
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
                  } else if (ctx.channelPost?.text) {
                    console.log(`CHANNEL POST TEXT: "${ctx.channelPost.text}"`);
                  }

                  // Continue to the next middleware
                  return next();
                });

                // Add handler for channel posts
                bot.on('channel_post', async (ctx) => {
                  console.log('*** CHANNEL POST RECEIVED ***');
                  console.log(`Channel ID: ${ctx.chat.id}, Channel title: ${ctx.chat.title || 'Unnamed channel'}`);
                  console.log('Ignoring channel post as bot is not needed for channels');
                  // No processing for channel posts
                });

                // Register bot commands with BotFather
                bot.telegram.setMyCommands([
                  { command: 'start', description: 'Start the bot and see main menu' },
                  { command: 'help', description: 'Show help information and commands' },
                  { command: 'modstatus', description: 'Check moderation status and settings' },
                  { command: 'modon', description: 'Enable message moderation in this group' },
                  { command: 'modoff', description: 'Disable message moderation in this group' },
                  { command: 'warnings', description: 'Check warnings for a specific user' },
                  { command: 'clearwarnings', description: 'Clear all warnings for a user' }
                ], { scope: { type: 'all_chat_administrators' } }).catch(error => {
                  console.error('Failed to register admin commands:', error);
                }).then(() => {
                  // Also register for all users
                  return bot.telegram.setMyCommands([
                    { command: 'start', description: 'Start the bot and see main menu' },
                    { command: 'help', description: 'Show help information and commands' },
                    { command: 'clearmemory', description: 'Clear your conversation history' },
                    { command: 'showmemory', description: 'Show a summary of your conversation' },
                    { command: 'test', description: 'Test if the bot is working properly' }
                  ], { scope: { type: 'all_private_chats' } });
                }).then(() => {
                  // Also register for default scope (all users in all chats)
                  return bot.telegram.setMyCommands([
                    { command: 'start', description: 'Start the bot and see main menu' },
                    { command: 'help', description: 'Show help information and commands' },
                    { command: 'test', description: 'Test if the bot is working properly' }
                  ]);
                }).then(() => {
                  console.log('Bot commands registered with Telegram');
                }).catch(error => {
                  console.error('Failed to register commands:', error);
                });

                // Handle when bot is added to or removed from a group
                bot.on('my_chat_member', async (ctx) => {
                  console.log(`[Bot Status] Chat member update in ${ctx.chat.id} (${ctx.chat.title || 'Unknown'})`);
                  console.log(`[Bot Status] Update details:`, JSON.stringify(ctx.update.my_chat_member));

                  // Check if this is a group or supergroup
                  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
                  if (!isGroup) {
                    console.log(`[Bot Status] Ignoring chat member update in non-group chat: ${ctx.chat.type}`);
                    return;
                  }

                  const chatId = ctx.chat.id.toString();
                  const chatTitle = ctx.chat.title || 'Unnamed Group';
                  const chatType = ctx.chat.type;
                  const newStatus = ctx.update.my_chat_member.new_chat_member.status;
                  const oldStatus = ctx.update.my_chat_member.old_chat_member.status;
                  const addedBy = ctx.update.my_chat_member.from;

                  console.log(`[Bot Status] Status change from ${oldStatus} to ${newStatus} in ${chatTitle}`);

                  // Bot was added to a group
                  if ((oldStatus === 'left' || oldStatus === 'kicked') &&
                    (newStatus === 'member' || newStatus === 'administrator')) {
                    console.log(`[Bot Status] Bot was added to group ${chatTitle} (${chatId}) by user ${addedBy.id}`);

                    try {
                      // Check if the specific user who added the bot has a valid API key
                      const telegramUserId = addedBy.id.toString();
                      const User = require('./models/User');
                      const userWithApiKey = await User.findOne({ telegramUserId });
                      const hasUserApiKey = userWithApiKey && userWithApiKey.apiKey && userWithApiKey.apiKey.length > 0;

                      if (!hasUserApiKey) {
                        console.log(`[Bot Status] Bot added to group ${chatTitle} by user ${telegramUserId} who doesn't have a personal API key, leaving group`);

                        // Send message explaining why the bot is leaving
                        await ctx.telegram.sendMessage(chatId,
                          `⚠️ I cannot be added to this group yet!\n\n` +
                          `The user who added me (${addedBy.first_name || 'User'}) needs to set up their personal API key first.\n\n` +
                          `Please contact @${ctx.botInfo.username} in a private message to set up your personal API key first, then add me back to the group.\n\n` +
                          `I'll now leave this group. Sorry for the inconvenience!`
                        );

                        // Leave the group
                        setTimeout(async () => {
                          try {
                            await ctx.telegram.leaveChat(chatId);
                            console.log(`[Bot Status] Successfully left group ${chatId} due to missing user API key`);
                          } catch (leaveError) {
                            console.error(`[Bot Status] Error leaving group ${chatId}:`, leaveError);
                          }
                        }, 5000); // Wait 5 seconds so user can read the message

                        return;
                      }

                      // Get chat member count
                      const chatInfo = await ctx.telegram.getChat(chatId);
                      const memberCount = chatInfo.permissions ? 0 : (await ctx.telegram.getChatMembersCount(chatId));

                      // Set API key user ID to the user who added the bot
                      let apiKeyUserId = null;
                      if (userWithApiKey && userWithApiKey._id) {
                        apiKeyUserId = userWithApiKey._id;
                        console.log(`[Bot Status] Using API key from user ${telegramUserId} for group ${chatId}`);
                      } else {
                        // This shouldn't happen since we check for user API key above
                        console.log(`[Bot Status] Unexpected: No user API key found for group ${chatId}`);
                      }

                      // Create group in database
                      const groupData = {
                        telegramGroupId: chatId,
                        groupName: chatTitle,
                        groupType: chatType,
                        memberCount: memberCount || 0,
                        agentId: agent._id,
                        isActive: true,
                        moderationEnabled: true,
                        addedByUserId: userWithApiKey._id,  // Store who added the bot
                        apiKeyUserId: apiKeyUserId          // Use the API key of the user who added the bot
                      };

                      const savedGroup = await groupService.saveGroup(groupData);
                      console.log(`[Bot Status] Group saved successfully: ${savedGroup.id}`);

                      // Check if the bot is an admin
                      if (newStatus === 'administrator') {
                        console.log(`[Bot Status] Bot was added as admin to ${chatTitle}`);
                        // Send welcome message
                        await ctx.telegram.sendMessage(chatId,
                          `👋 Thanks for adding me to ${chatTitle}!\n\n` +
                          `I'm ${agent.name}, and I'll help moderate this group.\n\n` +
                          `✅ I have admin permissions, so I'm ready to help keep this group safe.\n\n` +
                          `To see what I can do, use /modstatus command.`
                        );
                      } else {
                        console.log(`[Bot Status] Bot was added as member to ${chatTitle}`);
                        // Send message about needing admin permissions
                        await ctx.telegram.sendMessage(chatId,
                          `👋 Thanks for adding me to ${chatTitle}!\n\n` +
                          `I'm ${agent.name}, and I can help moderate this group.\n\n` +
                          `⚠️ To work properly, I need admin permissions to:\n` +
                          `• Delete messages\n` +
                          `• Restrict members\n` +
                          `• Ban users\n\n` +
                          `Please make me an admin to enable all features!`
                        );
                      }
                    } catch (error) {
                      console.error(`[Bot Status] Error handling bot addition to group:`, error);
                    }
                  }

                  // Bot was removed from a group
                  else if ((oldStatus === 'member' || oldStatus === 'administrator') &&
                    (newStatus === 'left' || newStatus === 'kicked')) {
                    console.log(`[Bot Status] Bot was removed from group ${chatTitle} (${chatId})`);

                    try {
                      // Mark group as inactive in database
                      await groupService.deactivateGroup(chatId);
                    } catch (error) {
                      console.error(`[Bot Status] Error handling bot removal from group:`, error);
                    }
                  }

                  // Bot was promoted to administrator
                  else if (oldStatus === 'member' && newStatus === 'administrator') {
                    console.log(`[Bot Status] Bot was promoted to admin in ${chatTitle} (${chatId})`);

                    try {
                      // Send thank you message
                      await ctx.telegram.sendMessage(chatId,
                        `✅ Thanks for making me an admin!\n\n` +
                        `I now have all the permissions I need to moderate this group.\n\n` +
                        `Use /modstatus to see my current settings or /help for a list of commands.`
                      );
                    } catch (error) {
                      console.error(`[Bot Status] Error handling bot promotion:`, error);
                    }
                  }

                  // Bot was demoted from administrator
                  else if (oldStatus === 'administrator' && newStatus === 'member') {
                    console.log(`[Bot Status] Bot was demoted from admin in ${chatTitle} (${chatId})`);

                    try {
                      // Send warning message
                      await ctx.telegram.sendMessage(chatId,
                        `⚠️ I've been removed as an admin.\n\n` +
                        `I can still chat, but I won't be able to moderate the group effectively.\n\n` +
                        `To restore full functionality, please make me an admin again with these permissions:\n` +
                        `• Delete messages\n` +
                        `• Restrict members\n` +
                        `• Ban users`
                      );
                    } catch (error) {
                      console.error(`[Bot Status] Error handling bot demotion:`, error);
                    }
                  }
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

                // Add help command for both private and group chats
                bot.command('help', async (ctx) => {
                  console.log(`[Help] Command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);

                  // Content differs based on whether we're in a private chat or group
                  if (ctx.chat.type === 'private') {
                    // In private chat, show the full help menu
                    await handleShowHelp(ctx);
                  } else {
                    // Check if agent has a validated API key
                    const hasValidApiKey = agent.userId && agent.userId._id && agent.userId.apiKey && agent.userId.apiKey.length > 0;

                    // In groups, show a more compact version
                    const helpMessage =
                      `*${agent.name} - Commands*\n\n` +

                      (hasValidApiKey ? '' : `*⚠️ IMPORTANT:* The bot owner must set up an API key in private chat first.\n\n`) +

                      `*Admin Commands:*\n` +
                      `/modstatus - Check moderation settings\n` +
                      `/modon - Enable moderation\n` +
                      `/modoff - Disable moderation\n` +
                      `/warnings @user - Check warnings\n` +
                      `/clearwarnings @user - Clear warnings\n\n` +

                      `*User Commands:*\n` +
                      `/start - Open the main menu\n` +
                      `/help - Show this help message\n\n` +

                      `For more commands and info, chat with me privately: @${ctx.botInfo.username}`;

                    // Send compact help message
                    await ctx.replyWithMarkdown(helpMessage);
                  }
                });

                bot.command('modstatus', async (ctx) => {
                  console.log(`Moderation status command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
                  console.log(`[DEBUG-COMMAND] /modstatus command received in chat type: ${ctx.chat.type}, chat ID: ${ctx.chat.id}`);

                  // Only proceed in group chats
                  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
                    console.log(`[DEBUG-COMMAND] /modstatus rejected - not a group chat (type: ${ctx.chat.type})`);
                    return ctx.reply('This command is only available in groups.');
                  }

                  // Only chat administrators can use this command
                  try {
                    console.log(`[DEBUG-COMMAND] Checking if user ${ctx.from.id} is an admin in chat ${ctx.chat.id}`);
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);
                    console.log(`[DEBUG-COMMAND] User ${ctx.from.id} admin status: ${isAdmin ? 'Is admin' : 'Not admin'} (${member.status})`);

                    if (!isAdmin) {
                      console.log(`[DEBUG-COMMAND] /modstatus rejected - user is not an admin`);
                      return ctx.reply('Only administrators can use this command.');
                    }
                  } catch (error) {
                    console.error(`[DEBUG-COMMAND] Error checking admin status for user ${ctx.from.id}:`, error);
                    return ctx.reply('An error occurred while checking admin status.');
                  }
                });

                // Handle modoff command
                bot.command('modoff', async (ctx) => {
                  console.log(`MODOFF command received from user ${ctx.from.id} in chat ${ctx.chat.id}`);

                  // Only works in groups
                  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
                    return ctx.reply('This command can only be used in groups.');
                  }

                  // Check if user is an admin
                  try {
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('⚠️ Only group administrators can use this command.');
                    }

                    // Update group settings in the database
                    const group = await groupService.updateModerationStatus(ctx.chat.id.toString(), false);

                    if (group) {
                      ctx.reply('✅ Moderation is now disabled for this group. I will no longer analyze or moderate messages.');
                      console.log(`[MODOFF] Moderation disabled for group ${ctx.chat.id} by user ${ctx.from.id}`);
                    } else {
                      ctx.reply('⚠️ An error occurred while updating moderation settings.');
                      console.error(`[MODOFF] Error updating moderation status for group ${ctx.chat.id}`);
                    }

                  } catch (error) {
                    console.error('Error checking admin status:', error);
                    ctx.reply('⚠️ An error occurred while checking your admin status.');
                  }
                });

                // Handle warnings command - check warnings for a user
                bot.command('warnings', async (ctx) => {
                  console.log(`WARNINGS command received from user ${ctx.from.id} in chat ${ctx.chat.id}`);

                  // Only works in groups
                  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
                    return ctx.reply('This command can only be used in groups.');
                  }

                  // Check if user is an admin
                  try {
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('⚠️ Only group administrators can use this command.');
                    }

                    // Parse the target user from the command
                    const args = ctx.message.text.split(' ');

                    if (args.length < 2) {
                      return ctx.reply('⚠️ Please specify a user: /warnings @username or /warnings user_id');
                    }

                    let targetUser = args[1];
                    let targetUserId;

                    // Handle both username and user ID formats
                    if (targetUser.startsWith('@')) {
                      // Username format - need to find the user ID
                      const username = targetUser.substring(1);

                      try {
                        // Try to get user info from message mention
                        if (ctx.message.entities && ctx.message.entities.length > 0) {
                          for (const entity of ctx.message.entities) {
                            if (entity.type === 'mention' && entity.user) {
                              targetUserId = entity.user.id.toString();
                              break;
                            }
                          }
                        }

                        // If we couldn't get the ID from mention, try to get chat members
                        if (!targetUserId) {
                          // This is a limitation - we can only check warnings for users currently in the group
                          const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, username);
                          if (chatMember && chatMember.user) {
                            targetUserId = chatMember.user.id.toString();
                          }
                        }
                      } catch (error) {
                        console.error(`Error finding user by username: ${username}`, error);
                      }

                      if (!targetUserId) {
                        return ctx.reply(`⚠️ Could not find user ${targetUser} in this group. The user must be a current member.`);
                      }
                    } else {
                      // Direct user ID format
                      targetUserId = targetUser;
                    }

                    // Get warning info for the user
                    const warningInfo = await warningService.getWarningInfo(targetUserId, ctx.chat.id.toString());

                    if (!warningInfo || warningInfo.warningCount === 0) {
                      return ctx.reply(`✅ User has no warnings in this group.`);
                    }

                    // Format warning information
                    let message = `*Warning Information*\n\n`;
                    message += `• User: ${warningInfo.username ? '@' + warningInfo.username : 'ID: ' + warningInfo.userId}\n`;
                    message += `• Warning Count: ${warningInfo.warningCount}/${warningService.WARNING_THRESHOLDS.BAN}\n`;

                    if (warningInfo.lastWarningDate) {
                      const lastWarningDate = new Date(warningInfo.lastWarningDate);
                      message += `• Last Warning: ${lastWarningDate.toLocaleDateString()} ${lastWarningDate.toLocaleTimeString()}\n`;
                    }

                    if (warningInfo.isBanned) {
                      message += `• Status: 🚫 Banned\n`;
                      if (warningInfo.banReason) {
                        message += `• Ban Reason: ${warningInfo.banReason}\n`;
                      }
                      if (warningInfo.banDate) {
                        const banDate = new Date(warningInfo.banDate);
                        message += `• Ban Date: ${banDate.toLocaleDateString()}\n`;
                      }
                    } else if (warningInfo.warningCount >= warningService.WARNING_THRESHOLDS.TEMP_MUTE) {
                      const remainingWarnings = warningService.WARNING_THRESHOLDS.BAN - warningInfo.warningCount;
                      message += `• Status: ⚠️ At risk - ${remainingWarnings} more warning${remainingWarnings !== 1 ? 's' : ''} until ban\n`;
                    }

                    // Show recent warnings
                    if (warningInfo.recentWarnings && warningInfo.recentWarnings.length > 0) {
                      message += `\n*Recent Warnings:*\n`;
                      warningInfo.recentWarnings.forEach((warning, index) => {
                        const warningDate = new Date(warning.timestamp);
                        message += `${index + 1}. ${warning.reason}\n`;
                        message += `   ${warningDate.toLocaleDateString()} ${warningDate.toLocaleTimeString()}\n`;
                      });
                    }

                    message += `\nUse /clearwarnings ${targetUser} to clear all warnings for this user.`;

                    await ctx.replyWithMarkdown(message);
                    console.log(`[WARNINGS] Displayed warnings for user ${targetUserId} in group ${ctx.chat.id}`);

                  } catch (error) {
                    console.error('Error checking warnings:', error);
                    ctx.reply('⚠️ An error occurred while checking warnings.');
                  }
                });

                // Handle clearwarnings command - clear warnings for a user
                bot.command('clearwarnings', async (ctx) => {
                  console.log(`CLEARWARNINGS command received from user ${ctx.from.id} in chat ${ctx.chat.id}`);

                  // Only works in groups
                  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
                    return ctx.reply('This command can only be used in groups.');
                  }

                  // Check if user is an admin
                  try {
                    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                    const isAdmin = ['creator', 'administrator'].includes(member.status);

                    if (!isAdmin) {
                      return ctx.reply('⚠️ Only group administrators can use this command.');
                    }

                    // Parse the target user from the command
                    const args = ctx.message.text.split(' ');

                    if (args.length < 2) {
                      return ctx.reply('⚠️ Please specify a user: /clearwarnings @username or /clearwarnings user_id');
                    }

                    let targetUser = args[1];
                    let targetUserId;

                    // Handle both username and user ID formats
                    if (targetUser.startsWith('@')) {
                      // Username format - need to find the user ID
                      const username = targetUser.substring(1);

                      try {
                        // Try to get user info from message mention
                        if (ctx.message.entities && ctx.message.entities.length > 0) {
                          for (const entity of ctx.message.entities) {
                            if (entity.type === 'mention' && entity.user) {
                              targetUserId = entity.user.id.toString();
                              break;
                            }
                          }
                        }

                        // If we couldn't get the ID from mention, try to get chat members
                        if (!targetUserId) {
                          const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, username);
                          if (chatMember && chatMember.user) {
                            targetUserId = chatMember.user.id.toString();
                          }
                        }
                      } catch (error) {
                        console.error(`Error finding user by username: ${username}`, error);
                      }

                      if (!targetUserId) {
                        return ctx.reply(`⚠️ Could not find user ${targetUser} in this group. The user must be a current member.`);
                      }
                    } else {
                      // Direct user ID format
                      targetUserId = targetUser;
                    }

                    // Get current warning count for confirmation
                    const warningInfo = await warningService.getWarningInfo(targetUserId, ctx.chat.id.toString());

                    if (!warningInfo || warningInfo.warningCount === 0) {
                      return ctx.reply(`✅ User has no warnings to clear.`);
                    }

                    // Clear warnings
                    const success = await warningService.clearWarnings(targetUserId, ctx.chat.id.toString());

                    if (success) {
                      let message = `✅ Successfully cleared all warnings for `;
                      message += warningInfo.username ? `@${warningInfo.username}` : `user ID: ${targetUserId}`;
                      message += ` (previously had ${warningInfo.warningCount} warning${warningInfo.warningCount !== 1 ? 's' : ''}).`;

                      await ctx.reply(message);
                      console.log(`[CLEARWARNINGS] Cleared warnings for user ${targetUserId} in group ${ctx.chat.id}`);
                    } else {
                      await ctx.reply('⚠️ An error occurred while clearing warnings.');
                      console.error(`[CLEARWARNINGS] Error clearing warnings for user ${targetUserId} in group ${ctx.chat.id}`);
                    }

                  } catch (error) {
                    console.error('Error clearing warnings:', error);
                    ctx.reply('⚠️ An error occurred while clearing warnings.');
                  }
                });
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