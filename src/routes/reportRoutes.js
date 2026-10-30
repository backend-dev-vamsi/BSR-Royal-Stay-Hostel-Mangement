
import express from "express";

import {
    getReportController,
} from "../controllers/reportController.js";

import { verifyAdminToken } from "../middlewares/authMiddleware.js";

const reportRouter = express.Router();

reportRouter.use(verifyAdminToken);

reportRouter.get("/", getReportController);

export default reportRouter;
