import express from "express";

import {
    createHosteller,
    getAllHostellers,
    getHostellerById,
    updateHosteller,
    vacateHosteller,
    getHostellerAllocationHistory,
    deleteHosteller
} from "../controllers/hostellerController.js";

import { verifyAdminToken } from "../middlewares/authMiddleware.js";

const hostellerRouter = express.Router();

hostellerRouter.use(verifyAdminToken);

hostellerRouter.post("/", createHosteller);
hostellerRouter.get("/", getAllHostellers);

// Register specific paths before /:hostellerId.
hostellerRouter.get(
    "/:hostellerId/allocations",
    getHostellerAllocationHistory
);


hostellerRouter.patch(
    "/:hostellerId/vacate",
    vacateHosteller
);

hostellerRouter.get("/:hostellerId", getHostellerById);
hostellerRouter.put("/:hostellerId", updateHosteller);
hostellerRouter.delete("/:hostellerId", deleteHosteller);

export default hostellerRouter;