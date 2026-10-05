const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultEnhanceMiddleware = config.server?.enhanceMiddleware;

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => {
    const enhanced = defaultEnhanceMiddleware
      ? defaultEnhanceMiddleware(middleware)
      : middleware;
    return (req, res, next) => {
      // Preserve window.opener while Google redirects the Expo web popup
      // through a different origin, so expo-web-browser can finish the flow.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
      return enhanced(req, res, next);
    };
  },
};

module.exports = config;
