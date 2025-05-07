# Testing Instructions for Telegram Bot

## Step 1: Verify Basic Message Reception

1. Send this exact message in your group: `testing bot`
2. The bot should respond with: "I can see your message! Bot is working."
3. If it responds, this confirms the bot can receive regular messages!

## Step 2: Check Console Logs

Look for these specific log entries:
```
*** TEXT MESSAGE HANDLER TRIGGERED ***
Message: "testing bot"
```

If you see these logs, your bot is successfully receiving messages in the group.

## Step 3: Test Regular Messages

1. Send a few normal messages (not commands) in the group
2. Check your console logs for:
```
*** TEXT MESSAGE HANDLER TRIGGERED ***
Processing message for moderation in group
```

3. This confirms messages are being captured and sent for moderation

## Step 4: Test Moderation Commands

Try these commands:
- `/modstatus` - Check moderation status
- `/modon` - Enable moderation
- `/modoff` - Disable moderation

## Step 5: Test Different Message Types

Send these types of messages to test moderation:
- A normal friendly message: "Hello everyone, how are you doing today?"
- A borderline unfriendly message: "This conversation is getting annoying."
- A spam-like message: "Free money! Click this link: bit.ly/example"

## What We Fixed

1. **Removed confusing code**: Eliminated all channel-related code
2. **Simplified message handling**: Created a clean, direct text handler
3. **Fixed duplicate bot instances**: Added token tracking to prevent conflicts
4. **Enhanced debugging**: Added better logging for troubleshooting

## If Issues Persist

If the bot still doesn't respond to regular messages (only commands):

1. Double-check privacy mode is disabled in BotFather
2. Try removing and re-adding the bot to the group
3. Create a brand new group for testing
4. Try using the bot in direct messages to verify it's working

Remember, the bot must be able to see regular messages for moderation to work properly. 