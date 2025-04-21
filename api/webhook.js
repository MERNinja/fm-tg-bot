const app = require('../src/index');
const logger = require('../src/services/loggerService');

// This is a Vercel serverless function handler
module.exports = (req, res) => {
    // Log incoming webhook
    try {
        logger.info('Webhook received', {
            method: req.method,
            path: req.url,
            body: typeof req.body === 'object' ? 'Telegram Update Object' : null
        });
    } catch (error) {
        console.error('Error logging webhook:', error);
    }

    // Pass the request to the Express app that has the bot's webhook handler
    return app(req, res);
}; 