import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Responder from '../models/Responder.js';
import Incident from '../models/Incident.js';
import { getJwtSecret } from './security.js';
import Hospital from '../models/Hospital.js';

let ioInstance = null;

export const initSocket = (server) => {
  const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:5173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',

  // Capacitor Android WebView
  'https://localhost',
];

  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Socket CORS origin rejected'));
      },
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Socket authentication middleware
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        socket.user = null;
        return next();
      }

      const decoded = jwt.verify(
        token,
        getJwtSecret()
      );
      const user = await User.findById(decoded.id).select('-passwordHash');
      if (user && user.isActive !== false) {
        socket.user = user;
      } else {
        socket.user = null;
      }
      next();
    } catch (err) {
      console.warn(`[Socket Auth Warning] Handshake with unverified token: ${err.message}`);
      socket.user = null;
      next();
    }
  });

  io.on('connection', (socket) => {
    const userRole = socket.user?.role || 'guest';
    const userId = socket.user?._id?.toString();

    // Auto-join user-specific and verified role-specific rooms
    if (userId) {
      socket.join(`user:${userId}`);
    }
    if (userRole && userRole !== 'guest') {
      socket.join(`room:${userRole}`);
    }

    console.log(`[Socket.IO] Client connected: ${socket.id} (User: ${userId || 'anonymous'}, Role: ${userRole})`);

    // Secure Incident Watch Room Subscription with Authorization Checks
    socket.on('incident:watch', async (incidentId) => {
      if (!incidentId) return;
        if (!socket.user) {
    return socket.emit('error:unauthorized', {
      message: 'Please log in to track an incident',
    });
  }

      try {
  const incident = await Incident.findById(incidentId).select(
    'citizenId assignedResponderId hospitalId'
  );

  if (!incident) {
    return socket.emit('error:unauthorized', {
      message: 'Incident not found',
    });
  }

  const role = socket.user.role;
  const userId = socket.user._id.toString();
  let authorized = false;

  if (role === 'admin') {
    authorized = true;
  }

  else if (role === 'citizen') {
    authorized = incident.citizenId?.toString() === userId;
  }

  else if (role === 'responder') {
    const responder = await Responder.findOne({ userId });

    authorized =
      !!responder &&
      incident.assignedResponderId?.toString() === responder._id.toString();
  }

  else if (role === 'hospital') {
    const hospital = await Hospital.findOne({ userId });

    authorized =
      !!hospital &&
      incident.hospitalId?.toString() === hospital._id.toString();
  }

  if (!authorized) {
    return socket.emit('error:unauthorized', {
      message: 'You are not authorized to track this incident',
    });
  }

  socket.join(`incident:${incidentId}`);

} catch (err) {
  console.error('[Socket incident:watch Error]', err.message);
}
}); // Close incident:watch handler

socket.on('incident:unwatch', (incidentId) => {
      if (incidentId) {
        socket.leave(`incident:${incidentId}`);
      }
    });

    // Responder live location updates (Strictly authorized)
    socket.on('responder:location', async (data) => {
      try {
        if (!socket.user || socket.user.role !== 'responder') {
          return socket.emit('error:unauthorized', {
            message: 'Only registered emergency responders can broadcast live telemetry',
          });
        }

        const { latitude, longitude, incidentId, address } = data;
        if (latitude === undefined || longitude === undefined) return;

        const lat = Number(latitude);
        const lng = Number(longitude);
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

        // Persist location update to MongoDB
        const responder = await Responder.findOne({ userId: socket.user._id });
        if (responder) {
          responder.currentLocation = {
            latitude: lat,
            longitude: lng,
            address: address || responder.currentLocation?.address || 'Live GPS',
          };
          responder.lastLocationUpdate = new Date();
          await responder.save();

          const updatePayload = {
            responderId: responder._id,
            unitName: responder.unitName,
            serviceType: responder.serviceType,
            latitude: lat,
            longitude: lng,
            lastLocationUpdate: responder.lastLocationUpdate,
          };

          // Broadcast to admin room
          io.to('room:admin').emit('responder:moved', updatePayload);

          // If tracking active incident, broadcast to incident room (including citizen)
          const targetIncidentId = responder.assignedIncidentId;
          if (targetIncidentId) {
            io.to(`incident:${targetIncidentId}`).emit('responder:moved', updatePayload);
          }
        }
      } catch (err) {
        console.error('[Socket responder:location Error]', err.message);
      }
    });

    socket.on('disconnect', (reason) => {
      // Clean disconnect
    });
  });

  ioInstance = io;
  return io;
};

export const getIO = () => {
  return ioInstance;
};

export default { initSocket, getIO };
