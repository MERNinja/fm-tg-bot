/**
 * Telegram Bot Moderation Service
 * 
 * This service handles moderation actions for Telegram groups, including:
 * - Analyzing messages with Fullmetal AI for moderation decisions
 * - Taking appropriate actions based on AI recommendations
 * - Managing ban/kick/mute operations
 */

const fullmetalService = require('./fullmetalService');
const memoryService = require('./memoryService');

class ModerationService {
    /**
     * Process a message for moderation
     * @param {string} message - The message content to moderate
     * @param {Object} ctx - Telegram context
     * @param {Object} agent - The Fullmetal agent to use
     * @param {boolean} takeAction - Whether to take action or just analyze
     * @returns {Promise<Object>} Moderation result with action taken
     */
    async moderateMessage(message, ctx, agent, takeAction = true) {
        try {
            const messageWithContext = this.#buildModerationPrompt(message, ctx);
            console.log(`[ModerationService] Analyzing message for moderation`);

            // Get a response from the Fullmetal agent
            const { response } = await fullmetalService.getStreamingResponse(messageWithContext, agent);

            let responseData = '';
            let buffer = '';

            return new Promise((resolve, reject) => {
                // Process the stream
                response.body.on('data', chunk => {
                    buffer += chunk.toString();

                    if (buffer.includes('\n\n')) {
                        const parts = buffer.split('\n\n');
                        buffer = parts.pop(); // Keep the last incomplete part

                        for (const part of parts) {
                            if (part.startsWith('data:')) {
                                const jsonData = part.substring(5).trim();
                                if (jsonData === '[DONE]') continue;

                                try {
                                    const data = JSON.parse(jsonData);
                                    if (data.token && !data.completed) {
                                        responseData += data.token;
                                    }
                                } catch (e) {
                                    console.error('[ModerationService] Error parsing chunk:', e);
                                }
                            }
                        }
                    }
                });

                response.body.on('end', async () => {
                    // Process any remaining data in buffer
                    if (buffer.startsWith('data:')) {
                        const jsonData = buffer.substring(5).trim();
                        if (jsonData !== '[DONE]') {
                            try {
                                const data = JSON.parse(jsonData);
                                if (data.token && !data.completed) {
                                    responseData += data.token;
                                }
                            } catch (e) {
                                console.error('[ModerationService] Error parsing final chunk:', e);
                            }
                        }
                    }

                    // Parse moderation decision
                    const moderationResult = this.#parseModerationResponse(responseData);

                    // Take action if requested
                    if (takeAction && moderationResult.actionRequired) {
                        try {
                            await this.#takeModeratorAction(ctx, moderationResult);
                            moderationResult.actionTaken = true;
                        } catch (actionError) {
                            console.error('[ModerationService] Error taking action:', actionError);
                            moderationResult.actionTaken = false;
                            moderationResult.actionError = actionError.message;
                        }
                    }

                    resolve(moderationResult);
                });

                response.body.on('error', err => {
                    console.error('[ModerationService] Stream error:', err);
                    reject(err);
                });
            });
        } catch (error) {
            console.error('[ModerationService] Error in moderation process:', error);
            return {
                actionRequired: false,
                error: error.message,
                actionTaken: false
            };
        }
    }

    /**
     * Build a moderation-specific prompt for the AI
     * @private
     * @param {string} message - The message to moderate
     * @param {Object} ctx - Telegram context
     * @returns {string} Formatted prompt for moderation
     */
    #buildModerationPrompt(message, ctx) {
        const user = ctx.from;
        const chat = ctx.chat;

        return `
Group: ${chat.title || 'Unknown'}
User: @${user.username || 'unknown'} (user_id: ${user.id})
Message: ${message}`;
    }

    /**
     * Parse the AI response to extract moderation decision
     * @private
     * @param {string} response - The AI response text
     * @returns {Object} Structured moderation decision
     */
    #parseModerationResponse(response) {
        try {
            // Extract JSON object if response contains other text
            // const jsonMatch = response.match(/{[\s\S]*}/);
            // const jsonStr = jsonMatch ? jsonMatch[0] : response;

            // Parse the JSON
            console.log('[ModerationService] Parsing response:', response);
            const decision = JSON.parse(response);

            console.log('[ModerationService] Parsed decision:', decision);

            // Map the action field to our internal actions
            let action = 'none';
            let actionRequired = false;

            if (decision.action === 'warn') {
                action = 'warn';
                actionRequired = true;
            } else if (decision.action === 'ban') {
                action = 'ban';
                actionRequired = true;
            } else if (decision.action === 'ignore') {
                action = 'none';
                actionRequired = false;
            }

            // Return structured decision
            return {
                actionRequired: actionRequired,
                reason: decision.reason || 'No reason provided',
                action: action,
                userId: decision.user_id,
                violationType: decision.reason || 'unknown',
                rawResponse: response
            };
        } catch (error) {
            console.error('[ModerationService] Error parsing moderation response:', error);
            console.log('Raw response:', response);

            // Return default values if parsing fails
            return {
                actionRequired: false,
                reason: 'Failed to parse AI response',
                action: 'none',
                userId: null,
                violationType: 'unknown',
                rawResponse: response,
                parseError: true
            };
        }
    }

    /**
     * Execute moderation actions on Telegram
     * @private
     * @param {Object} ctx - Telegram context
     * @param {Object} decision - Moderation decision
     * @returns {Promise<Object>} Result of the action
     */
    async #takeModeratorAction(ctx, decision) {
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const messageId = ctx.message.message_id;

        console.log(`[ModerationService] Taking action: ${decision.action} for user ${userId} in chat ${chatId}`);
        console.log(ctx.from);
        switch (decision.action) {
            case 'none':
                // No action needed
                return { success: true, action: 'none' };

            case 'warn':
                // Warn the user
                try {
                    await ctx.reply(`⚠️ Warning to @${ctx.from.username || userId}: ${decision.reason}`);

                    // Store warning in moderation history (could be implemented with a database)
                    console.log(`[ModerationService] Warning issued to user ${userId} for: ${decision.reason}`);

                    return { success: true, action: 'warn' };
                } catch (error) {
                    console.error('[ModerationService] Error issuing warning:', error);
                    return { success: false, action: 'warn', error: error.message };
                }

            case 'ban':
                // Ban the user permanently
                try {
                    // First delete the message that triggered the ban
                    await ctx.deleteMessage(messageId).catch(error => {
                        console.error('[ModerationService] Error deleting banned message:', error);
                    });

                    // Ban the user
                    await ctx.telegram.banChatMember(chatId, userId);

                    // Notify the group
                    await ctx.reply(`🚫 User @${ctx.from.username || userId} has been banned due to: ${decision.reason}`);

                    return { success: true, action: 'ban' };
                } catch (error) {
                    console.error('[ModerationService] Error banning user:', error);
                    return { success: false, action: 'ban', error: error.message };
                }

            default:
                console.log(`[ModerationService] Unknown action: ${decision.action}`);
                return { success: false, action: 'unknown' };
        }
    }

    /**
     * Log moderation action to database or external system
     * @param {Object} ctx - Telegram context
     * @param {Object} decision - Moderation decision
     * @param {Object} result - Result of action taken
     */
    async logModerationAction(ctx, decision, result) {
        // This would be implemented to store moderation actions in a database
        // For now, just log to console
        console.log(`[ModerationService] Moderation log: ${decision.action} for user ${ctx.from.id} in chat ${ctx.chat.id}`);
        console.log(`Reason: ${decision.reason}`);
        console.log(`Result: ${result.success ? 'Success' : 'Failed'}`);
    }
}

module.exports = new ModerationService(); 