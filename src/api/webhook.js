const app = require('../index');
const logger = require('../services/loggerService');

module.exports = (req, res) => {
    logger.info('Webhook received', { method: req.method, headers: req.headers });

    // Pass the request to the Express app that has the bot's webhook handler
    app(req, res);
}; 