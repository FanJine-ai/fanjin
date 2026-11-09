/**
 * OpenTelemetry Initialization Script
 * 
 * This file MUST be imported before any other application code to ensure
 * auto-instrumentation works correctly.
 * 
 * Usage in package.json:
 *   node --require ./dist/tracing.init.js ./dist/index.js
 * 
 * Or at the top of your entry point:
 *   import "./tracing.init";
 */

import { initializeTracing } from "./lib/tracing";

// Initialize tracing before any other imports
initializeTracing();
