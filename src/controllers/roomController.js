
import pool from "../config/database.js";
import {
    sendErrorResponse,
    sendSuccessResponse
} from "../utils/response.js";


export const createRoom = async (req, res) => {
    const {
        building_name,
        floor,
        room_number,
        sharing_type,
        monthly_cost
    } = req.body;

    if (
        typeof building_name !== "string" ||
        !building_name.trim() ||
        typeof floor !== "string" ||
        !floor.trim() ||
        typeof room_number !== "string" ||
        !room_number.trim() ||
        sharing_type === undefined ||
        sharing_type === null ||
        sharing_type === "" ||
        !Number.isInteger(Number(sharing_type)) ||
        Number(sharing_type) < 1 ||
        Number(sharing_type) > 6 ||
        monthly_cost === undefined ||
        monthly_cost === null ||
        monthly_cost === "" ||
        !Number.isFinite(Number(monthly_cost)) ||
        Number(monthly_cost) < 0
    ) {
        return sendErrorResponse(
            res,
            400,
            "Please provide valid building and room details. Sharing must be between 1 and 6."
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const cleanBuildingName = building_name.trim().replace(/\s+/g, " ");
        const cleanFloor = floor.trim().replace(/\s+/g, " ");
        const cleanRoomNumber = room_number.trim().replace(/\s+/g, " ");

        // Find existing active building.
        const existingBuilding = await client.query(
            `SELECT building_id, building_name
             FROM tbl_buildings
             WHERE LOWER(TRIM(building_name)) = LOWER($1)
               AND status = 'ACTIVE'
             LIMIT 1
             FOR UPDATE`,
            [cleanBuildingName]
        );

        let building;

        if (existingBuilding.rowCount > 0) {
            building = existingBuilding.rows[0];
        } else {
            const buildingResult = await client.query(
                `INSERT INTO tbl_buildings (building_name)
                 VALUES ($1)
                 RETURNING building_id, building_name, status`,
                [cleanBuildingName]
            );

            building = buildingResult.rows[0];
        }

        // Check duplicate room number in the same building.
        const existingRoom = await client.query(
            `SELECT room_id, room_number
             FROM tbl_rooms
             WHERE building_id = $1
               AND LOWER(TRIM(room_number)) = LOWER($2)
             LIMIT 1`,
            [building.building_id, cleanRoomNumber]
        );

        if (existingRoom.rowCount > 0) {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                409,
                `Room ${cleanRoomNumber} already exists in ${building.building_name}.`
            );
        }

        // Insert room.
        const roomResult = await client.query(
            `INSERT INTO tbl_rooms (
                building_id,
                floor,
                room_number,
                sharing_type,
                monthly_cost
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *`,
            [
                building.building_id,
                cleanFloor,
                cleanRoomNumber,
                Number(sharing_type),
                Number(monthly_cost)
            ]
        );

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            201,
            "Building and room saved successfully",
            {
                building,
                room: roomResult.rows[0]
            }
        );

    } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
            return sendErrorResponse(
                res,
                409,
                "This room number already exists in the selected building."
            );
        }

        if (error.code === "23503") {
            return sendErrorResponse(
                res,
                400,
                "Invalid building reference"
            );
        }

        console.error("Create room error:", error.message);

        return sendErrorResponse(
            res,
            500,
            "Internal server error"
        );

    } finally {
        client.release();
    }
};


export const getBuildings = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT building_id, building_name, status,
                    created_at, updated_at
             FROM tbl_buildings
             ORDER BY building_id DESC`
        );

        return sendSuccessResponse(
            res,
            200,
            "Buildings fetched successfully",
            result.rows
        );
    } catch (error) {
        console.error("Get buildings error:", error.message);

        return sendErrorResponse(
            res,
            500,
            "Internal server error"
        );
    }
};

export const getAllRooms = async (req, res) => {
    try {
        const result = await pool.query(`
            WITH room_data AS (
                SELECT
                    r.room_id,
                    b.building_id,
                    b.building_name,
                    r.floor,
                    r.room_number,
                    r.sharing_type,
                    r.monthly_cost,
                    r.status,
                    r.beds_filled,
                    GREATEST(
                        r.sharing_type - r.beds_filled,
                        0
                    ) AS vacant_beds,
                    r.created_at,
                    r.updated_at,
                    CASE
                        WHEN r.status = 'MAINTENANCE'
                            THEN 'Maintenance'
                        WHEN r.status = 'INACTIVE'
                            THEN 'Inactive'
                        WHEN r.beds_filled >= r.sharing_type
                            THEN 'Full'
                        WHEN r.beds_filled = 0
                            THEN 'Vacant'
                        ELSE
                            GREATEST(
                                r.sharing_type - r.beds_filled,
                                0
                            ) || ' bed(s) free'
                    END AS occupancy_status
                FROM tbl_rooms r
                JOIN tbl_buildings b
                    ON b.building_id = r.building_id
            ),

            summary AS (
                SELECT
                    (
                        SELECT COUNT(*)::INTEGER
                        FROM tbl_buildings
                        WHERE status = 'ACTIVE'
                    ) AS total_buildings,

                    (
                        SELECT COUNT(*)::INTEGER
                        FROM tbl_rooms
                        WHERE status = 'ACTIVE'
                    ) AS total_rooms,

                    (
                        SELECT COALESCE(
                            SUM(sharing_type), 0
                        )::INTEGER
                        FROM tbl_rooms
                        WHERE status = 'ACTIVE'
                    ) AS total_beds,

                    (
                        SELECT COALESCE(
                            SUM(beds_filled), 0
                        )::INTEGER
                        FROM tbl_rooms
                        WHERE status = 'ACTIVE'
                    ) AS occupied_beds,

                    (
                        SELECT COALESCE(
                            SUM(
                                GREATEST(
                                    sharing_type - beds_filled,
                                    0
                                )
                            ), 0
                        )::INTEGER
                        FROM tbl_rooms
                        WHERE status = 'ACTIVE'
                    ) AS vacant_beds
            )

            SELECT
                (SELECT row_to_json(summary)
                 FROM summary) AS summary,

                COALESCE(
                    (
                        SELECT json_agg(
                            row_to_json(rooms)
                            ORDER BY
                                rooms.building_name,
                                rooms.room_id DESC
                        )
                        FROM room_data rooms
                    ),
                    '[]'::JSON
                ) AS rooms
        `);

        const data = result.rows[0];

        return sendSuccessResponse(
            res,
            200,
            "Rooms and summary fetched successfully",
            {
                summary: data.summary,
                rooms: data.rooms
            }
        );
    } catch (error) {
        console.error("Get rooms error:", error.message);

        return sendErrorResponse(
            res,
            500,
            "Internal server error"
        );
    }
};


export const getRoomById = async (req, res) => {
    try {
        const { roomId } = req.params;

        if (!/^[1-9]\d*$/.test(roomId)) {
            return sendErrorResponse(
                res,
                400,
                "Invalid room ID"
            );
        }

        const result = await pool.query(
            `SELECT
                r.room_id,
                r.building_id,
                b.building_name,
                r.floor,
                r.room_number,
                r.sharing_type,
                r.monthly_cost,
                r.status,
                r.created_at,
                r.updated_at,
                COUNT(a.allocation_id)::INTEGER AS beds_filled,
                GREATEST(
                    r.sharing_type -
                    COUNT(a.allocation_id)::INTEGER,
                    0
                ) AS vacant_beds
             FROM tbl_rooms r
             JOIN tbl_buildings b
                ON b.building_id = r.building_id
             LEFT JOIN tbl_room_allocations a
                ON a.room_id = r.room_id
                AND a.status = 'ACTIVE'
             WHERE r.room_id = $1
             GROUP BY r.room_id, b.building_name`,
            [Number(roomId)]
        );

        if (result.rowCount === 0) {
            return sendErrorResponse(
                res,
                404,
                "Room not found"
            );
        }

        return sendSuccessResponse(
            res,
            200,
            "Room fetched successfully",
            result.rows[0]
        );
    } catch (error) {
        console.error("Get room by ID error:", error.message);

        return sendErrorResponse(
            res,
            500,
            "Internal server error"
        );
    }
};

export const updateRoom = async (req, res) => {
    try {
        const { roomId } = req.params;

        if (!/^[1-9]\d*$/.test(roomId)) {
            return sendErrorResponse(
                res,
                400,
                "Invalid room ID"
            );
        }

        const allowedFields = {
            building_id: value =>
                value !== "" &&
                Number.isInteger(Number(value)) &&
                Number(value) > 0
                    ? Number(value)
                    : undefined,

            floor: value =>
                typeof value === "string" && value.trim()
                    ? value.trim()
                    : undefined,

            room_number: value =>
                typeof value === "string" && value.trim()
                    ? value.trim()
                    : undefined,

            sharing_type: value =>
                value !== "" &&
                Number.isInteger(Number(value)) &&
                Number(value) >= 1 &&
                Number(value) <= 6
                    ? Number(value)
                    : undefined,

            monthly_cost: value =>
                value !== "" &&
                value !== null &&
                value !== undefined &&
                Number.isFinite(Number(value)) &&
                Number(value) >= 0
                    ? Number(value)
                    : undefined,

            status: value =>
                ["ACTIVE", "MAINTENANCE", "INACTIVE"].includes(value)
                    ? value
                    : undefined
        };

        const fields = Object.keys(req.body);

        if (fields.length === 0) {
            return sendErrorResponse(
                res,
                400,
                "Provide at least one field to update"
            );
        }

        const updates = [];
        const values = [];

        for (const field of fields) {
            if (!Object.hasOwn(allowedFields, field)) {
                return sendErrorResponse(
                    res,
                    400,
                    `Unsupported field: ${field}`
                );
            }

            const normalized = allowedFields[field](req.body[field]);

            if (normalized === undefined) {
                return sendErrorResponse(
                    res,
                    400,
                    `Invalid value for ${field}`
                );
            }

            updates.push(`${field} = $${values.length + 1}`);
            values.push(normalized);
        }

        const currentRoom = await pool.query(
            `SELECT room_id, sharing_type, status
             FROM tbl_rooms
             WHERE room_id = $1`,
            [Number(roomId)]
        );

        if (currentRoom.rowCount === 0) {
            return sendErrorResponse(
                res,
                404,
                "Room not found"
            );
        }

        // Validate a new building ID, if supplied.
        if (req.body.building_id !== undefined) {
            const building = await pool.query(
                `SELECT building_id
                 FROM tbl_buildings
                 WHERE building_id = $1
                   AND status = 'ACTIVE'`,
                [Number(req.body.building_id)]
            );

            if (building.rowCount === 0) {
                return sendErrorResponse(
                    res,
                    400,
                    "Invalid or inactive building"
                );
            }
        }

        // Prevent capacity from falling below occupied beds.
        if (req.body.sharing_type !== undefined) {
            const occupancy = await pool.query(
                `SELECT COUNT(*)::INTEGER AS filled
                 FROM tbl_room_allocations
                 WHERE room_id = $1
                   AND status = 'ACTIVE'`,
                [Number(roomId)]
            );

            if (
                Number(req.body.sharing_type) <
                occupancy.rows[0].filled
            ) {
                return sendErrorResponse(
                    res,
                    409,
                    "Sharing type cannot be less than occupied beds"
                );
            }
        }

        // Do not deactivate a room that has active occupants.
        if (
            req.body.status !== undefined &&
            req.body.status !== "ACTIVE"
        ) {
            const occupancy = await pool.query(
                `SELECT COUNT(*)::INTEGER AS filled
                 FROM tbl_room_allocations
                 WHERE room_id = $1
                   AND status = 'ACTIVE'`,
                [Number(roomId)]
            );

            if (occupancy.rows[0].filled > 0) {
                return sendErrorResponse(
                    res,
                    409,
                    "Room with active hostellers cannot be deactivated or placed under maintenance"
                );
            }
        }

        updates.push("updated_at = CURRENT_TIMESTAMP");
        values.push(Number(roomId));

        const result = await pool.query(
            `UPDATE tbl_rooms
             SET ${updates.join(", ")}
             WHERE room_id = $${values.length}
             RETURNING *`,
            values
        );

        return sendSuccessResponse(
            res,
            200,
            "Room updated successfully",
            result.rows[0]
        );
    } catch (error) {
        if (error.code === "23505") {
            return sendErrorResponse(
                res,
                409,
                "Room number already exists in this building"
            );
        }

        if (error.code === "23503") {
            return sendErrorResponse(
                res,
                400,
                "Invalid building ID"
            );
        }

        console.error("Update room error:", error.message);

        return sendErrorResponse(
            res,
            500,
            "Internal server error"
        );
    }
};

export const deleteRoom = async (req, res) => {
    try {
        const { roomId } = req.params;

        if (!/^[1-9]\d*$/.test(roomId)) {
            return sendErrorResponse(
                res,
                400,
                "Invalid room ID"
            );
        }

        const room = await pool.query(
            `SELECT room_id
             FROM tbl_rooms
             WHERE room_id = $1`,
            [Number(roomId)]
        );

        if (room.rowCount === 0) {
            return sendErrorResponse(
                res,
                404,
                "Room not found"
            );
        }

        const occupancy = await pool.query(
            `SELECT COUNT(*)::INTEGER AS filled
             FROM tbl_room_allocations
             WHERE room_id = $1
               AND status = 'ACTIVE'`,
            [Number(roomId)]
        );

        if (occupancy.rows[0].filled > 0) {
            return sendErrorResponse(
                res,
                409,
                "Room has active hostellers and cannot be deleted"
            );
        }

        await pool.query(
            `DELETE FROM tbl_rooms
             WHERE room_id = $1`,
            [Number(roomId)]
        );

        return sendSuccessResponse(
            res,
            200,
            "Room deleted successfully"
        );
    } catch (error) {
        if (error.code === "23503") {
            return sendErrorResponse(
                res,
                409,
                "Room is linked to other records and cannot be deleted"
            );
        }

        console.error("Delete room error:", error.message);

        return sendErrorResponse(
            res,
            500,
            "Internal server error"
        );
    }
};

export const getRoomSummary = async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                (
                    SELECT COUNT(*)::INTEGER
                    FROM tbl_buildings
                    WHERE status = 'ACTIVE'
                ) AS total_buildings,

                (
                    SELECT COUNT(*)::INTEGER
                    FROM tbl_rooms
                    WHERE status = 'ACTIVE'
                ) AS total_rooms,

                (
                    SELECT COALESCE(SUM(sharing_type), 0)::INTEGER
                    FROM tbl_rooms
                    WHERE status = 'ACTIVE'
                ) AS total_beds,

                (
                    SELECT COALESCE(
                        SUM(
                            GREATEST(
                                r.sharing_type -
                                COALESCE(occupied.filled, 0),
                                0
                            )
                        ),
                        0
                    )::INTEGER
                    FROM tbl_rooms r
                    LEFT JOIN (
                        SELECT
                            room_id,
                            COUNT(*)::INTEGER AS filled
                        FROM tbl_room_allocations
                        WHERE status = 'ACTIVE'
                        GROUP BY room_id
                    ) occupied
                        ON occupied.room_id = r.room_id
                    WHERE r.status = 'ACTIVE'
                ) AS vacant_beds
        `);

        return sendSuccessResponse(
            res,
            200,
            "Room summary fetched successfully",
            result.rows[0]
        );
    } catch (error) {
        console.error("Room summary error:", error.message);

        return sendErrorResponse(
            res,
            500,
            "Internal server error"
        );
    }
};

export const getBuildingById = async (req, res) => {
    const { buildingId } = req.params;

    try {
        if (!/^\d+$/.test(buildingId) || Number(buildingId) <= 0) {
            return sendErrorResponse(res, 400, "Invalid building ID");
        }

        const result = await pool.query(
            `SELECT building_id, building_name, status, created_at, updated_at
             FROM tbl_buildings
             WHERE building_id = $1`,
            [buildingId]
        );

        if (result.rows.length === 0) {
            return sendErrorResponse(res, 404, "Building not found");
        }

        return sendSuccessResponse(
            res,
            200,
            "Building fetched successfully",
            result.rows[0]
        );
    } catch (error) {
        console.error("Get building by ID error:", error.message);
        return sendErrorResponse(res, 500, "Failed to fetch building");
    }
};

export const updateBuildingById = async (req, res) => {
    const { buildingId } = req.params;
    const { building_name, status } = req.body;

    try {
        if (!/^\d+$/.test(buildingId) || Number(buildingId) <= 0) {
            return sendErrorResponse(res, 400, "Invalid building ID");
        }

        if (building_name === undefined && status === undefined) {
            return sendErrorResponse(
                res,
                400,
                "Provide building_name or status to update"
            );
        }

        if (
            building_name !== undefined &&
            (typeof building_name !== "string" || !building_name.trim())
        ) {
            return sendErrorResponse(res, 400, "Building name cannot be empty");
        }

        if (
            building_name !== undefined &&
            building_name.trim().length > 150
        ) {
            return sendErrorResponse(
                res,
                400,
                "Building name cannot exceed 150 characters"
            );
        }

        if (
            status !== undefined &&
            !["ACTIVE", "INACTIVE"].includes(status)
        ) {
            return sendErrorResponse(
                res,
                400,
                "Status must be ACTIVE or INACTIVE"
            );
        }

        const existingBuilding = await pool.query(
            `SELECT building_id
             FROM tbl_buildings
             WHERE building_id = $1`,
            [buildingId]
        );

        if (existingBuilding.rows.length === 0) {
            return sendErrorResponse(res, 404, "Building not found");
        }

        if (building_name !== undefined) {
            const duplicateBuilding = await pool.query(
                `SELECT building_id
                 FROM tbl_buildings
                 WHERE LOWER(building_name) = LOWER($1)
                   AND building_id <> $2`,
                [building_name.trim(), buildingId]
            );

            if (duplicateBuilding.rows.length > 0) {
                return sendErrorResponse(
                    res,
                    409,
                    "Building name already exists"
                );
            }
        }

        if (status === "INACTIVE") {
            const activeRooms = await pool.query(
                `SELECT room_id
                 FROM tbl_rooms
                 WHERE building_id = $1
                   AND status = 'ACTIVE'
                 LIMIT 1`,
                [buildingId]
            );

            if (activeRooms.rows.length > 0) {
                return sendErrorResponse(
                    res,
                    400,
                    "Cannot deactivate building while it has active rooms"
                );
            }
        }

        const updateFields = [];
        const values = [];
        let index = 1;

        if (building_name !== undefined) {
            updateFields.push(`building_name = $${index++}`);
            values.push(building_name.trim());
        }

        if (status !== undefined) {
            updateFields.push(`status = $${index++}`);
            values.push(status);
        }

        updateFields.push("updated_at = CURRENT_TIMESTAMP");
        values.push(buildingId);

        const result = await pool.query(
            `UPDATE tbl_buildings
             SET ${updateFields.join(", ")}
             WHERE building_id = $${index}
             RETURNING building_id, building_name, status, created_at, updated_at`,
            values
        );

        return sendSuccessResponse(
            res,
            200,
            "Building updated successfully",
            result.rows[0]
        );
    } catch (error) {
        console.error("Update building error:", error.message);
        return sendErrorResponse(res, 500, "Failed to update building");
    }
};

export const deleteBuildingById = async (req, res) => {
    const { buildingId } = req.params;

    try {
        if (!/^\d+$/.test(buildingId) || Number(buildingId) <= 0) {
            return sendErrorResponse(res, 400, "Invalid building ID");
        }

        const existingBuilding = await pool.query(
            `SELECT building_id, building_name
             FROM tbl_buildings
             WHERE building_id = $1`,
            [buildingId]
        );

        if (existingBuilding.rows.length === 0) {
            return sendErrorResponse(res, 404, "Building not found");
        }

        const rooms = await pool.query(
            `SELECT room_id
             FROM tbl_rooms
             WHERE building_id = $1
             LIMIT 1`,
            [buildingId]
        );

        if (rooms.rows.length > 0) {
            return sendErrorResponse(
                res,
                400,
                "Cannot delete building because rooms are assigned to it"
            );
        }

        const result = await pool.query(
            `DELETE FROM tbl_buildings
             WHERE building_id = $1
             RETURNING building_id, building_name`,
            [buildingId]
        );

        return sendSuccessResponse(
            res,
            200,
            "Building deleted successfully",
            result.rows[0]
        );
    } catch (error) {
        console.error("Delete building error:", error.message);
        return sendErrorResponse(res, 500, "Failed to delete building");
    }
};
