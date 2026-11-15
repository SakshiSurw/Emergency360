import express from 'express';
import {
  createReliefRequest,
  getReliefRequests,
  getReliefRequestById,
  verifyReliefRequest,
  assignReliefRequest,
  updateReliefRequestStatus,
  registerVolunteer,
  getVolunteers,
  approveVolunteer,
  updateVolunteerAvailability,
  getInventory,
  createInventoryItem,
  updateInventoryItem,
  recordDonation,
  getCampaignDonations,
  verifyCampaignDonation,
} from '../controllers/reliefController.js';
import { protect } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';

const router = express.Router();

// ==========================================
// PUBLIC & CITIZEN ROUTES
// ==========================================

// Public volunteer / NGO registration
router.post('/volunteers/register', registerVolunteer);

// Public inventory & distribution centers view (also supports legacy /)
router.get('/inventory', getInventory);
router.get('/', getInventory);

// Record a donation or pledge to a relief fund
router.post('/inventory/:id/donate', recordDonation);
router.post('/:id/donate', recordDonation);

// View donation history for a relief campaign
router.get('/inventory/:id/donations', getCampaignDonations);
router.get('/:id/donations', getCampaignDonations);

// ==========================================
// PROTECTED ROUTES (CITIZEN / VOLUNTEER / ADMIN)
// ==========================================
router.use(protect);

// Relief Requests (Citizen submits, Admin/Volunteer manages)
router.post('/requests', authorize('citizen', 'admin'), createReliefRequest);
router.get('/requests', authorize('citizen', 'admin', 'volunteer'), getReliefRequests);
router.get('/requests/:id', authorize('citizen', 'admin', 'volunteer'), getReliefRequestById);

// Verification and Assignment (Admin & Field Coordinators)
router.patch('/requests/:id/verify', authorize('admin'), verifyReliefRequest);
router.patch('/requests/:id/assign', authorize('admin'), assignReliefRequest);
router.patch('/requests/:id/status', authorize('admin', 'volunteer', 'citizen'), updateReliefRequestStatus);

// Volunteer & NGO Management (Admin only)
router.get('/volunteers', authorize('admin'), getVolunteers);
router.patch('/volunteers/:id/approve', authorize('admin'), approveVolunteer);
router.patch('/volunteers/:id/availability', authorize('volunteer', 'admin'), updateVolunteerAvailability);

// Inventory Management (Admin only, with legacy fallback)
router.post('/inventory', authorize('admin'), createInventoryItem);
router.patch('/inventory/:id', authorize('admin'), updateInventoryItem);
router.post('/', authorize('admin'), createInventoryItem);
router.patch('/:id', authorize('admin'), updateInventoryItem);

// Donation Verification (Admin only)
router.patch('/inventory/:id/donations/:donationId/verify', authorize('admin'), verifyCampaignDonation);
router.patch('/:id/donations/:donationId/verify', authorize('admin'), verifyCampaignDonation);

export default router;
