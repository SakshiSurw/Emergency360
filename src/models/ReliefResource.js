import mongoose from 'mongoose';

const resourceDeliverySchema = new mongoose.Schema(
  {
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReliefRequest',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ['dispatched', 'delivered', 'returned'],
      default: 'dispatched',
    },
    dispatchedAt: {
      type: Date,
      default: Date.now,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    dispatchedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  { _id: true }
);

const campaignDonationSchema = new mongoose.Schema(
  {
    receiptId: {
      type: String,
      required: true,
      index: true,
    },
    donorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    donorName: {
      type: String,
      default: 'Anonymous Contributor',
      trim: true,
    },
    donorEmail: {
      type: String,
      default: '',
      trim: true,
    },
    donorPhone: {
      type: String,
      default: '',
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    currency: {
      type: String,
      default: 'INR',
    },
    message: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pledged', 'verified', 'cancelled'],
      default: 'pledged',
    },
    gatewayMode: {
      type: String,
      enum: ['unconfigured', 'simulated_pledge'],
      default: 'unconfigured',
    },
    notice: {
      type: String,
      default: 'Payment gateway is unconfigured; contribution is recorded as a verified pledge towards the relief goal without live debit.',
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
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const reliefResourceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'disaster-alert',
        'food',
        'water',
        'drinking_water',
        'shelter',
        'fund',
        'medical-supply',
        'clothing',
        'transport-vehicle',
        'rescue-equipment',
        'volunteer',
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    region: { type: String, required: true, index: true },
    address: { type: String, default: '' },
    contactName: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    quantity: { type: Number, min: 0, default: 0 },
    totalQuantity: { type: Number, min: 0, default: 0 },
    allocatedQuantity: { type: Number, min: 0, default: 0 },
    unit: { type: String, default: 'units' },
    amountTarget: { type: Number, min: 0, default: 0 },
    amountRaised: { type: Number, min: 0, default: 0 },
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: [
        'active',
        'limited',
        'closed',
        'resolved',
        'available',
        'low_stock',
        'exhausted',
        'reserved',
      ],
      default: 'active',
      index: true,
    },
    warehouseLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      address: { type: String, default: '' },
    },
    deliveries: [resourceDeliverySchema],
    donations: [campaignDonationSchema],
    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date, default: null },
    verified: { type: Boolean, default: true },
    isDemo: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

reliefResourceSchema.virtual('availableQuantity').get(function () {
  const total = this.totalQuantity || this.quantity || 0;
  const allocated = this.allocatedQuantity || 0;
  return Math.max(0, total - allocated);
});

// Pre-save hook to keep quantity and totalQuantity in sync
reliefResourceSchema.pre('save', function (next) {
  if (this.totalQuantity === 0 && this.quantity > 0) {
    this.totalQuantity = this.quantity;
  } else if (this.quantity === 0 && this.totalQuantity > 0) {
    this.quantity = this.totalQuantity;
  }
  next();
});

const ReliefResource = mongoose.model('ReliefResource', reliefResourceSchema);
export default ReliefResource;
