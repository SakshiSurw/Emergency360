import mongoose from 'mongoose';

const statusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      required: true,
      enum: ['Submitted', 'Verified', 'Assigned', 'In Transit', 'Delivered', 'Cancelled'],
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

const deliveryRecordSchema = new mongoose.Schema(
  {
    deliveredAt: {
      type: Date,
      default: null,
    },
    deliveredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    notes: {
      type: String,
      default: '',
    },
    recipientAcknowledged: {
      type: Boolean,
      default: false,
    },
    confirmationCode: {
      type: String,
      default: null,
    },
  },
  { _id: false }
);

const reliefRequestSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      unique: true,
      index: true,
    },
    clientRequestId: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    citizenId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    incidentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Incident',
      default: null,
    },
    category: {
      type: String,
      required: [true, 'Relief category is required'],
      enum: [
        'rescue',
        'evacuation',
        'food',
        'drinking_water',
        'medicines',
        'shelter',
        'clothing',
        'transport',
      ],
      index: true,
    },
    urgency: {
      type: String,
      enum: ['Low', 'Medium', 'High', 'Critical'],
      default: 'High',
    },
    affectedPeople: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    affectedFamilies: {
      type: Number,
      min: 0,
      default: 0,
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
        required: [true, 'Address or landmark is required'],
      },
      district: {
        type: String,
        default: '',
      },
      landmark: {
        type: String,
        default: '',
      },
    },
    specificNeeds: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['Submitted', 'Verified', 'Assigned', 'In Transit', 'Delivered', 'Cancelled'],
      default: 'Submitted',
      index: true,
    },
    assignedVolunteerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Volunteer',
      default: null,
    },
    assignedResourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReliefResource',
      default: null,
    },
    allocatedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    deliveryRecord: {
      type: deliveryRecordSchema,
      default: () => ({}),
    },
    statusHistory: [statusHistorySchema],
    isDemo: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

reliefRequestSchema.index({ status: 1, category: 1, createdAt: -1 });
reliefRequestSchema.index({ citizenId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });

const ReliefRequest = mongoose.model('ReliefRequest', reliefRequestSchema);
export default ReliefRequest;
