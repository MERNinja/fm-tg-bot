const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const APP_MAIN = path.join(__dirname, 'src', 'index.js');
const LOG_FILE = path.join(__dirname, 'app.log');
const ERROR_FILE = path.join(__dirname, 'error.log');
const MAX_RESTARTS = 10;
const RESTART_DELAY = 5000; // 5 seconds

// Counters
let restartCount = 0;
let lastCrashTime = 0;
let consecutiveRapidCrashes = 0;

// Create log streams
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const errorStream = fs.createWriteStream(ERROR_FILE, { flags: 'a' });

// Log with timestamp
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;

    console.log(logMessage.trim());
    logStream.write(logMessage);
}

// Start the application
function startApp() {
    log(`Starting application (attempt ${restartCount + 1})...`);

    // Spawn the Node.js process
    const app = spawn('node', [APP_MAIN], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
    });

    // Capture and log stdout
    app.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
            log(`[APP] ${output}`);
        }
    });

    // Capture and log stderr
    app.stderr.on('data', (data) => {
        const errorOutput = data.toString().trim();
        if (errorOutput) {
            const errorLog = `[ERROR] ${errorOutput}\n`;
            console.error(errorLog.trim());
            errorStream.write(errorLog);
        }
    });

    // Handle process exit
    app.on('exit', (code, signal) => {
        const now = Date.now();
        const crashMessage = signal
            ? `Application terminated due to signal: ${signal}`
            : `Application exited with code: ${code}`;

        log(crashMessage);

        // Check if this is a rapid crash (within 10 seconds of startup)
        const isRapidCrash = now - lastCrashTime < 10000;
        if (isRapidCrash) {
            consecutiveRapidCrashes++;
            log(`Detected rapid crash! (${consecutiveRapidCrashes} consecutive)`);
        } else {
            consecutiveRapidCrashes = 0;
        }

        lastCrashTime = now;

        // Determine if we should restart
        if (restartCount < MAX_RESTARTS && consecutiveRapidCrashes < 3) {
            log(`Restarting application in ${RESTART_DELAY / 1000} seconds...`);
            restartCount++;
            setTimeout(startApp, RESTART_DELAY);
        } else {
            log('Maximum restart attempts reached or too many rapid crashes. Giving up.');
            process.exit(1);
        }
    });

    // Handle monitor process errors
    app.on('error', (err) => {
        log(`Failed to start application: ${err.message}`);
        process.exit(1);
    });

    // Reset restart count after 1 hour of stable operation
    setTimeout(() => {
        if (app.exitCode === null) {  // still running
            log('Application stable for 1 hour, resetting restart counter');
            restartCount = 0;
            consecutiveRapidCrashes = 0;
        }
    }, 60 * 60 * 1000);

    return app;
}

// Handle monitor process signals
process.on('SIGINT', () => {
    log('Monitor received SIGINT, shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('Monitor received SIGTERM, shutting down...');
    process.exit(0);
});

// Start the application
log('==== Application Monitor Started ====');
startApp(); 