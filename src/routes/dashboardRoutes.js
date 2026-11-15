import express from 'express';
import {
  getDashboardSummary,
  getDashboardIncidents,
  getResponseReports,
  getPublicStats,
} from '../controllers/dashboardController.js';
import { protect } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';

const router = express.Router();

// Public endpoint for landing page
router.get('/public-stats', getPublicStats);

// Protected dashboard routes
router.use(protect);

router.get('/summary', authorize('admin', 'hospital', 'responder'), getDashboardSummary);
router.get('/incidents', authorize('admin'), getDashboardIncidents);
router.get('/response-reports', authorize('admin'), getResponseReports);

export default router;
