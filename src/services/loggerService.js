const winston = require('winston');
const { EventEmitter } = require('events');

// Create a custom transport that emits events
class EmitterTransport extends winston.Transport {
    constructor(opts) {
        super(opts);
        this.emitter = opts.emitter;
    }

    log(info, callback) {
        setImmediate(() => {
            this.emit('logged', info);
        });

        // Emit the log event
        this.emitter.emit('log', info);

        callback();
    }
}

class LoggerService {
    constructor() {
        this.logEmitter = new EventEmitter();
        // In-memory log storage
        this.logs = [];
        this.maxLogs = 1000; // Maximum number of logs to keep in memory

        // Create Winston logger
        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            transports: [
                new winston.transports.Console(),
                new EmitterTransport({
                    emitter: this.logEmitter
                })
            ]
        });

        // Add logs to in-memory storage when emitted
        this.onLog((log) => {
            this.storeLog(log);
        });
    }

    // Store log in memory
    storeLog(log) {
        this.logs.push(log);
        // Trim logs if they exceed max size
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }
    }

    // Get all stored logs
    getLogs() {
        return this.logs;
    }

    // Clear all logs
    clearLogs() {
        this.logs = [];
        return { success: true, message: 'Logs cleared' };
    }

    // Log methods
    info(message, meta = {}) {
        this.logger.info(message, meta);
    }

    error(message, meta = {}) {
        this.logger.error(message, meta);
    }

    debug(message, meta = {}) {
        this.logger.debug(message, meta);
    }

    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    // Subscribe to log events
    onLog(callback) {
        this.logEmitter.on('log', callback);
    }
}

// Create singleton instance
const loggerService = new LoggerService();

module.exports = loggerService; 