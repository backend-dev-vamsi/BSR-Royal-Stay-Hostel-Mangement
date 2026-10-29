import express from "express";
import { collectFee,getFeeSummary,getPaymentHistory} from "../controllers/feeController.js";
import { verifyAdminToken } from "../middlewares/authMiddleware.js";

const feeRouter = express.Router();

feeRouter.use(verifyAdminToken);

feeRouter.post("/collect", collectFee);
feeRouter.get("/summary", getFeeSummary);
feeRouter.get("/payments", getPaymentHistory);

export default feeRouter;