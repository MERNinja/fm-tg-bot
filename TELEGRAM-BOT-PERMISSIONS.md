# Telegram Bot Group Permissions Guide

## Core Issue: Bot Not Receiving Group Messages

If your bot isn't receiving any messages in a group (not even seeing commands), the issue is almost certainly related to:

1. **Privacy Mode** - Most critical setting
2. **Bot API Configuration** - How your bot connects to Telegram
3. **Group Type** - Regular groups vs. Supergroups

## Privacy Mode (MOST IMPORTANT)

### What It Is
Privacy mode controls whether your bot can "see" messages that aren't explicitly addressed to it.

### How to Disable
1. Talk to [@BotFather](https://t.me/botfather) in Telegram
2. Send the command `/mybots`
3. Select your bot (@fullmetal_aibuddy_bot)
4. Select "Bot Settings"
5. Select "Group Privacy"
6. Select "Turn off"
7. BotFather will confirm: "Privacy mode is disabled for your bot."

### Important Notes
- **Must restart bot server** after changing this setting
- Changes can take 5-10 minutes to fully propagate through Telegram's servers
- Try toggling it ON and then OFF again if it's not working
- This setting is REQUIRED for group moderation bots

## Admin Permissions

For moderation features to work, the bot needs these admin permissions:
- **Delete Messages** - Required to remove problematic content
- **Ban Users** - Required to remove users from the group
- **Restrict Members** - Required to mute/restrict users

However, just to SEE messages, the bot doesn't need admin rights as long as privacy mode is disabled.

## Group Types

Telegram has two types of groups:
- **Normal Groups** - Limited to 200 members, fewer admin features
- **Supergroups** - Up to 200,000 members, full admin capabilities

For full moderation features, your group should be a supergroup. Most large groups automatically convert to supergroups.

## Testing Bot's Ability to See Group Messages

1. **Enable Debug Logging**:
   - We've added extensive logging to show ANY received messages

2. **Send a Regular Message**:
   - Type "test message" in the group (not a command)
   - Check your bot logs for:
     ```
     ========= MESSAGE RECEIVED =========
     CHAT TYPE: supergroup (12345678), FROM: username
     ```

3. **If No Logs Appear**:
   - Your bot isn't receiving ANY messages from the group
   - This confirms it's a privacy mode issue

## Complete Reset Procedure

If nothing else works, follow this complete reset procedure:

1. **Stop Bot Server**:
   ```
   taskkill /PID [your-node-pid] /F
   ```

2. **Toggle Privacy Mode**:
   - Go to BotFather
   - Enable privacy mode
   - Wait 1 minute
   - Disable privacy mode
   - Wait 1 minute

3. **Remove Bot from Group**:
   - Remove the bot completely from the group

4. **Start Bot Server**:
   ```
   node src/index.js
   ```

5. **Add Bot to Group**:
   - Add bot back to the group
   - Give it admin rights if needed for moderation

6. **Test with Regular Message**:
   - Send a non-command message
   - Check server logs for "MESSAGE RECEIVED"

## Webhook vs. Polling

If the issue persists, consider using a webhook instead of polling:

1. **Polling** (current method):
   - Bot regularly asks Telegram for updates
   - Simpler to set up but can have reliability issues

2. **Webhook**:
   - Telegram sends updates directly to your server
   - More reliable but requires HTTPS endpoint

## Bot Token Issues

In rare cases, the bot token itself might have issues:

1. **Create a New Bot**:
   - Go to BotFather and create a test bot
   - Use the new token to check if the issue persists
   - If the new bot works, your original token might be problematic

## Summary Checklist

✅ Privacy mode is disabled in BotFather  
✅ Bot server has been completely restarted  
✅ Bot is correctly added to the group  
✅ Group is a supergroup (preferable)  
✅ Bot has necessary admin rights  
✅ Debug logs are enabled and being monitored 