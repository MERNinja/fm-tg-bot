const { OpenAI } = require('openai');
require('dotenv').config();

class OpenAIService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    /**
     * Summarize conversation messages using OpenAI
     * @param {Array} messages - Array of message objects with role and content
     * @returns {Promise<string>} - Summary of the conversation
     */
    async summarizeConversation(messages) {
        try {
            if (!messages || messages.length === 0) {
                return '';
            }

            // Filter out empty messages and format for OpenAI
            const validMessages = messages.filter(m =>
                m && m.role && m.content && m.content.trim() !== ''
            );

            if (validMessages.length === 0) {
                return '';
            }

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

            // Call OpenAI API for summarization
            const response = await this.openai.chat.completions.create({
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

            // Extract and return the summary
            const summary = response.choices[0]?.message?.content?.trim();
            return summary || 'Conversation summary not available.';
        } catch (error) {
            console.error('Error using OpenAI for summarization:', error);
            return 'Conversation summary not available due to an error.';
        }
    }
}

module.exports = new OpenAIService(); 