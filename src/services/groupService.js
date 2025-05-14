const Group = require('../models/Group');
const User = require('../models/User');
const Agent = require('../models/Agent');

/**
 * Group Service for managing Telegram groups
 */
class GroupService {
    /**
     * Add or update a group in the database
     * 
     * @param {Object} groupData - Group data including telegramGroupId and other properties
     * @returns {Promise<Object>} - The created or updated group
     */
    async saveGroup(groupData) {
        try {
            const { telegramGroupId } = groupData;

            // Check if group exists
            let group = await Group.findOne({ telegramGroupId });

            if (group) {
                // Update existing group
                Object.assign(group, groupData);
                group.lastActivity = new Date();
                await group.save();
                console.log(`[GroupService] Updated group: ${telegramGroupId}, name: ${group.groupName}`);
                return group;
            } else {
                // Create new group
                group = new Group(groupData);
                await group.save();
                console.log(`[GroupService] Created new group: ${telegramGroupId}, name: ${group.groupName}`);
                return group;
            }
        } catch (error) {
            console.error(`[GroupService] Error saving group:`, error);
            throw error;
        }
    }

    /**
     * Get a group by Telegram group ID
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @returns {Promise<Object>} - The group or null if not found
     */
    async getGroupByTelegramId(telegramGroupId) {
        try {
            const group = await Group.findOne({ telegramGroupId })
                .populate('agentId')
                .populate('apiKeyUserId')
                .populate('addedByUserId');

            return group;
        } catch (error) {
            console.error(`[GroupService] Error getting group ${telegramGroupId}:`, error);
            return null;
        }
    }

    /**
     * Get all groups for a specific agent
     * 
     * @param {String} agentId - MongoDB ID of the agent
     * @returns {Promise<Array>} - Array of groups
     */
    async getGroupsByAgentId(agentId) {
        try {
            const groups = await Group.find({ agentId, isActive: true })
                .sort({ lastActivity: -1 })
                .populate('apiKeyUserId', 'email fullName');

            return groups;
        } catch (error) {
            console.error(`[GroupService] Error getting groups for agent ${agentId}:`, error);
            return [];
        }
    }

    /**
     * Get all groups added by a specific user
     * 
     * @param {String} userId - MongoDB ID of the user
     * @returns {Promise<Array>} - Array of groups
     */
    async getGroupsByUser(userId) {
        try {
            const groups = await Group.find({
                $or: [{ addedByUserId: userId }, { apiKeyUserId: userId }],
                isActive: true
            })
                .sort({ lastActivity: -1 })
                .populate('agentId', 'name');

            return groups;
        } catch (error) {
            console.error(`[GroupService] Error getting groups for user ${userId}:`, error);
            return [];
        }
    }

    /**
     * Get all groups added by a specific user
     * 
     * @param {String} userId - MongoDB ID of the user who added the groups
     * @returns {Promise<Array>} - Array of groups
     */
    async getGroupsByAddedByUserId(userId) {
        try {
            const groups = await Group.find({
                addedByUserId: userId,
                isActive: true
            })
                .sort({ lastActivity: -1 })
                .populate('agentId', 'name');

            console.log(`[GroupService] Found ${groups.length} groups added by user ${userId}`);
            return groups;
        } catch (error) {
            console.error(`[GroupService] Error getting groups added by user ${userId}:`, error);
            return [];
        }
    }

    /**
     * Update a group's API key user
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @param {String} userId - MongoDB ID of the user
     * @returns {Promise<Object>} - The updated group
     */
    async updateGroupApiKeyUser(telegramGroupId, userId) {
        try {
            const group = await Group.findOneAndUpdate(
                { telegramGroupId },
                {
                    apiKeyUserId: userId,
                    lastActivity: new Date()
                },
                { new: true }
            );

            console.log(`[GroupService] Updated API key user for group ${telegramGroupId} to user ${userId}`);
            return group;
        } catch (error) {
            console.error(`[GroupService] Error updating API key user for group ${telegramGroupId}:`, error);
            throw error;
        }
    }

    /**
     * Toggle moderation for a group
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @param {Boolean} enabled - Whether moderation should be enabled
     * @returns {Promise<Object>} - The updated group
     */
    async toggleModeration(telegramGroupId, enabled) {
        try {
            const group = await Group.findOneAndUpdate(
                { telegramGroupId },
                {
                    moderationEnabled: enabled,
                    lastActivity: new Date()
                },
                { new: true }
            );

            console.log(`[GroupService] ${enabled ? 'Enabled' : 'Disabled'} moderation for group ${telegramGroupId}`);
            return group;
        } catch (error) {
            console.error(`[GroupService] Error toggling moderation for group ${telegramGroupId}:`, error);
            throw error;
        }
    }

    /**
     * Update moderation settings for a group
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @param {Boolean} enabled - Whether moderation should be enabled
     * @returns {Promise<Object>} - The updated group
     */
    async updateGroupModeration(telegramGroupId, enabled) {
        try {
            const group = await Group.findOneAndUpdate(
                { telegramGroupId },
                {
                    moderationEnabled: enabled,
                    lastActivity: new Date()
                },
                { new: true }
            );

            console.log(`[GroupService] ${enabled ? 'Enabled' : 'Disabled'} moderation for group ${telegramGroupId}`);
            return group;
        } catch (error) {
            console.error(`[GroupService] Error updating moderation for group ${telegramGroupId}:`, error);
            throw error;
        }
    }

    /**
     * Update API usage statistics for a group
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @param {String} usageType - Type of usage: 'message', 'moderation', or 'command'
     * @returns {Promise<Boolean>} - Success status
     */
    async updateApiUsage(telegramGroupId, usageType = 'message') {
        try {
            const updateField = `apiUsage.${usageType}Count`;

            await Group.findOneAndUpdate(
                { telegramGroupId },
                {
                    $inc: { [updateField]: 1 },
                    lastActivity: new Date()
                }
            );

            return true;
        } catch (error) {
            console.error(`[GroupService] Error updating API usage for group ${telegramGroupId}:`, error);
            return false;
        }
    }

    /**
     * Mark a group as inactive (when bot is removed)
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @returns {Promise<Boolean>} - Success status
     */
    async deactivateGroup(telegramGroupId) {
        try {
            await Group.findOneAndUpdate(
                { telegramGroupId },
                { isActive: false }
            );

            console.log(`[GroupService] Deactivated group ${telegramGroupId}`);
            return true;
        } catch (error) {
            console.error(`[GroupService] Error deactivating group ${telegramGroupId}:`, error);
            return false;
        }
    }

    /**
     * Get the API key user for a specific group
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @returns {Promise<Object>} - User object with API key or null
     */
    async getApiKeyUserForGroup(telegramGroupId) {
        try {
            const group = await Group.findOne({ telegramGroupId })
                .populate('apiKeyUserId');

            if (!group || !group.apiKeyUserId) {
                return null;
            }

            return group.apiKeyUserId;
        } catch (error) {
            console.error(`[GroupService] Error getting API key user for group ${telegramGroupId}:`, error);
            return null;
        }
    }

    /**
     * Get custom instructions for a group
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @returns {Promise<String>} - Custom instructions text or empty string
     */
    async getGroupInstructions(telegramGroupId) {
        try {
            const group = await Group.findOne({ telegramGroupId });
            if (!group) {
                return '';
            }
            return group.customInstructions || '';
        } catch (error) {
            console.error(`[GroupService] Error getting instructions for group ${telegramGroupId}:`, error);
            return '';
        }
    }

    /**
     * Set custom instructions for a group
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @param {String} instructions - The custom instructions text
     * @returns {Promise<Object>} - The updated group
     */
    async setGroupInstructions(telegramGroupId, instructions) {
        try {
            const group = await Group.findOneAndUpdate(
                { telegramGroupId },
                {
                    customInstructions: instructions,
                    lastActivity: new Date()
                },
                { new: true }
            );

            console.log(`[GroupService] Updated custom instructions for group ${telegramGroupId}`);
            return group;
        } catch (error) {
            console.error(`[GroupService] Error setting instructions for group ${telegramGroupId}:`, error);
            throw error;
        }
    }

    /**
     * Clear custom instructions for a group
     * 
     * @param {String} telegramGroupId - Telegram group ID
     * @returns {Promise<Object>} - The updated group
     */
    async clearGroupInstructions(telegramGroupId) {
        try {
            const group = await Group.findOneAndUpdate(
                { telegramGroupId },
                {
                    customInstructions: '',
                    lastActivity: new Date()
                },
                { new: true }
            );

            console.log(`[GroupService] Cleared custom instructions for group ${telegramGroupId}`);
            return group;
        } catch (error) {
            console.error(`[GroupService] Error clearing instructions for group ${telegramGroupId}:`, error);
            throw error;
        }
    }
}

module.exports = new GroupService(); 