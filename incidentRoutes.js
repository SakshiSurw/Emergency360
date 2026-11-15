import express from 'express';
import { body } from 'express-validator';
import {
  createIncident,
  getAllIncidents,
  getMyIncidents,
  getIncidentById,
  verifyIncident,
  getNearestResponders,
  triggerEscalationCheck,
  assignIncident,
  updateIncidentStatus,
  cancelIncident,
  retryContactNotification,
  getLiveTrackingByToken,
  updateLiveLocationByToken,
  updateLiveLocation,
  stopLiveTracking,
  exportIncidentHistoryCsv,
  ALL_EMERGENCY_CATEGORIES,
} from '../controllers/incidentController.js';
import { protect } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';
import { validateRequest } from '../middleware/validateRequest.js';

const router = express.Router();

// Public Tokenized Live Tracking Endpoints (Secured by unguessable 48-char random session token)
router.get('/tracking/:token', getLiveTrackingByToken);
router.patch('/tracking/:token', updateLiveLocationByToken);

// All subsequent routes require JWT authentication
router.use(protect);

router.post(
  '/',
  authorize('citizen', 'admin'),
  [
    body('category')
      .isIn(ALL_EMERGENCY_CATEGORIES)
      .withMessage(`Category must be one of: ${ALL_EMERGENCY_CATEGORIES.join(', ')}`),
    body('location.latitude').isNumeric().withMessage('Valid latitude is required'),
    body('location.longitude').isNumeric().withMessage('Valid longitude is required'),
    body('affectedCount').optional().isInt({ min: 1 }).withMessage('Affected count must be at least 1'),
    body('categoryDetails').optional().isObject().withMessage('Category details must be an object'),
  ],
  validateRequest,
  createIncident
);

router.get('/my', authorize('citizen'), getMyIncidents);
router.get('/export/csv', authorize('admin', 'responder'), exportIncidentHistoryCsv);
router.get('/', authorize('admin', 'responder'), getAllIncidents);
router.get('/:id', getIncidentById);

router.patch('/:id/verify', authorize('admin'), verifyIncident);
router.post('/check-escalations', authorize('admin'), triggerEscalationCheck);
router.get('/:id/nearest-responders', authorize('admin'), getNearestResponders);
router.patch('/:id/assign', authorize('admin'), assignIncident);
router.patch('/:id/status', authorize('responder', 'admin'), updateIncidentStatus);
router.patch('/:id/cancel', authorize('citizen', 'admin'), cancelIncident);
router.post('/:id/retry-notification', authorize('citizen', 'admin'), retryContactNotification);
router.patch('/:id/live-location', authorize('citizen', 'admin'), updateLiveLocation);
router.patch('/:id/stop-tracking', authorize('citizen', 'admin'), stopLiveTracking);

export default router;
