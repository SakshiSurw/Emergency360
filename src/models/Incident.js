import mongoose from 'mongoose';

const statusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      required: true,
      enum: [
        'Pending',
        'Verified',
        'Assigned',
        'Accepted',
        'En Route',
        'Arrived',
        'Resolved',
        'Cancelled',
      ],
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      default: '',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { _id: false }
);

const contactNotificationSchema = new mongoose.Schema(
  {
    recipientName: { type: String, default: '' },
    recipientPhone: { type: String, default: '' },
    channel: { type: String, enum: ['sms', 'whatsapp', 'email'], default: 'sms' },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'not_configured', 'failed', 'retried'],
      default: 'pending',
    },
    messageId: { type: String, default: null },
    sentAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { _id: true }
);

const nearbyFacilitySchema = new mongoose.Schema(
  {
    facilityType: {
      type: String,
      enum: ['hospital', 'police_station', 'fire_station'],
      required: true,
    },
    name: { type: String, required: true },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    distanceKm: { type: Number, default: null },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
  },
  { _id: false }
);

const incidentSchema = new mongoose.Schema(
  {
    clientRequestId: { type: String, trim: true, maxlength: 100 },
    trustedContactSms: {
      type: String,
      enum: ['not_configured', 'no_contact', 'accepted', 'failed', 'unknown'],
      default: 'unknown',
    },
    citizenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category: {
      type: String,
      enum: [
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
      ],
      required: [true, 'Emergency category is required'],
    },
    affectedCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    categoryDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    description: {
      type: String,
      trim: true,
      default: 'Emergency SOS reported by citizen',
    },
    location: {
      latitude: {
        type: Number,
        required: [true, 'Latitude is required'],
        min: -90,
        max: 90,
      },
      longitude: {
        type: Number,
        required: [true, 'Longitude is required'],
        min: -180,
        max: 180,
      },
      address: {
        type: String,
        default: 'Location via GPS',
      },
      accuracy: {
        type: Number,
        default: null,
      },
      isApproximate: {
        type: Boolean,
        default: false,
      },
      isManual: {
        type: Boolean,
        default: false,
      },
      acquiredAt: {
        type: Date,
        default: Date.now,
      },
    },
    // Personal Emergency Network: Live location sharing expiration
    locationSharingExpiresAt: {
      type: Date,
      default: null,
    },
    // Consent-based Live Location Session
    trackingToken: {
      type: String,
      trim: true,
      default: null,
    },
    isLiveTrackingActive: {
      type: Boolean,
      default: true,
    },
    trackingExpiresAt: {
      type: Date,
      default: null,
    },
    liveLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      heading: { type: Number, default: null },
      speed: { type: Number, default: null },
      updatedAt: { type: Date, default: null },
    },
    lastLocationUpdate: {
      type: Date,
      default: null,
    },
    // Audit of contact notification deliveries (multi-contact delivery log)
    contactNotifications: {
      type: [contactNotificationSchema],
      default: [],
    },
    // Computed nearby emergency services (hospitals, police stations)
    nearbyEmergencyFacilities: {
      type: [nearbyFacilitySchema],
      default: [],
    },
    isDemo: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: [
        'Pending',
        'Verified',
        'Assigned',
        'Accepted',
        'En Route',
        'Arrived',
        'Resolved',
        'Cancelled',
      ],
      default: 'Pending',
    },
    priority: {
      type: String,
      enum: ['Low', 'Medium', 'High', 'Critical'],
      default: 'High',
    },
    assignedResponderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Responder',
      default: null,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      default: null,
    },
    intake: {
      status: {
        type: String,
        enum: ['Pending', 'Admitted_ER', 'Admitted_ICU', 'Treated_and_Released', 'Transferred'],
        default: 'Pending',
      },
      bedType: {
        type: String,
        enum: ['General', 'ICU', 'None'],
        default: 'None',
      },
      admittedAt: { type: Date, default: null },
      notes: { type: String, default: '' },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    isEscalated: {
      type: Boolean,
      default: false,
    },
    escalatedAt: {
      type: Date,
      default: null,
    },
    escalationReason: {
      type: String,
      default: '',
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    statusHistory: [statusHistorySchema],
  },
  {
    timestamps: true,
  }
);

incidentSchema.index({ status: 1, category: 1, createdAt: -1 });
incidentSchema.index({ status: 1, assignedAt: 1, isEscalated: 1 });
incidentSchema.index({ citizenId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
incidentSchema.index({ trackingToken: 1 }, { unique: true, sparse: true, partialFilterExpression: { trackingToken: { $type: 'string' } } });

const Incident = mongoose.model('Incident', incidentSchema);
export default Incident;
