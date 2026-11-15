import Responder from '../models/Responder.js';
import Incident from '../models/Incident.js';
import Hospital from '../models/Hospital.js';
import { calculateDistanceKm, estimateEtaMinutes, formatDistance } from '../utils/distance.js';

/**
 * Maps incident category to responder service type
 */
export const mapCategoryToServiceType = (category) => {
  switch (category) {
    case 'medical':
    case 'road_accident':
      return 'medical';
    case 'police':
    case 'women_safety':
    case 'missing_person':
      return 'police';
    case 'fire':
    case 'fire_explosion':
    case 'flood_rainfall':
    case 'natural_disaster':
    case 'trapped_rescue':
    case 'gas_hazardous':
      return 'fire';
    default:
      return 'medical';
  }
};

/**
 * Finds eligible registered and approved responders sorted by Haversine distance
 * @param {object} incident The incident document or object with coordinates and category
 * @returns {Array} List of ranked available responders with distance & ETA
 */
export const findNearestResponders = async (incident) => {
  const targetServiceType = mapCategoryToServiceType(incident.category);

  // Query only available registered responders matching category
  const availableResponders = await Responder.find({
    serviceType: targetServiceType,
    availability: 'available',
    isDemo: { $ne: true },
  }).populate('userId', 'name email phone isActive');

  // Strictly filter out any responder whose user account is inactive or pending administrator approval
  const approvedResponders = availableResponders.filter(
    (resp) => resp.userId && resp.userId.isActive !== false
  );

  const rankedResponders = approvedResponders.map((resp) => {
    const distanceKm = calculateDistanceKm(
      incident.location.latitude,
      incident.location.longitude,
      resp.currentLocation.latitude,
      resp.currentLocation.longitude
    );
    const etaMinutes = estimateEtaMinutes(distanceKm);

    return {
      responder: resp,
      distanceKm,
      etaMinutes,
      formattedDistance: formatDistance(distanceKm),
    };
  });

  // Sort ascending by distance
  rankedResponders.sort((a, b) => a.distanceKm - b.distanceKm);

  return rankedResponders;
};

/**
 * Assigns a responder to an incident using atomic locking to eliminate race conditions
 */
export const assignResponderToIncident = async (incidentId, responderId, updatedByUserId, hospitalId = null) => {
  const incident = await Incident.findOne({ _id: incidentId, isDemo: { $ne: true } });
  if (!incident) {
    throw new Error('Incident not found');
  }

  if (['Resolved', 'Cancelled'].includes(incident.status)) {
    throw new Error(`Cannot assign responder: Incident is already marked as ${incident.status}`);
  }

  // Pre-check responder existence and approval status
  const existingResponder = await Responder.findById(responderId).populate('userId', 'name phone isActive');
  if (!existingResponder) {
    throw new Error('Responder not found');
  }

  if (existingResponder.userId && existingResponder.userId.isActive === false) {
    throw new Error('Responder account is pending approval or inactive and cannot be assigned to an active emergency');
  }

  // Atomic reservation of responder to prevent simultaneous assignment
  const responder = await Responder.findOneAndUpdate(
    {
      _id: responderId,
      isDemo: { $ne: true },
      $or: [
        { availability: 'available' },
        { assignedIncidentId: incident._id }, // Re-dispatching to same unit allowed
      ],
    },
    {
      $set: {
        availability: 'busy',
        assignedIncidentId: incident._id,
      },
    },
    { new: true }
  ).populate('userId', 'name phone isActive');

  if (!responder) {
    throw new Error('Responder is no longer available or was concurrently assigned by another dispatcher');
  }

  // If a different responder was previously assigned, free the old responder
  if (
    incident.assignedResponderId &&
    incident.assignedResponderId.toString() !== responder._id.toString()
  ) {
    await Responder.findByIdAndUpdate(incident.assignedResponderId, {
      $set: { availability: 'available', assignedIncidentId: null },
    });
  }

  // If medical incident, route to explicit hospital or nearest emergency facility
  if (hospitalId) {
    incident.hospitalId = hospitalId;
  } else if (incident.category === 'medical' && !incident.hospitalId) {
    const verifiedHospitals = await Hospital.find({
      verifiedAt: { $ne: null },
      emergencyAvailable: true,
      isDemo: { $ne: true },
    });
    if (verifiedHospitals.length > 0) {
      let closestHospital = verifiedHospitals[0];
      let minDistance = calculateDistanceKm(
        incident.location.latitude,
        incident.location.longitude,
        closestHospital.location.latitude,
        closestHospital.location.longitude
      );
      for (let i = 1; i < verifiedHospitals.length; i++) {
        const d = calculateDistanceKm(
          incident.location.latitude,
          incident.location.longitude,
          verifiedHospitals[i].location.latitude,
          verifiedHospitals[i].location.longitude
        );
        if (d < minDistance) {
          minDistance = d;
          closestHospital = verifiedHospitals[i];
        }
      }
      incident.hospitalId = closestHospital._id;
    }
  }

  // Update incident record
  incident.assignedResponderId = responder._id;
  incident.status = 'Assigned';
  incident.assignedAt = new Date();
  incident.isEscalated = false;
  incident.escalatedAt = null;
  incident.escalationReason = '';
  incident.statusHistory.push({
    status: 'Assigned',
    timestamp: new Date(),
    note: `Assigned to ${responder.unitName} (${responder.serviceType.toUpperCase()})`,
    updatedBy: updatedByUserId || null,
  });
  await incident.save();

  return { incident, responder };
};
