const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
require('dotenv').config();

// Import controllers and services
const messageController = require('./controllers/messageController');
const { connectDB } = require('./config/database');
const Agent = require('./models/Agent');
const User = require('./models/User');

// Connect to the database
connectDB();


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

      // Loop through agents for debugging and setup
      for (let index = 0; index < agents.length; index++) {
        const agent = agents[index];
        console.log(`Agent ${index + 1}: ${agent.name}`);
        console.log(`  ID: ${agent._id}`);
        console.log(`  Token: ${agent.summary.telegram.token.substring(0, 10)}...`);

        // Check if user data is available
        if (agent.userId && agent.userId.apiKey && agent.userId.apiKey.length > 0) {
          console.log(`  User: ${agent.userId.name || agent.userId.email || 'Unknown'}`);
          console.log(`  API Key: ${agent.userId.apiKey[0].substring(0, 5)}...`);

          console.log(`First agent: ${agent.name}, ID: ${agent._id}`);

          // Get user data directly from the populated field
          const user = agent.userId;

          if (user && user.apiKey) {
            console.log('User API key found and loaded');
            console.log(`User: ${user.name || user.email || 'Unknown'}, ID: ${user._id}`);
          } else {
            console.log('No user API key found, using default');
          }

          if (agent._id) {
            // Initialize the bot
            const bot = new Telegraf(agent.summary.telegram.token);
            console.log('Bot initialized:', agent.summary.telegram.token, agent.name);
            // Wait for 10 seconds before continuing
            console.log('Waiting 1 seconds before starting the bot...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log('Wait complete, continuing bot initialization...');
            // Bot commands
            bot.start((ctx) => {
              console.log(`Start command received from user: ${ctx.from.id} (${ctx.from.username || 'no username'})`);
              ctx.reply('👋 Hi! Talk to me or use /chat to get started.');
            });

            // Handle text messages
            bot.on(message('text'), async (ctx) => {
              console.log(`Message received from ${ctx.from.id} (${ctx.from.username || 'no username'}): ${ctx.message.text.substring(0, 50)}${ctx.message.text.length > 50 ? '...' : ''}`);
              try {
            await messageController.processMessage(ctx.message.text, ctx, agent);
          } catch (error) {
            console.error('Error processing message:', error);
            ctx.reply('⚠️ An error occurred while processing your request.');
          }
        });

            try { 
          // Start the bot
          console.log('Launching bot...');
          bot.launch()
          console.log('Bot launched successfully');
          // Enable graceful stop
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
          }
        } else {
          console.log(`  Warning: No valid API key found for this agent`);
        }
      }
    } else {
      console.log('No agents found with Telegram tokens, using default values');
    }
  } catch (error) {
    console.error('Error initializing agent data:', error);
  }
}
// Initialize agent data and start the bot
(async () => {
  console.log('Starting initialization process...');
  await initializeAgentData();
  console.log('Initialization complete');
})();