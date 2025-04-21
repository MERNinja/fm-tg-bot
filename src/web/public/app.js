// DOM Elements
const logEntries = document.getElementById('log-entries');
const clearLogsBtn = document.getElementById('clear-logs');
const pauseLogsBtn = document.getElementById('pause-logs');
const logLevelSelect = document.getElementById('log-level');
const logFilterInput = document.getElementById('log-filter');
const statusIndicator = document.getElementById('status');
const logCount = document.getElementById('log-count');

// State
let isPaused = false;
let logs = [];
let filteredLogs = [];
let totalLogs = 0;

// Connect to Socket.IO server
const socket = io();

// Socket events
socket.on('connect', () => {
    statusIndicator.textContent = 'Connected';
    statusIndicator.classList.remove('disconnected');
});

socket.on('disconnect', () => {
    statusIndicator.textContent = 'Disconnected';
    statusIndicator.classList.add('disconnected');
});

// Handle initial logs when connecting
socket.on('initial-logs', (initialLogs) => {
    logs = initialLogs;
    totalLogs = logs.length;
    updateLogCount();
    applyFilters();
});

// Handle new logs coming in
socket.on('log', (log) => {
    totalLogs++;
    updateLogCount();

    if (!isPaused) {
        logs.push(log);
        applyFilters();
    }
});

// Handle logs cleared event
socket.on('logs-cleared', () => {
    logs = [];
    totalLogs = 0;
    updateLogCount();
    applyFilters();
});

// UI Event Listeners
clearLogsBtn.addEventListener('click', () => {
    // Send clear logs request to server
    socket.emit('clear-logs');
    // We'll update the UI when we receive the logs-cleared event
});

pauseLogsBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    pauseLogsBtn.textContent = isPaused ? 'Resume' : 'Pause';

    if (!isPaused) {
        // When resuming, fetch any missed logs
        fetchAllLogs();
    }
});

logLevelSelect.addEventListener('change', applyFilters);
logFilterInput.addEventListener('input', applyFilters);

// Functions
function fetchAllLogs() {
    fetch('/api/logs')
        .then(response => response.json())
        .then(data => {
            logs = data;
            totalLogs = logs.length;
            updateLogCount();
            applyFilters();
        })
        .catch(error => {
            console.error('Error fetching logs:', error);
        });
}

function applyFilters() {
    const level = logLevelSelect.value;
    const filterText = logFilterInput.value.toLowerCase();

    filteredLogs = logs.filter(log => {
        // Filter by log level
        if (level !== 'all' && log.level !== level) {
            return false;
        }

        // Filter by text
        if (filterText && !(
            (log.message && log.message.toLowerCase().includes(filterText)) ||
            JSON.stringify(log).toLowerCase().includes(filterText)
        )) {
            return false;
        }

        return true;
    });

    renderLogs();
}

function renderLogs() {
    logEntries.innerHTML = '';

    filteredLogs.forEach(log => {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${log.level || 'info'}`;

        // Format timestamp
        const timestamp = log.timestamp ? new Date(log.timestamp).toISOString() : new Date().toISOString();

        // Create log content
        logEntry.innerHTML = `
      <span class="log-time">${timestamp}</span>
      <span class="log-level ${log.level || 'info'}">${log.level || 'info'}</span>
      <span class="log-message">${formatLogMessage(log)}</span>
    `;

        logEntries.appendChild(logEntry);
    });

    // Auto-scroll to bottom if not paused
    if (!isPaused) {
        logEntries.parentElement.scrollTop = logEntries.parentElement.scrollHeight;
    }
}

function formatLogMessage(log) {
    let message = log.message || '';

    // If there's metadata, add it nicely formatted
    if (log.meta && Object.keys(log.meta).length > 0) {
        message += '<pre>' + JSON.stringify(log.meta, null, 2) + '</pre>';
    }

    // Escape HTML to prevent XSS
    return message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function updateLogCount() {
    logCount.textContent = `${totalLogs} logs${isPaused ? ' (paused)' : ''}`;
}

// Initial fetch of logs
fetchAllLogs(); 