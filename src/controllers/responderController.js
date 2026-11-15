import Responder from '../models/Responder.js';
import Incident from '../models/Incident.js';
import { broadcastEmergencyEvent } from '../services/notificationService.js';

// @desc    Get all responders
// @route   GET /api/responders
// @access  Private (Admin)
export const getAllResponders = async (req, res) => {
  try {
    const responders = await Responder.find({ isDemo: { $ne: true } })
      .populate('userId', 'name email phone')
      .populate('assignedIncidentId', 'category status location');

    res.json({
      success: true,
      total: responders.length,
      data: responders,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get available responders
// @route   GET /api/responders/available
// @access  Private (Admin)
export const getAvailableResponders = async (req, res) => {
  try {
    const { serviceType } = req.query;
    const filter = { isDemo: { $ne: true }, availability: 'available' };
    if (serviceType) filter.serviceType = serviceType;

    const responders = await Responder.find(filter).populate('userId', 'name phone');

    res.json({
      success: true,
      total: responders.length,
      data: responders,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get responder's current active assignment and history
// @route   GET /api/responders/my-assignments
// @access  Private (Responder)
export const getMyAssignments = async (req, res) => {
  try {
    const responder = await Responder.findOne({ userId: req.user._id, isDemo: { $ne: true } });
    if (!responder) {
      return res.status(404).json({ success: false, message: 'Responder profile not found' });
    }

   
// Active assignment
const activeStatuses = ['Assigned', 'Accepted', 'En Route', 'Arrived'];

let activeIncident = null;

// First check the responder's direct assignment reference
if (responder.assignedIncidentId) {
  activeIncident = await Incident.findOne({
    _id: responder.assignedIncidentId,
    assignedResponderId: responder._id,
    isDemo: { $ne: true },
    status: { $in: activeStatuses },
  }).populate('citizenId', 'name phone');
}

// Fallback: find an active incident assigned to this responder
if (!activeIncident) {
  activeIncident = await Incident.findOne({
    assignedResponderId: responder._id,
    isDemo: { $ne: true },
    status: { $in: activeStatuses },
  })
    .populate('citizenId', 'name phone')
    .sort({ assignedAt: -1 });
}

    // Historical assignments
    const pastIncidents = await Incident.find({
      assignedResponderId: responder._id,
      isDemo: { $ne: true },
      status: { $in: ['Resolved', 'Cancelled'] },
    }).sort({ updatedAt: -1 }).limit(20);

    res.json({
      success: true,
      data: {
        responder,
        activeIncident,
        pastIncidents,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update responder availability status
// @route   PATCH /api/responders/availability
// @access  Private (Responder)
export const updateAvailability = async (req, res) => {
  try {
    const { availability } = req.body;
    if (!['available', 'busy', 'off_duty'].includes(availability)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid availability status. Must be available, busy, or off_duty',
      });
    }

    const responder = await Responder.findOne({ userId: req.user._id, isDemo: { $ne: true } });
    if (!responder) {
      return res.status(404).json({ success: false, message: 'Responder profile not found' });
    }

    // Prevent changing to available if still assigned to an active unresolved incident
    if (availability === 'available' && responder.assignedIncidentId) {
      const activeIncident = await Incident.findOne({ _id: responder.assignedIncidentId, isDemo: { $ne: true } });
      if (activeIncident && !['Resolved', 'Cancelled'].includes(activeIncident.status)) {
        return res.status(400).json({
          success: false,
          message: 'Cannot set status to available while actively assigned to an unresolved emergency incident',
        });
      }
    }

    responder.availability = availability;
    await responder.save();

    broadcastEmergencyEvent('responder:status_changed', {
      responderId: responder._id,
      unitName: responder.unitName,
      availability,
    });

    res.json({
      success: true,
      message: `Availability updated to ${availability}`,
      data: responder,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update responder location from device GPS
// @route   PATCH /api/responders/location
// @access  Private (Responder)
export const updateLocation = async (req, res) => {
  try {
    const { latitude, longitude, address } = req.body;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ success: false, message: 'Valid GPS coordinates are required' });
    }

    const responder = await Responder.findOne({ userId: req.user._id, isDemo: { $ne: true } });
    if (!responder) {
      return res.status(404).json({ success: false, message: 'Responder profile not found' });
    }

    responder.currentLocation = {
      latitude: lat,
      longitude: lng,
      address: address || responder.currentLocation?.address || 'Current Location',
    };
    responder.lastLocationUpdate = new Date();
    await responder.save();

    const payload = {
      responderId: responder._id,
      unitName: responder.unitName,
      serviceType: responder.serviceType,
      latitude: responder.currentLocation.latitude,
      longitude: responder.currentLocation.longitude,
      lastLocationUpdate: responder.lastLocationUpdate,
    };

    // Broadcast live location to admins
    broadcastEmergencyEvent('responder:moved', payload, { role: 'admin' });

    // If currently dispatched to an incident, broadcast to that incident's tracking room
    if (responder.assignedIncidentId) {
      broadcastEmergencyEvent('responder:moved', payload, {
        incident: responder.assignedIncidentId.toString(),
      });
    }

    res.json({
      success: true,
      message: 'Location updated successfully',
      data: responder.currentLocation,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

