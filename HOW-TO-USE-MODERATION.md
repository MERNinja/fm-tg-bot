# How to Use the Moderation Bot (Privacy Mode Workaround)

## Current Setup
- Bot can respond to commands
- Bot is not reading regular messages due to privacy mode
- We're using a special command to analyze messages

## Using the `/mod` Command

Since the bot can't directly analyze all messages in the group due to privacy mode limitations, we've added a special command to analyze specific messages:

### Basic Usage
```
/mod [message to analyze]
```

### Examples

To analyze a potentially offensive message:
```
/mod This group is filled with idiots! You all suck.
```

To analyze potential spam:
```
/mod Check out my new site! Free iPhones at bit.ly/scam Click now!!!
```

To analyze a normal message:
```
/mod Hello everyone, how are you doing today?
```

### How It Works

1. Type `/mod` followed by the message you want to analyze
2. The bot will process this message through the moderation system
3. The bot will reply with the moderation analysis results, showing:
   - Whether action would be required
   - What type of action (warn, ban, etc.)
   - The reason for the action
   - The violation type detected (if any)

## Other Useful Commands

- `/test` - Test if the bot is working
- `/modstatus` - Check moderation status and bot permissions
- `/modon` - Enable moderation features
- `/modoff` - Disable moderation features

## Limitations

This approach has some limitations compared to full moderation with privacy mode disabled:

1. **Manual Analysis Only**: You need to manually submit messages for analysis
2. **No Automatic Actions**: The bot won't automatically take action on violating messages
3. **Limited Context**: The bot can't see message history or patterns of behavior

## Ideal Solution (If Possible)

The ideal solution would be to:

1. Disable privacy mode via BotFather
2. Restart the bot completely
3. Make the bot an admin in the group

This would allow the bot to see all messages and perform automatic moderation.

## Testing Different Message Types

Try these test messages with the `/mod` command to see how different content is classified:

### Safe Messages
```
/mod Hello everyone! Hope you're having a great day.
```

### Borderline Messages
```
/mod This discussion is getting annoying. Can we move on?
```

### Violating Messages
```
/mod [insert inappropriate content to test]
```

Remember that the moderation system is powered by AI, so results may vary based on context and phrasing. 