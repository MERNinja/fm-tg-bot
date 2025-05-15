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

// Store user states and pending group instructions
global.userStates = global.userStates || new Map();
global.pendingGroupInstructions = new Map();

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

// Utility function to safely call answerCbQuery
function safeAnswerCbQuery(ctx, text = '') {
  // Only call answerCbQuery if it's available in this context
  if (ctx.callbackQuery && typeof ctx.answerCbQuery === 'function') {
    return ctx.answerCbQuery(text);
  }
  // Return a resolved promise for consistent behavior
  return Promise.resolve();
}

// Utility function for safely editing messages
async function safeEditMessageText(ctx, text, options = {}) {
  try {
    if (ctx.callbackQuery) {
      // If it's a callback query, edit the message
      return await ctx.editMessageText(text, options);
    } else {
      // If not, send a new message
      return await ctx.reply(text, options);
    }
  } catch (error) {
    console.log(`[Safe Edit] Error editing message: ${error.message}`);
    // If editing fails, try alternative methods to send a message
    try {
      if (ctx.telegram && ctx.chat && ctx.chat.id) {
        // Use the telegram instance directly if available
        return await ctx.telegram.sendMessage(ctx.chat.id, text, options);
      } else if (ctx.telegram && ctx.from && ctx.from.id) {
        // If chat is not available but user is, send to user
        return await ctx.telegram.sendMessage(ctx.from.id, text, options);
      } else if (typeof ctx.reply === 'function') {
        // If ctx.reply is available, use it
        return await ctx.reply(text, options);
      } else {
        console.log(`[Safe Edit] Cannot send message - no valid methods available`);
      }
    } catch (fallbackError) {
      console.log(`[Safe Edit] Fallback error: ${fallbackError.message}`);
    }
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

                // Track if handlers have been registered to prevent duplicates
                let handlersRegistered = false;

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
                          text: '🚀 Get Started (Add to Group)',
                          callback_data: 'get_started'
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

                // Function to handle the Get Started flow
                async function handleGetStarted(ctx) {
                  console.log(`[Get Started] Processing Get Started request for user ${ctx.from.id}`);
                  await ctx.answerCbQuery('Starting setup process...');

                  // Check if user has an API key
                  const userId = ctx.from.id.toString();
                  const userWithApiKey = await checkUserApiKey(userId);
                  const hasUserApiKey = userWithApiKey && userWithApiKey.apiKey && userWithApiKey.apiKey.length > 0;

                  if (!hasUserApiKey) {
                    console.log(`[Get Started] User ${userId} doesn't have API key, redirecting to setup`);
                    await ctx.reply('You need to set up your API key first before adding the bot to groups.');
                    await handleApiKeySetup(ctx);
                    return;
                  }

                  // First check if user already has groups
                  try {
                    // Get groups for this agent
                    const groups = await groupService.getGroupsByAgentId(agent._id);

                    // Also check if there are any groups specifically added by this user
                    let userGroups = [];
                    if (userWithApiKey && userWithApiKey._id) {
                      userGroups = await groupService.getGroupsByAddedByUserId(userWithApiKey._id);
                    }

                    // Combine and filter unique groups
                    const allGroups = [...groups];
                    if (userGroups.length > 0) {
                      // Add user groups that aren't already in the list
                      for (const group of userGroups) {
                        if (!allGroups.some(g => g.telegramGroupId === group.telegramGroupId)) {
                          allGroups.push(group);
                        }
                      }
                    }

                    if (allGroups.length > 0) {
                      // User has existing groups, show them as options
                      await safeEditMessageText(ctx,
                        `*Get Started: Manage Existing Groups*\n\n` +
                        `You already have groups with this bot. Choose an option:\n\n` +
                        `• Select an existing group to manage\n` +
                        `• Add the bot to a new group`,
                        {
                          parse_mode: 'Markdown',
                          reply_markup: {
                            inline_keyboard: [
                              ...allGroups.map(group => [{
                                text: group.groupName,
                                callback_data: `group_${group.telegramGroupId}`
                              }]),
                              [{ text: '➕ Add to New Group', callback_data: 'add_to_new_group' }],
                              [{ text: '« Back to Main Menu', callback_data: 'back_to_main' }]
                            ]
                          }
                        }
                      );
                      return;
                    }

                    // No existing groups, continue with normal flow
                  } catch (error) {
                    console.error(`[Get Started] Error checking existing groups:`, error);
                    // Continue with the normal flow as a fallback
                  }

                  // Ask for group name
                  await safeEditMessageText(ctx,
                    `*Get Started: Add Bot to Group*\n\n` +
                    `Please enter the name of the group you want to add me to.\n\n` +
                    `This name will be used to prepare custom settings for your group.`,
                    { parse_mode: 'Markdown' }
                  );

                  // Set user state to wait for group name
                  global.userStates.set(userId, {
                    waitingFor: 'group_name',
                    timestamp: Date.now()
                  });

                  // Help text with cancel option
                  await ctx.reply(
                    'Type the name of your group, or /cancel to abort.',
                    {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: '« Back to Main Menu', callback_data: 'back_to_main' }]
                        ]
                      }
                    }
                  );
                }

                // Functions to handle custom instructions
                async function handleUseDefaultInstructions(ctx) {
                  // Use default instructions for the group
                  console.log(`[Get Started] User ${ctx.from.id} using default instructions`);
                  await ctx.answerCbQuery('Using default instructions...');

                  // Get state
                  const userId = ctx.from.id.toString();
                  const state = global.userStates.get(userId);

                  if (!state || !state.groupName) {
                    // Something went wrong, go back to main menu
                    console.log(`[Get Started] Missing group name in state for user ${userId}`);
                    await ctx.reply('⚠️ Error: Group name not found. Please start again.');

                    // Show main menu
                    const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                    await ctx.reply(welcomeMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                    return;
                  }

                  const groupName = state.groupName;

                  // Clear the waiting state
                  global.userStates.delete(userId);

                  // Provide link to add bot to the group with default instructions
                  await safeEditMessageText(ctx,
                    `✅ Bot is ready to be added to "${groupName}" with default settings!\n\n` +
                    `Click the button below to add the bot to your group:`,
                    {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: '➕ Add Bot to Group', url: `https://t.me/${ctx.botInfo.username}?startgroup=true` }],
                          [{ text: '« Back to Main Menu', callback_data: 'back_to_main' }]
                        ]
                      }
                    }
                  );
                }

                async function handleSetCustomInstructions(ctx) {
                  console.log(`[Get Started] User ${ctx.from.id} setting custom instructions`);
                  await ctx.answerCbQuery('Setting up custom instructions...');

                  // Get state
                  const userId = ctx.from.id.toString();
                  const state = global.userStates.get(userId);

                  if (!state || !state.groupName) {
                    // Something went wrong, go back to main menu
                    console.log(`[Get Started] Missing group name in state for user ${userId}`);
                    await ctx.reply('⚠️ Error: Group name not found. Please start again.');

                    // Show main menu
                    const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                    await ctx.reply(welcomeMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                    return;
                  }

                  // Update state to wait for custom instructions
                  global.userStates.set(userId, {
                    waitingFor: 'custom_instructions',
                    groupName: state.groupName,
                    timestamp: Date.now()
                  });

                  // Get default instructions
                  const defaultInstructions = agent.summary.system || 'No default instructions set for this agent.';

                  // Ask for custom instructions and include the default instructions for reference
                  await safeEditMessageText(ctx,
                    `*Group: ${state.groupName}*\n\n` +
                    `Please type your custom instructions for the bot in this group.\n\n` +
                    `These instructions will tell me how to behave, what's allowed/not allowed, and any special rules for the group.\n\n` +
                    `*Default System Instructions (you can copy and modify):*\n` +
                    `\`\`\`\n${defaultInstructions}\n\`\`\`\n\n` +
                    `Type or paste your instructions now, or type /cancel to abort.`,
                    { parse_mode: 'Markdown' }
                  );
                }

                async function handleViewGroupInstructions(ctx, groupName) {
                  console.log(`[Group Management] User ${ctx.from.id} viewing instructions for group ${groupName}`);
                  await ctx.answerCbQuery('Loading saved instructions...');

                  // Get instructions from pending map
                  if (global.pendingGroupInstructions && global.pendingGroupInstructions.has(groupName)) {
                    const instructions = global.pendingGroupInstructions.get(groupName);
                    await safeEditMessageText(ctx,
                      `*Saved Instructions for "${groupName}"*\n\n` +
                      `\`\`\`\n${instructions}\n\`\`\`\n\n` +
                      `These instructions will be applied when you add the bot to this group.`,
                      {
                        parse_mode: 'Markdown',
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: '➕ Add Bot to Group', url: `https://t.me/${ctx.botInfo.username}?startgroup=true` }],
                            [{ text: '« Back', callback_data: 'back_to_main' }]
                          ]
                        }
                      }
                    );
                  } else {
                    await safeEditMessageText(ctx,
                      `No saved instructions found for "${groupName}".\n\n` +
                      `You may have already added the bot to this group, or the instructions expired.`,
                      {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: '« Back', callback_data: 'back_to_main' }]
                          ]
                        }
                      }
                    );
                  }
                }

                // Group management functions
                async function handleGroupSelection(ctx, groupId) {
                  console.log(`[Group Management] User ${ctx.from.id} selecting group ${groupId}`);
                  await ctx.answerCbQuery('Loading group information...');

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await safeEditMessageText(ctx, 'Could not find group information. The group may have been deleted.', {
                        reply_markup: {
                          inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                        }
                      });
                      return;
                    }

                    // Get bot permissions in this group
                    let botPermissions = 'Unknown';
                    let isAdmin = false;

                    try {
                      const botMember = await ctx.telegram.getChatMember(groupId, ctx.botInfo.id);
                      isAdmin = botMember.status === 'administrator';
                      botPermissions = isAdmin ? 'Administrator' : botMember.status;
                    } catch (error) {
                      console.error(`[Group Management] Error getting bot permissions for group ${groupId}:`, error);
                      botPermissions = 'Error checking permissions';
                    }

                    // Build group info message
                    let message = `*Group: ${group.groupName}*\n\n`;
                    message += `*Status*\n`;
                    message += `• Type: ${group.groupType === 'supergroup' ? 'Supergroup' : 'Group'}\n`;
                    message += `• Bot Status: ${botPermissions}\n`;
                    message += `• Moderation: ${group.moderationEnabled ? '✅ Enabled' : '❌ Disabled'}\n`;
                    message += `• Active: ${group.isActive ? '✅ Yes' : '❌ No'}\n\n`;

                    if (group.customInstructions) {
                      message += `*Custom Instructions*\n`;
                      const shortInstructions = group.customInstructions.substring(0, 200);
                      message += `\`\`\`\n${shortInstructions}${group.customInstructions.length > 200 ? '...' : ''}\n\`\`\`\n\n`;
                    } else {
                      message += `*Using Default Instructions*\n\n`;
                    }

                    // Create action buttons
                    const actionButtons = [];

                    // Moderation toggle button
                    if (group.moderationEnabled) {
                      actionButtons.push([{ text: '🔴 Disable Moderation', callback_data: `group_mod_off_${groupId}` }]);
                    } else {
                      actionButtons.push([{ text: '🟢 Enable Moderation', callback_data: `group_mod_on_${groupId}` }]);
                    }

                    // Instructions update button
                    if (group.customInstructions) {
                      actionButtons.push([
                        { text: '📝 Update Instructions', callback_data: `group_update_instructions_${groupId}` },
                        { text: '🔄 Reset to Default', callback_data: `group_reset_instructions_${groupId}` }
                      ]);
                    } else {
                      actionButtons.push([{ text: '📝 Set Custom Instructions', callback_data: `group_update_instructions_${groupId}` }]);
                    }

                    // API key button
                    actionButtons.push([{ text: '🔑 Manage API Key', callback_data: `group_apikey_${groupId}` }]);

                    // Remove bot button
                    actionButtons.push([{ text: '❌ Remove Bot from Group', callback_data: `group_remove_${groupId}` }]);

                    // Back button
                    actionButtons.push([{ text: '« Back to Groups', callback_data: 'list_groups' }]);

                    const keyboard = {
                      inline_keyboard: actionButtons
                    };

                    await safeEditMessageText(ctx, message, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                  } catch (error) {
                    console.error(`[Group Management] Error handling group selection:`, error);
                    await safeEditMessageText(ctx, 'An error occurred while loading group information. Please try again later.', {
                      reply_markup: {
                        inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                      }
                    });
                  }
                }

                async function handleGroupRemoval(ctx, groupId) {
                  console.log(`[Group Management] User ${ctx.from.id} requesting bot removal from group ${groupId}`);
                  await ctx.answerCbQuery('Processing removal request...');

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await safeEditMessageText(ctx, 'Could not find group information. The group may have been deleted.', {
                        reply_markup: {
                          inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                        }
                      });
                      return;
                    }

                    // Show confirmation message
                    const confirmMessage = `⚠️ *Are you sure you want to remove the bot from "${group.groupName}"?*\n\n` +
                      `This will:\n` +
                      `• Remove the bot from the group\n` +
                      `• Disable all moderation features\n` +
                      `• Preserve your group settings for if you add the bot again later\n\n` +
                      `To confirm, click "Yes, Remove Bot" below:`;

                    const keyboard = {
                      inline_keyboard: [
                        [
                          { text: '✅ Yes, Remove Bot', callback_data: `group_remove_confirm_${groupId}` },
                          { text: '❌ Cancel', callback_data: `group_${groupId}` }
                        ]
                      ]
                    };

                    await safeEditMessageText(ctx, confirmMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                  } catch (error) {
                    console.error(`[Group Management] Error handling group removal:`, error);
                    await safeEditMessageText(ctx, 'An error occurred while processing your request. Please try again later.', {
                      reply_markup: {
                        inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                      }
                    });
                  }
                }

                async function toggleGroupModeration(ctx, groupId, enable) {
                  console.log(`[Group Management] User ${ctx.from.id} ${enable ? 'enabling' : 'disabling'} moderation for group ${groupId}`);
                  await ctx.answerCbQuery(`${enable ? 'Enabling' : 'Disabling'} moderation...`);

                  try {
                    // Update moderation status
                    await groupService.updateGroupModeration(groupId, enable);

                    // Get updated group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await safeEditMessageText(ctx, 'Could not find group information. The group may have been deleted.', {
                        reply_markup: {
                          inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                        }
                      });
                      return;
                    }

                    // Show success message
                    const statusMessage = `✅ Moderation has been ${enable ? 'enabled' : 'disabled'} for "${group.groupName}".\n\n` +
                      `${enable ?
                        'The bot will now actively moderate messages according to its instructions.' :
                        'The bot will no longer moderate messages but will still respond to commands and direct mentions.'}`;

                    const keyboard = {
                      inline_keyboard: [
                        [{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]
                      ]
                    };

                    await safeEditMessageText(ctx, statusMessage, {
                      reply_markup: keyboard
                    });

                    // Also send a message to the group about the change
                    try {
                      await ctx.telegram.sendMessage(groupId,
                        `🔔 *Moderation Status Change*\n\n` +
                        `Moderation has been ${enable ? 'enabled' : 'disabled'} for this group by an admin.\n\n` +
                        `${enable ?
                          'I will now actively moderate messages according to my instructions.' :
                          'I will no longer moderate messages but will still respond to commands and direct mentions.'}`,
                        { parse_mode: 'Markdown' }
                      );
                    } catch (notifyError) {
                      console.error(`[Group Management] Error notifying group ${groupId} about moderation change:`, notifyError);
                      // Just log this error but continue - notification to the group is optional
                    }
                  } catch (error) {
                    console.error(`[Group Management] Error toggling moderation for group ${groupId}:`, error);
                    await safeEditMessageText(ctx, 'An error occurred while updating moderation settings. Please try again later.', {
                      reply_markup: {
                        inline_keyboard: [[{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]]
                      }
                    });
                  }
                }

                async function handleUpdateGroupInstructions(ctx, groupId) {
                  console.log(`[Group Management] User ${ctx.from.id} updating instructions for group ${groupId}`);
                  await ctx.answerCbQuery('Preparing to update instructions...');

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await safeEditMessageText(ctx, 'Could not find group information. The group may have been deleted.', {
                        reply_markup: {
                          inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                        }
                      });
                      return;
                    }

                    // Get default instructions
                    const defaultInstructions = agent.summary.system || 'No default instructions set for this agent.';

                    // Show current instructions or default text
                    let promptMessage = `*Update Instructions for ${group.groupName}*\n\n`;

                    if (group.customInstructions) {
                      promptMessage += `Current Instructions:\n`;
                      promptMessage += `\`\`\`\n${group.customInstructions}\n\`\`\`\n\n`;
                    } else {
                      promptMessage += `This group is currently using the default instructions.\n\n`;
                    }

                    // Always show default instructions as reference
                    promptMessage += `*Default System Instructions (reference):*\n`;
                    promptMessage += `\`\`\`\n${defaultInstructions}\n\`\`\`\n\n`;

                    promptMessage += `Please enter the new instructions for the bot in this group. These instructions will tell me how to behave, what's allowed/not allowed, and any special rules for the group.\n\nReply to this message with your instructions, or type /cancel to abort.`;

                    // Set user state to wait for new instructions
                    const userId = ctx.from.id.toString();
                    global.userStates.set(userId, {
                      waitingFor: 'group_instructions',
                      groupId: groupId,
                      timestamp: Date.now()
                    });

                    await safeEditMessageText(ctx, promptMessage, {
                      parse_mode: 'Markdown'
                    });

                    // Add a way for the user to cancel
                    await ctx.reply('Type /cancel to abort this operation.', {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]
                        ]
                      }
                    });
                  } catch (error) {
                    console.error(`[Group Management] Error handling instruction update for group ${groupId}:`, error);
                    await safeEditMessageText(ctx, 'An error occurred while loading group information. Please try again later.', {
                      reply_markup: {
                        inline_keyboard: [[{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]]
                      }
                    });
                  }
                }

                async function handleResetGroupInstructions(ctx, groupId) {
                  console.log(`[Group Management] User ${ctx.from.id} resetting instructions for group ${groupId}`);
                  await ctx.answerCbQuery('Processing reset request...');

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await safeEditMessageText(ctx, 'Could not find group information. The group may have been deleted.', {
                        reply_markup: {
                          inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                        }
                      });
                      return;
                    }

                    // Show confirmation message
                    const confirmationMessage = `⚠️ *Reset Group Instructions*\n\n` +
                      `Are you sure you want to reset the instructions for "${group.groupName}" to the default?\n\n` +
                      `This will remove all custom instructions for this group.`;

                    const keyboard = {
                      inline_keyboard: [
                        [
                          { text: '✅ Yes, Reset to Default', callback_data: `group_reset_confirm_${groupId}` },
                          { text: '❌ Cancel', callback_data: `group_${groupId}` }
                        ]
                      ]
                    };

                    await safeEditMessageText(ctx, confirmationMessage, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                  } catch (error) {
                    console.error(`[Group Management] Error handling instruction reset for group ${groupId}:`, error);
                    await safeEditMessageText(ctx, 'An error occurred while processing your request. Please try again later.', {
                      reply_markup: {
                        inline_keyboard: [[{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]]
                      }
                    });
                  }
                }

                async function handleConfirmResetGroupInstructions(ctx, groupId) {
                  console.log(`[Group Management] User ${ctx.from.id} confirming reset of instructions for group ${groupId}`);
                  await ctx.answerCbQuery('Resetting instructions...');

                  try {
                    // Clear instructions from database
                    await groupService.clearGroupInstructions(groupId);

                    // Get updated group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await safeEditMessageText(ctx, 'Could not find group information. The group may have been deleted.', {
                        reply_markup: {
                          inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                        }
                      });
                      return;
                    }

                    // Show success message
                    const successMessage = `✅ Instructions for "${group.groupName}" have been reset to default.\n\n` +
                      `The bot will now use the agent's default instructions for this group.`;

                    const keyboard = {
                      inline_keyboard: [
                        [{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]
                      ]
                    };

                    await safeEditMessageText(ctx, successMessage, {
                      reply_markup: keyboard
                    });

                    // Also notify the group about the change
                    try {
                      await ctx.telegram.sendMessage(groupId,
                        `🔔 *Instructions Update*\n\n` +
                        `The bot instructions for this group have been reset to default by an admin.`,
                        { parse_mode: 'Markdown' }
                      );
                    } catch (notifyError) {
                      console.error(`[Group Management] Error notifying group ${groupId} about instruction reset:`, notifyError);
                      // Just log this error but continue - notification to the group is optional
                    }
                  } catch (error) {
                    console.error(`[Group Management] Error confirming instruction reset for group ${groupId}:`, error);
                    await safeEditMessageText(ctx, 'An error occurred while resetting instructions. Please try again later.', {
                      reply_markup: {
                        inline_keyboard: [[{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]]
                      }
                    });
                  }
                }

                async function handleGroupApiKeySetup(ctx, groupId) {
                  console.log(`[Group Management] User ${ctx.from.id} setting API key for group ${groupId}`);
                  await ctx.answerCbQuery('Loading API key options...');

                  try {
                    // Get group info
                    const group = await groupService.getGroupByTelegramId(groupId);

                    if (!group) {
                      await safeEditMessageText(ctx, 'Could not find group information. The group may have been deleted.', {
                        reply_markup: {
                          inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]]
                        }
                      });
                      return;
                    }

                    // Get user's API key
                    const userId = ctx.from.id.toString();
                    const User = require('./models/User');
                    const userWithApiKey = await User.findOne({ telegramUserId: userId });
                    const hasUserApiKey = userWithApiKey && userWithApiKey.apiKey && userWithApiKey.apiKey.length > 0;

                    if (!hasUserApiKey) {
                      await safeEditMessageText(ctx,
                        `❌ You don't have a personal API key configured.\n\n` +
                        `To manage API keys for groups, you need to set up your own API key first.`,
                        {
                          reply_markup: {
                            inline_keyboard: [
                              [{ text: '🔑 Set Up API Key', callback_data: 'setup_apikey' }],
                              [{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]
                            ]
                          }
                        }
                      );
                      return;
                    }

                    // Check current API key for the group
                    const currentKeyUserId = group.apiKeyUserId ? group.apiKeyUserId.toString() : null;
                    const isUsingYourKey = currentKeyUserId && userWithApiKey && currentKeyUserId === userWithApiKey._id.toString();

                    // Show message with options
                    let message = `*API Key Settings for "${group.groupName}"*\n\n`;

                    if (currentKeyUserId) {
                      message += `This group is currently using ${isUsingYourKey ? 'your personal' : 'another user\'s'} API key.\n\n`;
                    } else {
                      message += `This group doesn't have an API key configured yet.\n\n`;
                    }

                    message += `What would you like to do?`;

                    const keyboard = {
                      inline_keyboard: [
                        [{ text: '🔑 Use My API Key', callback_data: `group_apikey_set_mine_${groupId}` }]
                      ]
                    };

                    // Add option to remove API key if using yours
                    if (isUsingYourKey) {
                      keyboard.inline_keyboard.push([
                        { text: '❌ Remove My API Key', callback_data: `group_apikey_remove_${groupId}` }
                      ]);
                    }

                    // Back button
                    keyboard.inline_keyboard.push([
                      { text: '« Back to Group Settings', callback_data: `group_${groupId}` }
                    ]);

                    await safeEditMessageText(ctx, message, {
                      reply_markup: keyboard,
                      parse_mode: 'Markdown'
                    });
                  } catch (error) {
                    console.error(`[Group Management] Error handling API key setup for group ${groupId}:`, error);
                    await safeEditMessageText(ctx, 'An error occurred while loading API key options. Please try again later.', {
                      reply_markup: {
                        inline_keyboard: [[{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]]
                      }
                    });
                  }
                }

                // Function to handle adding the bot to a new group
                async function handleAddToNewGroup(ctx) {
                  console.log(`[Get Started] User ${ctx.from.id} initiating add to new group flow`);
                  await ctx.answerCbQuery('Starting new group setup...');

                  // Ask for group name
                  await safeEditMessageText(ctx,
                    `*Add Bot to New Group*\n\n` +
                    `Please enter the name of the group you want to add me to.\n\n` +
                    `This name will be used to prepare custom settings for your group.`,
                    { parse_mode: 'Markdown' }
                  );

                  // Set user state to wait for group name
                  const userId = ctx.from.id.toString();
                  global.userStates.set(userId, {
                    waitingFor: 'group_name',
                    timestamp: Date.now()
                  });

                  // Help text with cancel option
                  await ctx.reply(
                    'Type the name of your group, or /cancel to abort.',
                    {
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: '« Back to Main Menu', callback_data: 'back_to_main' }]
                        ]
                      }
                    }
                  );
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
                    // ... (existing code)
                    return;
                  } else if (userState && userState.waitingFor === 'group_name' && ctx.chat.type === 'private') {
                    // Handle group name input
                    const groupName = ctx.message.text.trim();
                    console.log(`[Get Started] Received group name from user ${userId}: ${groupName}`);

                    // Handle potential cancellation
                    if (groupName.toLowerCase() === '/cancel') {
                      console.log(`[Get Started] User ${userId} cancelled group selection`);
                      global.userStates.delete(userId);
                      await ctx.reply('Operation cancelled. Returning to main menu.');

                      // Show main menu
                      const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                      await ctx.reply(welcomeMessage, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                      });
                      return;
                    }

                    // Update state with selected group name
                    global.userStates.set(userId, {
                      waitingFor: 'instruction_choice',
                      groupName: groupName,
                      timestamp: Date.now()
                    });

                    // Get default instructions
                    const defaultInstructions = agent.summary.system || 'No default instructions set for this agent.';

                    // Show options for default or custom instructions
                    const message = `*Group: ${groupName}*\n\n` +
                      `How would you like to set up the bot for this group?\n\n` +
                      `*Default Instructions:*\n\`\`\`\n${defaultInstructions.substring(0, 200)}${defaultInstructions.length > 200 ? '...' : ''}\n\`\`\`\n\n` +
                      `Choose an option:`;

                    await ctx.reply(message, {
                      parse_mode: 'Markdown',
                      reply_markup: {
                        inline_keyboard: [
                          [{ text: '✅ Use Default Instructions', callback_data: 'use_default_for_group' }],
                          [{ text: '✏️ Set Custom Instructions', callback_data: 'set_custom_for_group' }],
                          [{ text: '« Cancel', callback_data: 'back_to_main' }]
                        ]
                      }
                    });

                    return;
                  } else if (userState && userState.waitingFor === 'custom_instructions' && ctx.chat.type === 'private') {
                    // Handle custom instructions input
                    const instructions = ctx.message.text.trim();
                    console.log(`[Get Started] Received custom instructions from user ${userId}`);

                    // Handle potential cancellation
                    if (instructions.toLowerCase() === '/cancel') {
                      console.log(`[Get Started] User ${userId} cancelled custom instructions`);
                      global.userStates.delete(userId);
                      await ctx.reply('Operation cancelled. Returning to main menu.');

                      // Show main menu
                      const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                      await ctx.reply(welcomeMessage, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                      });
                      return;
                    }

                    // Store custom instructions for this group
                    const groupName = userState.groupName;

                    // Store this in a global map
                    global.pendingGroupInstructions.set(groupName, instructions);

                    // Clear the waiting state
                    global.userStates.delete(userId);

                    // Provide link to add bot to the group with custom instructions
                    await ctx.reply(
                      `✅ Custom instructions saved for "${groupName}"!\n\n` +
                      `Click the button below to add the bot to your group:`,
                      {
                        reply_markup: {
                          inline_keyboard: [
                            [{ text: '➕ Add Bot to Group', url: `https://t.me/${ctx.botInfo.username}?startgroup=true` }],
                            [{ text: 'View Saved Instructions', callback_data: `view_group_instructions_${groupName}` }],
                            [{ text: '« Back to Main Menu', callback_data: 'back_to_main' }]
                          ]
                        }
                      }
                    );

                    return;
                  } else if (userState && userState.waitingFor === 'group_instructions' && ctx.chat.type === 'private') {
                    // Handle updating instructions for an existing group
                    const instructions = ctx.message.text.trim();
                    const groupId = userState.groupId;
                    console.log(`[Group Management] Received updated instructions for group ${groupId} from user ${userId}`);

                    // Handle potential cancellation
                    if (instructions.toLowerCase() === '/cancel') {
                      console.log(`[Group Management] User ${userId} cancelled instruction update`);
                      global.userStates.delete(userId);
                      await ctx.reply('Instruction update cancelled. Returning to group settings.');

                      // Show group settings
                      const group = await groupService.getGroupByTelegramId(groupId);
                      if (group) {
                        await ctx.reply(`Returning to settings for group "${group.groupName}"...`);
                        await handleGroupSelection(ctx, groupId);
                      } else {
                        // Fallback to main menu if group not found
                        const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);
                        await ctx.reply(welcomeMessage, {
                          reply_markup: keyboard,
                          parse_mode: 'Markdown'
                        });
                      }
                      return;
                    }

                    // Show loading message
                    await ctx.reply('Updating group instructions...');

                    try {
                      // Update instructions in the database
                      await groupService.setGroupInstructions(groupId, instructions);

                      // Get updated group info
                      const group = await groupService.getGroupByTelegramId(groupId);

                      // Clear the waiting state
                      global.userStates.delete(userId);

                      // Success message
                      await ctx.reply(
                        `✅ Instructions updated for "${group.groupName}"!\n\n` +
                        `The bot will now use these custom instructions for this group.`,
                        {
                          reply_markup: {
                            inline_keyboard: [
                              [{ text: '« Back to Group Settings', callback_data: `group_${groupId}` }]
                            ]
                          }
                        }
                      );

                      // Also notify the group about the change
                      try {
                        await ctx.telegram.sendMessage(groupId,
                          `🔔 *Instructions Update*\n\n` +
                          `The bot instructions for this group have been updated by an admin.`,
                          { parse_mode: 'Markdown' }
                        );
                      } catch (notifyError) {
                        console.error(`[Group Management] Error notifying group ${groupId} about instruction update:`, notifyError);
                        // Just log this error but continue - notification to the group is optional
                      }
                    } catch (error) {
                      console.error(`[Group Management] Error updating instructions for group ${groupId}:`, error);
                      await ctx.reply('⚠️ An error occurred while updating the instructions. Please try again later.');
                    }

                    return;
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
                      await safeAnswerCbQuery(ctx, 'Returning to main menu...');

                      // Get menu options
                      const { welcomeMessage, keyboard } = await generateMainMenu(ctx, agent);

                      // Edit the current message instead of sending a new one
                      await safeEditMessageText(ctx, welcomeMessage, {
                        reply_markup: keyboard,
                        parse_mode: 'Markdown'
                      });
                      console.log(`[Callback] Displayed main menu to user ${ctx.from.id}`);
                      break;

                    case 'get_started':
                      console.log(`[Callback] User ${ctx.from.id} starting Get Started flow`);
                      await handleGetStarted(ctx);
                      break;

                    case 'add_to_new_group':
                      console.log(`[Callback] User ${ctx.from.id} choosing to add bot to a new group`);
                      await handleAddToNewGroup(ctx);
                      break;

                    case 'use_default_for_group':
                      console.log(`[Callback] User ${ctx.from.id} choosing to use default instructions`);
                      await handleUseDefaultInstructions(ctx);
                      break;

                    case 'set_custom_for_group':
                      console.log(`[Callback] User ${ctx.from.id} choosing to set custom instructions`);
                      await handleSetCustomInstructions(ctx);
                      break;

                    case 'list_groups':
                      console.log(`[Callback] User ${ctx.from.id} requested group listing`);
                      await safeAnswerCbQuery(ctx, 'Fetching your groups...');

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

                          await safeEditMessageText(ctx, message, { reply_markup: groupsKeyboard });
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

                          await safeEditMessageText(ctx, message, {
                            reply_markup: groupsKeyboard,
                            parse_mode: 'Markdown'
                          });
                          console.log(`[Callback] Displayed group list to user ${ctx.from.id}`);
                        }
                      } catch (error) {
                        console.error(`[Callback] Error listing groups for user ${ctx.from.id}:`, error);
                        await safeAnswerCbQuery(ctx, 'Error fetching groups. Please try again later.');
                      }
                      break;

                    default:
                      // Handle group-related callbacks (they start with "group_")
                      if (callbackData.startsWith('group_')) {
                        // Extract the group ID from the callback data
                        if (callbackData.startsWith('group_api')) {
                          console.log(`[Callback] Group API key callback received: ${callbackData}`);
                          // Group API key related callbacks
                          if (callbackData.startsWith('group_apikey_')) {
                            const groupId = callbackData.replace('group_apikey_', '');
                            console.log(`[Callback] User ${ctx.from.id} setting API key for group ${groupId}`);
                            await handleGroupApiKeySetup(ctx, groupId);
                          }
                        } else if (callbackData.startsWith('group_mod_')) {
                          // Group moderation settings
                          if (callbackData.startsWith('group_mod_on_')) {
                            const groupId = callbackData.replace('group_mod_on_', '');
                            console.log(`[Callback] User ${ctx.from.id} enabling moderation for group ${groupId}`);
                            await toggleGroupModeration(ctx, groupId, true);
                          } else if (callbackData.startsWith('group_mod_off_')) {
                            const groupId = callbackData.replace('group_mod_off_', '');
                            console.log(`[Callback] User ${ctx.from.id} disabling moderation for group ${groupId}`);
                            await toggleGroupModeration(ctx, groupId, false);
                          }
                        } else if (callbackData.startsWith('group_update_instructions_')) {
                          // Handle updating group instructions
                          const groupId = callbackData.replace('group_update_instructions_', '');
                          console.log(`[Callback] User ${ctx.from.id} updating instructions for group ${groupId}`);
                          await handleUpdateGroupInstructions(ctx, groupId);
                        } else if (callbackData.startsWith('group_reset_instructions_')) {
                          // Handle resetting group instructions to default
                          const groupId = callbackData.replace('group_reset_instructions_', '');
                          console.log(`[Callback] User ${ctx.from.id} resetting instructions for group ${groupId}`);
                          await handleResetGroupInstructions(ctx, groupId);
                        } else if (callbackData.startsWith('group_reset_confirm_')) {
                          // Handle confirmed reset of group instructions
                          const groupId = callbackData.replace('group_reset_confirm_', '');
                          console.log(`[Callback] User ${ctx.from.id} confirmed reset of instructions for group ${groupId}`);
                          await handleConfirmResetGroupInstructions(ctx, groupId);
                        } else if (callbackData.startsWith('group_remove_confirm_')) {
                          // Handle confirmation of group removal
                          const groupId = callbackData.replace('group_remove_confirm_', '');
                          console.log(`[Callback] User ${ctx.from.id} confirmed removal of bot from group ${groupId}`);

                          // Handle removal confirmation
                          try {
                            await safeAnswerCbQuery(ctx, 'Removing bot from group...');

                            // Get group info
                            const group = await groupService.getGroupByTelegramId(groupId);

                            if (!group) {
                              await safeAnswerCbQuery(ctx, 'Error: Group not found');
                              await safeEditMessageText(ctx, 'Could not find group information. Please try again or contact support.',
                                { reply_markup: { inline_keyboard: [[{ text: '« Back to Groups', callback_data: 'list_groups' }]] } });
                              return;
                            }

                            // Try to leave the group
                            try {
                              await ctx.telegram.leaveChat(groupId);
                              console.log(`[Group Removal] Successfully left group ${groupId}`);

                              // Show success message
                              await safeEditMessageText(ctx,
                                `✅ Successfully removed bot from *${group.groupName}*\n\n` +
                                `The bot has left the group and all moderation features are now disabled.\n\n` +
                                `You can add the bot back at any time.`, {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                  inline_keyboard: [
                                    [{ text: '« Back to Groups', callback_data: 'list_groups' }]
                                  ]
                                }
                              });

                              // Mark the group as inactive
                              await groupService.deactivateGroup(groupId);

                            } catch (leaveError) {
                              console.error(`[Group Removal] Error leaving group ${groupId}:`, leaveError);

                              // If we get a "bot is not a member" error, just mark as inactive
                              if (leaveError.description && (
                                leaveError.description.includes('bot is not a member') ||
                                leaveError.description.includes('chat not found')
                              )) {
                                console.log(`[Group Removal] Bot is no longer in group ${groupId}, marking as inactive`);
                                await groupService.deactivateGroup(groupId);

                                await safeEditMessageText(ctx,
                                  `Bot is no longer in *${group.groupName}*\n\n` +
                                  `The group has been marked as inactive in the database.`,
                                  {
                                    parse_mode: 'Markdown',
                                    reply_markup: {
                                      inline_keyboard: [
                                        [{ text: '« Back to Groups', callback_data: 'list_groups' }]
                                      ]
                                    }
                                  }
                                );
                              } else {
                                // For other errors, show error message
                                await safeEditMessageText(ctx,
                                  `❌ Error removing bot from group\n\n` +
                                  `Please try manually removing the bot from the group.\n\n` +
                                  `Error: ${leaveError.description || 'Unknown error'}`,
                                  {
                                    reply_markup: {
                                      inline_keyboard: [
                                        [{ text: '« Back to Groups', callback_data: 'list_groups' }]
                                      ]
                                    }
                                  }
                                );
                              }
                            }
                          } catch (error) {
                            console.error(`[Group Removal] Error processing removal confirmation:`, error);
                            await safeAnswerCbQuery(ctx, 'An error occurred while removing the bot. Please try again later.');
                          }
                        } else if (callbackData.startsWith('group_remove_')) {
                          // Show removal confirmation
                          const groupId = callbackData.replace('group_remove_', '');
                          console.log(`[Callback] User ${ctx.from.id} requesting removal of bot from group ${groupId}`);
                          await handleGroupRemoval(ctx, groupId);
                        } else {
                          // Otherwise, assume it's a group selection
                          const groupId = callbackData.replace('group_', '');
                          console.log(`[Callback] User ${ctx.from.id} selecting group ${groupId}`);
                          await handleGroupSelection(ctx, groupId);
                        }
                      } else if (callbackData.startsWith('view_group_instructions_')) {
                        // Handle viewing group instructions
                        const groupName = callbackData.replace('view_group_instructions_', '');
                        console.log(`[Callback] User ${ctx.from.id} viewing instructions for group ${groupName}`);
                        await handleViewGroupInstructions(ctx, groupName);
                      } else {
                        console.log(`[Callback] Unknown callback query from user ${ctx.from.id}: ${callbackData}`);
                        await safeAnswerCbQuery(ctx, 'This feature is not implemented yet.');
                      }
                  }
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

                      // Check if there are pending instructions for this group
                      if (global.pendingGroupInstructions && global.pendingGroupInstructions.has(chatTitle)) {
                        console.log(`[Bot Status] Found pending instructions for group "${chatTitle}"`);
                        groupData.customInstructions = global.pendingGroupInstructions.get(chatTitle);

                        // Remove from pending instructions once applied
                        global.pendingGroupInstructions.delete(chatTitle);
                      }

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
                  console.log(`Bot stored in active bots map. Total active bots: ${activeBots.size}`);
                  console.log(`Active bot tokens: ${activeTokens.size}`);

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
  const intervalMs = intervalMinutes * 1000;
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