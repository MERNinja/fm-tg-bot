# Telegram Bot Moderation Features

This document provides instructions on how to set up and use the moderation features of your Fullmetal AI Telegram bot.

## Overview

The moderation bot uses Fullmetal AI to analyze messages in group chats, detect potentially problematic content, and take appropriate actions based on the content analysis.

## How the Moderation System Works

The bot uses a JSON-based response system from Fullmetal AI to make moderation decisions:

1. When a message is sent in a group, the bot forwards it to Fullmetal AI
2. The AI analyzes the message and responds with a specific JSON format:
   ```json
   {"action": "ignore"}  // For clean messages
   
   {"action": "warn", "user_id": 123456789, "reason": "toxic language"}  // For suspicious messages
   
   {"action": "ban", "user_id": 123456789, "reason": "spam"}  // For harmful content
   ```
3. The bot then takes the appropriate action based on the AI's decision

## Setup Requirements

### Bot Permissions

For moderation to work properly, the bot must be added to the group with the following permissions:

1. **Administrator Status** with the following permissions:
   - Can delete messages
   - Can restrict members
   - Can read all messages (Privacy mode must be disabled)

### Privacy Mode Configuration (REQUIRED)

**IMPORTANT**: The bot's privacy mode MUST be disabled to read all messages in the group. Without this, moderation will not work.

To disable privacy mode:

1. Talk to [@BotFather](https://t.me/botfather) in Telegram
2. Send the command `/mybots` and select your bot
3. Select "Bot Settings" > "Group Privacy"
4. Select "Turn off"

Once this is done, you'll need to restart your bot server for the changes to take effect.

### Adding the Bot to a Group

1. Open your group in Telegram
2. Click on the group name at the top to access group info
3. Select "Administrators" > "Add Administrator"
4. Search for your bot by username and add it
5. Enable the required permissions mentioned above

## Commands

The bot provides the following moderation-related commands:

- `/modstatus` - Check current moderation status and bot permissions (admin only)
- `/modon` - Enable moderation for this group (admin only)
- `/modoff` - Disable moderation for this group (admin only)

## Moderation Actions

When moderation is enabled, the bot can take the following actions:

1. **Warn Users**: Send a warning message to the group about the user's behavior
2. **Ban Users**: Permanently remove a user from the group (includes deleting the offending message)

## Troubleshooting

Common issues:

1. **Bot doesn't see all messages**: Make sure privacy mode is disabled via BotFather
2. **Commands not working**: Ensure your bot has been restarted after disabling privacy mode
3. **Bot can't take actions**: Check bot permissions in the group settings
4. **Moderation seems too strict/lenient**: Adjust the Fullmetal AI agent's persona

### Privacy Mode Troubleshooting

If you've disabled privacy mode but the bot still isn't seeing all messages:

1. Make sure you've restarted your bot server after changing the privacy mode
2. Ensure the bot is an administrator in the group
3. Try removing and re-adding the bot to the group
4. Check server logs for any errors related to receiving messages

## Support

For assistance with moderation features, contact the bot administrator or create an issue in the GitHub repository. 