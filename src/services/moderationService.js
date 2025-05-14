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
const warningService = require('./warningService');
const groupService = require('./groupService');
const UserWarning = require('../models/UserWarning');

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
            // Skip all channel operations as the bot isn't needed for channels
            if (ctx.chat.type === 'channel') {
                console.log(`[ModerationService] Message is from a channel, skipping as bot is not needed for channels`);
                return {
                    actionRequired: false,
                    reason: 'Bot not needed for channels',
                    action: 'none',
                    actionTaken: false
                };
            }

            // Get group info from database (if exists)
            const telegramGroupId = ctx.chat.id.toString();
            let group = null;

            // Find or create group in the database
            try {
                group = await groupService.getGroupByTelegramId(telegramGroupId);

                // If the group exists but moderation is disabled, skip moderation
                if (group && !group.moderationEnabled) {
                    console.log(`[ModerationService] Moderation is disabled for group ${telegramGroupId}, skipping`);
                    return {
                        actionRequired: false,
                        reason: 'Moderation disabled for this group',
                        action: 'none',
                        actionTaken: false
                    };
                }

                // If we don't have group info, create a basic record
                if (!group && ctx.chat.type !== 'private') {
                    console.log(`[ModerationService] Creating new group record for ${telegramGroupId}`);
                    const groupData = {
                        telegramGroupId: telegramGroupId,
                        groupName: ctx.chat.title || 'Unnamed Group',
                        groupType: ctx.chat.type,
                        agentId: agent._id,
                        apiKeyUserId: agent.userId?._id,
                        memberCount: 0,
                        moderationEnabled: true
                    };

                    // Save group data
                    group = await groupService.saveGroup(groupData);
                }
            } catch (error) {
                console.error(`[ModerationService] Error getting/creating group ${telegramGroupId}:`, error);
                // Continue with moderation using agent-level settings
            }

            // First check if the user is an admin - if so, skip moderation actions
            let isAdmin = false;
            try {
                if (ctx.from && ctx.chat) {
                    // For groups and supergroups, check admin status
                    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
                        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
                        isAdmin = ['creator', 'administrator'].includes(member.status);

                        if (isAdmin) {
                            console.log(`[ModerationService] User ${ctx.from.id} is an admin, skipping moderation`);
                            return {
                                actionRequired: false,
                                reason: 'User is an admin',
                                action: 'none',
                                isAdmin: true,
                                actionTaken: false
                            };
                        }
                    }
                }
            } catch (error) {
                console.error('[ModerationService] Error checking admin status:', error);
                // Continue with moderation if we can't verify admin status
            }

            // Update API usage for the group
            if (group) {
                await groupService.updateApiUsage(telegramGroupId, 'moderation');
            }

            const messageWithContext = this.#buildModerationPrompt(message, ctx);
            console.log(`[ModerationService] Analyzing message for moderation`);

            // Get API key from various sources (priority order):
            // 1. User-specific API key (if available)
            // 2. Group-specific API key (if available)
            // 3. Agent API key (fallback)
            let apiKey = null;
            const telegramUserId = ctx.from.id.toString();

            // Try to get Telegram user's API key first
            try {
                const User = require('../models/User');
                const userWithApiKey = await User.findOne({ telegramUserId });

                if (userWithApiKey && userWithApiKey.apiKey && userWithApiKey.apiKey.length > 0) {
                    apiKey = userWithApiKey.apiKey[0];
                    console.log(`[ModerationService] Using Telegram user-specific API key for user ${telegramUserId}`);
                }
            } catch (error) {
                console.error(`[ModerationService] Error getting user-specific API key for ${telegramUserId}:`, error);
            }

            // If no user-specific key, try group key
            if (!apiKey && group && group.apiKeyUserId && group.apiKeyUserId.apiKey && group.apiKeyUserId.apiKey.length > 0) {
                apiKey = group.apiKeyUserId.apiKey[0];
                console.log(`[ModerationService] Using group-specific API key for ${telegramGroupId}`);
            }
            // If no group key, try agent key
            else if (!apiKey && agent.userId && agent.userId.apiKey && agent.userId.apiKey.length > 0) {
                apiKey = agent.userId.apiKey[0];
                console.log(`[ModerationService] Using agent's API key (no user or group-specific key available)`);
            }

            // If no key available at all
            if (!apiKey) {
                console.log(`[ModerationService] No API key available for moderation`);
                return {
                    actionRequired: false,
                    reason: 'No API key available',
                    action: 'none',
                    actionTaken: false
                };
            }

            // Get a response from the Fullmetal agent
            const { response } = await fullmetalService.getStreamingResponse(messageWithContext, agent, apiKey, telegramUserId, telegramGroupId);

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
                    moderationResult.groupId = telegramGroupId;

                    // Take action if requested
                    if (takeAction && moderationResult.actionRequired) {
                        try {
                            await this.#takeModeratorAction(ctx, moderationResult, group);
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

        return `MODERATION_ANALYSIS
Group: ${chat.title || 'Unknown'}
User: @${user.username || 'unknown'} (user_id: ${user.id})
Message: ${message}

Analyze this message for community guidelines violations. 

IMPORTANT: Respond ONLY with one of these JSON templates, and nothing else - no explanations or repetition of the prompt:

{"action": "ignore", "reason": "Message appears safe"} 
{"action": "warn", "user_id": ${user.id}, "reason": "Specific reason for warning"}
{"action": "ban", "user_id": ${user.id}, "reason": "Specific reason for ban"}`;
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
            console.log('[ModerationService] Raw response:', response);

            // Try to find a complete JSON object in the response
            const jsonMatch = response.match(/\{[\s\S]*?\}/);
            if (!jsonMatch) {
                console.error('[ModerationService] No JSON object found in response');
                return {
                    actionRequired: false,
                    reason: 'No JSON object found in response',
                    action: 'none',
                    userId: null,
                    violationType: 'unknown',
                    rawResponse: response,
                    parseError: true
                };
            }

            const jsonStr = jsonMatch[0];
            console.log('[ModerationService] Extracted JSON:', jsonStr);

            // Parse the extracted JSON
            const decision = JSON.parse(jsonStr);
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
            console.log('[ModerationService] Problematic response:', response);

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
     * @param {Object} group - Group information
     * @returns {Promise<Object>} Result of the action
     */
    async #takeModeratorAction(ctx, decision, group) {
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const messageId = ctx.message.message_id;

        // Skip all channel operations as the bot isn't needed for channels
        if (ctx.chat.type === 'channel') {
            console.log(`[ModerationService] Cannot take action in channels as bot is not needed for channels`);
            return {
                success: false,
                action: 'none',
                error: 'Bot not needed for channels'
            };
        }

        // Double-check if user is an admin before taking any action
        let isAdmin = false;
        try {
            // For groups and supergroups, check admin status
            if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
                const member = await ctx.telegram.getChatMember(chatId, userId);
                isAdmin = ['creator', 'administrator'].includes(member.status);
            }

            if (isAdmin) {
                console.log(`[ModerationService] Cannot take action against admin user ${userId}`);
                return {
                    success: false,
                    action: 'none',
                    error: 'Cannot moderate admin users',
                    isAdmin: true
                };
            }
        } catch (error) {
            console.error('[ModerationService] Error checking admin status before action:', error);
            // Continue with the action if we can't verify admin status, but log the error
        }

        console.log(`[ModerationService] Taking action: ${decision.action} for user ${userId} in chat ${chatId}`);
        console.log(ctx.from);

        switch (decision.action) {
            case 'none':
                // No action needed
                return { success: true, action: 'none' };

            case 'warn':
                // Warn the user
                try {
                    // Track this warning in the warning service
                    const warningResult = await warningService.addWarning(ctx, decision.reason, {
                        _id: ctx.botInfo?.id?.toString() || 'unknown'
                    });

                    // Check if this was a previously banned user who got warnings reset
                    if (warningResult.action === 'warnings_reset') {
                        console.log(`[ModerationService] Previously banned user ${userId} had warnings reset`);
                        // Continue with processing the warning since we want to count this current violation
                    }

                    // Get the warning count
                    const warningCount = warningResult.warningCount || 1;

                    // Format warning reason
                    const warningReason = decision.reason || 'Violation of group rules';

                    // Add warning count to message
                    let warningMessage = `⚠️ Warning to @${ctx.from.username || userId}: ${warningReason}`;

                    // Check if this warning triggered an action through warning service
                    if (warningResult.action && warningResult.action !== 'warning_recorded') {
                        // In this case, no need to send our own message since warning service already sent notifications
                        console.log(`[ModerationService] Warning action escalated to ${warningResult.action}`);
                        return {
                            success: true,
                            action: 'warn',
                            warningCount,
                            escalated: warningResult.action
                        };
                    }

                    // No escalation, send normal warning message with count
                    warningMessage += `\n\n*Warning count: ${warningCount}/${warningService.WARNING_THRESHOLDS.BAN}*\n`;

                    // Add information about thresholds
                    if (warningCount === 1) {
                        warningMessage += `\nAfter ${warningService.WARNING_THRESHOLDS.TEMP_MUTE} warnings: 1 hour mute
After ${warningService.WARNING_THRESHOLDS.KICK} warnings: Removal from group
After ${warningService.WARNING_THRESHOLDS.BAN} warnings: Permanent ban`;
                    } else if (warningCount >= warningService.WARNING_THRESHOLDS.TEMP_MUTE - 1) {
                        const remainingUntilBan = warningService.WARNING_THRESHOLDS.BAN - warningCount;
                        warningMessage += `\n⚠️ *${remainingUntilBan} more warning${remainingUntilBan !== 1 ? 's' : ''} until permanent ban*`;
                    }

                    // Send the warning message
                    await ctx.reply(warningMessage, { parse_mode: 'Markdown' });

                    // Store warning in moderation history
                    console.log(`[ModerationService] Warning issued to user ${userId} for: ${decision.reason}`);

                    return {
                        success: true,
                        action: 'warn',
                        warningCount,
                        warningResult
                    };
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

                    // Record this as a severe violation in warning service (5 warnings at once, leading to ban)
                    await warningService.addWarning(ctx, `Severe violation: ${decision.reason}`, {
                        _id: ctx.botInfo?.id?.toString() || 'unknown'
                    });

                    // Force set to 5 warnings to trigger ban
                    const warningRecord = await UserWarning.findOne({
                        telegramUserId: userId.toString(),
                        telegramChatId: chatId.toString()
                    });

                    if (warningRecord) {
                        warningRecord.warningCount = warningService.WARNING_THRESHOLDS.BAN;
                        await warningRecord.save();

                        // Let warning service handle the ban for consistency
                        const banResult = await warningService.checkThresholdAndTakeAction(ctx, warningRecord);

                        if (banResult === 'banned') {
                            return { success: true, action: 'ban', method: 'warning_service' };
                        }
                    }

                    // If warning service ban failed or record not found, do direct ban
                    await ctx.telegram.banChatMember(chatId, userId);

                    // Notify the group
                    await ctx.reply(`🚫 User @${ctx.from.username || userId} has been banned due to: ${decision.reason}`);

                    return { success: true, action: 'ban', method: 'direct' };
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