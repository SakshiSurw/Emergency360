import express from 'express';
import {
  getAllHospitals,
  getMyHospital,
  getHospitalById,
  createHospital,
  verifyHospital,
  updateHospitalAvailability,
  getHospitalIntakes,
  updatePatientIntake,
} from '../controllers/hospitalController.js';
import { protect } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';

const router = express.Router();

router.get('/', getAllHospitals);
router.get('/my-hospital', protect, authorize('hospital'), getMyHospital);
router.get('/intakes', protect, authorize('hospital', 'admin'), getHospitalIntakes);
router.patch('/intakes/:id', protect, authorize('hospital', 'admin'), updatePatientIntake);
router.get('/:id', getHospitalById);

router.post('/', protect, authorize('admin'), createHospital);
router.patch('/:id/verify', protect, authorize('admin'), verifyHospital);
router.patch('/:id/availability', protect, authorize('hospital', 'admin'), updateHospitalAvailability);

export default router;