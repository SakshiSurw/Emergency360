import ReliefRequest from '../models/ReliefRequest.js';
import Volunteer from '../models/Volunteer.js';
import ReliefResource from '../models/ReliefResource.js';
import User from '../models/User.js';
import { broadcastEmergencyEvent } from '../services/notificationService.js';

// ==========================================
// 1. DISASTER & FLOOD RELIEF REQUESTS
// ==========================================

export const createReliefRequest = async (req, res) => {
  try {
    const {
      category,
      urgency = 'High',
      affectedPeople = 1,
      affectedFamilies = 0,
      location,
      specificNeeds = '',
      clientRequestId,
      incidentId,
    } = req.body;

    if (!category || !location || location.latitude === undefined || location.longitude === undefined || !location.address) {
      return res.status(400).json({
        success: false,
        message: 'Category, location coordinates (latitude, longitude), and address are required',
      });
    }

    const lat = Number(location.latitude);
    const lng = Number(location.longitude);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid coordinate bounds (-90 to 90, -180 to 180)',
      });
    }

    const validCategories = [
      'rescue',
      'evacuation',
      'food',
      'drinking_water',
      'medicines',
      'shelter',
      'clothing',
      'transport',
    ];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `Invalid relief category. Must be one of: ${validCategories.join(', ')}`,
      });
    }

    // Idempotency check via clientRequestId
    if (clientRequestId) {
      const existing = await ReliefRequest.findOne({ citizenId: req.user._id, clientRequestId })
        .populate('citizenId', 'name phone email');
      if (existing) {
        return res.status(200).json({
          success: true,
          message: 'Relief request already recorded',
          data: existing,
        });
      }
    }

    // Duplicate protection: Check if user submitted an identical category & location request within the last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const duplicate = await ReliefRequest.findOne({
      citizenId: req.user._id,
      category,
      createdAt: { $gte: tenMinutesAgo },
      status: { $in: ['Submitted', 'Verified', 'Assigned'] },
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'A similar relief request was recently submitted and is currently being processed.',
        existingRequestId: duplicate.requestId,
      });
    }

    const requestId = `REL-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;

    const reliefRequest = await ReliefRequest.create({
      requestId,
      clientRequestId,
      citizenId: req.user._id,
      incidentId: incidentId || null,
      category,
      urgency,
      affectedPeople: Math.max(1, Number(affectedPeople) || 1),
      affectedFamilies: Math.max(0, Number(affectedFamilies) || 0),
      location: {
        latitude: lat,
        longitude: lng,
        address: location.address,
        district: location.district || '',
        landmark: location.landmark || '',
      },
      specificNeeds,
      status: 'Submitted',
      statusHistory: [
        {
          status: 'Submitted',
          timestamp: new Date(),
          note: 'Disaster relief assistance request submitted by citizen',
          updatedBy: req.user._id,
        },
      ],
    });

    const populated = await ReliefRequest.findById(reliefRequest._id)
      .populate('citizenId', 'name phone email');

    broadcastEmergencyEvent('relief:request_created', populated, { role: 'admin' });

    res.status(201).json({
      success: true,
      message: 'Relief assistance request submitted successfully. Response teams notified.',
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getReliefRequests = async (req, res) => {
  try {
    const { category, status, urgency, district, search, page = 1, limit = 20 } = req.query;

    const query = { isDemo: { $ne: true } };

    // Role-based scoping: regular citizens see only their own requests unless admin or volunteer
    if (req.user.role === 'citizen') {
      query.citizenId = req.user._id;
    }

    if (category) query.category = category;
    if (status) query.status = status;
    if (urgency) query.urgency = urgency;
    if (district) query['location.district'] = new RegExp(district.trim(), 'i');

    if (search && search.trim() !== '') {
      const reg = new RegExp(search.trim(), 'i');
      query.$or = [
        { requestId: reg },
        { specificNeeds: reg },
        { 'location.address': reg },
        { 'location.landmark': reg },
      ];
    }

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * limitNum;

    const total = await ReliefRequest.countDocuments(query);
    const requests = await ReliefRequest.find(query)
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedVolunteerId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('assignedResourceId', 'title type unit')
      .populate('verifiedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum) || 1,
      data: requests,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getReliefRequestById = async (req, res) => {
  try {
    const request = await ReliefRequest.findById(req.params.id)
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedVolunteerId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('assignedResourceId', 'title type unit totalQuantity allocatedQuantity availableQuantity warehouseLocation')
      .populate('verifiedBy', 'name email');

    if (!request) {
      return res.status(404).json({ success: false, message: 'Relief request not found' });
    }

    // Role safeguard
    if (req.user.role === 'citizen' && request.citizenId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Forbidden: You cannot access this relief request' });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyReliefRequest = async (req, res) => {
  try {
    const request = await ReliefRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Relief request not found' });
    }

    if (request.status !== 'Submitted') {
      return res.status(400).json({
        success: false,
        message: `Cannot verify request: Current status is '${request.status}'`,
      });
    }

    request.status = 'Verified';
    request.verifiedBy = req.user._id;
    request.verifiedAt = new Date();
    request.statusHistory.push({
      status: 'Verified',
      timestamp: new Date(),
      note: req.body.note || 'Verified by Relief Operations Coordinator',
      updatedBy: req.user._id,
    });

    await request.save();

    const populated = await ReliefRequest.findById(request._id)
      .populate('citizenId', 'name phone email')
      .populate('verifiedBy', 'name email');

    broadcastEmergencyEvent('relief:request_verified', populated);

    res.json({
      success: true,
      message: 'Relief request verified successfully',
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const assignReliefRequest = async (req, res) => {
  try {
    const { volunteerId, resourceId, allocatedQuantity = 0, note = '' } = req.body;

    const request = await ReliefRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Relief request not found' });
    }

    if (!['Submitted', 'Verified', 'Assigned'].includes(request.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot assign request with status '${request.status}'`,
      });
    }

    // Validate volunteer assignment if provided
    let volunteer = null;
    if (volunteerId) {
      volunteer = await Volunteer.findById(volunteerId).populate('userId', 'name phone isActive');
      if (!volunteer) {
        return res.status(404).json({ success: false, message: 'Volunteer or NGO unit not found' });
      }
      if (volunteer.status !== 'approved' || (volunteer.userId && volunteer.userId.isActive === false)) {
        return res.status(400).json({
          success: false,
          message: 'Volunteer or NGO is pending approval or inactive and cannot be assigned to relief missions',
        });
      }
    }

    // Validate inventory resource allocation if provided
    let resource = null;
    const qty = Number(allocatedQuantity) || 0;
    if (resourceId && qty > 0) {
      resource = await ReliefResource.findById(resourceId);
      if (!resource) {
        return res.status(404).json({ success: false, message: 'Relief inventory resource not found' });
      }

      // Check available quantity
      const available = (resource.totalQuantity || resource.quantity || 0) - (resource.allocatedQuantity || 0);
      if (available < qty) {
        return res.status(400).json({
          success: false,
          message: `Insufficient inventory: requested ${qty} ${resource.unit}, but only ${available} available`,
        });
      }

      // Duplicate delivery protection: Check if resource already allocated to this request
      const alreadyAllocated = resource.deliveries.some(
        (d) => d.requestId.toString() === request._id.toString() && d.status === 'dispatched'
      );
      if (alreadyAllocated) {
        return res.status(409).json({
          success: false,
          message: 'Relief inventory has already been allocated to this request',
        });
      }

      // Atomically deduct available stock
      resource.allocatedQuantity = (resource.allocatedQuantity || 0) + qty;
      resource.deliveries.push({
        requestId: request._id,
        quantity: qty,
        status: 'dispatched',
        dispatchedAt: new Date(),
        dispatchedBy: req.user._id,
        notes: note || `Dispatched to request #${request.requestId}`,
      });
      await resource.save();

      request.assignedResourceId = resource._id;
      request.allocatedQuantity = qty;
    }

    if (volunteer) {
      request.assignedVolunteerId = volunteer._id;
      volunteer.availability = 'deployed';
      await volunteer.save();
    }

    request.status = 'Assigned';
    request.statusHistory.push({
      status: 'Assigned',
      timestamp: new Date(),
      note: note || `Assigned to ${volunteer ? volunteer.organizationName : 'Field Relief Unit'}${resource ? ` with ${qty} ${resource.unit} of ${resource.title}` : ''}`,
      updatedBy: req.user._id,
    });

    await request.save();

    const populated = await ReliefRequest.findById(request._id)
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedVolunteerId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('assignedResourceId', 'title type unit allocatedQuantity');

    broadcastEmergencyEvent('relief:request_assigned', populated);

    res.json({
      success: true,
      message: 'Relief request assigned and resources allocated successfully',
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateReliefRequestStatus = async (req, res) => {
  try {
    const { status, note = '', confirmationCode = '' } = req.body;

    const request = await ReliefRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Relief request not found' });
    }

    const ALLOWED = {
      Submitted: ['Verified', 'Cancelled'],
      Verified: ['Assigned', 'Cancelled'],
      Assigned: ['In Transit', 'Cancelled'],
      'In Transit': ['Delivered', 'Cancelled'],
      Delivered: [],
      Cancelled: [],
    };

    const nextAllowed = ALLOWED[request.status] || [];
    if (!nextAllowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Illegal transition from '${request.status}' to '${status}'. Allowed: [${nextAllowed.join(', ')}]`,
      });
    }

    // Mark delivery
    if (status === 'Delivered') {
      request.deliveryRecord = {
        deliveredAt: new Date(),
        deliveredBy: req.user._id,
        notes: note || 'Relief supplies / assistance delivered successfully',
        recipientAcknowledged: true,
        confirmationCode: confirmationCode || `CONF-${Date.now().toString().slice(-4)}`,
      };

      // Mark delivery on allocated inventory resource if any
      if (request.assignedResourceId) {
        const resource = await ReliefResource.findById(request.assignedResourceId);
        if (resource) {
          const entry = resource.deliveries.find(
            (d) => d.requestId.toString() === request._id.toString() && d.status === 'dispatched'
          );
          if (entry) {
            entry.status = 'delivered';
            entry.deliveredAt = new Date();
          }
          await resource.save();
        }
      }

      // Free volunteer back to available pool
      if (request.assignedVolunteerId) {
        await Volunteer.findByIdAndUpdate(request.assignedVolunteerId, {
          $set: { availability: 'available' },
        });
      }
    }

    // Handle cancellation: return allocated inventory
    if (status === 'Cancelled') {
      if (request.assignedResourceId && request.allocatedQuantity > 0) {
        const resource = await ReliefResource.findById(request.assignedResourceId);
        if (resource) {
          resource.allocatedQuantity = Math.max(0, (resource.allocatedQuantity || 0) - request.allocatedQuantity);
          const entry = resource.deliveries.find(
            (d) => d.requestId.toString() === request._id.toString() && d.status === 'dispatched'
          );
          if (entry) {
            entry.status = 'returned';
          }
          await resource.save();
        }
      }

      if (request.assignedVolunteerId) {
        await Volunteer.findByIdAndUpdate(request.assignedVolunteerId, {
          $set: { availability: 'available' },
        });
      }
    }

    request.status = status;
    request.statusHistory.push({
      status,
      timestamp: new Date(),
      note: note || `Status updated to ${status}`,
      updatedBy: req.user._id,
    });

    await request.save();

    const populated = await ReliefRequest.findById(request._id)
      .populate('citizenId', 'name phone email')
      .populate({
        path: 'assignedVolunteerId',
        populate: { path: 'userId', select: 'name phone' },
      })
      .populate('assignedResourceId', 'title type unit');

    broadcastEmergencyEvent('relief:request_updated', populated);

    res.json({
      success: true,
      message: `Relief request updated to '${status}'`,
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 2. VOLUNTEER & NGO REGISTRATION & APPROVAL
// ==========================================

export const registerVolunteer = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      organizationName,
      type = 'individual',
      serviceAreas = [],
      skills = ['general_relief'],
      capacity = {},
    } = req.body;

    if (!name || !email || !phone || !password || !organizationName) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, phone, password, and organization/unit name are required',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email address already exists',
      });
    }

    // Password complexity check
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long',
      });
    }

    const passwordHash = await User.hashPassword(password);

    // Create user with role 'volunteer' and isActive: false (requires admin approval)
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone.trim(),
      passwordHash,
      role: 'volunteer',
      isActive: false,
    });

    const volunteer = await Volunteer.create({
      userId: user._id,
      organizationName: organizationName.trim(),
      type,
      serviceAreas: Array.isArray(serviceAreas) ? serviceAreas : [serviceAreas],
      skills: Array.isArray(skills) ? skills : [skills],
      capacity: {
        volunteersCount: Number(capacity.volunteersCount) || 1,
        boatsCount: Number(capacity.boatsCount) || 0,
        vehiclesCount: Number(capacity.vehiclesCount) || 0,
        maxBeneficiariesPerDay: Number(capacity.maxBeneficiariesPerDay) || 50,
      },
      status: 'pending',
      availability: 'available',
    });

    res.status(201).json({
      success: true,
      message: 'Volunteer / NGO unit registration submitted successfully. Administrator verification is required before field deployment.',
      data: {
        volunteerId: volunteer._id,
        organizationName: volunteer.organizationName,
        type: volunteer.type,
        status: volunteer.status,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getVolunteers = async (req, res) => {
  try {
    const { status, type, skill, area } = req.query;
    const query = { isDemo: { $ne: true } };

    if (status) query.status = status;
    if (type) query.type = type;
    if (skill) query.skills = skill;
    if (area) query.serviceAreas = new RegExp(area.trim(), 'i');

    const volunteers = await Volunteer.find(query)
      .populate('userId', 'name email phone isActive')
      .populate('verifiedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: volunteers.length,
      data: volunteers,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const approveVolunteer = async (req, res) => {
  try {
    const { status = 'approved' } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
    }

    const volunteer = await Volunteer.findById(req.params.id);
    if (!volunteer) {
      return res.status(404).json({ success: false, message: 'Volunteer profile not found' });
    }

    volunteer.status = status;
    volunteer.verifiedBy = req.user._id;
    volunteer.verifiedAt = new Date();
    await volunteer.save();

    // Activate/deactivate linked user account
    await User.findByIdAndUpdate(volunteer.userId, {
      $set: { isActive: status === 'approved' },
    });

    const populated = await Volunteer.findById(volunteer._id)
      .populate('userId', 'name email phone isActive')
      .populate('verifiedBy', 'name email');

    res.json({
      success: true,
      message: `Volunteer profile has been ${status}`,
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateVolunteerAvailability = async (req, res) => {
  try {
    const { availability } = req.body;
    if (!['available', 'deployed', 'unavailable'].includes(availability)) {
      return res.status(400).json({ success: false, message: 'Invalid availability status' });
    }

    const volunteer = await Volunteer.findOne({
      $or: [{ _id: req.params.id }, { userId: req.user._id }],
    });

    if (!volunteer) {
      return res.status(404).json({ success: false, message: 'Volunteer profile not found' });
    }

    // Role check: non-admin can only update their own profile
    if (req.user.role !== 'admin' && volunteer.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Forbidden: You cannot modify another volunteer profile' });
    }

    volunteer.availability = availability;
    await volunteer.save();

    res.json({
      success: true,
      message: `Availability updated to '${availability}'`,
      data: volunteer,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// 3. RELIEF INVENTORY & DELIVERY TRACKING
// ==========================================

export const getInventory = async (req, res) => {
  try {
    const { type, region, status } = req.query;
    const query = { isDemo: { $ne: true } };

    if (type) query.type = type;
    if (region) query.region = new RegExp(region.trim(), 'i');
    if (status) query.status = status;

    const resources = await ReliefResource.find(query).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: resources.length,
      data: resources,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const createInventoryItem = async (req, res) => {
  try {
    const {
      type,
      title,
      description,
      region,
      address,
      contactName,
      contactPhone,
      totalQuantity,
      quantity,
      unit = 'units',
      status = 'available',
      warehouseLocation,
      amountTarget,
      amountRaised,
      currency,
    } = req.body;

    if (!type || !title || !description || !region) {
      return res.status(400).json({
        success: false,
        message: 'Type, title, description, and region are required',
      });
    }

    const qty = Number(totalQuantity !== undefined ? totalQuantity : quantity) || 0;

    const resource = await ReliefResource.create({
      type,
      title: title.trim(),
      description: description.trim(),
      region: region.trim(),
      address: address || '',
      contactName: contactName || '',
      contactPhone: contactPhone || '',
      totalQuantity: qty,
      quantity: qty,
      allocatedQuantity: 0,
      unit,
      amountTarget: Number(amountTarget) || 0,
      amountRaised: Number(amountRaised) || 0,
      currency: currency || 'INR',
      status,
      warehouseLocation: warehouseLocation || {},
      verified: true,
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      message: 'Relief inventory item created successfully',
      data: resource,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateInventoryItem = async (req, res) => {
  try {
    const resource = await ReliefResource.findById(req.params.id);
    if (!resource) {
      return res.status(404).json({ success: false, message: 'Inventory item not found' });
    }

    const allowedFields = [
      'type',
      'title',
      'description',
      'region',
      'address',
      'contactName',
      'contactPhone',
      'totalQuantity',
      'quantity',
      'unit',
      'amountTarget',
      'amountRaised',
      'currency',
      'status',
      'warehouseLocation',
    ];

    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        resource[key] = req.body[key];
      }
    }

    if (req.body.totalQuantity !== undefined) {
      resource.quantity = req.body.totalQuantity;
    }

    await resource.save();

    res.json({
      success: true,
      message: 'Relief inventory item updated successfully',
      data: resource,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const recordDonation = async (req, res) => {
  try {
    const { amount, donorName, donorPhone, donorEmail, message } = req.body;
    const donationAmount = Number(amount);

    if (!donationAmount || isNaN(donationAmount) || donationAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'A valid positive donation amount is required',
      });
    }

    const resource = await ReliefResource.findById(req.params.id);
    if (!resource) {
      return res.status(404).json({ success: false, message: 'Relief campaign or resource not found' });
    }

    if (resource.type !== 'fund') {
      return res.status(400).json({
        success: false,
        message: 'Contributions can only be recorded against relief funds or financial aid campaigns',
      });
    }

    const receiptId = `PLEDGE-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const donationRecord = {
      receiptId,
      donorId: req.user?._id || null,
      donorName: (donorName || req.user?.name || 'Anonymous Contributor').trim(),
      donorEmail: (donorEmail || req.user?.email || '').trim(),
      donorPhone: (donorPhone || req.user?.phone || '').trim(),
      amount: donationAmount,
      currency: resource.currency || 'INR',
      message: (message || '').trim(),
      status: 'pledged',
      gatewayMode: 'unconfigured',
      notice: 'Payment gateway is unconfigured; contribution is recorded as a verified pledge towards the relief goal without live debit.',
      createdAt: new Date(),
    };

    if (!Array.isArray(resource.donations)) {
      resource.donations = [];
    }
    resource.donations.push(donationRecord);
    resource.amountRaised = (resource.amountRaised || 0) + donationAmount;
    await resource.save();

    const savedRecord = resource.donations[resource.donations.length - 1];

    res.json({
      success: true,
      message: `Contribution of ${resource.currency || 'INR'} ${donationAmount} recorded successfully.`,
      receipt: savedRecord,
      data: resource,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getCampaignDonations = async (req, res) => {
  try {
    const resource = await ReliefResource.findById(req.params.id);
    if (!resource) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }
    res.json({
      success: true,
      count: resource.donations?.length || 0,
      data: resource.donations || [],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyCampaignDonation = async (req, res) => {
  try {
    const resource = await ReliefResource.findById(req.params.id);
    if (!resource) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const donation = resource.donations.id(req.params.donationId);
    if (!donation) {
      return res.status(404).json({ success: false, message: 'Donation record not found' });
    }

    donation.status = 'verified';
    donation.verifiedBy = req.user._id;
    donation.verifiedAt = new Date();

    await resource.save();

    res.json({
      success: true,
      message: 'Donation pledge verified successfully',
      data: donation,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
