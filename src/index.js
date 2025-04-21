const { Telegraf } = require('telegraf');
const express = require('express');
require('dotenv').config();

// Import controllers and services
const messageController = require('./controllers/messageController');
const { connectDB } = require('./config/database');
const logger = require('./services/loggerService');
const { startWebServer } = require('./web/server');

const fullmetalApiKey = process.env.FULLMETAL_API_KEY;
const fullmetalAgentId = process.env.FULLMETAL_AGENT_ID;

// Create Express app for serverless environments
const app = express();

// Initialize the bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Connect to the database
connectDB();

// Configure bot commands and handlers
setupBot(bot);

// Handle Vercel serverless environment
if (process.env.VERCEL) {
  // Define a route that Vercel can ping to keep the bot "alive"
  app.get('/', (req, res) => {
    res.send('Bot is running!');
  });

  // Set webhook for Telegram updates (for production)
  const WEBHOOK_URL = process.env.VERCEL_URL || process.env.WEBHOOK_URL;
  if (WEBHOOK_URL) {
    logger.info(`Setting webhook to ${WEBHOOK_URL}`);
    bot.telegram.setWebhook(`${WEBHOOK_URL}/api/webhook`);

    // Handle webhook route
    app.use(bot.webhookCallback('/api/webhook'));
  } else {
    logger.error('WEBHOOK_URL not set in environment variables');
  }

  // Export the Express app for Vercel
  module.exports = app;
} else {
  // Start the web server for logs in development environment
  startWebServer();

  // Start the bot in polling mode (for development)
  bot.launch();
  logger.info('Telegram bot started successfully in polling mode');
  console.log('🤖 Telegram bot is running in polling mode...');
  console.log('📊 Log viewer available at http://localhost:3000');

  // Enable graceful stop
  process.once('SIGINT', () => {
    logger.info('Bot stopping due to SIGINT');
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    logger.info('Bot stopping due to SIGTERM');
    bot.stop('SIGTERM');
  });
}

// Helper function to set up bot commands and handlers
function setupBot(bot) {
  // Bot commands
  bot.start((ctx) => {
    logger.info('Bot started by user', { userId: ctx.from.id, username: ctx.from.username });
    return ctx.reply('👋 Hi! Talk to me or use /chat to get started.');
  });

  bot.command('chat', async (ctx) => {
    const userInput = ctx.message.text.replace('/chat', '').trim();
    if (!userInput) return ctx.reply('❓ What do you want to say?');

    try {
      logger.info('Chat command received', { userId: ctx.from.id, message: userInput });
      await messageController.processMessage(userInput, ctx);
    } catch (error) {
      logger.error('Error processing chat command', { userId: ctx.from.id, error: error.message, stack: error.stack });
      console.error('Error:', error);
      ctx.reply('⚠️ An error occurred while processing your request.');
    }
  });

  // Command to set or update agent pre-prompt
  bot.command('setprompt', async (ctx) => {
    try {
      logger.info('Set prompt command received', { userId: ctx.from.id, text: ctx.message.text });
      await messageController.setPrePrompt(ctx);
    } catch (error) {
      logger.error('Error setting pre-prompt', { userId: ctx.from.id, error: error.message });
      console.error('Error setting pre-prompt:', error);
      ctx.reply('⚠️ An error occurred while updating the pre-prompt.');
    }
  });

  // Command to get agent info
  bot.command('agentinfo', async (ctx) => {
    try {
      logger.info('Agent info command received', { userId: ctx.from.id, text: ctx.message.text });
      await messageController.getAgentInfo(ctx);
    } catch (error) {
      logger.error('Error getting agent info', { userId: ctx.from.id, error: error.message });
      console.error('Error getting agent info:', error);
      ctx.reply('⚠️ An error occurred while retrieving agent information.');
    }
  });

  // Register bot commands with BotFather
  bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'chat', description: 'Chat with the AI' },
    { command: 'setprompt', description: 'Set a pre-prompt for an agent' },
    { command: 'agentinfo', description: 'Get information about an agent' }
  ]).then(() => {
    logger.info('Bot commands registered with Telegram');
    console.log('Bot commands registered with Telegram');
  }).catch(error => {
    logger.error('Failed to register commands', { error: error.message });
    console.error('Failed to register commands:', error);
  });

  // Handle text messages
  bot.on('text', async (ctx) => {
    try {
      logger.info('Text message received', {
        userId: ctx.from.id,
        username: ctx.from.username,
        messageId: ctx.message.message_id,
        text: ctx.message.text
      });
      ctx.reply('🧠 Thinking...');
      await messageController.processMessage(ctx.message.text, ctx, fullmetalApiKey, fullmetalAgentId);
      logger.info('Text message processed', {
        userId: ctx.from.id,
        username: ctx.from.username,
        messageId: ctx.message.message_id,
        text: ctx.message.text
      });
    } catch (error) {
      logger.error('Error processing message', { userId: ctx.from.id, error: error.message, stack: error.stack });
      console.error('Error:', error);
      ctx.reply('⚠️ An error occurred while processing your request.');
    }
  });
} 