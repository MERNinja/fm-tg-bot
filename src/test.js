"const { Telegraf } = require('telegraf'); console.log('Basic test working');"

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
// require('dotenv').config();

// Create a new bot instance with a mock token
const MOCK_TOKEN = '0000000000:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const bot = new Telegraf(MOCK_TOKEN);

// Log that this is just a demo
console.log('This is a demonstration of the group instructions update feature.');
console.log('No actual bot is being launched - this is just showing the code structure.');

// Store user states
const userStates = new Map();

// Mock group service
const groupService = {
    getGroupByTelegramId: async (groupId) => {
        console.log(`[Mock] Getting group info for ${groupId}`);
        return {
            _id: 'mockid123',
            telegramGroupId: groupId,
            groupName: 'Test Group',
            customInstructions: 'Original instructions for the group'
        };
    },
    setGroupInstructions: async (groupId, instructions) => {
        console.log(`[Mock] Setting instructions for group ${groupId}:`);
        console.log(instructions);
        return true;
    }
};

// Function to safely edit message text
async function safeEditMessageText(ctx, text, options = {}) {
    try {
        if (ctx.callbackQuery) {
            // If it's a callback query, edit the message
            return await ctx.editMessageText(text, options);
        } else {
            // If not, send a new message
            return await ctx.reply(text, options);
        }
    } catch (error) {
        console.log(`[Safe Edit] Error editing message: ${error.message}`);
        try {
            return await ctx.reply(text, options);
        } catch (fallbackError) {
            console.log(`[Safe Edit] Fallback error: ${fallbackError.message}`);
        }
    }
}

// Function to handle updating group instructions
async function handleUpdateGroupInstructions(ctx, groupId) {
    console.log(`[Group Management] User ${ctx.from.id} updating instructions for group ${groupId}`);

    try {
        // Get group info
        const group = await groupService.getGroupByTelegramId(groupId);

        if (!group) {
            await ctx.reply('Could not find group information. The group may have been deleted.');
            return;
        }

        // Show current instructions or default text
        let promptMessage = `*Update Instructions for ${group.groupName}*\n\n`;

        if (group.customInstructions) {
            promptMessage += `Current Instructions:\n`;
            promptMessage += `\`\`\`\n${group.customInstructions}\n\`\`\`\n\n`;
        } else {
            promptMessage += `This group is currently using the default instructions.\n\n`;
        }

        promptMessage += `Please enter the new instructions for the bot in this group. These instructions will tell me how to behave, what's allowed/not allowed, and any special rules for the group.\n\nReply to this message with your instructions, or type /cancel to abort.`;

        // Set user state to wait for new instructions
        const userId = ctx.from.id.toString();
        userStates.set(userId, {
            waitingFor: 'group_instructions',
            groupId: groupId,
            timestamp: Date.now()
        });

        await ctx.reply(promptMessage, {
            parse_mode: 'Markdown'
        });

        // Add a way for the user to cancel
        await ctx.reply('Type /cancel to abort this operation.');
    } catch (error) {
        console.error(`[Group Management] Error handling instruction update for group ${groupId}:`, error);
        await ctx.reply('An error occurred while loading group information. Please try again later.');
    }
}

// Command to start the update process
bot.command('updateinstructions', async (ctx) => {
    // For demo purposes, assume we're updating a group with ID "123456789"
    await handleUpdateGroupInstructions(ctx, "123456789");
});

// Handle text messages to process the new instructions
bot.on(message('text'), async (ctx) => {
    console.log(`Received message: ${ctx.message.text}`);

    const userId = ctx.from.id.toString();
    const userState = userStates.get(userId);

    if (userState && userState.waitingFor === 'group_instructions') {
        // Handle updating instructions for an existing group
        const instructions = ctx.message.text.trim();
        const groupId = userState.groupId;
        console.log(`[Group Management] Received updated instructions for group ${groupId} from user ${userId}`);

        // Handle potential cancellation
        if (instructions.toLowerCase() === '/cancel') {
            console.log(`[Group Management] User ${userId} cancelled instruction update`);
            userStates.delete(userId);
            await ctx.reply('Instruction update cancelled.');
            return;
        }

        // Show loading message
        await ctx.reply('Updating group instructions...');

        try {
            // Update instructions in the database
            await groupService.setGroupInstructions(groupId, instructions);

            // Get updated group info
            const group = await groupService.getGroupByTelegramId(groupId);

            // Clear the waiting state
            userStates.delete(userId);

            // Success message
            await ctx.reply(
                `✅ Instructions updated for "${group.groupName}"!\n\n` +
                `The bot will now use these custom instructions for this group.`
            );

        } catch (error) {
            console.error(`[Group Management] Error updating instructions for group ${groupId}:`, error);
            await ctx.reply('⚠️ An error occurred while updating the instructions. Please try again later.');
        }
    } else {
        await ctx.reply('Type /updateinstructions to start updating group instructions');
    }
});

// Start the bot
bot.launch().then(() => {
    console.log('Bot started!');
    console.log('Try sending the /updateinstructions command');
}).catch(err => {
    console.error('Error starting bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));  
