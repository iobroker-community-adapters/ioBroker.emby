# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

**Adapter-Specific Context - Emby Media Server Integration:**
- **Adapter Name:** emby
- **Primary Function:** Connect to and control Emby Media Server instances via WebSocket API
- **Key Technologies:** WebSocket (websocket npm package), HTTP REST API (request npm package)
- **External Service:** Emby Media Server - personal media server for organizing and streaming movies, TV shows, music, and photos
- **Connection Type:** Network-based connection using IP/port configuration with SSL support
- **Authentication:** API key-based authentication with Emby server
- **Key Features:** Media playback control, device detection and filtering, session monitoring, real-time status updates
- **Configuration Options:** Server IP/port, SSL toggle, API key, device ID filtering, timeout settings for episode transitions

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Follow the existing test structure in the `test/` directory
- Test files should follow the pattern `*.test.js`
- Focus on testing adapter logic, state changes, and external API interactions

### Integration Testing
- Use the `@iobroker/testing` package for integration tests
- Test the adapter startup, configuration handling, and cleanup
- Mock external services (Emby server) for reliable testing

### WebSocket Testing for Emby Adapter
- Mock WebSocket connections using appropriate testing libraries
- Test connection establishment, message handling, and reconnection logic
- Verify proper cleanup of WebSocket connections and timeouts

## Code Style and Formatting

### ESLint Configuration
- Follow the existing `.eslintrc.json` configuration
- Use Prettier for code formatting (`.prettierrc.js`)
- Run `npm run lint` to check code style
- Address linting issues before committing

### JavaScript Standards
- Use strict mode (`'use strict';`)
- Follow Node.js best practices for async operations
- Use proper error handling with try-catch blocks
- Implement proper resource cleanup in unload functions

## ioBroker Adapter Patterns

### Adapter Core Integration
```javascript
const utils = require('@iobroker/adapter-core');
let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'emby', // Adapter name
        stateChange: onStateChange,
        unload: onUnload,
        ready: onReady,
    });
    adapter = new utils.Adapter(options);
    return adapter;
}
```

### State Management
- Create states using `adapter.setObjectNotExists()`
- Update states with `adapter.setState(id, value, ack)`
- Subscribe to state changes with `adapter.subscribeStates('*')`
- Use appropriate state roles (media.*, button, indicator.connected, etc.)

### Configuration Access
- Access configuration via `adapter.config.propertyName`
- Validate configuration values before use
- Handle missing or invalid configuration gracefully

### Logging Best Practices
```javascript
adapter.log.debug('Detailed debugging information');
adapter.log.info('General information');
adapter.log.warn('Warning messages');
adapter.log.error('Error messages with context');
```

### Resource Cleanup (Emby-specific)
```javascript
function onUnload(callback) {
    try {
        // Close WebSocket connection
        if (connection) {
            connection.send('{"MessageType":"SessionsStop", "Data": ""}');
            connection.close();
        }
        
        // Clear all timeouts
        Object.keys(timeouts).forEach((timeout) => { 
            clearTimeout(timeouts[timeout]); 
        });
        
        adapter.log.info('cleaned everything up...');
        callback();
    } catch (e) {
        adapter.log.error('Error during cleanup: ' + e.message);
        callback();
    }
}
```

## API Integration Patterns

### WebSocket Connection Management
```javascript
const W3CWebSocket = require('websocket').w3cwebsocket;

function connectWebSocket() {
    const protocol = adapter.config.isSSL ? 'wss' : 'ws';
    const url = `${protocol}://${adapter.config.ip}/embywebsocket?api_key=${adapter.config.apikey}`;
    
    connection = new W3CWebSocket(url);
    connection.onopen = handleWebSocketOpen;
    connection.onmessage = handleWebSocketMessage;
    connection.onerror = handleWebSocketError;
    connection.onclose = handleWebSocketClose;
}
```

### HTTP Request Patterns
```javascript
const request = require('request');

function makeApiRequest(endpoint, callback) {
    const protocol = adapter.config.isSSL ? 'https' : 'http';
    const url = `${protocol}://${adapter.config.ip}/emby/${endpoint}?api_key=${adapter.config.apikey}`;
    
    request({ url: url, json: true }, (error, response, body) => {
        if (error) {
            adapter.log.error('API request failed: ' + error.message);
            return callback(error);
        }
        callback(null, body);
    });
}
```

### Device Management
- Filter devices based on configuration (`adapter.config.deviceIds`)
- Create device channels and states dynamically
- Handle device state changes and media information updates
- Implement device-specific command handling

## Error Handling

### Connection Error Management
- Implement retry logic for failed connections
- Use exponential backoff for reconnection attempts
- Log connection status changes appropriately
- Handle network timeout scenarios gracefully

### API Error Handling
- Check for valid API responses before processing
- Handle HTTP error codes appropriately
- Provide meaningful error messages to users
- Implement fallback behavior when possible

## File Organization

### Main Files
- `main.js` - Primary adapter logic and WebSocket handling
- `io-package.json` - Adapter metadata and configuration schema
- `package.json` - Node.js package configuration and dependencies

### Admin Interface
- `admin/index_m.html` - Configuration interface (Materialize UI)
- `admin/words.js` - Internationalization strings
- `admin/emby.png` - Adapter icon

### Testing Structure
- `test/integration.js` - Integration tests using @iobroker/testing
- `test/package.js` - Package validation tests
- Additional test files should follow `*.test.js` naming

## Dependencies and Libraries

### Core Dependencies
- `@iobroker/adapter-core` - ioBroker adapter framework
- `websocket` - WebSocket client for Emby server communication
- `request` - HTTP client for REST API calls (consider upgrading to axios or fetch)

### Development Dependencies
- `@iobroker/testing` - Testing framework for ioBroker adapters
- `eslint` + `prettier` - Code quality and formatting
- `mocha` - Test runner
- `typescript` - Type checking support

### Security Considerations
- Validate and sanitize all user inputs
- Use secure WebSocket connections (WSS) when available
- Store API keys securely in adapter configuration
- Implement rate limiting for API requests when appropriate

## Performance Optimization

### Timeout Management
- Use appropriate timeout values for different operations
- Clear timeouts properly to prevent memory leaks
- Implement timeout for episode transitions (`adapter.config.timeout`)

### State Updates
- Only update states when values actually change
- Use acknowledgment flags appropriately (`ack: true/false`)
- Batch state updates when possible to reduce overhead

### Memory Management
- Clean up event listeners and timers in unload function
- Avoid memory leaks in long-running WebSocket connections
- Monitor and handle large data structures efficiently

## Media Server Specific Patterns

### Session Handling
- Track active sessions and their states
- Handle session start/stop events
- Update media information based on session data

### Playback Control
- Implement standard media control commands (play, pause, stop, etc.)
- Handle volume control and mute functionality
- Support seeking and navigation commands

### Media Information Display
- Extract and display currently playing media details
- Show progress information and remaining time
- Handle different media types (movies, TV shows, music)

This configuration optimizes GitHub Copilot for ioBroker Emby adapter development, providing context-aware suggestions for WebSocket handling, media server integration, and ioBroker-specific patterns.