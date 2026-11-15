import Incident from '../models/Incident.js';
import Responder from '../models/Responder.js';
import { findNearestResponders } from './assignmentService.js';
import { broadcastEmergencyEvent, createNotification } from './notificationService.js';

// Default escalation threshold: 120 seconds, configurable via env var
export const getEscalationTimeoutSeconds = () => {
  const configured = Number(process.env.ESCALATION_TIMEOUT_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120;
};

let escalationInterval = null;
let isCheckInProgress = false;

/**
 * Checks for overdue assignments and escalates them atomically.
 * Returns an array of processed escalation records.
 *
 * @param {object} options
 * @param {number} [options.timeoutSeconds] - Override timeout in seconds (useful for tests)
 * @param {Date} [options.now] - Override current timestamp (useful for simulated time tests)
 */
export const checkAndEscalateOverdueIncidents = async ({
  timeoutSeconds = getEscalationTimeoutSeconds(),
  now = new Date(),
} = {}) => {
  // Prevent concurrent runs in the same node process
  if (isCheckInProgress) {
    return [];
  }

  isCheckInProgress = true;
  const results = [];

  try {
    const thresholdDate = new Date(now.getTime() - timeoutSeconds * 1000);

    // 1. Find candidates that are currently in Assigned status and exceeded timeout
    const overdueCandidates = await Incident.find({
      status: 'Assigned',
      assignedAt: { $ne: null, $lte: thresholdDate },
      isEscalated: { $ne: true },
      isDemo: { $ne: true },
    })
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      });

    for (const candidate of overdueCandidates) {
      const assignedResponder = candidate.assignedResponderId;
      if (!assignedResponder) continue;

      const responderId = assignedResponder._id;

      // 2. Atomically flag the incident as escalated.
      // Condition guarantees:
      // - status is STILL 'Assigned' (has not advanced to Accepted, En Route, Arrived, Resolved, etc.)
      // - assignedResponderId is STILL this responder
      // - isEscalated is not already true (duplicate protection)
      const escalatedIncident = await Incident.findOneAndUpdate(
        {
          _id: candidate._id,
          status: 'Assigned',
          assignedResponderId: responderId,
          isEscalated: { $ne: true },
        },
        {
            $set: {
              isEscalated: true,
              escalatedAt: now,
              escalationReason: `Responder ${assignedResponder.unitName} failed to accept within ${timeoutSeconds}s`,
              status: 'Verified',
              assignedResponderId: null,
              assignedAt: null,
            },
            $push: {
              statusHistory: {
                status: 'Verified',
                timestamp: now,
                note: `[ESCALATION] Responder ${assignedResponder.unitName} did not accept within ${timeoutSeconds}s. Assignment released and returned to dispatch.`,
                updatedBy: null,
              },
            },
          },
        { new: true }
      ).populate('citizenId', 'name phone');

      if (!escalatedIncident) {
        // Incident progressed or changed concurrently; skip safely
        continue;
      }

      // 3. Atomically release the non-responsive responder ONLY if they are still tied to this specific incident
      // Never release a responder who was already reassigned or marked otherwise
      const releasedResponder = await Responder.findOneAndUpdate(
        {
          _id: responderId,
          assignedIncidentId: candidate._id,
          availability: 'busy',
        },
        {
          $set: {
            availability: 'available',
            assignedIncidentId: null,
          },
        },
        { new: true }
      );

      // 4. Query recommended fallback responders
      let recommendedResponders = [];
      try {
        recommendedResponders = await findNearestResponders(escalatedIncident);
      } catch (err) {
        console.warn('[Escalation] Could not calculate nearest responders:', err.message);
      }

      // Filter out the responder who just timed out so dispatch gets next candidate
      const nextCandidates = recommendedResponders.filter(
        (r) => r.responder._id.toString() !== responderId.toString()
      );

      const escalationPayload = {
        incident: escalatedIncident,
        timedOutResponder: {
          _id: assignedResponder._id,
          unitName: assignedResponder.unitName,
          serviceType: assignedResponder.serviceType,
        },
        releasedResponder: Boolean(releasedResponder),
        timeoutSeconds,
        escalatedAt: now,
        nextCandidates,
      };

      // 5. Notify Control Center dispatch room via Socket.IO
      broadcastEmergencyEvent('incident:escalated', escalationPayload, { role: 'admin' });
      broadcastEmergencyEvent('incident:watch_update', escalatedIncident, {
        incident: escalatedIncident._id.toString(),
      });

      // 6. Push notification for Control Center records
      if (assignedResponder.userId?._id) {
        await createNotification({
          recipientId: assignedResponder.userId._id,
          incidentId: escalatedIncident._id,
          message: `Dispatch timeout: Assignment for incident at ${escalatedIncident.location?.address} has expired.`,
          type: 'alert',
        }).catch(() => {});
      }

      results.push(escalationPayload);
    }
  } catch (error) {
    console.error('[EscalationService Error]', error.message);
  } finally {
    isCheckInProgress = false;
  }

  return results;
};

/**
 * Starts periodic background polling for overdue assignments
 */
export const startEscalationMonitoring = (intervalMs = 15000) => {
  if (escalationInterval) return;
  escalationInterval = setInterval(() => {
    checkAndEscalateOverdueIncidents().catch((err) => {
      console.error('[Escalation Interval Error]', err.message);
    });
  }, intervalMs);

  // Allow node process to exit naturally if only this timer is pending
  if (escalationInterval && typeof escalationInterval.unref === 'function') {
    escalationInterval.unref();
  }
};

/**
 * Stops background monitoring
 */
export const stopEscalationMonitoring = () => {
  if (escalationInterval) {
    clearInterval(escalationInterval);
    escalationInterval = null;
  }
};
