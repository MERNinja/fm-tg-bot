# Telegram Bot Troubleshooting Guide

## Commands Not Working in Groups

If your bot's commands aren't working in group chats, try these solutions:

### 1. Check Bot Restart

The bot must be restarted after changes to privacy settings. Confirm your bot server is running:

```bash
# On Windows
tasklist | findstr node

# On Linux/Mac
ps aux | grep node
```

If it's running, stop and restart it to apply all changes.

### 2. Command Format in Groups

In groups, you must use the exact format:
- `/command@YourBotUsername` or
- `/command` (if the bot is the only one in the group)

If multiple bots are present, you must specify which bot should respond with `@YourBotUsername`.

### 3. Privacy Mode Check

Verify privacy mode is disabled:
1. Check BotFather settings
2. Look at your bot server logs - you should see ALL messages in the group, not just commands

### 4. Bot Permissions

Make sure your bot has the necessary admin permissions in the group:
1. Is the bot an administrator?
2. Does it have can_delete_messages and can_restrict_members permissions?

### 5. Test with the /test Command

Use the `/test` command (or `/test@YourBotUsername`) to verify basic command handling.

### 6. Check Server Logs

Logs should show:
- "Raw message object:" entries for every message
- "Detected command:" when you send a command
- "TEST command received" when you use the /test command

### 7. Bot Initialization Issues

Check if the bot was properly initialized:
1. Look for "Bot launched successfully" message in logs
2. Check for "Bot commands registered with Telegram" message
3. Check for any errors during startup

### 8. Telegram Server Issues

Occasionally, Telegram's servers might have issues:
1. Try again later
2. Check if other bots in the group are responsive

### 9. Re-add the Bot to the Group

If nothing else works:
1. Remove the bot from the group
2. Restart the bot server
3. Add the bot back with all required permissions

## Contact Support

If you continue to experience issues after trying these solutions, please provide:
1. Full server logs
2. Screenshots of the bot's admin permissions in the group
3. Screenshots of attempts to use commands 