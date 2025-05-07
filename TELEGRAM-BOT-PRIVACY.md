# Fixing Telegram Bot Privacy Mode for Group Messages

## The Problem
Your bot can receive commands but not regular messages in groups because of Telegram's privacy mode setting.

## What is Privacy Mode?
By default, Telegram bots can only see:
- Commands (like /start or /help)
- Messages that directly mention the bot (@yourbot)
- Replies to the bot's messages

Regular messages in groups are NOT visible to bots when privacy mode is enabled.

## How to Disable Privacy Mode

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send the command `/mybots`
3. Select your bot from the list
4. Select "Bot Settings"
5. Select "Group Privacy"
6. Select "Turn off"
7. BotFather will confirm: "Privacy mode is now disabled for your bot."

## Important After Disabling Privacy Mode

After changing the privacy mode setting:

1. **COMPLETELY RESTART YOUR BOT SERVER**
   ```
   # Find your bot process
   tasklist | findstr node
   
   # Kill it
   taskkill /PID [your-pid] /F
   
   # Start it again
   node src/index.js
   ```

2. **Wait 5-10 minutes** for the change to fully propagate through Telegram's servers

3. **Send regular messages** (not commands) in the group to test

## Checking If It's Working

The best way to confirm privacy mode is disabled:

1. Send a regular message in the group (not a command, not mentioning the bot)
2. Check your bot logs for:
   ```
   ========= MESSAGE RECEIVED =========
   MESSAGE TEXT: "your message"
   ```

3. If you see these logs, privacy mode is successfully disabled

## Common Issues

### Bot Still Not Receiving Group Messages?

1. **Multiple Bot Instances**: Make sure you don't have multiple instances of your bot running. This can cause conflicts.

2. **Group vs. Supergroup**: Some features only work in supergroups. Regular groups have limited functionality.

3. **Bot Removed/Re-added**: Try removing the bot from the group, then adding it again after privacy mode is disabled.

4. **Token Issues**: In rare cases, the bot token might need to be refreshed.

### How to Know Which Type of Group You Have

- **Regular groups** have a member limit of 200
- **Supergroups** can have up to 200,000 members
- Supergroups have extra features like admin logs, slow mode, etc.

Most large groups are automatically converted to supergroups by Telegram. 