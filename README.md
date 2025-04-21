# Fullmetal AI Telegram Bot

A Telegram bot that integrates with Fullmetal AI, using MongoDB to store and retrieve agent-specific details including pre-prompts, response metrics, and more.

## Features

- Interact with Fullmetal AI agents through Telegram
- Real-time streaming of AI responses with typing indicators ("...")
- Store and use agent-specific pre-prompts and context information from MongoDB
- Track and display agent performance metrics (average response time, prompts served)
- Real-time log viewer dashboard for monitoring bot activity
- Clean MVC architecture for maintainability
- Fully integrated with the Fullmetal agent data model
- Serverless deployment support with Vercel

## Project Structure

```
├── src
│   ├── api
│   │   └── webhook.js      # Serverless function for Telegram webhook
│   ├── config
│   │   └── database.js     # Database configuration
│   ├── controllers
│   │   └── messageController.js  # Message processing logic
│   ├── models
│   │   └── Agent.js        # Mongoose model for agents
│   ├── services
│   │   └── fullmetalService.js  # Service for API interactions
│   │   └── loggerService.js     # Logging service with in-memory storage
│   ├── web
│   │   ├── server.js       # Express server for log viewer
│   │   └── public/         # Static files for the log viewer UI
│   └── index.js            # Main entry point
├── .env                    # Environment variables (not in repo)
├── .env.example            # Example environment variables
├── package.json            # Project metadata and dependencies
├── vercel.json             # Vercel deployment configuration
└── README.md               # This file
```

## Setup

1. Clone the repository:
   ```
   git clone <repository-url>
   cd fullmetal-telegram-bot
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in your API keys and tokens:
   ```
   cp .env.example .env
   # Edit the .env file with your values
   ```

4. Start the bot locally:
   ```
   npm start
   ```

   For development with auto-reload:
   ```
   npm run dev
   ```

## Deployment

### Vercel Deployment

This bot can be deployed to Vercel as a serverless application:

1. Install the Vercel CLI:
   ```
   npm install -g vercel
   ```

2. Login to Vercel:
   ```
   vercel login
   ```

3. Deploy to Vercel:
   ```
   vercel
   ```

4. Set up environment variables on Vercel:
   - Go to your Vercel dashboard
   - Navigate to your project
   - Go to Settings > Environment Variables
   - Add all the required variables from your `.env` file
   - Make sure to set `VERCEL=true`
   - Set `WEBHOOK_URL` to your Vercel deployment URL (e.g., https://your-app.vercel.app)

5. Configure your Telegram bot to use webhooks:
   - After deployment, Vercel will provide you with a URL
   - Your webhook will be available at `https://your-app.vercel.app/api/webhook`

## Usage

- Start a conversation with your bot on Telegram (`/start`)
- Send a message directly to chat with the AI
- Use `/chat <message>` to send a specific prompt
- Use `/setprompt <agentId> <pre-prompt>` to configure a pre-prompt for an agent
- Use `/agentinfo <agentId>` to get information about an agent
- Access the real-time log viewer at `http://localhost:3000` (or your configured port) when running locally

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and get a welcome message |
| `/chat <message>` | Send a message to the AI |
| `/setprompt <agentId> <pre-prompt>` | Set a pre-prompt for an agent |
| `/agentinfo <agentId>` | Get information about an agent |

## Log Viewer

The bot includes a real-time log viewer accessible via a web browser when running locally:

- View logs in real-time as they happen
- Filter logs by level (info, error, warning, debug)
- Search logs for specific text
- Pause and clear logs as needed
- View detailed metadata for each log entry
- In-memory storage of up to 1000 most recent logs

### Testing the Log Viewer

You can generate test logs to see the log viewer in action:
1. Start the bot with `npm run dev`
2. Access the log viewer at `http://localhost:3000`
3. Generate test logs by visiting `http://localhost:3000/api/test-logs`
4. See the logs appear in the log viewer in real-time

### Log Viewer API

The log viewer exposes several REST API endpoints:

- `GET /api/logs` - Retrieve all stored logs
- `POST /api/logs/clear` - Clear all stored logs
- `GET /api/test-logs` - Generate test logs of various levels

## Agent Model

The bot uses an expanded version of the Fullmetal agent model, including:

- Basic agent information (name, ID, availability status)
- Performance metrics (response time, prompts served)
- Context information (role, description, instructions)
- Pre-prompt configuration for customizing agent behavior

## Environment Variables

- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token from BotFather
- `FULLMETAL_API_KEY`: Your Fullmetal AI API key
- `FULLMETAL_AGENT_ID`: Default Fullmetal agent ID to use
- `MONGODB_URI`: MongoDB connection string
- `WEB_PORT`: Port for the log viewer web server (default: 3000)
- `VERCEL`: Set to 'true' when deploying to Vercel
- `WEBHOOK_URL`: URL for the Telegram webhook (for Vercel deployment)

## License

MIT 