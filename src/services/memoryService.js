const Conversation = require('../models/Conversation');

class MemoryService {
    /**
     * Get or create a conversation for a specific user and agent
     * @param {string} telegramUserId - The Telegram user ID
     * @param {string} telegramChatId - The Telegram chat ID
     * @param {string} agentId - The agent ID
     * @returns {Promise<Object>} - The conversation object
     */
    async getOrCreateConversation(telegramUserId, telegramChatId, agentId) {
        try {
            let conversation = await Conversation.findOne({
                telegramUserId,
                telegramChatId,
                agentId
            });

            if (!conversation) {
                conversation = new Conversation({
                    telegramUserId,
                    telegramChatId,
                    agentId,
                    messages: []
                });
                await conversation.save();
                console.log(`Created new conversation for user ${telegramUserId} with agent ${agentId}`);
            }

            return conversation;
        } catch (error) {
            console.error('Error getting or creating conversation:', error);
            // throw error;
        }
    }

    /**
     * Add a message to the conversation history
     * @param {string} telegramUserId - The Telegram user ID
     * @param {string} telegramChatId - The Telegram chat ID
     * @param {string} agentId - The agent ID
     * @param {string} role - The message role (user, assistant, system)
     * @param {string} content - The message content
     * @returns {Promise<Object>} - The updated conversation
     */
    async addMessage(telegramUserId, telegramChatId, agentId, role, content) {
        try {
            // Validate content - don't store empty messages
            if (!content || content.trim() === '') {
                console.log(`Skipping empty message from ${role} for user ${telegramUserId}`);
                return null;
            }

            const conversation = await this.getOrCreateConversation(telegramUserId, telegramChatId, agentId);

            conversation.messages.push({
                role,
                content: content.trim(), // Ensure content is trimmed
                timestamp: new Date()
            });

            conversation.lastActive = new Date();
            await conversation.save();

            // If message count exceeds threshold, summarize older messages
            if (conversation.messages.length > 10) {
                this.summarizeOldMessages(conversation._id);
            }

            return conversation;
        } catch (error) {
            console.error('Error adding message to conversation:', error);
            // throw error;
        }
    }

    /**
     * Get conversation history for a user and agent
     * @param {string} telegramUserId - The Telegram user ID
     * @param {string} telegramChatId - The Telegram chat ID
     * @param {string} agentId - The agent ID
     * @param {number} limit - Maximum number of messages to return
     * @returns {Promise<Array>} - Array of messages
     */
    async getConversationHistory(telegramUserId, telegramChatId, agentId, limit = 20) {
        try {
            const conversation = await this.getOrCreateConversation(telegramUserId, telegramChatId, agentId);

            // If there's a summary and many messages, use the summary to provide context
            if (conversation.summary && conversation.messages.length > 30) {
                const recentMessages = conversation.messages.slice(-limit);
                return [
                    { role: 'system', content: `Previous conversation summary: ${conversation.summary}` },
                    ...recentMessages
                ];
            }

            // Return the most recent messages up to the limit
            return conversation.messages.slice(-limit);
        } catch (error) {
            console.error('Error getting conversation history:', error);
            return [];
        }
    }

    /**
     * Summarize older messages to maintain context while keeping token count low
     * @param {string} conversationId - The conversation ID
     * @returns {Promise<void>}
     */
    async summarizeOldMessages(conversationId) {
        try {
            const conversation = await Conversation.findById(conversationId);
            if (!conversation) return;

            // Keep only the most recent 5 messages and summarize the rest
            const messagesToKeep = 5;
            if (conversation.messages.length <= messagesToKeep) return;

            const oldMessages = conversation.messages.slice(0, -messagesToKeep);

            // Filter out any potentially empty messages
            const validOldMessages = oldMessages.filter(m =>
                m.content && m.content.trim() !== ''
            );

            if (validOldMessages.length === 0) {
                // If no valid old messages, just remove empty messages
                conversation.messages = conversation.messages.slice(-messagesToKeep);
                await conversation.save();
                return;
            }

            // Create a simple summary - in a production app, you might use an LLM for this
            let summary = conversation.summary || '';
            if (summary) summary += '\n\n';

            summary += `${validOldMessages.length} earlier messages exchanged. Key points: `;

            // Extract a simple summary from the messages - handle potential errors
            try {
                const userMessages = validOldMessages.filter(m => m.role === 'user');
                const assistantMessages = validOldMessages.filter(m => m.role === 'assistant');

                // Add user messages summary if available
                if (userMessages.length > 0) {
                    const userContentSamples = userMessages.slice(-3)
                        .map(m => m.content && typeof m.content === 'string' ? m.content.substring(0, 50) : '')
                        .filter(text => text.length > 0);

                    if (userContentSamples.length > 0) {
                        summary += `User discussed: ${userContentSamples.join('; ')}... `;
                    }
                }

                // Add assistant messages summary if available
                if (assistantMessages.length > 0) {
                    const assistantContentSamples = assistantMessages.slice(-3)
                        .map(m => m.content && typeof m.content === 'string' ? m.content.substring(0, 50) : '')
                        .filter(text => text.length > 0);

                    if (assistantContentSamples.length > 0) {
                        summary += `Assistant provided: ${assistantContentSamples.join('; ')}...`;
                    }
                }
            } catch (summaryError) {
                console.error('Error creating content summary:', summaryError);
                summary += 'Conversation details not available.';
            }

            // Update conversation with summary and keep only recent messages
            conversation.summary = summary;
            conversation.messages = conversation.messages.slice(-messagesToKeep);

            await conversation.save();
            console.log(`Summarized old messages for conversation ${conversationId}`);
        } catch (error) {
            console.error('Error summarizing old messages:', error);
        }
    }

    /**
     * Clear conversation history for a user and agent
     * @param {string} telegramUserId - The Telegram user ID
     * @param {string} telegramChatId - The Telegram chat ID
     * @param {string} agentId - The agent ID
     * @returns {Promise<boolean>} - Success indicator
     */
    async clearConversationHistory(telegramUserId, telegramChatId, agentId) {
        try {
            const result = await Conversation.findOneAndUpdate(
                { telegramUserId, telegramChatId, agentId },
                { $set: { messages: [], summary: '' } },
                { new: true }
            );

            return !!result;
        } catch (error) {
            console.error('Error clearing conversation history:', error);
            return false;
        }
    }

    /**
     * Build context from conversation history for AI prompt
     * @param {string} telegramUserId - The Telegram user ID
     * @param {string} telegramChatId - The Telegram chat ID
     * @param {string} agentId - The agent ID
     * @param {number} maxTokens - Maximum context tokens to include
     * @returns {Promise<string>} - Formatted context string
     */
    async buildContextFromHistory(telegramUserId, telegramChatId, agentId, maxTokens = 2000) {
        try {
            const messages = await this.getConversationHistory(telegramUserId, telegramChatId, agentId);

            if (!messages || messages.length === 0) return '';

            // Filter out any potentially empty messages
            const validMessages = messages.filter(m =>
                m && m.role && m.content && m.content.trim() !== ''
            );

            if (validMessages.length === 0) return '';

            // Simple token estimation (1 token ≈ 4 characters)
            const estimatedTokenLimit = maxTokens * 4;

            let context = 'Previous conversation:\n\n';
            let totalLength = context.length;

            // Add messages to context, respecting token limit
            for (let i = 0; i < validMessages.length; i++) {
                try {
                    const message = validMessages[i];
                    const roleLabel = message.role === 'user' ? 'User' :
                        message.role === 'assistant' ? 'Assistant' :
                            'System';

                    const messageText = `${roleLabel}: ${message.content}\n\n`;

                    if (totalLength + messageText.length > estimatedTokenLimit) {
                        context += '... (earlier conversation omitted) ...\n\n';
                        break;
                    }

                    context += messageText;
                    totalLength += messageText.length;
                } catch (messageError) {
                    console.error('Error processing message for context:', messageError);
                    // Skip problematic messages
                    continue;
                }
            }

            return context;
        } catch (error) {
            console.error('Error building context from history:', error);
            return '';
        }
    }
}

module.exports = new MemoryService(); 