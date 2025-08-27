const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

/**
 * Simplified configuration loader for WebSocket proxy
 * Auto-detects protocol and builds URLs from domain + secure flag
 */
function loadConfig(configPath = 'config.yml') {
  // Default configuration values
  const defaults = {
    port: 8080,
    domain: null,
    secure: true,
    connectionTimeout: 15000,
  };

  try {
    // Check if config file exists
    const fullPath = path.resolve(configPath);
    if (!fs.existsSync(fullPath)) {
      console.log(`Config file not found: ${fullPath}, using defaults`);
      return buildTargetUrls(defaults);
    }

    // Load and parse YAML
    const fileContent = fs.readFileSync(fullPath, 'utf8');
    const config = yaml.load(fileContent);

    // Merge with defaults
    const finalConfig = { ...defaults, ...config };

    console.log(`Configuration loaded from: ${fullPath}`);
    return buildTargetUrls(finalConfig);

  } catch (error) {
    console.error(`Error loading config: ${error.message}`);
    console.log('Using default configuration');
    return buildTargetUrls(defaults);
  }
}

/**
 * Build target URLs from domain and secure flag
 */
function buildTargetUrls(config) {
  if (!config.domain) {
    console.warn('No domain specified in configuration');
    return {
      ...config,
      httpTarget: null,
      wsTarget: null
    };
  }

  const httpProtocol = config.secure ? 'https' : 'http';
  const wsProtocol = config.secure ? 'wss' : 'ws';

  return {
    ...config,
    httpTarget: `${httpProtocol}://${config.domain}`,
    wsTarget: `${wsProtocol}://${config.domain}`
  };
}

module.exports = { loadConfig };
