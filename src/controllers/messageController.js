const fullmetalService = require('../services/fullmetalService');
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
   */
  async processMessage(userMessage, ctx, agent) {
    
    try {
      // Get streaming response from Fullmetal API
      const { response } = await fullmetalService.getStreamingResponse(userMessage, agent);
      
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
            responseText || '⚠️ Empty response.'
          ).catch(error => console.error('Error updating final message:', error));
          
          // Update agent metrics if we have an agent
          if (agent && agent._id) {
            await fullmetalService.updateResponseMetrics(agent, responseStartTime);
          }
          
          resolve(responseText || '⚠️ Empty response.');
        });

        response.body.on('error', err => {
          console.error('Stream error:', err);
          reject(err);
        });
      });
    } catch (error) {
      console.error('Error processing message:', error);
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
}

module.exports = new MessageController(); 