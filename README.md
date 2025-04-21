# Fullmetal AI Telegram Bot

A Telegram bot that integrates with Fullmetal AI, using MongoDB to store and retrieve agent-specific details including pre-prompts, response metrics, and more.

## Features

- Interact with Fullmetal AI agents through Telegram
- Real-time streaming of AI responses with typing indicators ("...")
- Store and use agent-specific pre-prompts and context information from MongoDB
- Track and display agent performance metrics (average response time, prompts served)
- Clean MVC architecture for maintainability
- Fully integrated with the Fullmetal agent data model

## Project Structure

```
├── src
│   ├── config
│   │   └── database.js     # Database configuration
│   ├── controllers
│   │   └── messageController.js  # Message processing logic
│   ├── models
│   │   └── Agent.js        # Mongoose model for agents
│   ├── services
│   │   └── fullmetalService.js  # Service for API interactions
│   └── index.js            # Main entry point
├── .env                    # Environment variables (not in repo)
├── .env.example            # Example environment variables
├── package.json            # Project metadata and dependencies
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

4. Start the bot:
   ```
   npm start
   ```

   For development with auto-reload:
   ```
   npm run dev
   ```

## Usage

- Start a conversation with your bot on Telegram (`/start`)
- Send a message directly to chat with the AI
- Use `/chat <message>` to send a specific prompt
- Use `/setprompt <agentId> <pre-prompt>` to configure a pre-prompt for an agent
- Use `/agentinfo <agentId>` to get information about an agent

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and get a welcome message |
| `/chat <message>` | Send a message to the AI |
| `/setprompt <agentId> <pre-prompt>` | Set a pre-prompt for an agent |
| `/agentinfo <agentId>` | Get information about an agent |

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

## License

MIT 