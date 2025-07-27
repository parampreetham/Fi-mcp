require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration ---
const PORT = 3000;
const GO_ADK_URL = 'http://localhost:8080'; // The URL of your fi-mcp-dev Go server

// --- Initialize Gemini ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Define Your Tools ---
const tools = [
  {
    functionDeclarations: [
      { name: "fetch_net_worth", description: "Calculate comprehensive net worth using ONLY actual data from accounts users connected on Fi Money." },
      { name: "fetch_credit_report", description: "Retrieve comprehensive credit report including scores, active loans, credit card utilization, payment history, and date of birth." },
      { name: "fetch_epf_details", description: "Retrieve detailed EPF (Employee Provident Fund) account information." },
      { name: "fetch_mf_transactions", description: "Retrieve detailed transaction history for mutual funds." },
      { name: "fetch_bank_transactions", description: "Retrieve detailed bank transactions for each bank account." },
      { name: "fetch_stock_transactions", description: "Retrieve detailed indian stock transactions for all connected indian stock accounts." },
    ],
  },
];

// --- System Prompt to Define the Agent's Persona ---
const systemInstruction = {
    role: "user",
    parts: [{ text: `
      You are an expert financial advisor named 'Fi Agent'. Your primary goal is to help users understand their financial data.

      Your logic for responding follows these strict rules:
      1.  If the user's request requires data you don't have, immediately call the necessary tool(s) without any conversational text first.
      2.  If the user specifically asks for a "chart", "graph", or "visualization", your FINAL response after getting all the necessary tool data MUST be ONLY a single, clean JSON string. This JSON object must contain a 'type' of 'chart', a 'title', a 'summary', and a 'data' array with objects containing 'name', 'value', and 'color'.
      3.  For ALL OTHER requests that do not ask for a chart, after getting the tool data, you must respond with a helpful, analytical summary in plain text.
      
      Do not deviate from these rules.
    ` }],
};

// --- In-Memory Store for Chat Histories ---
const chatSessions = new Map();


// --- NEW: Dashboard Endpoint ---
// In AgentFi-backend/index.js


app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || !sessionId) {
      return res.status(400).json({ error: 'Message and sessionId are required.' });
    }

    let chat;
    if (chatSessions.has(sessionId)) {
      chat = chatSessions.get(sessionId);
    } else {
      console.log(`[Node Backend] Starting new chat for session: ${sessionId}`);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', tools });
      chat = model.startChat({ history: [systemInstruction] });
      chatSessions.set(sessionId, chat);
    }

    let result = await chat.sendMessage(message);

    // Multi-step reasoning loop
    while (true) {
        // --- CORRECTED: Handle multiple function calls in parallel ---
        const functionCalls = result.response.functionCalls();

        if (!functionCalls || functionCalls.length === 0) {
            // If there are no function calls, Gemini is done. Break the loop.
            break;
        }

        console.log(`[Node Backend] Gemini wants to call ${functionCalls.length} tool(s)...`);

        // Use Promise.all to execute all tool calls concurrently
        const toolPromises = functionCalls.map((functionCall) => {
            const { name: toolName } = functionCall;
            console.log(`[Node Backend] -- Calling Go ADK for tool: ${toolName}`);
            return axios.post(
                `${GO_ADK_URL}/mcp/stream`,
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: toolName, arguments: {} },
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Mcp-Session-Id': sessionId,
                    },
                }
            );
        });
        
        // Wait for all the tool calls to complete
        const toolResponses = await Promise.all(toolPromises);
        
        console.log(`[Node Backend] Received all data from Go ADK.`);
        
        // Prepare the function responses to send back to Gemini
        const functionResponses = toolResponses.map((toolResponse, i) => {
            return {
                functionResponse: {
                    name: functionCalls[i].name,
                    response: toolResponse.data,
                },
            };
        });

        // Send all the tool results back to Gemini in one go
        result = await chat.sendMessage(functionResponses);
    }
// --- THIS IS THE MODIFIED SECTION ---
    const finalReplyText = result.response.text();
    
    // Clean the response to remove markdown fences before sending
    const cleanedReply = finalReplyText.replace(/```json\n|```/g, "").trim();
    
    // Send the CLEANED reply to the frontend
    return res.json({ reply: cleanedReply });
    // ------------------------------------

  } catch (error) {
    console.error('Error in /api/chat:', error.message);
    if (error.response) {
      console.error('Axios error data:', error.response.data);
    }
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- Start The Server ---
app.listen(PORT, () => {
  console.log(`Node.js backend is running on http://localhost:${PORT}`);
});


// In AgentFi-backend/index.js

app.get('/api/dashboard', async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId is required.' });
        }
        console.log(`[Node Backend] Fetching dashboard data for session: ${sessionId}`);

        // Define the tools we need for the dashboard
        const toolsToFetch = ['fetch_net_worth', 'fetch_credit_report'];

        // Use Promise.all to call the tools in parallel for speed
        const toolPromises = toolsToFetch.map(toolName =>
            axios.post(
                `${GO_ADK_URL}/mcp/stream`,
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: {} } },
                { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId } }
            )
        );

        const toolResponses = await Promise.all(toolPromises);

        // Extract and clean the data from each response
        const netWorthRaw = JSON.parse(toolResponses[0].data.result.content[0].text);
        const creditReportRaw = JSON.parse(toolResponses[1].data.result.content[0].text);

        // Navigate the actual structure of your mock data files
        const netWorthValue = parseInt(netWorthRaw.netWorthResponse.totalNetWorthValue.units);
        const assetsArray = netWorthRaw.netWorthResponse.assetValues
            .filter(item => !item.netWorthAttribute.startsWith("LIABILITY_TYPE"))
            .map(asset => ({
                type: asset.netWorthAttribute.replace("ASSET_TYPE_", "").replace("_", " "),
                value: parseInt(asset.value.units)
            }));

        const creditScoreValue = parseInt(creditReportRaw.creditReports[0].creditReportData.score.bureauScore);

        // Combine the data into a single object for the frontend
        const dashboardData = {
            netWorth: netWorthValue,
            assets: assetsArray,
            creditScore: creditScoreValue,
        };

        res.json(dashboardData);

    } catch (error) {
        console.error('Error in /api/dashboard:', error.message);
        res.status(500).json({ error: 'Failed to fetch dashboard data.' });
    }
});