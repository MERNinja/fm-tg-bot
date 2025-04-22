const fullmetalService = require('../services/fullmetalService');
const memoryService = require('../services/memoryService');
require('dotenv').config();
/**
 * Process streaming responses from Fullmetal AI and update the Telegram message
 */
class MessageController {
  /**
   * Process a user message and stream the response
   * @param {string} userMessage - The user's message
   * @param {Object} ctx - The Telegram context object
   * @returns {Promise<string>} - The final response text
   */3.

  async processMessage(userMessage, ctx, agent) {
    
    try {
      const telegramUserId = ctx.from.id.toString();
      const telegramChatId = ctx.chat.id.toString();
      const agentId = agent._id.toString();

      // Store user message in conversation history
      await memoryService.addMessage(telegramUserId, telegramChatId, agentId, 'user', userMessage);

      // Get conversation history to provide context
      const conversationContext = await memoryService.buildContextFromHistory(telegramUserId, telegramChatId, agentId);

      // If we have conversation context, add it to the message
      const messageWithContext = conversationContext
        ? `${conversationContext}\n\nUser's current message: ${userMessage}`
        : userMessage;

      // Get streaming response from Fullmetal API
      const { response } = await fullmetalService.getStreamingResponse(messageWithContext, agent);
      
      // Create initial message to update
      const sentMessage = await ctx.reply('...');
      let messageId = sentMessage.message_id;
      let responseText = '';
      let buffer = '';
      
      // Store response start time for metrics
      const responseStartTime = Date.now();

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
                    responseText += data.token;
                    // Update the message periodically (not on every token to avoid rate limits)
                    if (responseText.length % 20 === 0) {
                      ctx.telegram.editMessageText(
                        ctx.chat.id, 
                        messageId, 
                        undefined, 
                        responseText + "..."
                      ).catch(error => console.error('Error updating message:', error));
                    }
                  }
                } catch (e) {
                  console.error('Error parsing chunk:', e);
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
                  responseText += data.token;
                }
              } catch (e) {
                console.error('Error parsing final chunk:', e);
              }
            }
          }
          
          // Final update to the message
          ctx.telegram.editMessageText(
            ctx.chat.id, 
            messageId, 
            undefined, 
            responseText || `⚠️ I apologize, but I couldn't generate a reply at this time. Please try again later.`
          ).catch(error => console.error('Error updating final message:', error));
          
          // Store assistant response in conversation history
          await memoryService.addMessage(telegramUserId, telegramChatId, agentId, 'assistant', responseText);

          // Update agent metrics if we have an agent
          if (agent && agent._id) {
            await fullmetalService.updateResponseMetrics(agent, responseStartTime);
          }
          
          resolve(responseText || `⚠️ I apologize, but I couldn't reply at this moment. Please try again later.`);
        });

        response.body.on('error', err => {
          console.error('Stream error:', err);
          reject(err);
        });
      });
    } catch (error) {
      console.error('Error processing message:', error);
      // throw error;
    }
  }

  /**
   * Set or update an agent's pre-prompt
   * @param {Object} ctx - The Telegram context object
   * @returns {Promise<void>}
   */
  async setPrePrompt(ctx) {
    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
      return ctx.reply('Usage: /setprompt <agentId> <pre-prompt text>');
    }
    
    const agentId = args[1];
    const prePrompt = args.slice(2).join(' ');
    
    try {
      const agent = await fullmetalService.setPrePrompt(agentId, prePrompt);
      ctx.reply(`✅ Pre-prompt updated for agent: ${agent.name}`);
    } catch (error) {
      console.error('Error setting pre-prompt:', error);
      ctx.reply('⚠️ Failed to update pre-prompt');
    }
  }
  
  /**
   * Get information about an agent
   * @param {Object} ctx - The Telegram context object
   * @returns {Promise<void>}
   */
  async getAgentInfo(ctx) {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      return ctx.reply('Usage: /agentinfo <agentId>');
    }
    
    const agentId = args[1];
    
    try {
      const agent = await fullmetalService.getAgentDetails(agentId);
      
      if (!agent) {
        return ctx.reply(`⚠️ Agent not found: ${agentId}`);
      }
      
      // Format agent info
      let infoMessage = `📊 *Agent Information*\n\n`;
      infoMessage += `*Name:* ${agent.name}\n`;
      infoMessage += `*ID:* \`${agent.agentId}\`\n`;
      
      if (agent.role) {
        infoMessage += `*Role:* ${agent.role}\n`;
      }
      
      if (agent.averageResponseTime) {
        infoMessage += `*Avg Response Time:* ${agent.averageResponseTime.toFixed(2)}s\n`;
      }
      
      infoMessage += `*Prompts Served:* ${agent.promptServed || 0}\n`;
      infoMessage += `*Status:* ${agent.isAvailable ? '✅ Available' : '❌ Unavailable'}\n`;
      
      if (agent.summary && agent.summary.description) {
        infoMessage += `\n*Description:*\n${agent.summary.description}\n`;
      }
      
      ctx.reply(infoMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error getting agent info:', error);
      ctx.reply('⚠️ An error occurred while retrieving agent information');
    }
  }

  /**
   * Clear conversation history for the current user and agent
   * @param {Object} ctx - The Telegram context object
   * @returns {Promise<void>}
   */
  async clearMemory(ctx, agent) {
    try {
      const telegramUserId = ctx.from.id.toString();
      const telegramChatId = ctx.chat.id.toString();

      // Extract agent ID if provided, otherwise use default
      const args = ctx.message.text.split(' ');
      let agentId = null;

      if (args.length >= 2) {
        agentId = args[1]; // Use provided agent ID
      } else {
        // Try to get agent ID from the current context or use default
        if (agent) {
          agentId = agent._id.toString();
        } else {
          return ctx.reply('⚠️ Please specify an agent ID: /clearmemory <agentId>');
        }
      }

      const success = await memoryService.clearConversationHistory(telegramUserId, telegramChatId, agentId);

      if (success) {
        ctx.reply('🧹 Conversation history has been cleared. I\'ve forgotten our previous conversation.');
      } else {
        ctx.reply('⚠️ Could not clear conversation history. You may not have any stored conversations.');
      }
    } catch (error) {
      console.error('Error clearing memory:', error);
      ctx.reply('⚠️ An error occurred while clearing conversation history');
    }
  }

  /**
   * Show conversation summary
   * @param {Object} ctx - The Telegram context object
   * @returns {Promise<void>}
   */
  async showMemory(ctx, agent) {
    try {
      const telegramUserId = ctx.from.id.toString();
      const telegramChatId = ctx.chat.id.toString();

      // Extract agent ID if provided, otherwise use default
      const args = ctx.message.text.split(' ');
      let agentId = null;

      if (args.length >= 2) {
        agentId = args[1]; // Use provided agent ID
      } else {
        if (agent) {
          agentId = agent._id.toString();
        } else {
          return ctx.reply('⚠️ Please specify an agent ID: /showmemory <agentId>');
        }
      }

      const messages = await memoryService.getConversationHistory(telegramUserId, telegramChatId, agentId);

      if (messages.length === 0) {
        return ctx.reply('No conversation history found.');
      }

      // Create a summary of the conversation
      let summary = `*Conversation History Summary*\n\n`;
      summary += `You have ${messages.length} messages in this conversation.\n`;

      // Show a few recent messages as a sample
      if (messages.length > 0) {
        summary += `\n*Recent messages:*\n`;
        const recentMessages = messages.slice(-3); // Last 3 messages

        for (const message of recentMessages) {
          const role = message.role === 'user' ? '👤 You' : '🤖 Assistant';
          // Truncate message content if it's too long
          const content = message.content.length > 100
            ? message.content.substring(0, 100) + '...'
            : message.content;

          summary += `${role}: ${content}\n\n`;
        }
      }

      ctx.reply(summary, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error showing memory:', error);
      ctx.reply('⚠️ An error occurred while retrieving conversation history');
    }
  }
}

module.exports = new MessageController(); 