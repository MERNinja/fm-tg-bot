const { OpenAI } = require('openai');
require('dotenv').config();

// OpenAI request timeout (30 seconds)
const OPENAI_TIMEOUT = 30000;

class OpenAIService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            timeout: OPENAI_TIMEOUT
        });
    }

    /**
     * Summarize conversation messages using OpenAI
     * @param {Array} messages - Array of message objects with role and content
     * @returns {Promise<string>} - Summary of the conversation
     */
    async summarizeConversation(messages) {
        try {
            console.log(`[OpenAI] Starting summarization request for ${messages?.length || 0} messages`);

            if (!messages || messages.length === 0) {
                console.log('[OpenAI] No messages to summarize');
                return '';
            }

            // Filter out empty messages and format for OpenAI
            const validMessages = messages.filter(m =>
                m && m.role && m.content && m.content.trim() !== ''
            );

            if (validMessages.length === 0) {
                console.log('[OpenAI] No valid messages after filtering');
                return '';
            }

            console.log(`[OpenAI] Summarizing ${validMessages.length} messages`);

            // Create a formatted conversation string for the AI
            const conversationText = validMessages.map(m => {
                const role = m.role === 'user' ? 'User' :
                    m.role === 'assistant' ? 'Assistant' : 'System';
                return `${role}: ${m.content.trim()}`;
            }).join('\n\n');

            // Create the prompt for summarization
            const prompt = `Please summarize the following conversation in 2-3 sentences, 
      highlighting the main topics discussed and key points. Please write the summary 
      in third person (e.g., "The user asked about X, and the assistant explained Y").
      
      Here's the conversation:
      
      ${conversationText}
      
      Summary:`;

            // Create a promise with timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`OpenAI summarization request timed out after ${OPENAI_TIMEOUT / 1000} seconds`));
                }, OPENAI_TIMEOUT);
            });

            // Call OpenAI API for summarization with timeout
            const apiPromise = this.openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    {
                        role: "system",
                        content: "You are a helpful assistant that summarizes conversations concisely."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 150,
                temperature: 0.7,
            });

            // Race against timeout
            const response = await Promise.race([apiPromise, timeoutPromise]);

            // Extract and return the summary
            const summary = response.choices[0]?.message?.content?.trim();
            console.log(`[OpenAI] Summarization successful, result length: ${summary?.length || 0}`);

            return summary || 'Conversation summary not available.';
        } catch (error) {
            // Specific error handling
            if (error.message && error.message.includes('timed out')) {
                console.error('[OpenAI] Summarization request timed out:', error.message);
                return 'Conversation summary not available due to timeout.';
            }

            if (error.status) {
                console.error(`[OpenAI] API error (${error.status}):`, error.message);
                return `Conversation summary not available. API error ${error.status}.`;
            }

            console.error('[OpenAI] Error using OpenAI for summarization:', error);
            return 'Conversation summary not available due to an error.';
        }
    }
}

module.exports = new OpenAIService(); 