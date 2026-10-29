

import express from "express";
import {
    createRoom,
    getBuildings,
    getBuildingById,
    updateBuildingById,
    deleteBuildingById,
    getAllRooms,
    getRoomById,
    updateRoom,
    deleteRoom,
    getRoomSummary
} from "../controllers/roomController.js";
import { verifyAdminToken } from "../middlewares/authMiddleware.js";

const roomRouter = express.Router();

roomRouter.use(verifyAdminToken);

roomRouter.get("/summary", getRoomSummary);

roomRouter.get("/buildings", getBuildings);
roomRouter.get("/buildings/:buildingId", getBuildingById);
roomRouter.put("/buildings/:buildingId", updateBuildingById);
roomRouter.delete("/buildings/:buildingId", deleteBuildingById);

roomRouter.post("/rooms", createRoom);
roomRouter.get("/rooms", getAllRooms);
roomRouter.get("/rooms/:roomId", getRoomById);
roomRouter.put("/rooms/:roomId", updateRoom);
roomRouter.delete("/rooms/:roomId", deleteRoom);

export default roomRouter;

