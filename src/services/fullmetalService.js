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
      prePrompt = agent.summary.systemPrompt || '';
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
   * @param {string} agentId - The agent ID to use
   * @returns {Promise<{response: Response, agent: Object}>} - The streaming response from the API and agent object
   */
  async getStreamingResponse(userMessage, agent) {
    const { fullPrompt, agentId: targetAgentId } = await this.preparePrompt(userMessage, agent);
    
    console.log(`Processing message: ${fullPrompt}`);
    const response = await fetch(this.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': agent.userId.apiKey[0]
      },
      body: JSON.stringify({
        prompt: fullPrompt,
        agentId: targetAgentId,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    // Return both the response and the agent for tracking purposes
    return { response, agent };
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
      throw error;
    }
  }
}

module.exports = new FullmetalService(); 