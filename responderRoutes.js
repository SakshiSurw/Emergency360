import express from 'express';
import {
  getAllResponders,
  getAvailableResponders,
  getMyAssignments,
  updateAvailability,
  updateLocation,
} from '../controllers/responderController.js';
import { protect } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/', authorize('admin'), getAllResponders);
router.get('/available', authorize('admin'), getAvailableResponders);
router.get('/my-assignments', authorize('responder'), getMyAssignments);
router.patch('/availability', authorize('responder'), updateAvailability);
router.patch('/location', authorize('responder'), updateLocation);

export default router;
