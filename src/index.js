const { Telegraf } = require('telegraf');
require('dotenv').config();

// Import controllers and services
const messageController = require('./controllers/messageController');
const { connectDB } = require('./config/database');

const fullmetalApiKey = process.env.FULLMETAL_API_KEY;
const fullmetalAgentId = process.env.FULLMETAL_AGENT_ID;
// Initialize the bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
// Connect to the database
connectDB();

// Bot commands
bot.start((ctx) => ctx.reply('👋 Hi! Talk to me or use /chat to get started.'));

bot.command('chat', async (ctx) => {
  const userInput = ctx.message.text.replace('/chat', '').trim();
  if (!userInput) return ctx.reply('❓ What do you want to say?');

  try {
    await messageController.processMessage(userInput, ctx);
  } catch (error) {
    console.error('Error:', error);
    ctx.reply('⚠️ An error occurred while processing your request.');
  }
});

// Command to set or update agent pre-prompt
bot.command('setprompt', async (ctx) => {
  try {
    await messageController.setPrePrompt(ctx);
  } catch (error) {
    console.error('Error setting pre-prompt:', error);
    ctx.reply('⚠️ An error occurred while updating the pre-prompt.');
  }
});

// Command to get agent info
bot.command('agentinfo', async (ctx) => {
  try {
    await messageController.getAgentInfo(ctx);
  } catch (error) {
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
  console.log('Bot commands registered with Telegram');
}).catch(error => {
  console.error('Failed to register commands:', error);
});

// Handle text messages
bot.on('text', async (ctx) => {
  try {
    ctx.reply('🧠 Thinking...');
    await messageController.processMessage(ctx.message.text, ctx, fullmetalApiKey, fullmetalAgentId);
  } catch (error) {
    console.error('Error:', error);
    ctx.reply('⚠️ An error occurred while processing your request.');
  }
});

// Start the bot
bot.launch();
console.log('🤖 Telegram bot is running...');

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM')); 