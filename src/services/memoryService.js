const Conversation = require('../models/Conversation');
const openaiService = require('./openaiService');

// Cache recent messages to prevent duplicates
const recentMessageCache = new Map();
const MESSAGE_CACHE_TTL = 30000; // 30 seconds

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
            console.log(`[Memory] Looking for conversation: User=${telegramUserId}, Chat=${telegramChatId}, Agent=${agentId}`);

            let conversation = await Conversation.findOne({
                telegramUserId,
                telegramChatId,
                agentId
            });

            if (!conversation) {
                console.log(`[Memory] Conversation not found, creating new conversation`);
                conversation = new Conversation({
                    telegramUserId,
                    telegramChatId,
                    agentId,
                    messages: []
                });
                await conversation.save();
                console.log(`[Memory] Created new conversation for user ${telegramUserId} with agent ${agentId}, ID: ${conversation._id}`);
            } else {
                console.log(`[Memory] Found existing conversation: ID=${conversation._id}, Messages=${conversation.messages.length}`);
            }

            return conversation;
        } catch (error) {
            console.error(`[Memory] ERROR in getOrCreateConversation: ${error.message}`, error);
            // throw error;
        }
    }

    /**
     * Check if a message appears to be a duplicate of a recently saved message
     * @param {string} telegramUserId - The Telegram user ID
     * @param {string} role - The message role
     * @param {string} content - The message content
     * @returns {boolean} - True if the message appears to be a duplicate
     */
    isDuplicateMessage(telegramUserId, role, content) {
        const cacheKey = `${telegramUserId}-${role}-${content.substring(0, 50)}`;

        if (recentMessageCache.has(cacheKey)) {
            console.log(`[Memory] Detected potential duplicate message: ${cacheKey}`);
            return true;
        }

        // Store in cache for duplicate detection
        recentMessageCache.set(cacheKey, Date.now());

        // Cleanup old cache entries (simple TTL implementation)
        const now = Date.now();
        for (const [key, timestamp] of recentMessageCache.entries()) {
            if (now - timestamp > MESSAGE_CACHE_TTL) {
                recentMessageCache.delete(key);
            }
        }

        return false;
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
            console.log(`[Memory] Adding message: User=${telegramUserId}, Role=${role}, ContentLength=${content?.length || 0}`);

            // Validate content - don't store empty messages
            if (!content || content.trim() === '') {
                console.log(`[Memory] Skipping empty message from ${role} for user ${telegramUserId}`);
                return null;
            }

            // Check for potential duplicates
            if (this.isDuplicateMessage(telegramUserId, role, content)) {
                console.log(`[Memory] Skipping duplicate message from ${role} for user ${telegramUserId}`);
                return null;
            }

            const conversation = await this.getOrCreateConversation(telegramUserId, telegramChatId, agentId);
            if (!conversation) {
                console.log('[Memory] Failed to get or create conversation, message not saved');
                return null;
            }

            // Check if the last message is identical to avoid duplicates
            if (conversation.messages.length > 0) {
                const lastMessage = conversation.messages[conversation.messages.length - 1];
                if (lastMessage.role === role && lastMessage.content === content.trim()) {
                    console.log(`[Memory] Skipping duplicate of last message from ${role} for user ${telegramUserId}`);
                    return conversation;
                }
            }

            // Add message to conversation
            conversation.messages.push({
                role,
                content: content.trim(), // Ensure content is trimmed
                timestamp: new Date()
            });

            conversation.lastActive = new Date();
            console.log(`[Memory] Saving conversation with ${conversation.messages.length} messages`);
            await conversation.save();
            console.log(`[Memory] Message saved successfully to conversation ${conversation._id}`);

            // If message count exceeds threshold, summarize older messages
            if (conversation.messages.length > 30) {
                console.log(`[Memory] Message threshold exceeded (${conversation.messages.length} > 10), triggering summarization`);
                this.summarizeOldMessages(conversation._id);
            }

            return conversation;
        } catch (error) {
            console.error(`[Memory] ERROR in addMessage: ${error.message}`, error);
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
            console.log(`[Memory] Getting conversation history: User=${telegramUserId}, Limit=${limit}`);

            const conversation = await this.getOrCreateConversation(telegramUserId, telegramChatId, agentId);
            if (!conversation) {
                console.log('[Memory] Failed to get conversation, returning empty history');
                return [];
            }

            // If there's a summary and many messages, use the summary to provide context
            if (conversation.summary && conversation.messages.length > 30) {
                console.log(`[Memory] Using summary with recent messages (total: ${conversation.messages.length})`);
                const recentMessages = conversation.messages.slice(-limit);

                const result = [
                    { role: 'system', content: `Previous conversation summary: ${conversation.summary}` },
                    ...recentMessages
                ];

                console.log(`[Memory] Returning ${result.length} messages with summary`);
                return result;
            }

            // Return the most recent messages up to the limit
            const messages = conversation.messages.slice(-limit);
            console.log(`[Memory] Returning ${messages.length} recent messages (no summary)`);
            return messages;
        } catch (error) {
            console.error(`[Memory] ERROR in getConversationHistory: ${error.message}`, error);
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
            console.log(`[Memory] Starting summarization for conversation: ${conversationId}`);

            const conversation = await Conversation.findById(conversationId);
            if (!conversation) {
                console.log(`[Memory] Conversation ${conversationId} not found, aborting summarization`);
                return;
            }

            // Keep only the most recent 5 messages and summarize the rest
            const messagesToKeep = 5;
            if (conversation.messages.length <= messagesToKeep) {
                console.log(`[Memory] Not enough messages to summarize (${conversation.messages.length} <= ${messagesToKeep})`);
                return;
            }

            const oldMessages = conversation.messages.slice(0, -messagesToKeep);
            console.log(`[Memory] Found ${oldMessages.length} old messages to summarize`);

            // Filter out any potentially empty messages
            const validOldMessages = oldMessages.filter(m =>
                m.content && m.content.trim() !== ''
            );
            console.log(`[Memory] ${validOldMessages.length} valid messages for summarization after filtering`);

            if (validOldMessages.length === 0) {
                // If no valid old messages, just remove empty messages
                console.log(`[Memory] No valid old messages, just cleaning up conversation`);
                conversation.messages = conversation.messages.slice(-messagesToKeep);
                await conversation.save();
                console.log(`[Memory] Cleaned up conversation, now has ${conversation.messages.length} messages`);
                return;
            }

            // Use OpenAI to generate a summary
            let aiSummary = '';
            try {
                console.log(`[Memory] Calling OpenAI to summarize ${validOldMessages.length} messages`);
                aiSummary = await openaiService.summarizeConversation(validOldMessages);
                console.log(`[Memory] AI summarization successful, result length: ${aiSummary.length}`);
            } catch (aiError) {
                console.error(`[Memory] Error generating AI summary: ${aiError.message}`, aiError);
                // Fallback to simple summary method
                console.log(`[Memory] Falling back to simple summarization`);
                aiSummary = this.createSimpleSummary(validOldMessages);
                console.log(`[Memory] Simple summary created, length: ${aiSummary.length}`);
            }

            // Create the final summary
            let summary = conversation.summary || '';
            if (summary) {
                console.log(`[Memory] Appending to existing summary (${summary.length} chars)`);
                summary += '\n\n';
            }

            // Add message count and AI summary
            summary += `${validOldMessages.length} earlier messages summarized: ${aiSummary}`;
            console.log(`[Memory] Final summary length: ${summary.length} chars`);

            // Update conversation with summary and keep only recent messages
            conversation.summary = summary;
            conversation.messages = conversation.messages.slice(-messagesToKeep);

            console.log(`[Memory] Saving updated conversation with summary and ${conversation.messages.length} messages`);
            await conversation.save();
            console.log(`[Memory] Summarization complete for conversation ${conversationId}`);
        } catch (error) {
            console.error(`[Memory] ERROR in summarizeOldMessages: ${error.message}`, error);
        }
    }

    /**
     * Create a simple summary as a fallback when AI summarization fails
     * @param {Array} messages - Array of message objects
     * @returns {string} - Simple summary text
     */
    createSimpleSummary(messages) {
        try {
            console.log(`[Memory] Creating simple summary for ${messages.length} messages`);

            const userMessages = messages.filter(m => m.role === 'user');
            const assistantMessages = messages.filter(m => m.role === 'assistant');

            console.log(`[Memory] Found ${userMessages.length} user messages and ${assistantMessages.length} assistant messages`);

            let summary = '';

            // Add user messages summary if available
            if (userMessages.length > 0) {
                const userContentSamples = userMessages.slice(-3)
                    .map(m => m.content && typeof m.content === 'string' ? m.content.substring(0, 50) : '')
                    .filter(text => text.length > 0);

                if (userContentSamples.length > 0) {
                    summary += `User discussed: ${userContentSamples.join('; ')}... `;
                    console.log(`[Memory] Added ${userContentSamples.length} user samples to summary`);
                }
            }

            // Add assistant messages summary if available
            if (assistantMessages.length > 0) {
                const assistantContentSamples = assistantMessages.slice(-3)
                    .map(m => m.content && typeof m.content === 'string' ? m.content.substring(0, 50) : '')
                    .filter(text => text.length > 0);

                if (assistantContentSamples.length > 0) {
                    summary += `Assistant provided: ${assistantContentSamples.join('; ')}...`;
                    console.log(`[Memory] Added ${assistantContentSamples.length} assistant samples to summary`);
                }
            }

            console.log(`[Memory] Simple summary created, length: ${summary.length}`);
            return summary || 'Conversation details not available.';
        } catch (error) {
            console.error(`[Memory] ERROR in createSimpleSummary: ${error.message}`, error);
            return 'Conversation details not available.';
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
            console.log(`[Memory] Clearing conversation history: User=${telegramUserId}, Agent=${agentId}`);

            const result = await Conversation.findOneAndUpdate(
                { telegramUserId, telegramChatId, agentId },
                { $set: { messages: [], summary: '' } },
                { new: true }
            );

            if (result) {
                console.log(`[Memory] Successfully cleared conversation history for ID: ${result._id}`);
                return true;
            } else {
                console.log(`[Memory] No conversation found to clear for user ${telegramUserId} with agent ${agentId}`);
                return false;
            }
        } catch (error) {
            console.error(`[Memory] ERROR in clearConversationHistory: ${error.message}`, error);
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
            console.log(`[Memory] Building context from history: User=${telegramUserId}, maxTokens=${maxTokens}`);

            const conversation = await this.getOrCreateConversation(telegramUserId, telegramChatId, agentId);
            if (!conversation) {
                console.log(`[Memory] No conversation found, returning empty context`);
                return '';
            }

            // Get messages and check if we have a summary
            const messages = conversation.messages;
            const hasSummary = conversation.summary && conversation.summary.trim() !== '';

            console.log(`[Memory] Found conversation with ${messages.length} messages${hasSummary ? ' and summary' : ''}`);

            if (!messages || messages.length === 0) {
                // If we have a summary but no messages, still return the summary
                if (hasSummary) {
                    console.log(`[Memory] No messages but summary available, returning only summary`);
                    return `Previous conversation summary: ${conversation.summary}\n\n`;
                }

                console.log(`[Memory] No messages found, returning empty context`);
                return '';
            }

            // Filter out any potentially empty messages
            const validMessages = messages.filter(m =>
                m && m.role && m.content && m.content.trim() !== ''
            );

            console.log(`[Memory] Found ${validMessages.length} valid messages after filtering`);

            if (validMessages.length === 0 && !hasSummary) {
                console.log(`[Memory] No valid messages after filtering and no summary, returning empty context`);
                return '';
            }

            // Simple token estimation (1 token ≈ 4 characters)
            const estimatedTokenLimit = maxTokens * 4;
            console.log(`[Memory] Estimated token limit: ${maxTokens} tokens ≈ ${estimatedTokenLimit} chars`);

            let context = 'Previous conversation:\n\n';
            let totalLength = context.length;

            // Always include summary if available (it's more important than old messages)
            if (hasSummary) {
                const summaryText = `Summary of earlier conversation: ${conversation.summary}\n\n`;
                context += summaryText;
                totalLength += summaryText.length;
                console.log(`[Memory] Added summary to context (${summaryText.length} chars)`);
            }

            let includedMessages = 0;

            // Add messages to context, respecting token limit
            for (let i = 0; i < validMessages.length; i++) {
                try {
                    const message = validMessages[i];
                    const roleLabel = message.role === 'user' ? 'User' :
                        message.role === 'assistant' ? 'Assistant' :
                            'System';

                    const messageText = `${roleLabel}: ${message.content}\n\n`;

                    if (totalLength + messageText.length > estimatedTokenLimit) {
                        console.log(`[Memory] Token limit reached after ${includedMessages} messages, truncating`);
                        if (includedMessages === 0) {
                            // If we couldn't add any messages but have a summary, that's still useful
                            if (hasSummary) {
                                console.log(`[Memory] No room for messages, but summary was included`);
                                return context;
                            }

                            // If we can't even add one message, truncate the message to fit
                            const truncatedMessage = `${roleLabel}: ${message.content.substring(0, estimatedTokenLimit - totalLength - 50)}...\n\n`;
                            context += truncatedMessage;
                            includedMessages++;
                            console.log(`[Memory] Added truncated message (${truncatedMessage.length} chars)`);
                        } else {
                            context += '... (earlier messages omitted for brevity) ...\n\n';
                        }
                        break;
                    }

                    context += messageText;
                    totalLength += messageText.length;
                    includedMessages++;
                } catch (messageError) {
                    console.error(`[Memory] Error processing message for context: ${messageError.message}`, messageError);
                    // Skip problematic messages
                    continue;
                }
            }

            console.log(`[Memory] Built context with ${includedMessages}/${validMessages.length} messages, total length: ${totalLength} chars`);
            return context;
        } catch (error) {
            console.error(`[Memory] ERROR in buildContextFromHistory: ${error.message}`, error);
            return '';
        }
    }
}

module.exports = new MemoryService(); 