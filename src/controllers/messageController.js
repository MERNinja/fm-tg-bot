const fullmetalService = require('../services/fullmetalService');
const memoryService = require('../services/memoryService');
require('dotenv').config();

// Define a longer timeout for operations (3 minutes)
const API_TIMEOUT = 180000; // 3 minutes in milliseconds

/**
 * Process streaming responses from Fullmetal AI and update the Telegram message
 */
class MessageController {
  /**
   * Process a user message and stream the response
   * @param {string} userMessage - The user's message
   * @param {Object} ctx - The Telegram context object
   * @returns {Promise<string>} - The final response text
   */
  async processMessage(userMessage, ctx, agent) {
    
    try {
      console.log(`[Controller] Processing message from user: ${ctx.from?.id || 'unknown'}, text: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`);

      // Handle case where ctx.from might be missing (like in some channel posts)
      const telegramUserId = (ctx.from?.id || ctx.chat?.id || 'unknown').toString();
      const telegramChatId = ctx.chat?.id?.toString() || telegramUserId;
      const agentId = agent._id.toString();

      // Check if this is a potential duplicate message
      // Use a cache with unique request IDs to prevent duplicate processing
      const requestId = `${telegramUserId}-${telegramChatId}-${Date.now()}`;
      console.log(`[Controller] Request ID: ${requestId}`);

      // Store user message in conversation history
      console.log(`[Controller] Storing user message in conversation history, userID: ${telegramUserId}, agentID: ${agentId}`);
      await memoryService.addMessage(telegramUserId, telegramChatId, agentId, 'user', userMessage);

      // Create initial message to update (early response)
      const sentMessage = await ctx.reply('Processing your message...');
      let messageId = sentMessage.message_id;

      try {
        // Get conversation history to provide context
        console.log(`[Controller] Building context from history for user: ${telegramUserId}`);
        const conversationContext = await memoryService.buildContextFromHistory(telegramUserId, telegramChatId, agentId);

        // Determine the type of chat we're in for better context
        const chatTypeContext = ctx.chat?.type === 'private'
          ? 'private chat'
          : ctx.chat?.type === 'channel'
            ? `channel "${ctx.chat?.title || 'unnamed'}"`
            : `${ctx.chat?.type || 'group'} "${ctx.chat?.title || 'unnamed'}"`;

        // If we have conversation context, add it to the message
        let messageWithContext = conversationContext
          ? `${conversationContext}\n\nUser's current message: ${userMessage}`
          : userMessage;

        // Add chat type information for better context awareness
        messageWithContext = `[This message is from a ${chatTypeContext}]\n${messageWithContext}`;

        console.log(`[Controller] Sending request to Fullmetal API, context length: ${messageWithContext.length}`);

        // Update message to show we're waiting for API
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          messageId,
          undefined,
          'Typing...'
        ).catch(error => console.error('[Controller] Error updating initial message:', error));

        // Get streaming response from Fullmetal API with timeout handling
        const apiPromise = fullmetalService.getStreamingResponse(messageWithContext, agent);

        // Create a timeout promise
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`API request timed out after ${API_TIMEOUT / 1000} seconds`));
          }, API_TIMEOUT);
        });

        // Race the API promise against the timeout
        const { response } = await Promise.race([apiPromise, timeoutPromise]);

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
                        ).catch(error => console.error('[Controller] Error updating message:', error));
                      }
                    }
                  } catch (e) {
                    console.error('[Controller] Error parsing chunk:', e);
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
                  console.error('[Controller] Error parsing final chunk:', e);
                }
              }
            }

            // Final update to the message
            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id,
                messageId,
                undefined, 
                responseText || 'Please try again.'
              );
            } catch (error) {
              console.error('[Controller] Error updating final message:', error);
              // If editing fails, try sending a new message
              try {
                await ctx.reply('⚠️ Error updating message. Full response:');
                await ctx.reply(responseText || 'Please try again.');
              } catch (secondError) {
                console.error('[Controller] Error sending fallback message:', secondError);
              }
            }

            // Store assistant response in conversation history
            if (responseText) {
              await memoryService.addMessage(telegramUserId, telegramChatId, agentId, 'assistant', responseText);
            }

            // Update agent metrics if we have an agent
            if (agent && agent._id) {
              await fullmetalService.updateResponseMetrics(agent, responseStartTime);
            }

            console.log(`[Controller] Completed processing message from user: ${telegramUserId}, response length: ${responseText.length}`);
            resolve(responseText || 'Please try again.');
          });

          response.body.on('error', err => {
            console.error('[Controller] Stream error:', err);
            reject(err);
          });
        });
      } catch (innerError) {
        console.error('[Controller] Error during message processing:', innerError);

        // If it's a timeout or API error, send a friendly message
        let errorMessage = '⚠️ Sorry, I\'m having trouble processing your request right now.';

        if (innerError.message && innerError.message.includes('timed out')) {
          errorMessage = '⚠️ Sorry, the response is taking too long. Please try again with a simpler query or try later.';
        } else if (innerError.message && innerError.message.includes('API error')) {
          errorMessage = '⚠️ Sorry, there was an error communicating with the AI service. Please try again later.';
        }

        // Update the initial message with the error
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            errorMessage
          );
        } catch (msgError) {
          // If editing fails, send a new message
          console.error('[Controller] Error updating error message:', msgError);
          await ctx.reply(errorMessage).catch(e => console.error('[Controller] Failed to send error message:', e));
        }

        return errorMessage;
      }
    } catch (error) {
      console.error('[Controller] Unhandled error in processMessage:', error);
      // Try to send an error message to the user
      try {
        await ctx.reply('⚠️ An unexpected error occurred while processing your request. Please try again later.');
      } catch (replyError) {
        console.error('[Controller] Failed to send error message:', replyError);
      }
      throw error;
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