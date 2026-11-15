import crypto from 'crypto';
import Incident from '../models/Incident.js';
import Responder from '../models/Responder.js';
import Hospital from '../models/Hospital.js';
import User from '../models/User.js';
import { findNearestResponders, assignResponderToIncident } from '../services/assignmentService.js';
import { broadcastEmergencyEvent, createNotification } from '../services/notificationService.js';
import { sendSmsAlert } from '../services/smsService.js';
import { calculateDistanceKm } from '../utils/distance.js';

// All 10 supported emergency categories (plus legacy fire/police aliases for backwards compatibility)
export const ALL_EMERGENCY_CATEGORIES = [
  'medical',
  'police',
  'fire',
  'road_accident',
  'fire_explosion',
  'flood_rainfall',
  'natural_disaster',
  'trapped_rescue',
  'women_safety',
  'missing_person',
  'gas_hazardous',
  'other',
];

// Configurable priority determination rules
export const determineIncidentPriority = (category, requestedPriority) => {
  if (requestedPriority && ['Low', 'Medium', 'High', 'Critical'].includes(requestedPriority)) {
    return requestedPriority;
  }
  if (['fire_explosion', 'fire', 'trapped_rescue', 'gas_hazardous'].includes(category)) {
    return 'Critical';
  }
  if (['road_accident', 'medical', 'flood_rainfall', 'natural_disaster', 'women_safety'].includes(category)) {
    return 'High';
  }
  return 'Medium';
};

// Rate limiting map for tracking updates (per-token timestamp)
const liveLocationThrottles = new Map();
const LIVE_LOCATION_THROTTLE_MS = 1500;

// Strict State Transition Matrix
const ALLOWED_TRANSITIONS = {
  Pending: ['Verified', 'Cancelled'],
  Verified: ['Assigned', 'Cancelled'],
  Assigned: ['Accepted', 'Cancelled'],
  Accepted: ['En Route', 'Cancelled'],
  'En Route': ['Arrived', 'Cancelled'],
  Arrived: ['Resolved'],
  Resolved: [],
  Cancelled: [],
};

// @desc    Create emergency incident (Citizen SOS) with Personal Emergency Network
// @route   POST /api/incidents
// @access  Private (Citizen, Admin)
export const createIncident = async (req, res) => {
  try {
    const { category, location, description, priority, clientRequestId, affectedCount, categoryDetails } = req.body;

    if (clientRequestId && (typeof clientRequestId !== 'string' || clientRequestId.length > 100)) {
      return res.status(400).json({ success: false, message: 'Invalid client request ID.' });
    }

    if (clientRequestId) {
      const existing = await Incident.findOne({ citizenId: req.user._id, clientRequestId })
        .populate('citizenId', 'name phone email');
      if (existing) {
        return res.status(200).json({
          success: true,
          message: 'This SOS was already recorded.',
          notifications: {
            trustedContactSms: existing.trustedContactSms || 'unknown',
            contactNotifications: existing.contactNotifications || [],
          },
          data: existing,
        });
      }
    }

    if (!category || !location || location.latitude === undefined || location.longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Category and location coordinates (latitude, longitude) are required',
      });
    }

    const lat = Number(location.latitude);
    const lng = Number(location.longitude);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid latitude or longitude coordinate bounds (-90 to 90, -180 to 180)',
      });
    }

    // Validate category across all 10 emergency categories
    if (!ALL_EMERGENCY_CATEGORIES.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `Invalid emergency category. Must be one of: ${ALL_EMERGENCY_CATEGORIES.join(', ')}`,
      });
    }

    // Determine effective priority according to safety rules
    const effectivePriority = determineIncidentPriority(category, priority);

    // Personal Emergency Network: Calculate secure location sharing window based on citizen consent
    const sharingConsent = req.user.locationSharingConsent !== false;
    const durationMinutes = Number(req.user.locationSharingDurationMinutes) || 120;
    const trackingToken = sharingConsent ? crypto.randomBytes(24).toString('hex') : null;
    const trackingExpiresAt = sharingConsent
      ? new Date(Date.now() + durationMinutes * 60 * 1000)
      : null;
    const isLiveTrackingActive = Boolean(sharingConsent);

    // Personal Emergency Network: Query nearby emergency facilities (hospitals and police)
    const verifiedHospitals = await Hospital.find({
      verifiedAt: { $ne: null },
      isDemo: { $ne: true },
    }).limit(20);

    const nearbyHospitals = verifiedHospitals.map((h) => ({
      facilityType: 'hospital',
      name: h.name,
      address: h.address,
      phone: h.phone || '',
      distanceKm: calculateDistanceKm(lat, lng, h.location.latitude, h.location.longitude),
      latitude: h.location.latitude,
      longitude: h.location.longitude,
    })).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 3);

    const policeResponders = await Responder.find({
      serviceType: 'police',
      isDemo: { $ne: true },
    }).limit(20);

    const nearbyPolice = policeResponders.map((p) => ({
      facilityType: 'police_station',
      name: p.unitName || 'Police Patrol Unit',
      address: p.currentLocation?.address || 'Patrol Beat',
      phone: '',
      distanceKm: calculateDistanceKm(lat, lng, p.currentLocation.latitude, p.currentLocation.longitude),
      latitude: p.currentLocation.latitude,
      longitude: p.currentLocation.longitude,
    })).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 3);

    const nearbyEmergencyFacilities = [...nearbyHospitals, ...nearbyPolice];
    const initialCaptureTime = location.acquiredAt ? new Date(location.acquiredAt) : new Date();

    const incident = await Incident.create({
      citizenId: req.user._id,
      clientRequestId,
      category,
      description: description || `Emergency SOS for ${category.toUpperCase()}`,
      affectedCount: affectedCount ? Math.max(1, Number(affectedCount)) : 1,
      categoryDetails: categoryDetails && typeof categoryDetails === 'object' ? categoryDetails : {},
      location: {
        latitude: lat,
        longitude: lng,
        address: location.address || 'Reported Location',
        accuracy: location.accuracy || null,
        isApproximate: Boolean(location.isApproximate),
        isManual: Boolean(location.isManual),
        acquiredAt: initialCaptureTime,
      },
      status: 'Pending',
      priority: effectivePriority,
      isDemo: false,
      locationSharingExpiresAt: trackingExpiresAt,
      trackingToken,
      isLiveTrackingActive,
      trackingExpiresAt,
      liveLocation: {
        latitude: lat,
        longitude: lng,
        accuracy: location.accuracy || null,
        heading: null,
        speed: null,
        updatedAt: initialCaptureTime,
      },
      lastLocationUpdate: initialCaptureTime,
      nearbyEmergencyFacilities,
      contactNotifications: [],
      trustedContactSms: 'unknown',
      statusHistory: [
        {
          status: 'Pending',
          timestamp: new Date(),
          note: location.isManual ? 'SOS triggered with manually pinned coordinates' : 'SOS triggered with browser GPS telemetry',
          updatedBy: req.user._id,
        },
      ],
    });

    // Populate citizen details
    const populatedIncident = await Incident.findById(incident._id).populate(
      'citizenId',
      'name phone email'
    );

    // Broadcast to control room dispatchers in real time
    broadcastEmergencyEvent('incident:created', populatedIncident, { role: 'admin' });

    // Personal Emergency Network: Multi-contact notification delivery
    let contactsToNotify = Array.isArray(req.user.emergencyContacts) && req.user.emergencyContacts.length > 0
      ? req.user.emergencyContacts.filter((c) => c.phone && c.notifySms !== false)
      : [];

    if (contactsToNotify.length === 0 && req.user.emergencyContact?.phone) {
      contactsToNotify = [{
        name: req.user.emergencyContact.name,
        phone: req.user.emergencyContact.phone,
        relationship: req.user.emergencyContact.relationship,
      }];
    }

    const mapLink = `https://maps.google.com/?q=${lat},${lng}`;
    const liveTrackLink = trackingToken
      ? ` Live Track: ${(process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '')}/track/${trackingToken}`
      : '';
    const contactNotifications = [];

    for (const contact of contactsToNotify) {
      const smsResult = await sendSmsAlert({
        to: contact.phone,
        body: `EMERGENCY SOS from ${req.user.name}. Need: ${category.toUpperCase()}. Affected: ${incident.affectedCount}. GPS: ${lat.toFixed(5)},${lng.toFixed(5)}. Map: ${mapLink}.${liveTrackLink} Address: ${location.address || 'GPS location'}. Call ${req.user.phone}. Ref: ${incident._id}.`,
      });
      const status = smsResult.success
        ? 'accepted'
        : smsResult.mode === 'unconfigured'
        ? 'not_configured'
        : 'failed';

      contactNotifications.push({
        recipientName: contact.name || 'Emergency Contact',
        recipientPhone: contact.phone,
        channel: 'sms',
        status,
        messageId: smsResult.sid || null,
        sentAt: new Date(),
        retryCount: 0,
        error: smsResult.error || smsResult.message || null,
      });
    }

    let overallSmsStatus = 'no_contact';
    if (contactNotifications.length > 0) {
      if (contactNotifications.some((n) => n.status === 'accepted')) {
        overallSmsStatus = 'accepted';
      } else if (contactNotifications.every((n) => n.status === 'not_configured')) {
        overallSmsStatus = 'not_configured';
      } else {
        overallSmsStatus = 'failed';
      }
    }

    incident.trustedContactSms = overallSmsStatus;
    incident.contactNotifications = contactNotifications;
    await incident.save();

    populatedIncident.trustedContactSms = overallSmsStatus;
    populatedIncident.contactNotifications = contactNotifications;
    populatedIncident.nearbyEmergencyFacilities = nearbyEmergencyFacilities;

    res.status(201).json({
      success: true,
      message: 'SOS recorded for control-center review. This app cannot confirm dispatch acceptance; call your local emergency number if you need immediate assistance.',
      notifications: {
        trustedContactSms: overallSmsStatus,
        contactNotifications,
      },
      data: populatedIncident,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Retry failed emergency contact notification
// @route   POST /api/incidents/:id/retry-notification
// @access  Private (Citizen, Admin)
export const retryContactNotification = async (req, res) => {
  try {
    const { notificationId } = req.body;
    const incident = await Incident.findById(req.params.id).populate('citizenId', 'name phone');
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    // Role check: citizen who created it or admin
    if (req.user.role !== 'admin' && incident.citizenId?._id?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Forbidden: You cannot modify alerts for this incident' });
    }

    const notifs = incident.contactNotifications || [];
    let targets = notifs;
    if (notificationId) {
      targets = notifs.filter((n) => n._id.toString() === notificationId.toString());
    } else {
      targets = notifs.filter((n) => ['failed', 'not_configured'].includes(n.status));
    }

    if (targets.length === 0) {
      return res.status(400).json({ success: false, message: 'No eligible failed or unconfigured notifications found to retry' });
    }

    const lat = incident.location?.latitude;
    const lng = incident.location?.longitude;
    const mapLink = `https://maps.google.com/?q=${lat},${lng}`;

    for (const target of targets) {
      const smsResult = await sendSmsAlert({
        to: target.recipientPhone,
        body: `[RETRY] EMERGENCY SOS from ${incident.citizenId?.name || 'Citizen'}. Need: ${incident.category.toUpperCase()}. GPS: ${lat},${lng}. Map: ${mapLink}. Ref: ${incident._id}.`,
      });
      target.retryCount = (target.retryCount || 0) + 1;
      target.sentAt = new Date();
      if (smsResult.success) {
        target.status = 'retried';
        target.messageId = smsResult.sid || target.messageId;
        target.error = null;
      } else {
        target.status = smsResult.mode === 'unconfigured' ? 'not_configured' : 'failed';
        target.error = smsResult.error || smsResult.message || 'Retry delivery failed';
      }
    }

    // Update overall trustedContactSms if any succeeded
    if (notifs.some((n) => ['accepted', 'retried'].includes(n.status))) {
      incident.trustedContactSms = 'accepted';
    }

    await incident.save();

    res.json({
      success: true,
      message: `Retried ${targets.length} notification(s)`,
      contactNotifications: incident.contactNotifications,
      trustedContactSms: incident.trustedContactSms,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all incidents with pagination, search, and server-side filters
// @route   GET /api/incidents
// @access  Private (Admin, Responder)
export const getAllIncidents = async (req, res) => {
  try {
    const { category, status, priority, search, page = 1, limit = 20 } = req.query;

    const query = { isDemo: { $ne: true } };
    if (category) query.category = category;
    if (status) query.status = status;
    if (priority) query.priority = priority;

    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { description: searchRegex },
        { 'location.address': searchRegex },
      ];
    }

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * limitNum;

    const total = await Incident.countDocuments(query);
    const incidents = await Incident.find(query)
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('hospitalId', 'name address phone emergencyAvailable')
      .populate('verifiedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum) || 1,
      data: incidents,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Export filtered incident history as CSV
// @route   GET /api/incidents/export/csv
// @access  Private (Admin, Responder)
export const exportIncidentHistoryCsv = async (req, res) => {
  try {
    const { category, status, priority, search } = req.query;

    const query = { isDemo: { $ne: true } };
    if (category) query.category = category;
    if (status) query.status = status;
    if (priority) query.priority = priority;

    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { description: searchRegex },
        { 'location.address': searchRegex },
      ];
    }

    const incidents = await Incident.find(query)
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('hospitalId', 'name address phone')
      .sort({ createdAt: -1 })
      .limit(1000);

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const headers = [
      'Incident ID',
      'Category',
      'Priority',
      'Status',
      'Reported At',
      'Resolved At',
      'Resolution Time (Mins)',
      'Citizen Name',
      'Citizen Phone',
      'Address',
      'Latitude',
      'Longitude',
      'GPS Accuracy (m)',
      'Location Mode',
      'Live Sharing Active',
      'Affected Count',
      'Assigned Unit',
      'Responder Phone',
      'Assigned Hospital',
      'PEN Notifications Status',
      'Audit Trail Summary',
    ];

    const rows = incidents.map((inc) => {
      let resolutionTime = '';
      if (inc.resolvedAt && inc.createdAt) {
        const diffMs = new Date(inc.resolvedAt) - new Date(inc.createdAt);
        resolutionTime = Math.round(diffMs / 60000);
      }

      const auditSummary = (inc.statusHistory || [])
        .map((h) => `${h.status} (${new Date(h.timestamp).toISOString().slice(11, 16)})`)
        .join(' -> ');

      return [
        escapeCsv(inc._id),
        escapeCsv(inc.category),
        escapeCsv(inc.priority),
        escapeCsv(inc.status),
        escapeCsv(inc.createdAt ? new Date(inc.createdAt).toISOString() : ''),
        escapeCsv(inc.resolvedAt ? new Date(inc.resolvedAt).toISOString() : ''),
        escapeCsv(resolutionTime),
        escapeCsv(inc.citizenId?.name || 'Citizen'),
        escapeCsv(inc.citizenId?.phone || ''),
        escapeCsv(inc.location?.address || ''),
        escapeCsv(inc.location?.latitude),
        escapeCsv(inc.location?.longitude),
        escapeCsv(inc.location?.accuracy || ''),
        escapeCsv(inc.location?.isManual ? 'Manual Pin' : 'GPS Fix'),
        escapeCsv(inc.isLiveTrackingActive ? 'YES' : 'NO'),
        escapeCsv(inc.affectedCount || 1),
        escapeCsv(inc.assignedResponderId?.unitName || 'None'),
        escapeCsv(inc.assignedResponderId?.userId?.phone || ''),
        escapeCsv(inc.hospitalId?.name || 'None'),
        escapeCsv(inc.trustedContactSms || 'unknown'),
        escapeCsv(auditSummary),
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="emergency360-incident-history.csv"');
    res.status(200).send(csvContent);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get my incidents (Citizen personal history)
// @route   GET /api/incidents/my
// @access  Private (Citizen)
export const getMyIncidents = async (req, res) => {
  try {
    const incidents = await Incident.find({ citizenId: req.user._id, isDemo: { $ne: true } })
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('hospitalId', 'name address phone')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      total: incidents.length,
      data: incidents,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single incident by ID
// @route   GET /api/incidents/:id
// @access  Private
export const getIncidentById = async (req, res) => {
  try {
    const incident = await Incident.findOne({ _id: req.params.id, isDemo: { $ne: true } })
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('hospitalId', 'name address phone emergencyAvailable availableBeds')
      .populate('verifiedBy', 'name email')
      .populate('statusHistory.updatedBy', 'name role');

    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    // Role ownership check: Citizens can only inspect their own incidents
    if (
      req.user.role === 'citizen' &&
      incident.citizenId._id.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not have permission to view this incident',
      });
    }

    res.json({ success: true, data: incident });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Verify incident (Control Center Admin)
// @route   PATCH /api/incidents/:id/verify
// @access  Private (Admin)
export const verifyIncident = async (req, res) => {
  try {
    const incident = await Incident.findOne({ _id: req.params.id, isDemo: { $ne: true } });
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    if (incident.status !== 'Pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot verify incident: Current status is ${incident.status}`,
      });
    }

    incident.status = 'Verified';
    incident.verifiedBy = req.user._id;
    incident.statusHistory.push({
      status: 'Verified',
      timestamp: new Date(),
      note: 'Verified by Control Center dispatch administrator',
      updatedBy: req.user._id,
    });
    await incident.save();

    // Query nearest candidates
    const nearestResponders = await findNearestResponders(incident);

    const populatedIncident = await Incident.findById(incident._id)
      .populate('citizenId', 'name phone')
      .populate('verifiedBy', 'name email');

    // Real-time broadcast
    broadcastEmergencyEvent('incident:verified', {
      incident: populatedIncident,
      nearestResponders,
    });
    broadcastEmergencyEvent('incident:watch_update', populatedIncident, {
      incident: incident._id.toString(),
    });

    res.json({
      success: true,
      message: 'Incident verified successfully',
      data: populatedIncident,
      nearestResponders,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get nearest responders for incident
// @route   GET /api/incidents/:id/nearest-responders
// @access  Private (Admin)
export const triggerEscalationCheck = async (req, res) => {
  try {
    const { checkAndEscalateOverdueIncidents } = await import('../services/escalationService.js');
    const escalations = await checkAndEscalateOverdueIncidents();
    res.json({ success: true, count: escalations.length, data: escalations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getNearestResponders = async (req, res) => {
  try {
    const incident = await Incident.findOne({ _id: req.params.id, isDemo: { $ne: true } });
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    const nearestResponders = await findNearestResponders(incident);
    res.json({ success: true, data: nearestResponders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Assign responder to incident (Control Center Admin)
// @route   PATCH /api/incidents/:id/assign
// @access  Private (Admin)
export const assignIncident = async (req, res) => {
  try {
    const { responderId, hospitalId } = req.body;
    if (!responderId) {
      return res.status(400).json({ success: false, message: 'Responder ID is required' });
    }

    const { incident, responder } = await assignResponderToIncident(
      req.params.id,
      responderId,
      req.user._id,
      hospitalId
    );

    const populatedIncident = await Incident.findById(incident._id)
      .populate('citizenId', 'name phone')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      });

    // Notify responder in-app
    await createNotification({
      recipientId: responder.userId,
      incidentId: incident._id,
      message: `Emergency Alert: You have been dispatched to a ${incident.category.toUpperCase()} incident at ${incident.location.address}`,
      type: 'assignment',
    });

    // Real-time broadcast
    broadcastEmergencyEvent('incident:assigned', populatedIncident);
    broadcastEmergencyEvent('incident:watch_update', populatedIncident, {
      incident: incident._id.toString(),
    });

    res.json({
      success: true,
      message: `Incident assigned to ${responder.unitName}`,
      data: populatedIncident,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update incident response status with strict state machine validation
// @route   PATCH /api/incidents/:id/status
// @access  Private (Responder, Admin)
export const updateIncidentStatus = async (req, res) => {
  try {
    const { status, note } = req.body;

    const incident = await Incident.findOne({ _id: req.params.id, isDemo: { $ne: true } });
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    // Strict State Machine Check
    const allowedNext = ALLOWED_TRANSITIONS[incident.status] || [];
    if (!allowedNext.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Illegal transition: Cannot transition from '${incident.status}' to '${status}'. Allowed transitions: [${allowedNext.join(', ')}]`,
      });
    }

    // Role Authority Check
    if (['Accepted', 'En Route', 'Arrived'].includes(status)) {
      if (req.user.role !== 'responder') {
        return res.status(403).json({
          success: false,
          message: 'Only the assigned emergency responder can advance to this status',
        });
      }

      const responder = await Responder.findOne({ userId: req.user._id });
      if (
        !responder ||
        !incident.assignedResponderId ||
        incident.assignedResponderId.toString() !== responder._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You are not the assigned responder for this incident',
        });
      }
    }

    incident.status = status;
    incident.statusHistory.push({
      status,
      timestamp: new Date(),
      note: note || `Status progressed to ${status}`,
      updatedBy: req.user._id,
    });

    // When marked Resolved: set resolvedAt timestamp and release responder atomically
    if (status === 'Resolved') {
      incident.resolvedAt = new Date();
      if (incident.assignedResponderId) {
        await Responder.findByIdAndUpdate(incident.assignedResponderId, {
          $set: { availability: 'available', assignedIncidentId: null },
        });
      }
    }

    await incident.save();

    const populatedIncident = await Incident.findById(incident._id)
      .populate('citizenId', 'name phone')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      });

    // Real-time broadcast
    broadcastEmergencyEvent('incident:status_updated', populatedIncident);
    broadcastEmergencyEvent('incident:watch_update', populatedIncident, {
      incident: incident._id.toString(),
    });

    res.json({
      success: true,
      message: `Incident status updated to ${status}`,
      data: populatedIncident,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Cancel emergency incident (Citizen or Admin)
// @route   PATCH /api/incidents/:id/cancel
// @access  Private (Citizen, Admin)
export const cancelIncident = async (req, res) => {
  try {
    const incident = await Incident.findOne({ _id: req.params.id, isDemo: { $ne: true } });
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    if (['Resolved', 'Cancelled'].includes(incident.status)) {
      return res.status(400).json({
        success: false,
        message: `Incident is already ${incident.status}`,
      });
    }

    // Citizen can only cancel their own incident
    if (
      req.user.role === 'citizen' &&
      incident.citizenId.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You cannot cancel another user’s emergency incident',
      });
    }

    incident.status = 'Cancelled';
    incident.statusHistory.push({
      status: 'Cancelled',
      timestamp: new Date(),
      note: req.body.reason || 'Cancelled by user',
      updatedBy: req.user._id,
    });

    // Free responder if assigned
    if (incident.assignedResponderId) {
      await Responder.findByIdAndUpdate(incident.assignedResponderId, {
        $set: { availability: 'available', assignedIncidentId: null },
      });
    }

    await incident.save();

    const populatedIncident = await Incident.findById(incident._id)
      .populate('citizenId', 'name phone')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      });

    broadcastEmergencyEvent('incident:cancelled', populatedIncident);
    broadcastEmergencyEvent('incident:watch_update', populatedIncident, {
      incident: incident._id.toString(),
    });

    res.json({
      success: true,
      message: 'Emergency incident cancelled',
      data: populatedIncident,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get public sanitized live-tracking session by unguessable token
// @route   GET /api/incidents/tracking/:token
// @access  Public (Secured by unguessable token + expiration)
export const getLiveTrackingByToken = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || typeof token !== 'string' || !/^[a-f0-9]{48}$/i.test(token)) {
      return res.status(400).json({ success: false, message: 'Invalid tracking token format' });
    }

    const incident = await Incident.findOne({ trackingToken: token })
      .select('category status priority location liveLocation lastLocationUpdate trackingExpiresAt isLiveTrackingActive nearbyEmergencyFacilities affectedCount categoryDetails createdAt');

    if (!incident) {
      return res.status(404).json({ success: false, message: 'Live tracking session not found' });
    }

    if (!incident.isLiveTrackingActive) {
      return res.status(410).json({
        success: false,
        message: 'Live tracking session was revoked or stopped by the citizen',
        isRevoked: true,
      });
    }

    if (incident.trackingExpiresAt && new Date(incident.trackingExpiresAt) < new Date()) {
      incident.isLiveTrackingActive = false;
      await incident.save();
      return res.status(410).json({
        success: false,
        message: 'Live tracking session has expired',
        isExpired: true,
      });
    }

    res.json({
      success: true,
      data: {
        incidentId: incident._id,
        category: incident.category,
        status: incident.status,
        priority: incident.priority,
        affectedCount: incident.affectedCount,
        categoryDetails: incident.categoryDetails,
        location: incident.location,
        liveLocation: incident.liveLocation,
        lastLocationUpdate: incident.lastLocationUpdate,
        trackingExpiresAt: incident.trackingExpiresAt,
        isLiveTrackingActive: incident.isLiveTrackingActive,
        nearbyEmergencyFacilities: incident.nearbyEmergencyFacilities,
        createdAt: incident.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update live coordinates via unguessable token
// @route   PATCH /api/incidents/tracking/:token
// @access  Public (Secured by unguessable token, rate-limited, and verified)
export const updateLiveLocationByToken = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || typeof token !== 'string' || !/^[a-f0-9]{48}$/i.test(token)) {
      return res.status(400).json({ success: false, message: 'Invalid tracking token format' });
    }

    // Rate-limiting check
    const now = Date.now();
    const lastTime = liveLocationThrottles.get(token);
    if (lastTime && now - lastTime < LIVE_LOCATION_THROTTLE_MS) {
      return res.status(429).json({
        success: false,
        message: 'Rate limit exceeded: coordinate updates are throttled to once every 1.5 seconds',
      });
    }

    const { latitude, longitude, accuracy, heading, speed } = req.body;
    const lat = Number(latitude);
    const lng = Number(longitude);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid coordinate bounds (-90 to 90, -180 to 180)',
      });
    }

    const incident = await Incident.findOne({ trackingToken: token });
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Live tracking session not found' });
    }

    if (!incident.isLiveTrackingActive) {
      return res.status(410).json({
        success: false,
        message: 'Live tracking session was revoked or stopped by the citizen',
        isRevoked: true,
      });
    }

    if (incident.trackingExpiresAt && new Date(incident.trackingExpiresAt) < new Date()) {
      incident.isLiveTrackingActive = false;
      await incident.save();
      return res.status(410).json({
        success: false,
        message: 'Live tracking session has expired',
        isExpired: true,
      });
    }

    const updateTime = new Date();
    incident.location.latitude = lat;
    incident.location.longitude = lng;
    if (accuracy !== undefined) incident.location.accuracy = Number(accuracy) || null;

    incident.liveLocation = {
      latitude: lat,
      longitude: lng,
      accuracy: accuracy !== undefined ? Number(accuracy) : null,
      heading: heading !== undefined ? Number(heading) : null,
      speed: speed !== undefined ? Number(speed) : null,
      updatedAt: updateTime,
    };
    incident.lastLocationUpdate = updateTime;

    await incident.save();
    liveLocationThrottles.set(token, now);

    // Broadcast live telemetry to control room and incident watch room
    broadcastEmergencyEvent('incident:live_location', {
      incidentId: incident._id,
      latitude: lat,
      longitude: lng,
      accuracy: incident.liveLocation.accuracy,
      heading: incident.liveLocation.heading,
      speed: incident.liveLocation.speed,
      updatedAt: updateTime,
    });
    broadcastEmergencyEvent('incident:watch_update', incident, {
      incident: incident._id.toString(),
    });

    res.json({
      success: true,
      message: 'Live location telemetry recorded',
      lastLocationUpdate: updateTime,
      liveLocation: incident.liveLocation,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update live coordinates (Authenticated Citizen or Admin)
// @route   PATCH /api/incidents/:id/live-location
// @access  Private (Citizen, Admin)
export const updateLiveLocation = async (req, res) => {
  try {
    const { latitude, longitude, accuracy, heading, speed } = req.body;
    const lat = Number(latitude);
    const lng = Number(longitude);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid coordinate bounds (-90 to 90, -180 to 180)',
      });
    }

    const incident = await Incident.findById(req.params.id);
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    if (
      req.user.role === 'citizen' &&
      incident.citizenId.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You cannot stream location for another user’s incident',
      });
    }

    if (!incident.isLiveTrackingActive) {
      return res.status(410).json({
        success: false,
        message: 'Live location sharing is currently stopped',
        isRevoked: true,
      });
    }

    if (incident.trackingExpiresAt && new Date(incident.trackingExpiresAt) < new Date()) {
      incident.isLiveTrackingActive = false;
      await incident.save();
      return res.status(410).json({
        success: false,
        message: 'Live location sharing session has expired',
        isExpired: true,
      });
    }

    const updateTime = new Date();
    incident.location.latitude = lat;
    incident.location.longitude = lng;
    if (accuracy !== undefined) incident.location.accuracy = Number(accuracy) || null;

    incident.liveLocation = {
      latitude: lat,
      longitude: lng,
      accuracy: accuracy !== undefined ? Number(accuracy) : null,
      heading: heading !== undefined ? Number(heading) : null,
      speed: speed !== undefined ? Number(speed) : null,
      updatedAt: updateTime,
    };
    incident.lastLocationUpdate = updateTime;

    await incident.save();

    broadcastEmergencyEvent('incident:live_location', {
      incidentId: incident._id,
      latitude: lat,
      longitude: lng,
      accuracy: incident.liveLocation.accuracy,
      heading: incident.liveLocation.heading,
      speed: incident.liveLocation.speed,
      updatedAt: updateTime,
    });
    broadcastEmergencyEvent('incident:watch_update', incident, {
      incident: incident._id.toString(),
    });

    res.json({
      success: true,
      message: 'Live location telemetry updated',
      lastLocationUpdate: updateTime,
      liveLocation: incident.liveLocation,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Stop/revoke live location sharing (Citizen or Admin)
// @route   PATCH /api/incidents/:id/stop-tracking
// @access  Private (Citizen, Admin)
export const stopLiveTracking = async (req, res) => {
  try {
    const incident = await Incident.findById(req.params.id);
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Incident not found' });
    }

    if (
      req.user.role === 'citizen' &&
      incident.citizenId.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You cannot modify location sharing for another user’s incident',
      });
    }

    incident.isLiveTrackingActive = false;
    await incident.save();

    broadcastEmergencyEvent('incident:tracking_stopped', {
      incidentId: incident._id,
      stoppedAt: new Date(),
    });

    res.json({
      success: true,
      message: 'Live location sharing stopped successfully',
      isLiveTrackingActive: false,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
