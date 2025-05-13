/**
 * User Warning Tracking Service
 * 
 * This service handles tracking warnings for users across Telegram groups, including:
 * - Recording warnings in the database
 * - Checking warning thresholds
 * - Taking action when users exceed warning limits
 */

const UserWarning = require('../models/UserWarning');

// Warning thresholds
const WARNING_THRESHOLDS = {
    TEMP_MUTE: 3,  // Temporary mute after 3 warnings
    KICK: 4,        // Kick after 4 warnings
    BAN: 5          // Ban after 5 warnings
};

// Warning expiration (in days)
const WARNING_EXPIRATION_DAYS = 30;

class WarningService {
    constructor() {
        // Make thresholds accessible as a property of the service
        this.WARNING_THRESHOLDS = WARNING_THRESHOLDS;
        this.WARNING_EXPIRATION_DAYS = WARNING_EXPIRATION_DAYS;
    }

    /**
     * Records a warning for a user
     * @param {Object} ctx - Telegram context
     * @param {string} reason - Reason for the warning
     * @param {Object} agent - The agent that issued the warning
     * @returns {Promise<Object>} Result with warning count and action taken
     */
    async addWarning(ctx, reason, agent) {
        try {
            if (!ctx.from || !ctx.chat) {
                console.error('[WarningService] Missing user or chat information');
                return { success: false, error: 'Missing user or chat information' };
            }

            const userId = ctx.from.id.toString();
            const chatId = ctx.chat.id.toString();
            const username = ctx.from.username || '';
            const botId = ctx.botInfo?.id?.toString() || agent._id.toString();

            console.log(`[WarningService] Adding warning for user ${userId} in chat ${chatId}`);

            // Find or create warning record
            let warningRecord = await UserWarning.findOne({
                telegramUserId: userId,
                telegramChatId: chatId
            });

            // If user already has a warning record, check if they were previously banned
            if (warningRecord && warningRecord.isBanned) {
                console.log(`[WarningService] User ${userId} was previously banned in this group`);

                try {
                    // Reset warning count and ban status for re-added user
                    warningRecord.warningCount = 0;
                    warningRecord.warnings = [];
                    warningRecord.isBanned = false;
                    warningRecord.banDate = null;
                    warningRecord.banReason = null;
                    await warningRecord.save();

                    // Notify the chat
                    await ctx.reply(`⚠️ Warning history has been reset for a previously banned user who has been re-added to the group.`);

                    // Continue with adding the new warning after reset
                    console.log(`[WarningService] Warning history reset, now adding new warning`);
                } catch (error) {
                    console.error('[WarningService] Error resetting warnings for previously banned user:', error);
                }
            }

            // Remove expired warnings first (if record exists)
            if (warningRecord) {
                await this.cleanupExpiredWarnings(warningRecord);
            }

            if (!warningRecord) {
                console.log(`[WarningService] Creating new warning record for user ${userId}`);
                warningRecord = new UserWarning({
                    telegramUserId: userId,
                    telegramChatId: chatId,
                    username: username,
                    warningCount: 0,
                    warnings: []
                });
            }

            // Add the new warning
            warningRecord.warnings.push({
                reason: reason,
                timestamp: new Date(),
                moderatorBotId: botId
            });

            // Update warning count and last warning date
            warningRecord.warningCount = warningRecord.warnings.length;
            warningRecord.lastWarningDate = new Date();

            // Save the record
            await warningRecord.save();
            console.log(`[WarningService] User ${userId} now has ${warningRecord.warningCount} warnings`);

            // Check if threshold reached and take action
            const action = await this.checkThresholdAndTakeAction(ctx, warningRecord);

            return {
                success: true,
                userId: userId,
                warningCount: warningRecord.warningCount,
                action: action
            };
        } catch (error) {
            console.error('[WarningService] Error adding warning:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Clean up expired warnings
     * @param {Object} warningRecord - The warning record to clean
     * @returns {Promise<void>}
     */
    async cleanupExpiredWarnings(warningRecord) {
        if (!warningRecord.warnings || warningRecord.warnings.length === 0) {
            return;
        }

        const now = new Date();
        const expirationMs = WARNING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
        const validWarnings = warningRecord.warnings.filter(warning => {
            const warningDate = new Date(warning.timestamp);
            const ageMs = now - warningDate;
            return ageMs < expirationMs;
        });

        if (validWarnings.length < warningRecord.warnings.length) {
            console.log(`[WarningService] Removing ${warningRecord.warnings.length - validWarnings.length} expired warnings`);
            warningRecord.warnings = validWarnings;
            // Ensure warning count matches the actual number of valid warnings
            warningRecord.warningCount = validWarnings.length;

            // Check if user is currently banned but all ban-causing warnings have expired
            if (warningRecord.isBanned && warningRecord.warningCount < WARNING_THRESHOLDS.BAN) {
                console.log(`[WarningService] User's ban status reset due to expired warnings`);
                warningRecord.isBanned = false;
                warningRecord.banReason = null;
                warningRecord.banDate = null;
            }

            await warningRecord.save();
            console.log(`[WarningService] Updated warning count to ${warningRecord.warningCount} after cleanup`);
        }
    }

    /**
     * Check if warning thresholds have been reached and take appropriate action
     * @param {Object} ctx - Telegram context
     * @param {Object} warningRecord - The user's warning record
     * @returns {Promise<string>} Action taken
     */
    async checkThresholdAndTakeAction(ctx, warningRecord) {
        try {
            const warningCount = warningRecord.warningCount;
            const userId = warningRecord.telegramUserId;
            const chatId = warningRecord.telegramChatId;

            // If already banned, check if they've been re-added and reset their warnings
            if (warningRecord.isBanned) {
                console.log(`[WarningService] User ${userId} was previously banned, checking if they were re-added`);

                try {
                    // Check if the user is currently in the group
                    const chatMember = await ctx.telegram.getChatMember(chatId, userId);

                    // If user exists and is a member (not banned), reset their warnings
                    if (chatMember && ['member', 'administrator', 'creator'].includes(chatMember.status)) {
                        console.log(`[WarningService] Previously banned user ${userId} was re-added to group, resetting warnings`);

                        // Reset warning count and ban status
                        warningRecord.warningCount = 0;
                        warningRecord.warnings = [];
                        warningRecord.isBanned = false;
                        warningRecord.banDate = null;
                        warningRecord.banReason = null;
                        await warningRecord.save();

                        // Notify the chat
                        await ctx.reply(`⚠️ Warning history has been reset for a previously banned user who has been re-added to the group.`);

                        return 'warnings_reset';
                    }
                } catch (error) {
                    console.error('[WarningService] Error checking status of previously banned user:', error);
                }

                return 'already_banned';
            }

            console.log(`[WarningService] Checking thresholds for user ${userId} with ${warningCount} warnings`);

            // Double-check that warning count matches actual warnings array length
            if (warningCount !== warningRecord.warnings.length) {
                console.log(`[WarningService] Warning count mismatch detected: count=${warningCount}, actual=${warningRecord.warnings.length}`);
                warningRecord.warningCount = warningRecord.warnings.length;
                await warningRecord.save();
                console.log(`[WarningService] Fixed warning count to ${warningRecord.warningCount}`);
            }

            // Check for ban threshold (5 warnings)
            if (warningCount >= WARNING_THRESHOLDS.BAN) {
                console.log(`[WarningService] Ban threshold reached for user ${userId}`);
                try {
                    // Ban the user
                    await ctx.telegram.banChatMember(chatId, userId);

                    // Update record
                    warningRecord.isBanned = true;
                    warningRecord.banDate = new Date();
                    warningRecord.banReason = `Exceeded maximum warning threshold (${WARNING_THRESHOLDS.BAN})`;
                    await warningRecord.save();

                    // Notify the chat
                    await ctx.reply(`🚫 User has been banned from this group after receiving ${warningCount} warnings.`);

                    return 'banned';
                } catch (error) {
                    console.error('[WarningService] Error banning user:', error);
                    return 'ban_failed';
                }
            }

            // Check for kick threshold (4 warnings)
            else if (warningCount >= WARNING_THRESHOLDS.KICK) {
                console.log(`[WarningService] Kick threshold reached for user ${userId}`);
                try {
                    // Kick the user (ban and then unban to kick)
                    await ctx.telegram.banChatMember(chatId, userId);
                    setTimeout(async () => {
                        try {
                            await ctx.telegram.unbanChatMember(chatId, userId);
                            console.log(`[WarningService] Successfully unbanned user ${userId} after kick`);
                        } catch (unbanError) {
                            console.error('[WarningService] Error unbanning user after kick:', unbanError);
                        }
                    }, 5000); // 5 second delay

                    // Notify the chat
                    await ctx.reply(`⚠️ User has been removed from this group after receiving ${warningCount} warnings. They can rejoin but will be banned after ${WARNING_THRESHOLDS.BAN} warnings.`);

                    return 'kicked';
                } catch (error) {
                    console.error('[WarningService] Error kicking user:', error);
                    return 'kick_failed';
                }
            }

            // Check for mute threshold (3 warnings)
            else if (warningCount >= WARNING_THRESHOLDS.TEMP_MUTE) {
                console.log(`[WarningService] Mute threshold reached for user ${userId}`);
                try {
                    // Calculate mute duration (1 hour)
                    const muteUntil = Math.floor(Date.now() / 1000) + 3600;

                    // Restrict user permissions
                    await ctx.telegram.restrictChatMember(chatId, userId, {
                        until_date: muteUntil,
                        can_send_messages: false,
                        can_send_media_messages: false,
                        can_send_other_messages: false,
                        can_add_web_page_previews: false
                    });

                    // Notify the chat
                    await ctx.reply(`🔇 User has been muted for 1 hour after receiving ${warningCount} warnings.`);

                    return 'muted';
                } catch (error) {
                    console.error('[WarningService] Error muting user:', error);
                    return 'mute_failed';
                }
            }

            // No threshold reached yet
            return 'warning_recorded';
        } catch (error) {
            console.error('[WarningService] Error checking thresholds:', error);
            return 'threshold_check_failed';
        }
    }

    /**
     * Get warning count for a user in a specific chat
     * @param {string} userId - Telegram user ID
     * @param {string} chatId - Telegram chat ID
     * @returns {Promise<number>} Warning count
     */
    async getWarningCount(userId, chatId) {
        try {
            const warningRecord = await UserWarning.findOne({
                telegramUserId: userId.toString(),
                telegramChatId: chatId.toString()
            });

            if (!warningRecord) {
                return 0;
            }

            // Clean up expired warnings first
            await this.cleanupExpiredWarnings(warningRecord);

            return warningRecord.warningCount;
        } catch (error) {
            console.error('[WarningService] Error getting warning count:', error);
            return 0;
        }
    }

    /**
     * Get warning information for a user
     * @param {string} userId - Telegram user ID
     * @param {string} chatId - Telegram chat ID
     * @returns {Promise<Object|null>} Warning information or null if not found
     */
    async getWarningInfo(userId, chatId) {
        try {
            const warningRecord = await UserWarning.findOne({
                telegramUserId: userId.toString(),
                telegramChatId: chatId.toString()
            });

            if (!warningRecord) {
                return null;
            }

            // Clean up expired warnings first
            await this.cleanupExpiredWarnings(warningRecord);

            return {
                userId: warningRecord.telegramUserId,
                username: warningRecord.username,
                warningCount: warningRecord.warningCount,
                lastWarningDate: warningRecord.lastWarningDate,
                isBanned: warningRecord.isBanned,
                banDate: warningRecord.banDate,
                banReason: warningRecord.banReason,
                recentWarnings: warningRecord.warnings.slice(-3) // Get the 3 most recent warnings
            };
        } catch (error) {
            console.error('[WarningService] Error getting warning info:', error);
            return null;
        }
    }

    /**
     * Clear all warnings for a user in a specific chat
     * @param {string} userId - Telegram user ID
     * @param {string} chatId - Telegram chat ID
     * @returns {Promise<boolean>} Success indicator
     */
    async clearWarnings(userId, chatId) {
        try {
            const result = await UserWarning.findOneAndUpdate(
                {
                    telegramUserId: userId.toString(),
                    telegramChatId: chatId.toString()
                },
                {
                    $set: {
                        warningCount: 0,
                        warnings: [],
                        isBanned: false,
                        banDate: null,
                        banReason: null
                    }
                }
            );

            return !!result;
        } catch (error) {
            console.error('[WarningService] Error clearing warnings:', error);
            return false;
        }
    }
}

module.exports = new WarningService(); 