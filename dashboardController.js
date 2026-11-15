import Incident from '../models/Incident.js';
import Responder from '../models/Responder.js';
import Hospital from '../models/Hospital.js';

// @desc    Get control-center summary statistics
// @route   GET /api/dashboard/summary
// @access  Private (Admin, Hospital, Responder)
export const getDashboardSummary = async (req, res) => {
  try {
    const totalIncidents = await Incident.countDocuments({ isDemo: { $ne: true } });
    const pendingIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Pending' });
    const verifiedIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Verified' });
    const assignedIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Assigned' });
    const activeDispatched = await Incident.countDocuments({
      isDemo: { $ne: true },
      status: { $in: ['Accepted', 'En Route', 'Arrived'] },
    });
    const resolvedIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Resolved' });
    const cancelledIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Cancelled' });

    // Category breakdown
    const medicalIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, category: 'medical' });
    const policeIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, category: 'police' });
    const fireIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, category: 'fire' });

    // Responders availability
    const totalResponders = await Responder.countDocuments({ isDemo: { $ne: true } });
    const availableResponders = await Responder.countDocuments({ isDemo: { $ne: true }, availability: 'available' });
    const busyResponders = await Responder.countDocuments({ isDemo: { $ne: true }, availability: 'busy' });
    const offDutyResponders = await Responder.countDocuments({ isDemo: { $ne: true }, availability: 'off_duty' });

    // Hospitals & Beds
    const hospitals = await Hospital.find({ isDemo: { $ne: true }, verifiedAt: { $ne: null } });
    const totalBeds = hospitals.reduce((acc, h) => acc + (h.totalBeds || 0), 0);
    const availableBeds = hospitals.reduce((acc, h) => acc + (h.availableBeds || 0), 0);
    const totalICUBeds = hospitals.reduce((acc, h) => acc + (h.totalICUBeds || 0), 0);
    const availableICUBeds = hospitals.reduce((acc, h) => acc + (h.availableICUBeds || 0), 0);

    // Calculate average response / resolution time for resolved incidents
    const resolvedList = await Incident.find({
      isDemo: { $ne: true },
      status: 'Resolved',
      resolvedAt: { $ne: null },
    }).select('createdAt resolvedAt');

    let avgResponseTimeMinutes = 0;
    if (resolvedList.length > 0) {
      const totalMinutes = resolvedList.reduce((acc, inc) => {
        const diffMs = new Date(inc.resolvedAt) - new Date(inc.createdAt);
        return acc + diffMs / (1000 * 60);
      }, 0);
      avgResponseTimeMinutes = Math.round((totalMinutes / resolvedList.length) * 10) / 10;
    }

    res.json({
      success: true,
      data: {
        incidents: {
          total: totalIncidents,
          pending: pendingIncidents,
          verified: verifiedIncidents,
          assigned: assignedIncidents,
          active: activeDispatched,
          resolved: resolvedIncidents,
          cancelled: cancelledIncidents,
          byCategory: {
            medical: medicalIncidents,
            police: policeIncidents,
            fire: fireIncidents,
          },
          avgResponseTimeMinutes,
        },
        responders: {
          total: totalResponders,
          available: availableResponders,
          busy: busyResponders,
          offDuty: offDutyResponders,
        },
        hospitals: {
          totalFacilities: hospitals.length,
          totalBeds,
          availableBeds,
          totalICUBeds,
          availableICUBeds,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get recent live incident feed
// @route   GET /api/dashboard/incidents
// @access  Private (Admin)
export const getDashboardIncidents = async (req, res) => {
  try {
    const incidents = await Incident.find({ isDemo: { $ne: true } })
      .populate('citizenId', 'name phone')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      data: incidents,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get historical reports & response performance
// @route   GET /api/dashboard/response-reports
// @access  Private (Admin)
export const getResponseReports = async (req, res) => {
  try {
    const total = await Incident.countDocuments({ isDemo: { $ne: true } });
    const resolved = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Resolved' });
    const pending = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Pending' });

    // Category distribution
    const categories = await Incident.aggregate([
      { $match: { isDemo: { $ne: true } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);

    // Priority distribution
    const priorities = await Incident.aggregate([
      { $match: { isDemo: { $ne: true } } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]);

    res.json({
      success: true,
      data: {
        total,
        resolved,
        pending,
        categories: categories.map((c) => ({ category: c._id, count: c.count })),
        priorities: priorities.map((p) => ({ priority: p._id, count: p.count })),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get real public statistics for Landing Page (No Auth Required)
// @route   GET /api/dashboard/public-stats
// @access  Public
export const getPublicStats = async (req, res) => {
  try {
    const totalIncidents = await Incident.countDocuments({ isDemo: { $ne: true } });
    const resolvedIncidents = await Incident.countDocuments({ isDemo: { $ne: true }, status: 'Resolved' });
    const availableResponders = await Responder.countDocuments({ isDemo: { $ne: true }, availability: 'available' });
    const totalHospitals = await Hospital.countDocuments({ isDemo: { $ne: true }, verifiedAt: { $ne: null } });

    // Calculate real avg resolution time in minutes from MongoDB
    const resolvedList = await Incident.find({
      isDemo: { $ne: true },
      status: 'Resolved',
      resolvedAt: { $ne: null },
    }).select('createdAt resolvedAt');

    let avgResponseTimeMinutes = 0;
    if (resolvedList.length > 0) {
      const totalMinutes = resolvedList.reduce((acc, inc) => {
        const diffMs = new Date(inc.resolvedAt) - new Date(inc.createdAt);
        return acc + diffMs / (1000 * 60);
      }, 0);
      avgResponseTimeMinutes = Math.round((totalMinutes / resolvedList.length) * 10) / 10;
    }

    res.json({
      success: true,
      data: {
        totalIncidents,
        resolvedIncidents,
        availableResponders,
        totalHospitals,
        avgResponseTimeMinutes,
        source: 'MongoDB Live Records',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

