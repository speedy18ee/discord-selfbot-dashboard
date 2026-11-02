const EventEmitter = require('events');

class Logger extends EventEmitter {
  constructor(maxLogs = 500) {
    super();
    this.maxLogs = maxLogs;
    this.logs = [];
  }

  log(level, tag, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const entry = {
      id: Date.now() + Math.random().toString(36).substring(2, 6),
      timestamp,
      level: level.toUpperCase(),
      tag,
      message,
      meta
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    const color = this.getLevelColor(entry.level);
    console.log(`${color}[${entry.timestamp.substring(11, 19)}] [${entry.level}] [${tag}] \x1b[0m${message}`);

    this.emit('log', entry);
    return entry;
  }

  getLevelColor(level) {
    switch (level) {
      case 'ERROR': return '\x1b[31m'; // Red
      case 'WARN':  return '\x1b[33m'; // Yellow
      case 'VOICE': return '\x1b[35m'; // Magenta
      case 'MUSIC': return '\x1b[36m'; // Cyan
      case 'SUCCESS': return '\x1b[32m'; // Green
      default: return '\x1b[34m'; // Blue
    }
  }

  info(tag, message, meta) { return this.log('INFO', tag, message, meta); }
  warn(tag, message, meta) { return this.log('WARN', tag, message, meta); }
  error(tag, message, meta) { return this.log('ERROR', tag, message, meta); }
  voice(tag, message, meta) { return this.log('VOICE', tag, message, meta); }
  music(tag, message, meta) { return this.log('MUSIC', tag, message, meta); }
  success(tag, message, meta) { return this.log('SUCCESS', tag, message, meta); }

  getRecentLogs(limit = 100) {
    return this.logs.slice(-limit);
  }

  clear() {
    this.logs = [];
    this.emit('cleared');
  }
}

module.exports = new Logger();
