const express = require('express');
const http = require('http');
const path = require('path');
const socketIO = require('socket.io');
const loggerService = require('../services/loggerService');

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Parse JSON request bodies
app.use(express.json());

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Main route serves the log viewer page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get all logs
app.get('/api/logs', (req, res) => {
    res.json(loggerService.getLogs());
});

// API endpoint to clear all logs
app.post('/api/logs/clear', (req, res) => {
    res.json(loggerService.clearLogs());
});

// API endpoint to generate test logs
app.get('/api/test-logs', (req, res) => {
    loggerService.info('This is a test info log', { source: 'API', test: true });
    loggerService.error('This is a test error log', { source: 'API', test: true });
    loggerService.warn('This is a test warning log', { source: 'API', test: true });
    loggerService.debug('This is a test debug log', { source: 'API', test: true });

    res.json({ success: true, message: 'Test logs generated' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected to logs');

    // Send all existing logs to the client
    socket.emit('initial-logs', loggerService.getLogs());

    // Subscribe to logger events
    const logListener = (log) => {
        socket.emit('log', log);
    };

    // Add listener for this connection
    loggerService.onLog(logListener);

    // Handle clear logs request from client
    socket.on('clear-logs', () => {
        loggerService.clearLogs();
        io.emit('logs-cleared');
    });

    // Clean up on disconnect
    socket.on('disconnect', () => {
        loggerService.logEmitter.removeListener('log', logListener);
        console.log('Client disconnected from logs');
    });
});

// Start server
const PORT = process.env.WEB_PORT || 3000;
function startWebServer() {
    // Only start the web server if we're not in a serverless environment
    if (!process.env.VERCEL) {
        server.listen(PORT, () => {
            console.log(`Log viewer server running on http://localhost:${PORT}`);
        });
        return true;
    } else {
        console.log('Running in serverless mode - log viewer disabled');
        return false;
    }
}

module.exports = { startWebServer }; 