import http from 'http';
import dotenv from 'dotenv';
dotenv.config();

import app from './app.js';
import connectDB from './config/db.js';
import { initSocket } from './config/socket.js';
import { startEscalationMonitoring } from './services/escalationService.js';
import { getJwtSecret } from './config/security.js';
import { setServers } from 'node:dns';

setServers(['1.1.1.1', '8.8.8.8']);

getJwtSecret();

const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with server
initSocket(server);

// Start server after attempting DB connection
const startServer = async () => {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`🚀 Emergency360 API running on port ${PORT}`);
    console.log(`📡 Real-Time WebSockets initialized`);
    console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    console.log(`===============================================`);
  });
};

startServer().then(() => {
  startEscalationMonitoring(15000);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error(`Unhandled Rejection Error: ${err.message}`);
});
