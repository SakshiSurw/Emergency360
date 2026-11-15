import Notification from '../models/Notification.js';
import { getIO } from '../config/socket.js';

export const createNotification = async ({
  recipientId,
  incidentId = null,
  message,
  type = 'alert',
}) => {
  try {
    const notification = await Notification.create({
      recipientId,
      incidentId,
      message,
      type,
    });

    const io = getIO();
    if (io) {
      io.to(`user:${recipientId}`).emit('notification:new', notification);
    }

    return notification;
  } catch (error) {
    console.error('[NotificationService Error]', error.message);
  }
};

/**
 * Broadcast emergency alerts across roles & incidents
 */
export const broadcastEmergencyEvent = (event, payload, target = {}) => {
  const io = getIO();
  if (!io) return;

  if (target.role) {
    io.to(`room:${target.role}`).emit(event, payload);
  } else if (target.user) {
    io.to(`user:${target.user}`).emit(event, payload);
  } else if (target.incident) {
    io.to(`incident:${target.incident}`).emit(event, payload);
  } else {
    io.emit(event, payload);
  }
};
