import Hospital from '../models/Hospital.js';
import Incident from '../models/Incident.js';
import { broadcastEmergencyEvent } from '../services/notificationService.js';


// @desc    Get currently authenticated hospital facility
// @route   GET /api/hospitals/my-hospital
// @access  Private (Hospital)
export const getMyHospital = async (req, res) => {
  try {
    const hospital = await Hospital.findOne({
      userId: req.user._id,
      isDemo: { $ne: true },
    }).populate('lastUpdatedBy', 'name email');

    if (!hospital) {
      return res.status(404).json({
        success: false,
        message: 'No hospital facility linked to your staff profile',
      });
    }

    res.json({ success: true, data: hospital });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all registered hospitals
// @route   GET /api/hospitals
// @access  Public / Private
export const getAllHospitals = async (req, res) => {
  try {
    const hospitals = await Hospital.find({ isDemo: { $ne: true }, verifiedAt: { $ne: null } })
      .populate('lastUpdatedBy', 'name email')
      .sort({ name: 1 });

    res.json({
      success: true,
      total: hospitals.length,
      data: hospitals,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single hospital by ID
// @route   GET /api/hospitals/:id
// @access  Public / Private
export const getHospitalById = async (req, res) => {
  try {
    const hospital = await Hospital.findOne({ _id: req.params.id, isDemo: { $ne: true }, verifiedAt: { $ne: null } }).populate(
      'lastUpdatedBy',
      'name email'
    );

    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital not found' });
    }

    res.json({ success: true, data: hospital });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Register a new hospital facility
// @route   POST /api/hospitals
// @access  Private (Admin)
export const createHospital = async (req, res) => {
  try {
    const {
      name,
      address,
      phone,
      location,
      emergencyAvailable,
      availableBeds,
      totalBeds,
      availableICUBeds,
      totalICUBeds,
      services,
      bloodBankAvailable,
    } = req.body;

    if (!name || !address || !phone || !location || location.latitude === undefined || location.longitude === undefined || availableBeds === undefined || totalBeds === undefined || availableICUBeds === undefined || totalICUBeds === undefined || emergencyAvailable === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Verified provider name, address, phone, coordinates, emergency status, and current bed counts are required',
      });
    }

    const hospital = await Hospital.create({
      name,
      address,
      phone: phone || '',
      location: {
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
      },
      emergencyAvailable: Boolean(emergencyAvailable),
      availableBeds: Number(availableBeds),
      totalBeds: Number(totalBeds),
      availableICUBeds: Number(availableICUBeds),
      totalICUBeds: Number(totalICUBeds),
      services: Array.isArray(services) ? services : [],
      bloodBankAvailable: Boolean(bloodBankAvailable),
      verifiedAt: null,
      lastUpdatedBy: req.user._id,
    });

    broadcastEmergencyEvent('hospital:created', hospital);

    res.status(201).json({
      success: true,
      message: 'Hospital registered successfully',
      data: hospital,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// @desc Verify a provider record after the administrator checks it with the provider
// @route PATCH /api/hospitals/:id/verify
export const verifyHospital = async (req, res) => {
  try {
    const hospital = await Hospital.findOneAndUpdate(
      { _id: req.params.id, isDemo: { $ne: true } },
      { $set: { verifiedAt: new Date(), lastUpdatedBy: req.user._id } },
      { new: true, runValidators: true }
    );
    if (!hospital) return res.status(404).json({ success: false, message: 'Hospital not found' });
    broadcastEmergencyEvent('hospital:created', hospital);
    res.json({ success: true, data: hospital });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update hospital bed & emergency availability
// @route   PATCH /api/hospitals/:id/availability
// @access  Private (Hospital Staff or Admin)
export const updateHospitalAvailability = async (req, res) => {
  try {
    const { availableBeds, totalBeds, availableICUBeds, totalICUBeds, emergencyAvailable } = req.body;

    const hospital = await Hospital.findOne({ _id: req.params.id, isDemo: { $ne: true }, verifiedAt: { $ne: null } });
    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital not found' });
    }

    if (req.user.role === 'hospital') {
      if (!hospital.userId || hospital.userId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You can only update bed capacity for your assigned hospital facility',
        });
      }
    }

    if (availableBeds !== undefined) hospital.availableBeds = Math.max(0, Number(availableBeds));
    if (totalBeds !== undefined) hospital.totalBeds = Math.max(0, Number(totalBeds));
    if (availableICUBeds !== undefined) hospital.availableICUBeds = Math.max(0, Number(availableICUBeds));
    if (totalICUBeds !== undefined) hospital.totalICUBeds = Math.max(0, Number(totalICUBeds));
    if (emergencyAvailable !== undefined) hospital.emergencyAvailable = Boolean(emergencyAvailable);

    hospital.lastUpdatedBy = req.user._id;
    await hospital.save();

    const populatedHospital = await Hospital.findById(hospital._id).populate(
      'lastUpdatedBy',
      'name email'
    );

    // Broadcast updated capacity in real time
    broadcastEmergencyEvent('hospital:updated', populatedHospital);

    res.json({
      success: true,
      message: 'Hospital emergency capacity updated successfully',
      data: populatedHospital,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get emergency patient intakes assigned to hospital
// @route   GET /api/hospitals/intakes
// @access  Private (Hospital Staff, Admin)
export const getHospitalIntakes = async (req, res) => {
  try {
    let targetHospital = null;

    if (req.user.role === 'hospital') {
      targetHospital = await Hospital.findOne({
        $or: [{ userId: req.user._id }, { lastUpdatedBy: req.user._id }],
        isDemo: { $ne: true },
        verifiedAt: { $ne: null },
      });

      if (!targetHospital) {
        return res.json({
          success: true,
          total: 0,
          hospital: null,
          data: [],
          message: 'No verified hospital facility linked to your staff profile.',
        });
      }
    } else if (req.user.role === 'admin') {
      if (req.query.hospitalId) {
        targetHospital = await Hospital.findOne({ _id: req.query.hospitalId, isDemo: { $ne: true } });
      }
    }

    const query = {
      category: 'medical',
      isDemo: { $ne: true },
    };
    if (targetHospital) {
      query.hospitalId = targetHospital._id;
    } else {
      query.hospitalId = { $ne: null };
    }

    const incidents = await Incident.find(query)
      .populate('citizenId', 'name phone')
      .populate({
        path: 'assignedResponderId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('hospitalId', 'name address phone emergencyAvailable availableBeds totalBeds availableICUBeds totalICUBeds')
      .sort({ createdAt: -1 })
      .limit(50);

    const intakes = incidents.map((inc) => ({
      _id: inc._id,
      category: inc.category,
      description: inc.description,
      priority: inc.priority,
      status: inc.status,
      patient: {
        name: inc.citizenId?.name || 'Emergency Patient',
        phone: inc.citizenId?.phone || 'Confidential',
      },
      location: {
        address: inc.location?.address || 'Reported Scene',
        latitude: inc.location?.latitude,
        longitude: inc.location?.longitude,
      },
      assignedResponder: inc.assignedResponderId
        ? {
            _id: inc.assignedResponderId._id,
            unitName: inc.assignedResponderId.unitName,
            serviceType: inc.assignedResponderId.serviceType,
            vehicleNumber: inc.assignedResponderId.vehicleNumber,
            availability: inc.assignedResponderId.availability,
          }
        : null,
      intake: inc.intake || {
        status: 'Pending',
        bedType: 'None',
        admittedAt: null,
        notes: '',
      },
      createdAt: inc.createdAt,
      updatedAt: inc.updatedAt,
    }));

    res.json({
      success: true,
      total: intakes.length,
      hospital: targetHospital
        ? {
            _id: targetHospital._id,
            name: targetHospital.name,
            availableBeds: targetHospital.availableBeds,
            totalBeds: targetHospital.totalBeds,
            availableICUBeds: targetHospital.availableICUBeds,
            totalICUBeds: targetHospital.totalICUBeds,
            emergencyAvailable: targetHospital.emergencyAvailable,
          }
        : null,
      data: intakes,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update emergency patient admission and bed triage
// @route   PATCH /api/hospitals/intakes/:id
// @access  Private (Hospital Staff, Admin)
export const updatePatientIntake = async (req, res) => {
  try {
    const { status, bedType, notes } = req.body;

    const validStatuses = ['Pending', 'Admitted_ER', 'Admitted_ICU', 'Treated_and_Released', 'Transferred'];
    const validBedTypes = ['General', 'ICU', 'None'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid intake status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    if (bedType && !validBedTypes.includes(bedType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid bed type. Must be one of: ${validBedTypes.join(', ')}`,
      });
    }

    const incident = await Incident.findOne({ _id: req.params.id, isDemo: { $ne: true } });
    if (!incident) {
      return res.status(404).json({ success: false, message: 'Emergency incident record not found' });
    }

    if (incident.category !== 'medical') {
      return res.status(400).json({
        success: false,
        message: 'Patient intake is only valid for medical emergency incidents',
      });
    }

    let hospital = null;
    if (req.user.role === 'hospital') {
      hospital = await Hospital.findOne({
        $or: [{ userId: req.user._id }, { lastUpdatedBy: req.user._id }],
        verifiedAt: { $ne: null },
      });

      if (!hospital) {
        return res.status(404).json({ success: false, message: 'No linked hospital facility found for your account' });
      }

      if (!incident.hospitalId || incident.hospitalId.toString() !== hospital._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: You can only update patient intakes assigned to your hospital facility',
        });
      }
    } else {
      if (incident.hospitalId) {
        hospital = await Hospital.findById(incident.hospitalId);
      }
    }

    const previousBedType = incident.intake?.bedType || 'None';
    const newStatus = status || incident.intake?.status || 'Pending';
    const newBedType = ['Treated_and_Released', 'Transferred'].includes(newStatus)
      ? (bedType || 'None')
      : (bedType || previousBedType);

    // Synchronize bed counts with hospital facility
    if (hospital) {
      if (['Treated_and_Released', 'Transferred'].includes(newStatus)) {
        // Patient released or transferred: return their previously reserved bed
        if (previousBedType === 'ICU') {
          hospital.availableICUBeds = Math.min(hospital.totalICUBeds, hospital.availableICUBeds + 1);
        } else if (previousBedType === 'General') {
          hospital.availableBeds = Math.min(hospital.totalBeds, hospital.availableBeds + 1);
        }
      } else if (newBedType !== previousBedType) {
        // Bed type changed: release old bed
        if (previousBedType === 'ICU') {
          hospital.availableICUBeds = Math.min(hospital.totalICUBeds, hospital.availableICUBeds + 1);
        } else if (previousBedType === 'General') {
          hospital.availableBeds = Math.min(hospital.totalBeds, hospital.availableBeds + 1);
        }

        // Allocate new bed
        if (newBedType === 'ICU') {
          hospital.availableICUBeds = Math.max(0, hospital.availableICUBeds - 1);
        } else if (newBedType === 'General') {
          hospital.availableBeds = Math.max(0, hospital.availableBeds - 1);
        }
      }
      await hospital.save();
    }

    if (newStatus === 'Treated_and_Released') {
      incident.status = 'Resolved';
      incident.resolvedAt = incident.resolvedAt || new Date();
    }

    incident.intake = {
      status: newStatus,
      bedType: newBedType,
      admittedAt: newStatus.startsWith('Admitted') ? (incident.intake?.admittedAt || new Date()) : incident.intake?.admittedAt,
      notes: notes !== undefined ? notes : (incident.intake?.notes || ''),
      updatedBy: req.user._id,
    };

    incident.statusHistory.push({
      status: incident.status,
      timestamp: new Date(),
      note: `Hospital Triage Update: ${newStatus} (${newBedType} Bed)`,
      updatedBy: req.user._id,
    });

    await incident.save();

    if (hospital) {
      broadcastEmergencyEvent('hospital:updated', hospital);
    }
    broadcastEmergencyEvent('hospital:intake_updated', {
      incidentId: incident._id,
      intake: incident.intake,
    });

    res.json({
      success: true,
      message: 'Patient intake status and bed triage updated successfully',
      data: incident.intake,
      hospitalCapacity: hospital
        ? {
            availableBeds: hospital.availableBeds,
            totalBeds: hospital.totalBeds,
            availableICUBeds: hospital.availableICUBeds,
            totalICUBeds: hospital.totalICUBeds,
          }
        : null,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};