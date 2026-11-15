import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { isDbConnected } from './config/db.js';

import authRoutes from './routes/authRoutes.js';
import incidentRoutes from './routes/incidentRoutes.js';
import responderRoutes from './routes/responderRoutes.js';
import hospitalRoutes from './routes/hospitalRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import bloodBankRoutes from './routes/bloodBankRoutes.js';
import reliefRoutes from './routes/reliefRoutes.js';
import adminAccountRoutes from './routes/adminAccountRoutes.js';
import { notFound, errorHandler } from './middleware/errorMiddleware.js';

const app = express();

// Security HTTP headers
app.use(helmet());

// Explicit CORS origin allowlist (Strict, no permissive wildcard fallbacks)
/*const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];*/
const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:5173',
  'http://localhost:5173',
    'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',

  // Capacitor Android app
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (such as mobile apps, curl, automated test suites)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        return callback(new Error(`CORS Policy: Origin ${origin} not allowed by Access-Control-Allow-Origin`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Express JSON body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: {
    success: false,
    message: 'Too many requests from this IP address, please try again after 15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Specific Auth & SOS Rate Limiter to prevent abuse
const authAndSosLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 2000 : 50,
  message: {
    success: false,
    message: 'Rate limit exceeded for authentication or SOS requests. Please wait a moment.',
  },
});
app.use('/api/auth/login', authAndSosLimiter);
app.use('/api/auth/register', authAndSosLimiter);

// API root endpoint makes phone/browser connectivity checks clear.
app.get('/api', (req, res) => {
  res.json({ success: true, message: 'Emergency360 API is reachable', health: '/api/health' });
});

// Detailed Health Check Endpoint
app.get('/api/health', (req, res) => {
  const dbOk = isDbConnected();
  const uptimeSeconds = Math.floor(process.uptime());
  const memoryUsageMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'healthy' : 'degraded',
    service: 'Emergency360 API',
    version: '1.0.0',
    database: {
      status: dbOk ? 'connected' : 'disconnected',
      engine: 'MongoDB / Mongoose',
    },
    system: {
      uptimeSeconds,
      memoryUsageMb: `${memoryUsageMb} MB`,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
    },
    timestamp: new Date().toISOString(),
  });
});

// Avoid Mongoose buffering delays during login when the database is unavailable.
// Health and API-root routes above remain reachable for diagnostics.
app.use('/api', (req, res, next) => {
  if (!isDbConnected()) {
    return res.status(503).json({
      success: false,
      message: 'Database is unavailable. Check MongoDB connection and try again.',
      code: 'DATABASE_UNAVAILABLE',
    });
  }
  next();
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/incidents', incidentRoutes);
app.use('/api/responders', responderRoutes);
app.use('/api/hospitals', hospitalRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/blood-banks', bloodBankRoutes);
app.use('/api/relief', reliefRoutes);
app.use('/api/admin/accounts', adminAccountRoutes);

// Error Handling Middlewares
app.use(notFound);
app.use(errorHandler);

export default app;
