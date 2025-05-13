const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const Agent = require('../models/Agent');

class FullmetalService {
  constructor() {
    this.API_URL = 'https://api.fullmetal.ai/agent/prompt';
  }

  /**
   * Get agent details from the database
   * @param {string} agentId - The agent ID to fetch
   * @returns {Promise<Object>} - The agent details including pre-prompt
   */
  async getAgentDetails(agentId) {
    try {
      const agent = await Agent.findById(agentId);
      if (agent) {
        console.log(`Using agent: ${agent.name}`);
        
        // Track prompt request for analytics
        if (agent.promptServed !== undefined) {
          await Agent.findByIdAndUpdate(agent._id, { 
            $inc: { promptServed: 1 } 
          });
        }
        
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Error fetching agent details:', error);
      return null;
    }
  }

  /**
   * Prepare the full prompt with pre-prompt if available
   * @param {string} userMessage - The user's message
   * @param {string} agentId - The agent ID to use
   * @returns {Promise<Object>} - Object containing the full prompt and agent ID
   */
  async preparePrompt(userMessage, agent) {
    // Default to environment variable if not provided
    const targetAgentId = agent._id;
    let prePrompt = '';
    let role = '';
    let summary = {};

    // Try to fetch agent details from database
    // const agent = await this.getAgentDetails(targetAgentId);
    if (agent) {
      prePrompt = agent.summary.system || '';
      role = agent.role || '';
      summary = agent.summary || {};
      
      // Track response start time for calculating averageResponseTime
      agent._responseStartTime = Date.now();
    }

    // Build context from agent properties if available
    let contextInfo = '';
    if (role) {
      contextInfo += `Your role: ${role}\n`;
    }
    
    if (summary && typeof summary === 'object' && Object.keys(summary).length > 0) {
      if (summary.description) {
        contextInfo += `Description: ${summary.description}\n`;
      }
      if (summary.instructions) {
        contextInfo += `Instructions: ${summary.instructions}\n`;
      }
    }

    // Combine pre-prompt with context info and user message
    let fullPrompt = userMessage;
    if (contextInfo || prePrompt) {
      fullPrompt = `${contextInfo}${prePrompt ? prePrompt + '\n\n' : ''}${userMessage}`;
    }

    return {
      fullPrompt,
      agentId: targetAgentId,
      agent // Return the full agent object for later use
    };
  }

  /**
   * Update agent's response time metrics
   * @param {Object} agent - The agent object
   * @param {number} startTime - The start time of the response
   */
  async updateResponseMetrics(agent, startTime) {
    if (!agent || !agent._id) return;
    
    const responseTime = (Date.now() - startTime) / 1000; // in seconds
    
    // Calculate new average response time
    let newAvgTime = agent.averageResponseTime || 0;
    const promptCount = agent.promptServed || 1;
    
    // Simple moving average
    newAvgTime = ((newAvgTime * (promptCount - 1)) + responseTime) / promptCount;
    
    // Update the agent
    await Agent.findByIdAndUpdate(agent._id, {
      averageResponseTime: newAvgTime
    });
    
    console.log(`Updated response metrics for ${agent.name}: ${newAvgTime.toFixed(2)}s avg`);
  }

  /**
   * Send a request to the Fullmetal AI API and return a streaming response
   * @param {string} userMessage - The user's message
   * @param {Object} agent - The agent object to use
   * @param {string} [apiKey] - Optional specific API key to use (for group-specific billing)
   * @returns {Promise<{response: Response, agent: Object}>} - The streaming response from the API and agent object
   */
  async getStreamingResponse(userMessage, agent, apiKey = null) {
    // Use provided API key or fallback to agent's user API key
    const useApiKey = apiKey || (agent.userId && agent.userId.apiKey && agent.userId.apiKey.length > 0 ? agent.userId.apiKey[0] : null);

    if (!useApiKey) {
      console.error(`[FullmetalService] No API key available for agent ${agent.name}`);
      throw new Error('No API key available');
    }

    // Add instruction to respond in natural language, not JSON
    let systemPrompt = agent.summary.system || "";

    // Customize system prompt based on message type
    if (userMessage.includes("MODERATION_ANALYSIS")) {
      // Special system prompt for moderation requests
      systemPrompt = `${systemPrompt}\n\nYou are a content moderation assistant. For moderation requests:
1. Analyze the content objectively according to community guidelines
2. Respond ONLY with the requested JSON format, nothing else
3. Do not include any explanations or repeat the original prompt
4. If uncertain, use the "ignore" action unless there's clear evidence of a violation`;

      console.log(`[FullmetalService] Handling moderation request with specific system instructions`);
    } else {
      // Normal conversation, add natural language instructions
      systemPrompt += "\n\nPlease respond in natural language, not JSON format. Provide a conversational response as you would in a normal chat.";
    }

    const bodyData = {
      prompt: userMessage,
      agentId: agent._id,
      stream: true,
      systemPrompt: systemPrompt ?
        `${systemPrompt}\n\nPlease consider the User's current message for your response.` :
        "Please consider the User's current message for your response."
    }
    console.log(`[FullmetalService] Processing message with${apiKey !== null ? ' group-specific' : ' agent\'s'} API key`);

    try {
      const response = await fetch(this.API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': useApiKey
        },
        body: JSON.stringify(bodyData)
      });

      if (!response.ok) {
        console.error(`[FullmetalService] API error: ${response.status}`);
      }

      // Return both the response and the agent for tracking purposes
      return { response, agent };
    } catch (error) {
      console.error(`[FullmetalService] Error calling Fullmetal API:`, error);
      throw error;
    }
  }

  /**
   * Set or update an agent's pre-prompt
   * @param {string} agentId - The agent ID to update
   * @param {string} prePrompt - The pre-prompt text to set
   * @returns {Promise<Object>} - The updated agent
   */
  async setPrePrompt(agentId, prePrompt) {
    try {
      // Check if agent exists
      let agent = await Agent.findOne({ agentId });
      
      if (agent) {
        // Update existing agent
        agent.prePrompt = prePrompt;
        await agent.save();
      } else {
        // Create new agent with required fields
        agent = new Agent({
          agentId,
          name: `Agent ${agentId}`,
          prePrompt,
          userId: '000000000000000000000000', // Default placeholder user ID
          isAvailable: true,
          summary: { description: "Created via Telegram bot" },
          agentType: 'api'
        });
        await agent.save();
      }
      
      return agent;
    } catch (error) {
      console.error('Error setting pre-prompt:', error);
      // throw error;
    }
  }

  /**
   * Get the default agent from the database
   * @returns {Promise<Object>} - The default agent details
   */
  async getDefaultAgent() {
    try {
      // Find the first available agent with a Telegram token
      const agent = await Agent.findOne({
        'summary.telegram.token': { $exists: true, $ne: null },
        isAvailable: true
      });

      if (agent) {
        console.log(`Using default agent: ${agent.name}`);
        return agent;
      }
      return null;
    } catch (error) {
      console.error('Error fetching default agent:', error);
      return null;
    }
  }
}

module.exports = new FullmetalService(); 