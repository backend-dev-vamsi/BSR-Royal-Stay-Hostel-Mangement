import pool from "../config/database.js";
import {
    sendErrorResponse,
    sendSuccessResponse
} from "../utils/response.js";

const PHONE_REGEX = /^\d{10}$/;
const AADHAR_REGEX = /^\d{12}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const FEE_PLANS = ["Monthly", "Weekly", "Day-wise"];
const HOSTELLER_STATUSES = ["Staying", "Vacated"];  

const VACATING_REASONS = [
    "Course completed",
    "Job/relocation",
    "Shifted to another hostel",
    "Personal reasons",
    "Others"
];

const PERSONAL_FIELDS = [
    "full_name",
    "aadhar_number",
    "phone_number",
    "address",
    "emergency_contact_name",
    "emergency_contact_relationship",
    "emergency_contact_number",
    "join_date",
    "fee_plan",
    "number_of_days"
];

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
}

function isValidDate(value) {
    if (typeof value !== "string" || !DATE_REGEX.test(value)) {
        return false;
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
}

function isPositiveInteger(value) {
    return Number.isInteger(Number(value)) && Number(value) > 0;
}

function validatePersonalData(data, isCreate = false) {
    const errors = [];

    if (
        isCreate &&
        (!data.full_name || !data.aadhar_number ||
            !data.phone_number || !data.join_date || !data.fee_plan)
    ) {
        errors.push(
            "full_name, aadhar_number, phone_number, join_date and fee_plan are required"
        );
    }

    if (
        data.full_name !== undefined &&
        (typeof data.full_name !== "string" ||
            !data.full_name.trim() ||
            data.full_name.trim().length > 150)
    ) {
        errors.push("full_name must be a non-empty string of at most 150 characters");
    }

    if (
        data.aadhar_number !== undefined &&
        !AADHAR_REGEX.test(String(data.aadhar_number))
    ) {
        errors.push("aadhar_number must contain exactly 12 digits");
    }

    if (
        data.phone_number !== undefined &&
        !PHONE_REGEX.test(String(data.phone_number))
    ) {
        errors.push("phone_number must contain exactly 10 digits");
    }

    if (
        data.emergency_contact_number !== undefined &&
        data.emergency_contact_number !== null &&
        data.emergency_contact_number !== "" &&
        !PHONE_REGEX.test(String(data.emergency_contact_number))
    ) {
        errors.push("emergency_contact_number must contain exactly 10 digits");
    }

    if (
        data.join_date !== undefined &&
        !isValidDate(data.join_date)
    ) {
        errors.push("join_date must be a valid date in YYYY-MM-DD format");
    }

    if (
        data.fee_plan !== undefined &&
        !FEE_PLANS.includes(data.fee_plan)
    ) {
        errors.push("fee_plan must be Monthly, Weekly or Day-wise");
    }

    if (data.fee_plan === "Day-wise") {
        if (
            !Number.isInteger(Number(data.number_of_days)) ||
            Number(data.number_of_days) < 1 ||
            Number(data.number_of_days) > 365
        ) {
            errors.push("number_of_days must be between 1 and 365 for Day-wise plans");
        }
    } else if (
        data.fee_plan !== undefined &&
        data.number_of_days !== undefined &&
        data.number_of_days !== null &&
        data.number_of_days !== ""
    ) {
        errors.push("number_of_days must only be provided for Day-wise plans");
    }

    if (
        data.address !== undefined &&
        data.address !== null &&
        typeof data.address !== "string"
    ) {
        errors.push("address must be a string");
    }

    return errors;
}

function validateId(id) {
    return /^\d+$/.test(String(id)) && Number(id) > 0;
}

function getHostellerId(req, res) {
    const id = req.params.hostellerId;

    if (!validateId(id)) {
        sendErrorResponse(res, 400, "Invalid hosteller ID");
        return null;
    }

    return Number(id);
}

async function getRoomForAllocation(client, roomId) {
    const result = await client.query(
        `SELECT room_id, sharing_type, status
         FROM tbl_rooms
         WHERE room_id = $1
         FOR UPDATE`,
        [roomId]
    );

    if (result.rows.length === 0) {
        fail(404, "Room not found");
    }

    const room = result.rows[0];

    if (room.status !== "ACTIVE") {
        fail(400, "This room is not available for allocation");
    }

    const capacity = Number(room.sharing_type);

    if (!Number.isInteger(capacity) || capacity < 1) {
        fail(400, "Room sharing capacity is invalid");
    }

    const countResult = await client.query(
        `SELECT COUNT(*)::INTEGER AS occupied_beds
         FROM tbl_room_allocations
         WHERE room_id = $1
           AND status = 'ACTIVE'`,
        [roomId]
    );

    return {
        capacity,
        occupiedBeds: countResult.rows[0].occupied_beds
    };
}

async function ensureRoomHasSpace(client, roomId) {
    const room = await getRoomForAllocation(client, roomId);

    if (room.occupiedBeds >= room.capacity) {
        fail(409, "This room is full");
    }
}

async function getHostellerStatus(client, hostellerId, lock = false) {
    const result = await client.query(
        `SELECT hosteller_id, status, join_date
         FROM tbl_hostellers
         WHERE hosteller_id = $1
         ${lock ? "FOR UPDATE" : ""}`,
        [hostellerId]
    );

    if (result.rows.length === 0) {
        fail(404, "Hosteller not found");
    }

    return result.rows[0];
}

// POST /hostellers
export async function createHosteller(req, res) {
    const data = req.body;

    const errors = validatePersonalData(data, true);

    if (errors.length) {
        return sendErrorResponse(res, 400, "Validation failed", errors);
    }

    if (!isPositiveInteger(data.room_id)) {
        return sendErrorResponse(res, 400, "A valid room_id is required");
    }

    if (data.join_date > new Date().toISOString().slice(0, 10)) {
        return sendErrorResponse(res, 400, "join_date cannot be in the future");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Lock the room and check capacity before registering.
        await ensureRoomHasSpace(client, Number(data.room_id));

        const insertResult = await client.query(
            `INSERT INTO tbl_hostellers (
                full_name,
                aadhar_number,
                phone_number,
                address,
                emergency_contact_name,
                emergency_contact_relationship,
                emergency_contact_number,
                join_date,
                fee_plan,
                number_of_days,
                status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Staying')
            RETURNING *`,
            [
                data.full_name.trim(),
                data.aadhar_number,
                data.phone_number,
                data.address ?? null,
                data.emergency_contact_name ?? null,
                data.emergency_contact_relationship ?? null,
                data.emergency_contact_number || null,
                data.join_date,
                data.fee_plan,
                data.fee_plan === "Day-wise"
                    ? Number(data.number_of_days)
                    : null
            ]
        );

        const hosteller = insertResult.rows[0];

        await client.query(
            `INSERT INTO tbl_room_allocations (
                room_id, hosteller_id, allocation_date, status
            )
            VALUES ($1, $2, $3, 'ACTIVE')`,
            [Number(data.room_id), hosteller.hosteller_id, data.join_date]
        );

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            201,
            "Hosteller registered and room allocated successfully",
            hosteller
        );
    } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
            return sendErrorResponse(
                res,
                409,
                "A hosteller with this Aadhar number or active allocation already exists"
            );
        }

        if (error.status) {
            return sendErrorResponse(res, error.status, error.message);
        }

        console.error("createHosteller:", error);

        return sendErrorResponse(res, 500, "Failed to register hosteller");
    } finally {
        client.release();
    }
}

// GET /hostellers?status=Staying&search=Ravi
export async function getAllHostellers(req, res) {
    try {
        const { status, search } = req.query;

        if (
            status &&
            !HOSTELLER_STATUSES.includes(status)
        ) {
            return sendErrorResponse(
                res,
                400,
                "status must be Staying or Vacated"
            );
        }

        const values = [];
        const conditions = [];

        if (status) {
            values.push(status);
            conditions.push(`h.status = $${values.length}`);
        }

        if (search && String(search).trim()) {
            values.push(`%${String(search).trim()}%`);
            const index = values.length;

            conditions.push(`(
                h.full_name ILIKE $${index}
                OR h.phone_number ILIKE $${index}
                OR h.aadhar_number ILIKE $${index}
                OR r.room_number::TEXT ILIKE $${index}
                OR b.building_name ILIKE $${index}
            )`);
        }

        const whereClause = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

        const result = await pool.query(
            `SELECT
                h.hosteller_id,
                h.full_name,
                h.aadhar_number,
                h.phone_number,
                h.address,
                h.emergency_contact_name,
                h.emergency_contact_relationship,
                h.emergency_contact_number,
                h.join_date,
                h.fee_plan,
                h.number_of_days,
                h.status,
                h.vacating_date,
                h.vacating_reason,
                h.vacating_remarks,
                h.created_at,
                r.room_id,
                r.room_number,
                r.floor,
                r.sharing_type,
                b.building_name,
                ra.allocation_id,
                ra.allocation_date
             FROM tbl_hostellers h
             LEFT JOIN tbl_room_allocations ra
                ON ra.hosteller_id = h.hosteller_id
                AND ra.status = 'ACTIVE'
             LEFT JOIN tbl_rooms r ON r.room_id = ra.room_id
             LEFT JOIN tbl_buildings b ON b.building_id = r.building_id
             ${whereClause}
             ORDER BY h.created_at DESC`,
            values
        );

        // Avoid returning full Aadhar numbers in list responses.
        const hostellers = result.rows.map((row) => ({
            ...row,
            aadhar_number: row.aadhar_number
                ? `XXXX-XXXX-${row.aadhar_number.slice(-4)}`
                : null
        }));

        return sendSuccessResponse(
            res,
            200,
            "Hostellers fetched successfully",
            hostellers
        );
    } catch (error) {
        console.error("getAllHostellers:", error);
        return sendErrorResponse(res, 500, "Failed to fetch hostellers");
    }
}

// GET /hostellers/:hostellerId
export async function getHostellerById(req, res) {
    const hostellerId = getHostellerId(req, res);
    if (!hostellerId) return;

    try {
        const result = await pool.query(
            `SELECT
                h.*,
                ra.allocation_id,
                ra.room_id,
                ra.allocation_date,
                r.room_number,
                r.floor,
                r.sharing_type,
                b.building_name
             FROM tbl_hostellers h
             LEFT JOIN tbl_room_allocations ra
                ON ra.hosteller_id = h.hosteller_id
                AND ra.status = 'ACTIVE'
             LEFT JOIN tbl_rooms r ON r.room_id = ra.room_id
             LEFT JOIN tbl_buildings b ON b.building_id = r.building_id
             WHERE h.hosteller_id = $1`,
            [hostellerId]
        );

        if (result.rows.length === 0) {
            return sendErrorResponse(res, 404, "Hosteller not found");
        }

        return sendSuccessResponse(
            res,
            200,
            "Hosteller fetched successfully",
            result.rows[0]
        );
    } catch (error) {
        console.error("getHostellerById:", error);
        return sendErrorResponse(res, 500, "Failed to fetch hosteller");
    }
}

// PUT /hostellers/:hostellerId
// This updates personal and fee details, not room or vacating status.
export async function updateHosteller(req, res) {
    const hostellerId = getHostellerId(req, res);
    if (!hostellerId) return;

    const data = req.body;
    const keys = Object.keys(data);

    if (!keys.length) {
        return sendErrorResponse(res, 400, "Provide at least one field to update");
    }

    const allowed = PERSONAL_FIELDS.filter((field) =>
        Object.prototype.hasOwnProperty.call(data, field)
    );

    const forbidden = keys.filter((key) =>
        !PERSONAL_FIELDS.includes(key)
    );

    if (forbidden.length) {
        return sendErrorResponse(
            res,
            400,
            `These fields cannot be updated here: ${forbidden.join(", ")}`
        );
    }

    const errors = validatePersonalData(data, false);

    if (errors.length) {
        return sendErrorResponse(res, 400, "Validation failed", errors);
    }

    if (data.join_date && data.join_date > new Date().toISOString().slice(0, 10)) {
        return sendErrorResponse(res, 400, "join_date cannot be in the future");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const currentResult = await client.query(
            `SELECT * FROM tbl_hostellers
             WHERE hosteller_id = $1
             FOR UPDATE`,
            [hostellerId]
        );

        if (currentResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return sendErrorResponse(res, 404, "Hosteller not found");
        }

        const current = currentResult.rows[0];

        if (current.status === "Vacated") {
            await client.query("ROLLBACK");
            return sendErrorResponse(
                res,
                400,
                "A vacated hosteller cannot be updated"
            );
        }

        const nextJoinDate = data.join_date ?? current.join_date;
        const nextFeePlan = data.fee_plan ?? current.fee_plan;
        const nextDays = data.number_of_days ?? (
            data.fee_plan && data.fee_plan !== "Day-wise"
                ? null
                : current.number_of_days
        );

        if (nextJoinDate > new Date().toISOString().slice(0, 10)) {
            await client.query("ROLLBACK");
            return sendErrorResponse(res, 400, "join_date cannot be in the future");
        }

        if (
            nextFeePlan === "Day-wise" &&
            (!Number.isInteger(Number(nextDays)) ||
                Number(nextDays) < 1 ||
                Number(nextDays) > 365)
        ) {
            await client.query("ROLLBACK");
            return sendErrorResponse(
                res,
                400,
                "Day-wise fee plans require number_of_days between 1 and 365"
            );
        }

        if (nextFeePlan !== "Day-wise" && data.number_of_days != null) {
            await client.query("ROLLBACK");
            return sendErrorResponse(
                res,
                400,
                "number_of_days is only valid for a Day-wise plan"
            );
        }

        const finalDays = nextFeePlan === "Day-wise" ? Number(nextDays) : null;

        if (data.join_date) {
            const allocationResult = await client.query(
                `SELECT allocation_date
                 FROM tbl_room_allocations
                 WHERE hosteller_id = $1
                 ORDER BY allocation_date ASC
                 LIMIT 1`,
                [hostellerId]
            );

            if (
                allocationResult.rows.length &&
                data.join_date > allocationResult.rows[0].allocation_date
            ) {
                await client.query("ROLLBACK");
                return sendErrorResponse(
                    res,
                    400,
                    "join_date cannot be later than the first room allocation date"
                );
            }
        }

        const values = [];
        const assignments = [];

        for (const field of allowed) {
            let value = data[field];

            if (field === "full_name") value = value.trim();

            if (field === "number_of_days") {
                value = nextFeePlan === "Day-wise" ? finalDays : null;
            }

            if (field === "fee_plan") {
                value = nextFeePlan;
            }

            if (field === "join_date") {
                value = nextJoinDate;
            }

            values.push(value === "" ? null : value);
            assignments.push(`${field} = $${values.length}`);
        }

        // Ensure fee-plan changes also update number_of_days.
        if (!allowed.includes("number_of_days") && (
            allowed.includes("fee_plan") || allowed.includes("join_date")
        )) {
            values.push(finalDays);
            assignments.push(`number_of_days = $${values.length}`);
        }

        values.push(hostellerId);

        const result = await client.query(
            `UPDATE tbl_hostellers
             SET ${assignments.join(", ")},
                 updated_at = CURRENT_TIMESTAMP
             WHERE hosteller_id = $${values.length}
             RETURNING *`,
            values
        );

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            200,
            "Hosteller updated successfully",
            result.rows[0]
        );
    } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
            return sendErrorResponse(res, 409, "A hosteller with this Aadhar number already exists");
        }

        console.error("updateHosteller:", error);

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status ? error.message : "Failed to update hosteller"
        );
    } finally {
        client.release();
    }
}

// PATCH /hostellers/:hostellerId/room
export async function changeHostellerRoom(req, res) {
    const hostellerId = getHostellerId(req, res);
    if (!hostellerId) return;

    const { room_id: roomId, allocation_date: allocationDate } = req.body;

    if (!isPositiveInteger(roomId)) {
        return sendErrorResponse(res, 400, "A valid room_id is required");
    }

    if (
        allocationDate !== undefined &&
        !isValidDate(allocationDate)
    ) {
        return sendErrorResponse(
            res,
            400,
            "allocation_date must be a valid YYYY-MM-DD date"
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const hosteller = await getHostellerStatus(client, hostellerId, true);

        if (hosteller.status !== "Staying") {
            fail(400, "Only staying hostellers can change rooms");
        }

        const currentResult = await client.query(
            `SELECT allocation_id, room_id, allocation_date
             FROM tbl_room_allocations
             WHERE hosteller_id = $1 AND status = 'ACTIVE'
             FOR UPDATE`,
            [hostellerId]
        );

        if (!currentResult.rows.length) {
            fail(409, "No active room allocation exists for this hosteller");
        }

        const current = currentResult.rows[0];

        if (Number(current.room_id) === Number(roomId)) {
            fail(400, "Hosteller is already allocated to this room");
        }

        const newDate = allocationDate || new Date().toISOString().slice(0, 10);

        if (newDate < current.allocation_date || newDate < hosteller.join_date) {
            fail(400, "New allocation date cannot be earlier than the current allocation or join date");
        }

        // Lock/check the new room before closing the old allocation.
        await ensureRoomHasSpace(client, Number(roomId));

        await client.query(
            `UPDATE tbl_room_allocations
             SET status = 'VACATED',
                 vacated_date = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE allocation_id = $2`,
            [newDate, current.allocation_id]
        );

        const result = await client.query(
            `INSERT INTO tbl_room_allocations (
                room_id, hosteller_id, allocation_date, status
             )
             VALUES ($1, $2, $3, 'ACTIVE')
             RETURNING *`,
            [Number(roomId), hostellerId, newDate]
        );

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            200,
            "Hosteller room changed successfully",
            result.rows[0]
        );
    } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
            return sendErrorResponse(res, 409, "Hosteller already has an active allocation");
        }

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status ? error.message : "Failed to change hosteller room"
        );
    } finally {
        client.release();
    }
}

// PATCH /hostellers/:hostellerId/vacate
export async function vacateHosteller(req, res) {
    const hostellerId = getHostellerId(req, res);
    if (!hostellerId) return;

    const {
        vacating_date: vacatingDate,
        vacating_reason: vacatingReason,
        vacating_remarks: vacatingRemarks
    } = req.body;

    if (!isValidDate(vacatingDate)) {
        return sendErrorResponse(
            res,
            400,
            "vacating_date is required in YYYY-MM-DD format"
        );
    }

    if (!VACATING_REASONS.includes(vacatingReason)) {
        return sendErrorResponse(
            res,
            400,
            `vacating_reason must be one of: ${VACATING_REASONS.join(", ")}`
        );
    }

    if (
        vacatingReason === "Other" &&
        (!vacatingRemarks || !String(vacatingRemarks).trim())
    ) {
        return sendErrorResponse(
            res,
            400,
            "vacating_remarks is required when vacating_reason is Other"
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const hosteller = await getHostellerStatus(client, hostellerId, true);

        if (hosteller.status !== "Staying") {
            fail(400, "Hosteller is already vacated");
        }

        if (vacatingDate < hosteller.join_date) {
            fail(400, "vacating_date cannot be earlier than join_date");
        }

        const allocationResult = await client.query(
            `SELECT allocation_id, allocation_date
             FROM tbl_room_allocations
             WHERE hosteller_id = $1 AND status = 'ACTIVE'
             FOR UPDATE`,
            [hostellerId]
        );

        if (!allocationResult.rows.length) {
            fail(409, "No active room allocation exists for this hosteller");
        }

        const allocation = allocationResult.rows[0];

        if (vacatingDate < allocation.allocation_date) {
            fail(400, "vacating_date cannot be earlier than allocation_date");
        }

        await client.query(
            `UPDATE tbl_room_allocations
             SET status = 'VACATED',
                 vacated_date = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE allocation_id = $2`,
            [vacatingDate, allocation.allocation_id]
        );

        const result = await client.query(
            `UPDATE tbl_hostellers
             SET status = 'Vacated',
                 vacating_date = $1,
                 vacating_reason = $2,
                 vacating_remarks = $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE hosteller_id = $4
             RETURNING *`,
            [
                vacatingDate,
                vacatingReason,
                vacatingRemarks?.trim() || null,
                hostellerId
            ]
        );

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            200,
            "Hosteller vacated successfully and room bed released",
            result.rows[0]
        );
    } catch (error) {
        await client.query("ROLLBACK");

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status ? error.message : "Failed to vacate hosteller"
        );
    } finally {
        client.release();
    }
}

// GET /hostellers/:hostellerId/allocations
export async function getHostellerAllocationHistory(req, res) {
    const hostellerId = getHostellerId(req, res);
    if (!hostellerId) return;

    try {
        const hostellerResult = await pool.query(
            `SELECT hosteller_id, full_name
             FROM tbl_hostellers
             WHERE hosteller_id = $1`,
            [hostellerId]
        );

        if (!hostellerResult.rows.length) {
            return sendErrorResponse(res, 404, "Hosteller not found");
        }

        const result = await pool.query(
            `SELECT
                ra.allocation_id,
                ra.room_id,
                r.room_number,
                r.floor,
                b.building_name,
                ra.allocation_date,
                ra.vacated_date,
                ra.status,
                ra.created_at
             FROM tbl_room_allocations ra
             JOIN tbl_rooms r ON r.room_id = ra.room_id
             LEFT JOIN tbl_buildings b ON b.building_id = r.building_id
             WHERE ra.hosteller_id = $1
             ORDER BY ra.allocation_date DESC, ra.allocation_id DESC`,
            [hostellerId]
        );

        return sendSuccessResponse(
            res,
            200,
            "Room allocation history fetched successfully",
            result.rows
        );
    } catch (error) {
        console.error("getHostellerAllocationHistory:", error);
        return sendErrorResponse(res, 500, "Failed to fetch allocation history");
    }
}

// DELETE /hostellers/:hostellerId
export async function deleteHosteller(req, res) {
    const hostellerId = getHostellerId(req, res);
    if (!hostellerId) return;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Check hosteller exists and lock the record
        const hosteller = await getHostellerStatus(
            client,
            hostellerId,
            true
        );

        // Allow deletion only for vacated hostellers
        if (hosteller.status !== "Vacated") {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                409,
                "Cannot delete a hosteller who is currently staying. Vacate the hosteller first."
            );
        }

        // Delete all room allocation history
        await client.query(
            `DELETE FROM tbl_room_allocations
             WHERE hosteller_id = $1`,
            [hostellerId]
        );

        // Delete the hosteller record
        const result = await client.query(
            `DELETE FROM tbl_hostellers
             WHERE hosteller_id = $1
             RETURNING hosteller_id`,
            [hostellerId]
        );

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            200,
            "Hosteller and room allocation history deleted successfully",
            result.rows[0]
        );

    } catch (error) {
        await client.query("ROLLBACK");

        if (error.status === 404) {
            return sendErrorResponse(
                res,
                404,
                error.message
            );
        }

        console.error("deleteHosteller:", error);

        return sendErrorResponse(
            res,
            500,
            "Failed to delete hosteller and room allocation history"
        );
    } finally {
        client.release();
    }
}
